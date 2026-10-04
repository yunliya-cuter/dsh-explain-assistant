import type { EvidenceEnvelope, ImageSnapshotRef, ToolTrace } from './contracts.js';
import { stableJson, truncateValue } from './evidence.js';

/**
 * §11.6「依据可展开核查」/ §6.3「依据分级」/ §8：把一次问答的**可核查材料**组装成可落库的
 * evidence / tools / images，并施加大小上限。
 *
 * 为什么需要这个文件：
 * 旧实现里 `routes.ts` 调 `saveRecord` 时只写了 9 个字段（id/kind/status/complete/question/
 * answerText/reasoningText/usage/startedAt/updatedAt），**没写 evidence、没写 tools、没写 images**。
 * 而 `llm.ts` 明明已经算出了 `toolTrace`（工具过程），只是在落库这一步被丢掉了。
 * 后果：界面上「查看完整内容」点开也只能看到回答正文 —— 看不到「这条结论当时读了什么、
 * 跑了哪些工具」，而这正是用户要核对的东西（§11.6）。而且这不是「恰好这几条没有」：
 * 实测 `/home/dsh/.dsh/explain-assistant/sessions/` 下全部 15 个落库文件，带 tools/evidence 的为 0。
 *
 * 三条硬要求：
 * 1. 形状必须沿用 `contracts.ts` 的既有定义（EvidenceEnvelope / ToolTrace / ImageSnapshotRef），
 *    不另造第二套协议；
 * 2. `evidenceState` 不许一律写 `observed`（§6.3）——判定规则与客户端
 *    `src/client/selection.ts` 的 `classifyEvidence` **保持一致**，避免同一件事在两侧叫两个级别；
 * 3. 截断必须留痕：超出上限时把 `truncated` 标在**被保留的最后一条**上，并把丢弃条数写进
 *    `metadata`，绝不悄悄丢。
 */

/** 单条记录里依据与工具过程的条数上限（与 evidence.ts 的 maxItems 同量级）。 */
export const RECORD_MAX_EVIDENCE = 200;
export const RECORD_MAX_TOOLS = 64;
/** 单条记录里这三组内容加起来的字节上限；超了就从尾部丢并留痕。 */
export const RECORD_MAX_CONTENT_BYTES = 256 * 1024;

const EVIDENCE_STATES = new Set(['observed', 'reported_only', 'unavailable']);

/** §6.3：认不出来源的状态时，宁可写「无从得知」，也不假装「已观察到」。 */
export function normalizeEvidenceState(value: unknown): EvidenceEnvelope['evidenceState'] {
  return typeof value === 'string' && EVIDENCE_STATES.has(value)
    ? value as EvidenceEnvelope['evidenceState']
    : 'unavailable';
}

/**
 * §6.3：工具执行的真实结局决定分级。
 *
 * 与 `selection.ts:classifyEvidence` 同一条判据：工具卡片的 done/ok/failed/error 都算「记录已证实」
 * （失败证实的也是「这次失败」这个事实）；只有还没定论（preparing/running）才算「无从得知」。
 */
export function evidenceStateForToolStatus(status: unknown): EvidenceEnvelope['evidenceState'] {
  if (status === 'ok' || status === 'error') return 'observed';
  return 'unavailable';
}

function isEnvelope(value: unknown): value is EvidenceEnvelope {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as EvidenceEnvelope).kind === 'string'
    && typeof (value as EvidenceEnvelope).evidenceState === 'string';
}

function isSnapshotRef(value: unknown): value is ImageSnapshotRef {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as ImageSnapshotRef).sha256 === 'string'
    && typeof (value as ImageSnapshotRef).relativePath === 'string';
}

/**
 * 从工具返回的 `result.value` 里挑出依据与图片快照。
 *
 * 三种形态都要认（都是既有代码产出的，不是猜的）：
 * - 单个 EvidenceEnvelope（readWorkspaceText / saveWorkspaceImageSnapshot 的 value.evidence）；
 * - EvidenceEnvelope 数组（listWorkspace / searchWorkspace）；
 * - `{ evidence, snapshot }`（读图工具，snapshot 是 ImageSnapshotRef）。
 * 都不匹配时返回空数组，由调用方决定是否包一层「已观察到工具输出」的依据。
 */
export function collectEvidence(value: unknown): { evidence: EvidenceEnvelope[]; images: ImageSnapshotRef[] } {
  const evidence: EvidenceEnvelope[] = [];
  const images: ImageSnapshotRef[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { for (const entry of item) visit(entry); return; }
    if (!item || typeof item !== 'object') return;
    const object = item as Record<string, unknown>;
    if (isEnvelope(object)) { evidence.push(object); return; }
    if (isSnapshotRef(object)) { images.push(object); return; }
    if ('evidence' in object) visit(object.evidence);
    if ('snapshot' in object) visit(object.snapshot);
  };
  visit(value);
  return { evidence, images };
}

