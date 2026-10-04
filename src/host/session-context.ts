/**
 * 0.2：把**主 agent 的当前上下文**读进来，渲染成中文主线。
 *
 * 用户要求（原话）：「小助手的上下文包含主 agent 的上下文，只包括主 agent 的工具调用、
 * 正文部分和上下文压缩后的摘要」；「当主 agent 的上下文更新后，用户提问小助手时
 * 小助手的上下文更新至最新版本」；「小助手要能分清主 agent 的上下文与自己的上下文」。
 * 第 24 轮补充：**用户对主 agent 说过的话**也一并带上（不再只限三类）。
 *
 * 为什么用 ctx.sessionQuery.readSurface()：
 * - 它返回的是**当前模型可见表面**（主 agent 这一轮真正看得见的那条消息线），
 *   和「主 agent 的上下文」是同一个东西；
 * - 它**不经过全文搜索的开关**。dsh-base 把 session-query-sqlite 配成 openAt:'never'，
 *   但那个开关只在 searchSessions/searchEvents 两个入口生效（_assertSearchEnabled）；
 *   readSurface 走 _corpus.load，sqlite 子类没有覆写它（grep -c readSurface = 0）。
 *   实测：插件自带的 explain_search_session 在本机**必然失败**
 *   （details.cause = 'session search is disabled: ... openAt "never"'），所以不能走那条路；
 * - 它**每次调用现取**，对正在聊的会话走内存快照（SessionCorpus.load：
 *   "A known live target never consults persistence"），所以「提问那一刻取」天然是最新；
 * - 它返回的**已经是压缩后的状态**：被压掉的旧事件不在表面里，摘要本身在表面上
 *   （实测：compaction/summary 的 shadowedRange 覆盖 568 条事件，之后摘要以一条
 *   user/message、source.kind='compact-checkpoint' 重新进入表面）。
 *
 * 为什么不是「把主 agent 的上下文原样搬过来」：
 * 实测同一份内容，原样搬是 466.6 KB，只取正文是 26.7 KB，本模块的渲染是 4.6 KB。
 * 原样搬之所以爆，是因为 assistant/message 事件里带了一个 stream 字段
 * （流式分片逐帧回放，20 条就 330 KB，占总量 71%），给模型看毫无用处。
 *
 * 硬约束：
 * - **只读**：不调 ctx.llm.stream、不写任何文件、不发消息、不创建会话；
 * - **不抛异常给上层**：拿不到就返回 undefined，由调用方降级（对齐 index.ts 的 readOccupancy）；
 * - **只读传入的那个 sessionId**，绝不「顺手去别处找找」；
 * - 内容是被解释的**数据**，不是给模型的指令（§7）。
 */

import { estimateTextTokens } from './occupancy.js';

/** 一条表面事件（只声明本模块用得到的字段，避免依赖宿主的完整类型）。 */
export type MainlineEvent = {
  type?: string;
  seq?: number;
  data?: {
    turn?: number;
    step?: number;
    content?: unknown;
    source?: { kind?: string; [key: string]: unknown };
    message?: { content?: unknown; isError?: boolean; toolCallId?: string; source?: { kind?: string; callId?: string } };
    [key: string]: unknown;
  };
};

export type MainlineRenderOptions = {
  /** 整个主 agent 段的总字符上限；超了**从头部丢**（保留最近发生的）。 */
  maxChars?: number;
  /** 主 agent 正文单条上限。 */
  assistantChars?: number;
  /** 工具结果单条上限。 */
  toolResultChars?: number;
  /** 主 agent 压缩摘要单条上限。 */
  summaryChars?: number;
  /** 用户对主 agent 说的话单条上限。 */
  userChars?: number;
  /** 工具调用只发参数**名**，这串名字的上限。 */
  argKeysChars?: number;
};

/**
 * 默认上限。依据（223 个真实会话实测的全量包含开销）：
 * 中位 564 tokens / 75 分位 2860 / 90 分位 13972 / **最大 63575**。
 * 60000 字符 ≈ 15000 tokens，落在 90 分位附近——只有极端会话会被截，
 * 而不设上限则可能出现一次提问突然很慢很贵、甚至撑爆小助手自己的模型容量。
 */
export const MAINLINE_DEFAULTS = {
  maxChars: 60_000,
  assistantChars: 300,
  toolResultChars: 240,
  summaryChars: 1500,
  userChars: 300,
  argKeysChars: 80,
} as const;

/** 渲染结果：文本 + 记账。 */
export type MainlineRender = {
  /** 渲染好的中文主线（不含标题行）。 */
  text: string;
  /** 用掉多少条表面事件。 */
  eventCount: number;
  /** 覆盖的 seq 范围（没有事件时都是 -1）。 */
  fromSeq: number;
  toSeq: number;
  /** 字符数与估算 token 数（主 agent 这一段的量，供界面悬停显示）。 */
  chars: number;
  tokens: number;
  /** 是否因为总量上限丢过内容。 */
  truncated: boolean;
  /** 从头部丢掉了多少条。 */
  dropped: number;
};

