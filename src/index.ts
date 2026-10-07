import { createExplainAssistantRoutes } from './host/routes.js';
import { readConfiguredTimeouts } from './host/timeout-config.js';
import { JsonSessionStore } from './host/persistence.js';
import { catalogContains, discoverCatalog, resolveSelection, toModelSelection } from './host/catalog.js';
import { buildMessages, SYSTEM_PROMPT } from './host/prompts.js';
import { carriedRecords, measureAssistantOccupancy } from './host/occupancy.js';
import { readMainlineContext } from './host/session-context.js';
import { ExplainAssistantError, type HistoryResultPayload } from './host/contracts.js';
import { createArchiveSweeper } from './host/archive.js';

/** Host services required by the explanation assistant. */
export const inject = [
  "connection",
  "sessionQuery",
  "fs",
  "attachments",
  "llm",
  "tokenMeter",
];

/**
 * 读取**小助手自身**的上下文占用（§9.2）。
 *
 * 这里刻意**不再**读主会话：旧实现用 `sessions.get(sessionId)` 拿主会话再
 * `tokenMeter.measure(主会话)`，量的其实是主 agent 的上下文，与 §9.2
 * 「显示小助手自身占用，不使用主 agent 的数值」正面冲突。
 * 而且 TokenMeasurement 根本没有 contextWindow 字段，旧代码的分母恒为 undefined，
 * 圆环在真实运行时**永远**显示「占用未知」。
 *
 * 小助手不是 DSH 会话，没有可 measure 的 Session，所以自身上下文的规模按固定密度
 * 估算（见 host/occupancy.ts），结果一律带 estimated=true，界面标「估算」。
 * 容量取自适配器自报的 llm.resolveModelInfo().context.contextWindow；
 * 未选模型或容量未知时返回 undefined，由界面显示「占用未知」——不编造、不借用主 agent。
 *
 * 0.2 补充：主 agent 转移进来的那一段**要计入总量**（它确实占用了小助手的上下文），
 * 但**分开记账**（occupancy.parts），界面悬停时才能分别显示两块各占多少。
 * 注意这不违反 §9.2：「不使用主 agent 的数值」指的是不能拿主 agent 的上下文窗口
 * 或它的百分比来冒充小助手的，不是不许把小助手自己发出的请求里含的那部分算进来。
 */
async function readOccupancy(
  ctx: any,
  state: any,
  mainline?: { tokens?: number; chars?: number },
): Promise<{ percent: number; estimated: boolean; parts: { mainAgentTokens: number; mainAgentChars: number; ownTokens: number; ownChars: number } } | undefined> {
  try {
    const explicit = state?.explicitModel as { provider?: string; model?: string } | undefined;
    if (!explicit?.provider || !explicit?.model) return undefined;
    const llm = ctx?.llm;
    if (typeof llm?.resolveModelInfo !== 'function') return undefined;
    const info = await llm.resolveModelInfo(explicit.provider, explicit.model);
    const contextWindow = info?.context?.contextWindow;
    const occupancy = measureAssistantOccupancy({
      systemPrompt: SYSTEM_PROMPT,
      compactSummary: state?.compactState?.summary,
      records: carriedRecords(state?.records, state?.compactState?.createdAt),
      contextWindow,
      ...(typeof mainline?.tokens === 'number' ? { mainAgentTokens: mainline.tokens } : {}),
      ...(typeof mainline?.chars === 'number' ? { mainAgentChars: mainline.chars } : {}),
    });
    if (!occupancy) return undefined;
    return { percent: occupancy.percent, estimated: true, parts: occupancy.parts };
  } catch {
    return undefined;
  }
}

/** §5.1/§8 历史分页大小。一次给一页，避免记录变多后把浮窗塞满。 */
const HISTORY_PAGE_SIZE = 20;
/** §11.6：展开单条记录时，依据 / 工具步骤 / 图片各自一页给多少条。 */
const HISTORY_RESULT_PAGE_SIZE = 20;
/** 把客户端传来的游标收敛成合法的「更早记录条数」。 */
function clampCursor(cursor: string | undefined, total: number): number {
  const parsed = typeof cursor === 'string' && cursor.trim() ? Number(cursor) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return total;
  return Math.min(parsed, total);
}
/**
 * 展开单条记录时的游标收敛。
 *
 * 方向与 loadHistory 相反：翻更早历史是从**最新**往过去翻（缺省游标 = 末尾），
 * 展开一条记录是从**第一条**往后读（缺省游标 = 开头）。
 * 两者绝不能共用同一个收敛函数，否则第一页会从中间开始，前面的依据永远看不到。
 */