/** 工具名 → 依据的 kind / source。没列出来的按「会话读取」处理（只读工具里最常见的一类）。 */
function toolProvenance(tool: string): { kind: EvidenceEnvelope['kind']; source: EvidenceEnvelope['source'] } {
  if (tool.includes('workspace_image')) return { kind: 'image', source: 'workspace_latest' };
  if (tool.includes('workspace')) return { kind: 'file', source: 'workspace_latest' };
  if (tool.includes('model_context')) return { kind: 'model', source: 'session_snapshot' };
  return { kind: 'tool', source: 'session_snapshot' };
}

/**
 * 把 `llm.ts` 返回的 toolTrace 转成落库用的 tools，并顺带抽出依据与图片。
 *
 * toolTrace 的形状本来就与 `contracts.ts` 的 ToolTrace 对齐（tool/callId/arguments/status/result/
 * startedAt/finishedAt/truncated/sentBytes/availableBytes），所以这里只做**白名单拷贝**——
 * 不认识的字段不带进落库文件，避免把将来的内部字段固化进磁盘格式。
 */
export function fromToolTrace(trace: readonly unknown[], sessionId: string, now: string): {
  tools: ToolTrace[];
  evidence: EvidenceEnvelope[];
  images: ImageSnapshotRef[];
} {
  const tools: ToolTrace[] = [];
  const evidence: EvidenceEnvelope[] = [];
  const images: ImageSnapshotRef[] = [];
  for (const raw of trace) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const tool = typeof item.tool === 'string' && item.tool ? item.tool : 'unknown';
    const status = item.status === 'ok' || item.status === 'error' || item.status === 'preparing' || item.status === 'running' || item.status === 'stopped'
      ? item.status
      : 'error';
    const startedAt = typeof item.startedAt === 'string' ? item.startedAt : now;
    const entry: ToolTrace = {
      tool,
      status,
      startedAt,
      ...(typeof item.callId === 'string' ? { callId: item.callId } : {}),
      ...(item.arguments === undefined ? {} : { arguments: item.arguments }),
      ...(item.result === undefined ? {} : { result: item.result }),
      ...(typeof item.finishedAt === 'string' ? { finishedAt: item.finishedAt } : {}),
      ...(item.truncated === true ? { truncated: true } : {}),
      ...(typeof item.sentBytes === 'number' ? { sentBytes: item.sentBytes } : {}),
      ...(typeof item.availableBytes === 'number' ? { availableBytes: item.availableBytes } : {}),
    };
    tools.push(entry);

    // 工具产出的依据：先把 result.value 里现成的 EvidenceEnvelope 认出来。
    const result = item.result as Record<string, unknown> | undefined;
    const value = result && typeof result === 'object' ? result.value : undefined;
    const collected = collectEvidence(value);
    evidence.push(...collected.evidence);
    images.push(...collected.images);

    // 工具**确实产出过**内容、但内容不是 EvidenceEnvelope 形状（例如会话事件原文）时，
    // 按 §11.6「关联真实命令、参数、输出」补一条依据，让用户至少能看到这次读取的真实结局。
    if (!collected.evidence.length && !collected.images.length) {
      const provenance = toolProvenance(tool);
      evidence.push({
        schemaVersion: 1,
        sessionId,
        kind: provenance.kind,
        title: tool,
        summary: result && result.ok === false && typeof result.message === 'string'
          ? result.message
          : '这次读取的原始结果',
        ...(result && result.ok === false ? { status: 'error' } : {}),
        ...(item.arguments === undefined ? {} : { arguments: item.arguments }),
        ...(value === undefined ? {} : { output: value }),
        source: provenance.source,
        evidenceState: evidenceStateForToolStatus(status),
        capturedAt: now,
        truncated: entry.truncated === true,
        incomplete: status !== 'ok' && status !== 'error',
      });
    }
  }
  return { tools, evidence, images };
}

/**
 * 把客户端随请求带上来的「已选择依据」转成 EvidenceEnvelope。
 *
 * §6.3：分级**原样沿用客户端的判定**（selection.ts 的 classifyEvidence），
 * 因为那才是看着真实 DOM 属性分出来的级别；拿不到就退成 unavailable，绝不默认 observed。
 * §5.2：选择结果在选中那一刻就冻结为 selected_frozen，这里保持一致。
 */