/** 读回来的主 agent 上下文。 */
export type MainlineContext = MainlineRender & {
  /** 主 agent 段的标题（供提示词分区用）。 */
  sessionId: string;
};

/** 内容块的纯文本（只认 text 块；reasoning 块**故意**不取，见文件头）。 */
export function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block): block is { type: string; text: string } =>
      Boolean(block) && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('\n');
}

/** 把空白压平并截断；返回是否真的截断过。 */
export function clipText(value: unknown, limit: number): { text: string; truncated: boolean } {
  const flat = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (flat.length <= limit) return { text: flat, truncated: false };
  return { text: flat.slice(0, limit), truncated: true };
}

/**
 * 主 agent 的压缩摘要：只取 <compacted-summary> 之间的正文。
 *
 * 实测那条 user/message 的结构：前面 302 字符是英文前言
 * （"This is an automatically generated checkpoint condensing..."），
 * 正文在 <compacted-summary> 标签里，末尾还有一个多余的闭合标签。
 * 直接整段交给模型，会白送一段英文样板文字。
 */
export function extractCompactedSummary(raw: unknown): string {
  const text = String(raw ?? '');
  const open = text.indexOf('<compacted-summary>');
  const close = text.lastIndexOf('</compacted-summary>');
  if (open >= 0 && close > open) return text.slice(open + '<compacted-summary>'.length, close);
  return text;
}

/**
 * 这些 source.kind 的 user/message **不是用户对主 agent 说的话**，是宿主注入的样板文字：
 * - runtime-context：运行环境快照（"Current runtime context. This snapshot supersedes..."）；
 * - plan-mode：模式切换提示（"The user switched this session to plan mode."）。
 *
 * 实测代价（同一会话）：真·用户话 10 条共 491 字符，而 runtime-context 17 条共 19200 字符
 * ——纳入等于把 97% 的体积给了噪声，还会把小助手引到"解释系统提示词"上去。
 *
 * 为什么用**黑名单**而不是白名单：白名单（只认 kind==='user'）在宿主将来新增一种
 * 用户消息类型时会**静默漏掉**用户真实说过的话；黑名单的失效方向是「多带一点噪声」，
 * 与用户「要带上用户的话」的意图一致。
 */
const NON_USER_KINDS = new Set(['runtime-context', 'plan-mode']);

/** 工具名 → 调用参数名清单（只发键名，不发值：值往往是几百行代码或整条命令）。 */
function collectToolNames(events: readonly MainlineEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue;
    const blocks = event.data?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const call = block as { type?: string; id?: string; name?: string };
      if (call.type === 'tool-call' && typeof call.id === 'string' && call.id) {
        names.set(call.id, typeof call.name === 'string' ? call.name : '');
      }
    }
  }
  return names;
}