function clampResultCursor(cursor: string | undefined, total: number): number {
  const parsed = typeof cursor === 'string' && cursor.trim() ? Number(cursor) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, total);
}

/** Host half of the read-only explanation assistant. */
export function apply(ctx: any): void {
  const connection = ctx?.connection;
  if (!connection?.fetch?.register) return;
  const active = new Map<string, { requestId: string; controller: AbortController }>();
  const home = typeof process !== 'undefined' ? (process.env.DSH_HOME || process.env.HOME) : undefined;
  const store = home ? new JsonSessionStore({ rootDir: home + '/explain-assistant' }) : undefined;
  const sessionQuery = ctx?.sessionQuery;

  /**
   * 0.2：主 agent 上下文的**短时缓存**（仅 loadState 用）。
   *
   * 为什么需要：打开浮窗时客户端会连续打几次 state，而 readSurface 每次都要克隆
   * 整份表面（实测：小会话 1–2 ms，1.4 万事件的会话约 23 ms，3.4 万事件的会话约 1.2 秒）。
   * 没有缓存时，这几次刷新会把同一份内容重复读好几遍。
   *
   * 为什么 TTL 只有 5 秒：用户要求「提问时同步至最新」。5 秒足够吸收打开浮窗时的那几次
   * 连续刷新，又短到不会让界面上的占用数字明显落后。**提问路径不经过这个缓存**
   * （见 buildMessages），所以「答得出主 agent 刚做完的那一步」不受影响。
   */
  const MAINLINE_CACHE_TTL_MS = 5000;
  const mainlineCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof readMainlineContext>> }>();
  const readMainlineCached = async (id: string, signal?: AbortSignal) => {
    const now = Date.now();
    const hit = mainlineCache.get(id);
    if (hit && now - hit.at < MAINLINE_CACHE_TTL_MS) return hit.value;
    const value = await readMainlineContext({ sessionQuery, sessionId: id, signal });
    mainlineCache.set(id, { at: now, value });
    // 缓存不能无限长：归档清理过的会话不该继续占内存。
    if (mainlineCache.size > 64) {
      const oldest = [...mainlineCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, mainlineCache.size - 64);
      for (const [key] of oldest) mainlineCache.delete(key);
    }
    return value;
  };

  /** 目录可能随时变化（换 provider、加模型），故做短时缓存，避免每个请求都打一遍宿主。 */
  let catalogCache: { at: number; value: any } | undefined;
  const CATALOG_TTL_MS = 30000;
  const loadCatalog = async (signal?: AbortSignal) => {
    const now = Date.now();
    if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
    const value = await discoverCatalog(ctx?.llm, signal);
    catalogCache = { at: now, value };
    return value;
  };

  /**
   * §4/§8 F6：归档清理。
   *
   * 旧实现里持久化层已经有 `remove` 与 `retryPendingDeletes`，但**没有任何调用方**：
   * 删除失败的任务只是静静躺在内存集合里，插件重启就永久丢失，用户的小助手记录
   * 会一直留在磁盘上。这里在插件启动时补一次收尾。
   */
  const cleanupArchived = async (reason: string) => {
    if (!store) return { attempted: 0, failed: 0 };
    try {
      const result = await store.retryPendingDeletes();
      if (result.attempted) console.error('[dsh-explain-assistant] 清理遗留的小助手记录：尝试', result.attempted, '条，失败', result.failed, '条（' + reason + '）');
      return result;
    } catch (error) {
      // 清理失败绝不能让插件启动失败：记录仍然可用，只是这次没删掉。
      console.error('[dsh-explain-assistant] 清理遗留记录失败（' + reason + '）：', error instanceof Error ? error.message : String(error));
      return { attempted: 0, failed: 0 };
    }
  };
  // 插件加载时就收尾一次（不阻塞加载）。
  void cleanupArchived('插件启动');

  /**
   * §4/§8 F6 归档处理三条腿的**中间那条：轻量周期检查**。
   *
   * 前情：实施文档 §8 要求「启动清理、轻量周期检查、可用归档事件即时处理」三条腿。
   * 此前只有启动清理（而且它只重试**失败的删除**，不会主动发现归档）。
   *
   * 「可用归档事件即时处理」**不可实现**，已核实：整个 DSH 安装里搜不到 archive 事件、
   * 也没有 archived 标识（`grep -rn 'archived' /usr/local/lib/node_modules/@deepseek-ai/dsh/lib` 为空）。
   * 不为了凑齐三条腿去硬造一个假的事件监听。
   *
   * 所以这里补周期检查，但**判据极其保守**：只有会话对象**明确自报已归档**才允许删。
   * 查不到会话一律视为「拿不准」（因为 SESSION 被删、服务不可用、时机不对这三种情况
   * 从返回值上无法区分），保留记录。宁可漏删，绝不误删。
   *
   * 副作用如实说明：当前 DSH 没有归档标识，所以这条腿在真实运行中**几乎不会删掉任何东西**。
   * 这是正确的安全行为；等 DSH 提供归档信号后无需改代码即可生效。
   */
  const archiveSweeper = store ? createArchiveSweeper({
    listSessionIds: () => store.listSessionIds(),
    // 单个会话的查询也要兜异常：这里再包一层，确保「服务抛错」判成 unknown 而不是把扫描打断。
    lookupSession: (id: string) => {
      try {
        const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined;
        const session = typeof sessions?.get === 'function' ? sessions.get(id) : undefined;
        // sessions 服务本身不可用时返回 undefined → classifySessionArchive 判 unknown → 保留。
        return session;
      } catch {
        return undefined;
      }
    },
    // 只删本插件自己的东西：store.remove 只删 <rootDir>/sessions/<id>.json 与该会话的图片目录，
    // 不碰工作区文件，也不碰 DSH 共享附件。
    removeSession: (id: string) => store.remove(id),
    logger: (message: string) => console.error('[dsh-explain-assistant]', message),
  }) : undefined;
  archiveSweeper?.start();

  /**
   * §4/§8 F6「已归档」的**内存墓碑**。
   *
   * 为什么需要它：forget 会**删除**磁盘文件（规范要求删除而不是清空），而删掉之后
   * `store.load(id)` 会返回一份**全新的空状态**（archived=false）。于是「晚到的写入」
   * （saveRecord / saveCompact / markUnread）会走 load→save 把文件**重新创建出来**，
   * 归档等于白做。这里记住「这个会话已经被归档清理过」，写入侧据此拒绝。
   *
   * 局限（如实说明）：墓碑在内存里，插件重启后丢失。重启后若还有该会话的晚到写入，
   * 仍可能重建文件；能兜住它的是下一次归档信号/周期检查。详见回报。
   */
  const forgotten = new Set<string>();
  /** 该会话是否已被归档清理（磁盘已删或已被标记归档）。写入侧必须先用它把关。 */
  const isForgotten = async (id: string): Promise<boolean> => {
    if (forgotten.has(id)) return true;
    if (!store) return false;
    try { return Boolean((await store.load(id)).state.archived); } catch { return false; }
  };

  const service = {
    /**
     * §10 调用限额：把超时预算做成**可被环境变量覆盖**（默认值不变，仍 300s / 120s）。
     *
     * 为什么需要：F7「界面超时提示」的实现一直都在，但从没在页面上触发过 ——
     * 默认要等 5 分钟，靠干等不现实。可覆盖之后就能压到几秒、真实触发一次超时并截图取证。
     * 校验严格：非法/负数/非数字/过大一律回退默认（见 host/timeout-config.ts），
     * 绝不出现「超时变 0」或「永久等待」。
     */
    llmTimeouts: readConfiguredTimeouts(),
    loadState: async (id: string, signal?: AbortSignal) => {
      const state: any = store ? (await store.load(id)).state : { sessionId: id, records: [], unread: false, archived: false };
      const explicit = state.explicitModel as { provider?: string; model?: string } | undefined;
      // 0.2：主 agent 上下文同时驱动两件事——占用数字（圆环）与悬停显示的构成。
      const mainline = await readMainlineCached(id, signal);
      const occupancy = await readOccupancy(ctx, state, mainline);
      const catalog = await loadCatalog(signal).catch(() => ({ groups: [], failures: [] }));
      // §5.1/§8：首屏只给最近一页，更早的靠「查看更早历史」按页取。
      // 一次全给会在记录变多后把浮窗塞满，也让首屏变慢。
      const allRecords: any[] = Array.isArray(state?.records) ? state.records : [];
      const pageStart = Math.max(0, allRecords.length - HISTORY_PAGE_SIZE);
      return {
        ...state,
        records: allRecords.slice(pageStart),
        hasEarlier: pageStart > 0,
        ...(pageStart > 0 ? { historyCursor: String(pageStart) } : {}),
        // §5.1/§8：把**宿主持有的总条数**一并下发。
        //
        // 为什么需要它：这里的 hasEarlier/historyCursor 恒按「首屏=最近一页」算，
        // 只要总数 > 一页就永远说「还有更早」。而客户端可能已经翻到底、手里握着全部记录。
        // 客户端若照抄这两个字段（旧实现就是），一次刷新就会把「已到底」覆盖回「还能翻」，
        // 游标也指回已经加载过的那一页 → 再点一次就整段重复渲染（界面 24→28→32，磁盘始终 24）。
        // 有了总数，客户端才能算准「我手里的够不够」。
        totalRecords: allRecords.length,
        model: explicit && explicit.provider && explicit.model
          ? { provider: explicit.provider, model: explicit.model, source: 'explicit' }
          : undefined,
        // §9.1/F1：压缩结果必须随状态一起下发，否则界面永远看不到摘要，
        // 用户按了 /compact 却没有任何反馈（成功失败都一样）。
        compactState: state.compactState,
        ...(occupancy === undefined ? {} : { occupancy: occupancy.percent }),
        occupancyKnown: occupancy !== undefined,
        occupancyEstimated: occupancy?.estimated === true,
        // 0.2：这份上下文由哪两块构成（圆环的悬停提示据此显示，不再只给一个总数）。
        // 两块之和 === 本次实际注入的量（主 agent 段超上限时按**丢完之后**的实际值记，
        // 否则用户悬停看到的数对不上账）。
        ...(occupancy === undefined ? {} : {
          occupancyParts: {
            mainAgentTokens: occupancy.parts.mainAgentTokens,
            mainAgentChars: occupancy.parts.mainAgentChars,
            ownTokens: occupancy.parts.ownTokens,
            ownChars: occupancy.parts.ownChars,
            ...(mainline ? { mainAgentEvents: mainline.eventCount, mainlineTruncated: mainline.truncated } : {}),
          },
        }),
        catalog,
      };
    },
    /**
     * §5.1「更早历史需通过宿主提供的读取能力取得」/ §8「关闭再打开能查看并继续追问」。
     *
     * 旧实现恒返回 hasEarlier:false，于是客户端「查看更早历史」按钮**永远不渲染** ——
     * 用户记录一多就翻不上去。这里按页返回：cursor 表示「还有多少条更早的记录」。
     */
    loadHistory: async (id: string, cursor?: string) => {
      const state: any = store ? (await store.load(id)).state : undefined;
      const all: any[] = Array.isArray(state?.records) ? state.records : [];
      const remaining = clampCursor(cursor, all.length);
      const from = Math.max(0, remaining - HISTORY_PAGE_SIZE);
      const records = all.slice(from, remaining);
      const next = from;
      return { records, hasEarlier: next > 0, ...(next > 0 ? { cursor: String(next) } : {}) };
    },
    /**
     * §5.1「更早历史需通过宿主提供的读取能力取得」/ §8「关闭再打开能查看并继续追问」
     * / §11.6「依据可核查」：把一条记录里被截断的内容按页交出来。
     *
     * 旧实现只有接口声明与路由分发，service 层**根本没有这个方法**，
     * 于是 /history-result 恒返回 payload:{} —— 客户端就算想展开也没东西可展开，
     * 用户永远看不到「这一条当时到底读取了什么、跑过哪些工具」。
     *
     * 三条硬要求：
     * 1. 只读本会话自己的记录：先按入参 sessionId 打开存储，再在**这一份**状态里找 recordId。
     *    别的会话的记录不可能出现在这里（存储按 sessionId 分文件），返回体再带上 sessionId 供对账。
     * 2. 记录不存在 / 不属于本会话：抛 RECORD_NOT_FOUND（路由转 404）并给中文原因，
     *    绝不静默返回空对象——那会让界面显示「没有内容」，用户以为记录里真的没有依据（§10「不静默失败」）。
     * 3. 三组数组字段（evidence/tools/images）按 cursor 分段返回，字段形状沿用 contracts 既有定义，
     *    不另造第二套协议；answerText / reasoningText 等其余字段原样带出。
     */
    loadHistoryResult: async (id: string, recordId: string, cursor?: string, signal?: AbortSignal): Promise<HistoryResultPayload> => {
      // 取消/环境故障都要给明确原因，不能把「读不到」说成「这条记录不存在」。
      if (signal?.aborted) throw new ExplainAssistantError('ABORTED', '这次读取已经取消。');
      const wanted = typeof recordId === 'string' ? recordId.trim() : '';
      if (!wanted) throw new ExplainAssistantError('INVALID_REQUEST', '缺少要展开的记录标识（recordId）。');
      if (!store) throw new ExplainAssistantError('PERSISTENCE_FAILED', '小助手没有可用的保存目录，无法读取记录。');
      const state: any = store ? (await store.load(id)).state : undefined;
      const all: any[] = Array.isArray(state?.records) ? state.records : [];
      // §8 会话隔离：这里只在**本会话**的落库文件里找，找不到就是拿不到，不存在"顺手去别处找找"。
      const found: any = all.find(item => item && item.id === wanted);
      if (!found || typeof found !== 'object') throw new ExplainAssistantError('RECORD_NOT_FOUND', '这条小助手记录不存在，或者它属于另一个主对话，无法查看。');
      const evidence: any[] = Array.isArray(found.evidence) ? found.evidence : [];
      const tools: any[] = Array.isArray(found.tools) ? found.tools : [];
      const images: any[] = Array.isArray(found.images) ? found.images : [];
      // 三组字段共用同一个游标：一次往后走一页，三组一起前进，界面按「第几页」对齐。
      const total = Math.max(evidence.length, tools.length, images.length);
      const from = clampResultCursor(cursor, total);
      const to = Math.min(total, from + HISTORY_RESULT_PAGE_SIZE);
      // §5.1：缺省游标从**第一条**开始往后读（与 loadHistory 从最新往过去翻的方向相反，故各用各的收敛函数）。
      return {
        sessionId: id,
        recordId: String(found.id ?? wanted),
        record: { ...found, evidence: evidence.slice(from, to), tools: tools.slice(from, to), images: images.slice(from, to) } as any,
        counts: { evidence: evidence.length, tools: tools.length, images: images.length },
        cursor: to < total ? String(to) : null,
        hasEarlier: to < total,
      };
    },
    /**
     * §7：模型目录查询。
     *
     * 这里**必须绕开缓存**：这个接口就是「刷新模型」按钮打的那一个。
     * 用户刚在宿主里配好一个新提供方，点刷新却看不到 —— 因为旧实现复用了
     * 30 秒 TTL 的 loadCatalog，按钮被缓存吃掉，用户以为刷新坏了。
     * 刷新是显式意图，代价限于用户亲手点的那一下，可以接受。
     */
    listModels: async (signal?: AbortSignal) => {
      const fresh = await discoverCatalog(ctx?.llm, signal);
      catalogCache = { at: Date.now(), value: fresh };
      return { groups: fresh.groups, failures: fresh.failures };
    },
    /**
     * 解析小助手该用哪个模型。
     *
     * §7 / §11.8：未选择模型时必须让用户去选，绝不偷偷调用默认模型。
     * 因此未选择时直接抛错，由路由把中文原因返回给界面，
     * 而不是返回一个占位 provider 让请求悄悄跑起来。
     */
    resolveModel: async (id: string, signal?: AbortSignal) => {
      const state: any = store ? (await store.load(id)).state : undefined;
      const catalog = await loadCatalog(signal);
      const resolved = resolveSelection(state?.explicitModel, catalog);
      if (resolved.kind === 'explicit') {
        const selection: any = { provider: resolved.provider, model: resolved.model };
        if (resolved.reasoningEffort) selection.reasoningEffort = resolved.reasoningEffort;
        return { selection };
      }
      throw new ExplainAssistantError(resolved.kind === 'required' ? 'MODEL_UNAVAILABLE' : 'MODEL_NOT_FOUND', resolved.message);
    },
    /**
     * 记住浮窗的摆放位置与大小。
     *
     * 为什么需要：`AssistantState.geometry` 字段与磁盘形状一直都在，但**没有任何写入方** ——
     * 用户拖好位置、关掉浮窗再打开就又回到默认位置。这里补上写入路径。
     *
     * 与其它写入同样过 `isForgotten` 把关：已归档清理过的会话，其文件已被删除，
     * 而 store.update 对不存在的文件会走 load→save **把文件重新创建出来**。
     */
    saveGeometry: async (id: string, geometry: unknown) => {
      if (!store) return geometry;
      const value = geometry as { x?: unknown; y?: unknown; width?: unknown; height?: number };
      // 再校验一次（路由已校验，服务层不信任调用方）：四个有限数才写。
      const keys: Array<'x' | 'y' | 'width' | 'height'> = ['x', 'y', 'width', 'height'];
      const valid = Boolean(value) && typeof value === 'object'
        && keys.every(key => typeof (value as Record<string, unknown>)[key] === 'number' && Number.isFinite((value as Record<string, unknown>)[key] as number));
      if (!valid) return geometry;
      if (await isForgotten(id)) return geometry;
      await store.update(id, (state: any) => { state.geometry = { x: value.x, y: value.y, width: value.width, height: value.height }; });
      return value;
    },
    selectModel: async (id: string, model: unknown, signal?: AbortSignal) => {
      const selection = toModelSelection(model);
      const catalog = await loadCatalog(signal).catch(() => undefined);
      // 只有拿到目录时才校验成员资格；目录本身不可用时不应把用户的选择挡在门外。
      if (catalog && catalog.groups.length && !catalogContains(catalog, selection.provider, selection.model)) {
        throw new ExplainAssistantError('MODEL_NOT_FOUND', '所选模型不在当前可用模型目录中：' + selection.provider + '/' + selection.model);
      }
      if (store && !(await isForgotten(id))) await store.update(id, (state: any) => { state.explicitModel = selection; });
      return selection;
    },
    /**
     * §7/§11.6：把本会话既往问答一并交给模型，追问才能接上前面的话。
     *
     * 旧实现每次都只发 system + user 两条，模型对上一轮一无所知，
     * 用户问「那它为什么这么做」时它只能反问「你指的是哪一步」——
     * 追问实际退化成每次重述背景。
     *
     * §9.1：压缩过之后，参考的是「摘要 + 压缩之后的新问答」，不是压缩前的原始问答。
     * §5.1：不能无节制把全部历史交给模型，所以只取最近若干轮（由 buildMessages 截断）。
     */
    buildMessages: async (id: string, question: string, payload: Record<string, unknown>, signal?: AbortSignal, mode: 'ask' | 'compact' = 'ask') => {
      const state: any = store ? (await store.load(id)).state : undefined;
      const compactCreatedAt: string | undefined = state?.compactState?.createdAt;
      const all: any[] = Array.isArray(state?.records) ? state.records : [];
      // 压缩之前的问答已被摘要取代；只有 ask 记录参与对话（compact 记录是操作日志）。
      const turns = all
        .filter(record => record && record.kind === 'ask')
        .filter(record => !compactCreatedAt || (typeof record.startedAt === 'string' && record.startedAt > compactCreatedAt))
        // §10/D1：把「为什么没完成」一起带进追问上下文（老记录没有该字段 → undefined，行为不变）。
        .map(record => ({ question: record.question, answer: record.answerText, ...(record.reason ? { reason: record.reason } : {}) }));
      // 既往助手消息必须带来源（provider/model），否则形状不合 dsh-llm 契约。
      const explicit = state?.explicitModel;
      /**
       * 0.2：主 agent 的上下文。
       *
       * **压缩模式下一律不注入**——这是用户明确要求的「小助手 /compact 只压小助手与用户对话
       * 产生的上下文，主 agent 转移进来的部分不应受影响」。
       *
       * 为什么靠「不注入」而不是「压缩后再回填」：ask 与 compact 共用本函数
       * （routes.ts 的同一行调用），所以这里是两条路径唯一的、也是最清楚的分叉点。
       * 注入之后由 compactAssistant 把整份 messages 送去摘要——**任何**在场的内容都会被摘要掉，
       * 事后回填既多一次拼接，又会出现「摘要里提到了它、回填的原文里也有它」的双版本。
       *
       * 这里**不用 loadState 的那个短时缓存**：提问要求「同步至最新」，
       * 必须读此刻的表面（readSurface 对活跃会话走内存快照，代价很小）。
       */
      const mainline = mode === 'compact'
        ? undefined
        : await readMainlineContext({ sessionQuery, sessionId: id, signal });
      return buildMessages(question, payload, {
        history: turns,
        compactSummary: state?.compactState?.summary,
        ...(mainline ? { mainline: { text: mainline.text } } : {}),
        ...(explicit?.provider && explicit?.model ? { assistantSource: { provider: explicit.provider, model: explicit.model } } : {}),
      });
    },
    /**
     * 只读工具的运行上下文（§6.1「哪里可以调整」、§7 工作区只读、§11.6 依据可核查）。
     *
     * 旧实现把 workspace 恒设为 undefined、且完全不传 imageSnapshotRoot / modelContext，
     * 于是 7 个只读工具里有 5 个在真实运行时**必然**失败：
     * 三个工作区工具撞 FILESYSTEM_UNAVAILABLE、读图撞 IMAGE_UNAVAILABLE、
     * explain_get_model_context 拿不到模型上下文。工具存在但永远跑不通，等于没有。
     *
     * 这里从主会话的 header.cwd 取工作区根（会话创建时的绝对路径，宿主已校验），
     * 图片快照根用插件自己的持久化目录（与 evidence.saveWorkspaceImageSnapshot 约定一致）。
     */
    toolContext: async (id: string, signal?: AbortSignal) => {
      const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined;
      const session = typeof sessions?.get === 'function' ? sessions.get(id) : undefined;
      const workspace = typeof session?.header?.cwd === 'string' && session.header.cwd ? session.header.cwd : undefined;
      const state: any = store ? (await store.load(id)).state : undefined;
      const model = state?.explicitModel;
      let modelContext: unknown;
      if (model?.provider && model?.model && typeof ctx?.llm?.resolveModelInfo === 'function') {
        modelContext = await ctx.llm.resolveModelInfo(model.provider, model.model).catch(() => undefined);
      }
      return {
        sessionId: id,
        sessionQuery,
        signal,
        ...(workspace ? { workspace } : {}),
        ...(home ? { imageSnapshotRoot: home + '/explain-assistant' } : {}),
        ...(modelContext === undefined ? {} : { modelContext }),
        attachmentStore: ctx?.attachments,
      };
    },
    isSessionAllowed: async (id: string) => Boolean(id),
    // 已归档 = 内存墓碑 或 磁盘标记。墓碑必须算进来：文件被删掉之后 store.load 会返回
    // 一份全新空状态（archived=false），只看磁盘的话读侧会以为这个会话「没归档过」，
    // 于是晚到的 ask/compact 又会跑起来并把文件重新写出来。
    isArchived: async (id: string) => forgotten.has(id) || Boolean(store && (await store.load(id)).state.archived),
    /**
     * §4「关闭浮窗不删除问答」/ §8 记录生命周期：主对话被归档时，
     * 小助手为它保存的问答与图片快照也应随之清理，而不是永远留在磁盘上。
     */
    forget: async (id: string) => {
      if (!store) return { removed: false };
      // 顺序很重要，不能反：
      // 1) 先**标记** archived 并清空内容 —— 这样即使删除失败，读侧（isArchived）也已拒绝，
      //    且磁盘上不留用户内容；规范 §8 要的就是「标记 → 短暂等待 → 删除」。
      await store.update(id, (state: any) => { state.archived = true; state.records = []; state.compactState = undefined; state.unread = false; });
      // 2) 立刻立墓碑，挡住「删除之后晚到的写入」把文件重建出来（store.load 对已删文件
      //    会返回全新空状态、archived=false，光靠磁盘标记挡不住）。
      forgotten.add(id);
      // 3) 再删除插件 JSON 与图片快照目录。失败会进 retryPendingDeletes 的重试队列
      //    （见 persistence.remove 的 catch），并在这里被吞掉——归档通知不能因为一次删除失败就失败。
      let removed = false;
      let failure: string | undefined;
      try {
        await store.remove(id);
        removed = true;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        console.error('[dsh-explain-assistant] 归档清理删除失败（' + id + '），已进入重试队列：', failure);
      }
      const result = await cleanupArchived('归档清理 ' + id).catch(() => ({ attempted: 0, failed: 0 }));
      return { removed: true, deleted: removed, ...(failure ? { deleteFailed: failure } : {}), retry: result };
    },
    llm: ctx?.llm,
    tokenMeter: ctx?.tokenMeter,
    // §4/§8 F6「拒绝新的历史写入」：已被归档清理的会话不得再落库，
    // 否则 store.load 对已删文件返回的空状态会被 save 写成新文件，归档白做。
    saveRecord: async (id: string, record: unknown) => {
      if (!store) return;
      if (await isForgotten(id)) return;
      const current = (await store.load(id)).state;
      if (current.archived) return;                 // 双保险：磁盘上标记了归档也拒绝
      current.records.push(record as any); current.historyRevision++; current.updatedAt = new Date().toISOString(); await store.save(current);
    },
    /** §9.1：压缩结果落库；只在压缩成功时调用，失败时保留此前可用的状态。 */
    saveCompact: async (id: string, compact: { summary: string; reasoning: string; sourceRecordIds: string[]; model?: unknown }) => {
      if (!store) return;
      if (await isForgotten(id)) return;             // §4/§8：已归档会话拒绝新的 compact 写入
      await store.update(id, (state: any) => {
        state.compactState = {
          version: 1,
          summary: compact.summary,
          sourceRecordIds: Array.isArray(compact.sourceRecordIds) ? compact.sourceRecordIds : [],
          createdAt: new Date().toISOString(),
          ...(compact.model ? { model: compact.model } : {}),
        };
      });
    },
    markUnread: async (id: string) => { if (store && !(await isForgotten(id))) await store.update(id, (state: any) => { state.unread = true; }); },
    /**
     * §10：标记已读（打开浮窗后清除未读）。
     *
     * **必须走 isForgotten 把关**：已归档清理过的会话，其文件已被删除，
     * 而 store.update 对不存在的文件会走 load→save **把文件重新创建出来**——
     * 那等于把刚清理掉的东西又建回来。所以已归档的一律不写。
     */
    markRead: async (id: string) => { if (store && !(await isForgotten(id))) await store.update(id, (state: any) => { state.unread = false; }); },
  };
  const routes = createExplainAssistantRoutes({ service, active } as any);
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  ctx.effect?.(() => async () => { lifetime.abort(); archiveSweeper?.stop(); await Promise.allSettled([...pending]); await store?.close(); });
  const entries = [
    ['/api/explain-assistant/state', ['GET']], ['/api/explain-assistant/history', ['GET']], ['/api/explain-assistant/history-result', ['GET']],
    ['/api/explain-assistant/models', ['GET']], ['/api/explain-assistant/select-model', ['POST']],
    ['/api/explain-assistant/ask', ['POST']], ['/api/explain-assistant/compact', ['POST']],
    ['/api/explain-assistant/in-flight', ['DELETE']],
    // §4/§8 F6：客户端收到归档信号后调它清理该会话。注意键必须带 /api 前缀
    // （apply 注册用的是这个键；而 createExplainAssistantRoutes 返回的 Map 键不带，两套都出现在代码里）。
    ['/api/explain-assistant/forget', ['POST']],
    ['/api/explain-assistant/mark-read', ['POST']],
    // 记住浮窗位置。与 mark-read 一样是「收尾动作」，但仍走 guard：已归档会话不该再写状态。
    ['/api/explain-assistant/geometry', ['POST']],
  ] as const;
  for (const [path, methods] of entries) connection.fetch.register({
    path, methods: [...methods] as any,
    requestBody: path.endsWith('/ask') || path.endsWith('/compact') ? 'streaming' : 'buffered',
    fetch: (request: Request) => {
      const task = routes.get(path.replace('/api', ''))?.(new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) })) ?? Promise.resolve(new Response('Not found', { status: 404 }));
      // 路由处理器永远不能向宿主抛出拒绝：DSH 启动器把未处理的 Promise 拒绝视为致命错误并 exit(1)，
      // 整站会随之白屏。这里既消除 pending 跟踪派生的未处理拒绝，也把异常转成普通错误响应。
      const settled = task.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[dsh-explain-assistant] route failed:', path, message);
        return new Response(JSON.stringify({ error: { code: 'INTERNAL', message } }), {
          status: 500, headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      });
      pending.add(settled);
      void settled.finally(() => pending.delete(settled)).catch(() => undefined);
      return settled;
    },
  });
}
export const name = "dsh-explain-assistant";