export function fromSelectedEvidence(selected: unknown, sessionId: string, now: string): EvidenceEnvelope[] {
  if (!Array.isArray(selected)) return [];
  const result: EvidenceEnvelope[] = [];
  for (const raw of selected) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === 'string' && item.title ? item.title : undefined;
    const summary = typeof item.summary === 'string' && item.summary ? item.summary : undefined;
    const text = typeof item.summary === 'string' ? item.summary : undefined;
    result.push({
      schemaVersion: 1,
      sessionId,
      kind: 'node',
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(text ? { text } : {}),
      source: 'selected_frozen',
      evidenceState: normalizeEvidenceState(item.evidenceState),
      capturedAt: typeof item.capturedAt === 'string' && item.capturedAt ? item.capturedAt : now,
      ...(typeof item.version === 'string' ? { version: item.version } : {}),
      truncated: item.truncated === true,
      incomplete: item.incomplete === true,
      ...(item.id === undefined ? {} : { metadata: { selectedId: String(item.id) } }),
    });
  }
  return result;
}

/** 超出条数上限时从尾部丢，并把「丢过东西」这件事标在保留的最后一条上（不静默丢）。 */
function capByCount<T extends { truncated?: boolean }>(items: T[], max: number, label: string): T[] {
  if (items.length <= max) return items;
  const kept = items.slice(0, max);
  const last = kept[kept.length - 1];
  if (last) {
    last.truncated = true;
    if (label === 'evidence') {
      const envelope = last as unknown as EvidenceEnvelope;
      envelope.incomplete = true;
      envelope.metadata = { ...(envelope.metadata ?? {}), droppedByLimit: items.length - max };
    }
  }
  return kept;
}

/** 超字节上限时继续从尾部丢（先丢工具，再丢图片，最后丢依据最旧的）。 */
function capByBytes(
  state: { evidence: EvidenceEnvelope[]; tools: ToolTrace[]; images: ImageSnapshotRef[] },
  maxBytes: number,
): { evidence: EvidenceEnvelope[]; tools: ToolTrace[]; images: ImageSnapshotRef[]; dropped: number } {
  let dropped = 0;
  const size = () => Buffer.byteLength(stableJson({ evidence: state.evidence, tools: state.tools, images: state.images }), 'utf8');
  while (size() > maxBytes) {
    if (state.tools.length) { state.tools = state.tools.slice(0, -1); dropped++; continue; }
    if (state.images.length) { state.images = state.images.slice(0, -1); dropped++; continue; }
    if (state.evidence.length) { state.evidence = state.evidence.slice(0, -1); dropped++; continue; }
    break;
  }
  if (dropped) {
    const last = state.evidence[state.evidence.length - 1];
    if (last) { last.truncated = true; last.incomplete = true; last.metadata = { ...(last.metadata ?? {}), droppedByBytes: dropped }; }
    const lastTool = state.tools[state.tools.length - 1];
    if (lastTool) lastTool.truncated = true;
  }
  return { ...state, dropped };
}

export interface RecordContentInput {
  sessionId: string;
  selectedEvidence?: unknown;
  toolTrace?: readonly unknown[];
  now?: string;
}

/**
 * 组装一条记录的可核查内容。**永不抛异常**：落库是尽力而为，
 * 组装失败不能把已经跑完的问答连累掉（失败时回空数组，各字段仍是合法形状）。
 */
export function buildRecordContent(input: RecordContentInput): {
  evidence: EvidenceEnvelope[];
  tools: ToolTrace[];
  images: ImageSnapshotRef[];
} {
  const now = input.now ?? new Date().toISOString();
  try {
    const selected = fromSelectedEvidence(input.selectedEvidence, input.sessionId, now);
    const fromTools = fromToolTrace(Array.isArray(input.toolTrace) ? input.toolTrace : [], input.sessionId, now);
    // 依据顺序：用户选中的在前（那是他提问的出发点），工具读到的在后。
    let evidence = capByCount([...selected, ...fromTools.evidence], RECORD_MAX_EVIDENCE, 'evidence');
    let tools = capByCount(fromTools.tools, RECORD_MAX_TOOLS, 'tools');
    let images = fromTools.images;
    // 单条工具结果本身也已按工具上限截断过；这里再做一次记录级兜底。
    const clipped = tools.map(tool => {
      if (tool.result === undefined) return tool;
      const bounded = truncateValue(tool.result, { maxBytes: 64 * 1024 });
      return bounded.truncated ? { ...tool, result: bounded.value, truncated: true } : tool;
    });
    tools = clipped;
    const fitted = capByBytes({ evidence, tools, images }, RECORD_MAX_CONTENT_BYTES);
    return { evidence: fitted.evidence, tools: fitted.tools, images: fitted.images };
  } catch {
    return { evidence: [], tools: [], images: [] };
  }
}