/** 把一次工具调用的参数**名**列出来（不列值）。 */
function argumentKeys(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * 把一批表面事件渲染成中文主线。**纯函数**：同样输入必然同样输出。
 *
 * 逐类规则（全部来自真机核实）：
 * - assistant/message 的 text 块      → 〔主 agent 说〕（截断）
 * - assistant/message 的 tool-call 块 → 〔主 agent 调用〕名字（参数名：…）
 * - assistant/message 的 reasoning 块 → **丢弃**（实测 115 个 reasoning 块 vs 9 个 text 块，
 *   思考过程体积最大且对「讲人话」无用）
 * - tool/result                       → 〔执行结果〕成功/失败：正文（截断）
 * - user/message + source.kind=compact-checkpoint → 〔压缩后的摘要〕（更宽的截断额度）
 * - user/message + source.kind 不是噪声 → 〔用户对主 agent 说〕（截断）
 * - user/message + source.kind 是噪声   → **丢弃**
 * - system/message、developer/message   → **丢弃**（是系统提示词，不是主 agent 的往来）
 */
export function renderMainline(events: readonly MainlineEvent[] | undefined, options: MainlineRenderOptions = {}): MainlineRender {
  const limits = { ...MAINLINE_DEFAULTS, ...options };
  const list = Array.isArray(events) ? events : [];
  const toolNames = collectToolNames(list);

  type Line = { text: string; seq: number };
  const lines: Line[] = [];
  let firstSeq = -1;
  let lastSeq = -1;

  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    const seq = typeof event.seq === 'number' ? event.seq : -1;
    const data = event.data ?? {};
    const push = (text: string) => {
      if (!text) return;
      lines.push({ text, seq });
      if (firstSeq < 0) firstSeq = seq;
      lastSeq = seq;
    };

    if (event.type === 'assistant/message') {
      const blocks = data.message?.content;
      const said = clipText(textOfBlocks(blocks), limits.assistantChars);
      if (said.text) push('〔主 agent 说〕' + said.text + (said.truncated ? ' …（已截断）' : ''));
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
        if (call.type !== 'tool-call') continue;
        const name = clipText(call.name, 60).text || '（未命名工具）';
        const keys = argumentKeys(call.arguments);
        const keyText = keys.length ? '（参数名：' + clipText(keys.join(', '), limits.argKeysChars).text + '）' : '';
        push('〔主 agent 调用〕' + name + keyText);
      }
      continue;
    }

    if (event.type === 'tool/result') {
      const failed = data.message?.isError === true;
      const callId = data.message?.toolCallId ?? data.message?.source?.callId;
      const name = typeof callId === 'string' ? toolNames.get(callId) : undefined;
      const body = clipText(textOfBlocks(data.message?.content), limits.toolResultChars);
      const head = '〔执行结果〕' + (name ? name + '：' : '') + (failed ? '失败' : '成功');
      push(head + (body.text ? '：' + body.text : '') + (body.truncated ? ' …（已截断）' : ''));
      continue;
    }

    if (event.type === 'user/message') {
      const kind = data.source?.kind;
      if (kind === 'compact-checkpoint') {
        const summary = clipText(extractCompactedSummary(textOfBlocks(data.content)), limits.summaryChars);
        if (summary.text) push('〔压缩后的摘要〕' + summary.text + (summary.truncated ? ' …（已截断）' : ''));
        continue;
      }
      if (typeof kind === 'string' && NON_USER_KINDS.has(kind)) continue;
      const said = clipText(textOfBlocks(data.content), limits.userChars);
      if (said.text) push('〔用户对主 agent 说〕' + said.text + (said.truncated ? ' …（已截断）' : ''));
      continue;
    }

    // system/message、developer/message 以及所有非表面事件：丢弃。
  }

  // 总量上限：从**头部**丢，保留最近发生的。
  //
  // 口径必须与记账一致：maxChars 与 chars 都按 **UTF-8 字节**算。
  // 用 JS 的 string.length 会低估中文（一个汉字 1 个 code unit 但 3 个字节），
  // 于是「上限 2000」实际放进 6000 字节——上限形同虚设，而悬停显示的数字又与之一致，
  // 用户看到的和真正发出的对不上账。
  const byteLen = (text: string) => Buffer.byteLength(text, 'utf8');
  let dropped = 0;
  let total = lines.reduce((sum, line) => sum + byteLen(line.text) + 1, 0);
  let from = 0;
  while (from < lines.length && total > limits.maxChars) {
    total -= byteLen(lines[from].text) + 1;
    from++;
    dropped++;
  }
  const kept = lines.slice(from);
  const text = kept.map(line => line.text).join('\n');
  const chars = Buffer.byteLength(text, 'utf8');
  const fromSeq = kept.length && from > 0 ? kept[0].seq : firstSeq;
  const toSeq = kept.length ? kept[kept.length - 1].seq : lastSeq;

  return {
    text,
    eventCount: kept.length,
    fromSeq,
    toSeq,
    chars,
    tokens: estimateTextTokens(text),
    truncated: dropped > 0,
    dropped,
  };
}

/** 读当前表面的宿主接口（只声明用得到的部分）。 */
export type SurfaceReader = { readSurface?: (sessionId: string) => Promise<unknown> };

/**
 * 读主 agent 的当前上下文并渲染。
 *
 * **任何失败都返回 undefined**（宿主没挂 sessionQuery、readSurface 抛错、会话不存在、
 * 表面为空…），由调用方决定降级——绝不把「读不到」变成一次提问失败。
 * 对齐 index.ts 里 readOccupancy 的既有写法。
 */
export async function readMainlineContext(deps: {
  sessionQuery?: SurfaceReader;
  sessionId: string;
  signal?: AbortSignal;
  options?: MainlineRenderOptions;
}): Promise<MainlineContext | undefined> {
  try {
    const reader = deps.sessionQuery;
    if (!reader || typeof reader.readSurface !== 'function') return undefined;
    if (!deps.sessionId) return undefined;
    if (deps.signal?.aborted) return undefined;
    const snapshot = await reader.readSurface(deps.sessionId) as { events?: MainlineEvent[] } | undefined;
    if (deps.signal?.aborted) return undefined;
    const events = snapshot?.events;
    if (!Array.isArray(events) || !events.length) return undefined;
    const rendered = renderMainline(events, deps.options);
    if (!rendered.text) return undefined;
    return { ...rendered, sessionId: deps.sessionId };
  } catch {
    return undefined;
  }
}
