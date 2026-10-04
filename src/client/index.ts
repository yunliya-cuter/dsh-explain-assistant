import { assistantRegistry, type EvidenceItem, type AssistantClientState, type HistoryDetailState } from './store.js';
import type { AssistantApi, AskEvent } from './api.js';
import { createAssistantApi } from './api.js';

export type ClientPluginOptions = {
  api?: AssistantApi;
  session?: { id: string; cwd?: string } | (() => { id: string; cwd?: string } | undefined);
};

type RequestKind = 'ask' | 'compact';
type ActiveRequest = {
  token: symbol;
  controller: AbortController;
  sessionId: string;
  question: string;
  kind: RequestKind;
  startedAt: string;
  requestId?: string;
  recorded: boolean;
};

const EVENT_TYPES = new Set(['start', 'progress', 'reasoning', 'text', 'tool_start', 'tool_result', 'usage', 'complete', 'error', 'aborted']);
/**
 * 判定一个失败的请求该显示成「已停止」还是「出错」。
 *
 * 三种「停」要分清（§10）：
 * - 用户点停止 / 关窗 → 我们自己的 signal 被 abort；
 * - 宿主发 aborted 事件 → 提供方那边中断，不是我们的错，算「已停止」；
 * - 其他 → 真正的错误。
 * 旧实现只看 signal，于是宿主发来的 aborted 事件被当成 error，界面显示「出错」。
 */
function isAbortLike(error: unknown, signal: AbortSignal | undefined, terminal: string | undefined): boolean {
  if (signal?.aborted) return true;
  if ((error as { name?: string })?.name === 'AbortError') return true;
  if (terminal === 'aborted') return true;
  return (error as { code?: string })?.code === 'ABORTED';
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function eventParts(event: AskEvent): { sessionId?: string; requestId?: string; payload: Record<string, unknown> } | undefined {
  if (!event || typeof event.type !== 'string' || !EVENT_TYPES.has(event.type) || !isObject(event.data)) return undefined;
  const root = event.data;
  const payload = isObject(root.payload) ? root.payload : root;
  return {
    sessionId: typeof root.sessionId === 'string' ? root.sessionId : undefined,
    requestId: typeof root.requestId === 'string' ? root.requestId : undefined,
    payload,
  };
}
function newRecordId(requestId?: string): string { return requestId || ('helper-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)); }
function phaseBusy(state: AssistantClientState): boolean { return state.phase === 'connecting' || state.phase === 'running'; }

export function createClientPlugin(options: ClientPluginOptions = {}) {
  const api = options.api || createAssistantApi();
  const active = new Map<string, ActiveRequest>();
  let disposed = false;
  let selectedSession: { id: string; cwd?: string } | undefined;

  const session = () => selectedSession || (typeof options.session === 'function' ? options.session() : options.session);
  const isCurrent = (request: ActiveRequest) => !disposed && active.get(request.sessionId)?.token === request.token;

  /** 每个会话最近一次收到的终止性事件类型（用于区分「已停止」与「出错」）。 */
  const terminalEvent = new Map<string, string>();

  const appendRecord = (request: ActiveRequest, status: 'complete' | 'interrupted', state: AssistantClientState, answer?: string) => {
    if (request.recorded || request.kind !== 'ask') return;
    request.recorded = true;
    const now = new Date().toISOString();
    assistantRegistry.update(request.sessionId, current => {
      const recordId = newRecordId(request.requestId);
      if (current.records.some(record => record.id === recordId)) return;
      current.records = [...current.records, {
        id: recordId,
        question: request.question,
        answer: answer ?? current.text,
        reasoning: current.reasoning,
        status,
        createdAt: request.startedAt,
        completedAt: status === 'complete' ? now : undefined,
        tools: current.tools,
        incomplete: status !== 'complete',
      }];
    });
  };

  const applyEvent = (request: ActiveRequest, event: AskEvent) => {
    const parts = eventParts(event);
    if (!parts || !isCurrent(request)) return;
    if (parts.sessionId && parts.sessionId !== request.sessionId) return;
    const state = assistantRegistry.get(request.sessionId);
    if (parts.requestId && state.requestId && parts.requestId !== state.requestId) return;
    const data = parts.payload;
    if (event.type === 'start') {
      const requestId = parts.requestId || (typeof data.requestId === 'string' ? data.requestId : undefined);
      request.requestId = requestId;
      assistantRegistry.update(request.sessionId, { phase: 'running', requestId });
      return;
    }
    if (event.type === 'reasoning') {
      assistantRegistry.update(request.sessionId, current => { current.phase = 'running'; if (typeof data.delta === 'string') current.reasoning += data.delta; });
      return;
    }
    if (event.type === 'text') {
      assistantRegistry.update(request.sessionId, current => { current.phase = 'running'; if (typeof data.delta === 'string') current.text += data.delta; });
      return;
    }
    if (event.type === 'tool_start') {
      const name = String(data.tool || data.name || 'tool');
      assistantRegistry.update(request.sessionId, current => {
        const id = String(data.toolCallId || data.id || name + '-' + current.tools.length);
        current.tools = [...current.tools, { id, name, label: typeof data.label === 'string' ? data.label : undefined, status: 'running' }];
      });
      return;
    }
    if (event.type === 'tool_result') {
      assistantRegistry.update(request.sessionId, current => {
        const id = typeof data.toolCallId === 'string' || typeof data.id === 'string' ? String(data.toolCallId || data.id) : undefined;
        let index = id ? current.tools.findIndex(tool => tool.id === id) : -1;
        if (index < 0 && typeof data.tool === 'string') index = current.tools.map(tool => tool.name).lastIndexOf(data.tool);
        if (index < 0) index = current.tools.findIndex(tool => tool.status === 'running');
        // 工具失败必须显示成失败。宿主把失败结果放在 result 里（{ok:false, code, message}），
        // 外层 payload 上并没有 ok 字段；旧代码只读 data.ok，于是**所有失败的只读工具都被标成「完成」**，
        // 用户以为读到了东西，其实什么都没读到（§6.3「不得把没发生的事说成发生了」）。
        const failed = data.ok === false || (isObject(data.result) && (data.result as Record<string, unknown>).ok === false);
        const detail = typeof data.message === 'string'
          ? data.message
          : isObject(data.result) && typeof (data.result as Record<string, unknown>).message === 'string'
            ? String((data.result as Record<string, unknown>).message)
            : undefined;
        if (index >= 0) current.tools = current.tools.map((tool, toolIndex) => toolIndex === index ? { ...tool, status: failed ? 'error' : 'ok', result: data.result, detail } : tool);
      });
      return;
    }
    if (event.type === 'usage') {
      // §9.2：占用必须由小助手自己的口径算（见 host/occupancy.ts），**不能**从用量事件里猜。
      // 真实 usage 事件是 dsh-llm 的 TokenUsage（inputTokens/outputTokens/totalTokens/…），
      // 根本没有 percent 字段，所以旧写法恒把 occupancyKnown 置 false ——
      // 后果是用户一提问，圆环就从「4% 估算」退化成「占用未知」，且再也回不来。
      // 这里改为：只在事件确实带 percent 时才更新，否则保持既有占用不变；
      // 问答结束后统一走 refreshState() 重新向宿主取一次准确值。
      const percent = typeof data.percent === 'number' ? data.percent : isObject(data.usage) && typeof data.usage.percent === 'number' ? data.usage.percent : undefined;
      if (percent !== undefined) assistantRegistry.update(request.sessionId, { occupancy: percent, occupancyKnown: true });
      return;
    }
    if (event.type === 'complete') {
      const answer = typeof data.text === 'string' ? data.text : undefined;
      // §9.1/F9：压缩的产物是 summary 而不是 text。此前无论成功失败都不写任何 UI 状态，
      // 用户按了 /compact 界面毫无变化，等于功能不存在。这里把摘要落到 compactState，
      // 浮窗据此显示「已压缩」与摘要正文。
      const summary = typeof data.summary === 'string' ? data.summary : undefined;
      assistantRegistry.update(request.sessionId, current => {
        if (request.kind === 'compact') {
          // §9.1「失败清楚提示，保留压缩前的可用状态」：
          // 这次没拿到摘要时**必须保留上一次成功的摘要正文**，不能整份替换掉——
          // 否则用户第一次压缩成功后，第二次失败会把那份仍可用的摘要从界面上抹掉。
          if (summary) current.compactState = { ...current.compactState, summary, status: 'complete', updatedAt: new Date().toISOString() };
          else current.compactState = { ...current.compactState, status: 'error', error: '模型没有返回可用的摘要内容。' };
        } else {
          if (answer && !current.text) current.text = answer;
        }
        current.phase = 'complete'; current.requestId = undefined; current.unread = true;
      });
      appendRecord(request, 'complete', assistantRegistry.get(request.sessionId), answer);
      // 请求结束后重新拉一次 state：
      // - compact：宿主已把 compactState 落库，界面要显示摘要；
      // - ask：上下文变长了，占用要按小助手自身口径重算（§9.2 最后一条）。
      void refreshState(request.sessionId);
      return;
    }
    if (event.type === 'aborted') {
      terminalEvent.set(request.sessionId, 'aborted');
      const message = typeof data.message === 'string' ? data.message : '请求已中断';
      assistantRegistry.update(request.sessionId, current => {
        current.phase = 'interrupted'; current.requestId = undefined; current.error = message; current.unread = true;
        // §9.1「失败清楚提示，保留压缩前的可用状态」：只改 status，保留上一份可用摘要正文。
        if (request.kind === 'compact') current.compactState = { ...current.compactState, status: 'interrupted', error: message };
      });
      appendRecord(request, 'interrupted', assistantRegistry.get(request.sessionId));
      return;
    }
    if (event.type === 'error') {
      terminalEvent.set(request.sessionId, 'error');
      const message = typeof data.message === 'string' ? data.message : '请求失败';
      assistantRegistry.update(request.sessionId, current => {
        current.phase = 'error'; current.requestId = undefined; current.error = message; current.unread = true;
        if (request.kind === 'compact') current.compactState = { ...current.compactState, status: 'error', error: message };
      });
      appendRecord(request, 'interrupted', assistantRegistry.get(request.sessionId));
    }
  };

  /**
   * 从宿主拉一次状态并回写。首次打开与压缩成功后都要用，故抽成一个函数。
   *
   * §7/§11.8：宿主把模型目录随 state 一起下发（payload.catalog）。此前这里只取了
   * records/model/occupancy，catalog 被丢弃，导致浮窗首次打开必是「暂时没有可用的模型」空态，
   * 必须手点「刷新模型」才出现列表。
   * §9.1/F1：compactState 同样随 state 下发，压缩后的摘要与「已压缩」状态靠它显示。
   */
  /**
   * 安全地调用 api 上的方法：把调用**推迟到微任务**里再执行。
   *
   * 为什么必须有这个包装（这是 Lead 抓到的真实回归的根因）：
   * `api.x(...).catch(...)` 里的 `.catch()` 只能接住「方法返回 Promise 之后」的失败，
   * **接不住「方法压根不存在」这种同步抛出**（TypeError: api.x is not a function）。
   * 在「宿主版本旧 / 调用方传了精简的 api 替身」这种边界上，那一行会**同步炸掉调用方**——
   * 表现为浮窗打不开、按钮渲染崩、dispose 清理中断。
   *
   * 放进微任务后，TypeError 与网络错误走同一条路落进 `.catch()`，按各自承诺的方式降级。
   * 这也让这些函数**真正守住自己的返回类型**（不会同步抛，只会返回被拒绝的 Promise）。
   */
  const callApi = <T>(invoke: () => Promise<T>): Promise<T> => {
    try {
      // **同步调用**（保持原有调用时机不变），但用 try 包住：
      // 方法不存在时抛的是同步 TypeError，catch 住并转成「被拒绝的 Promise」，
      // 于是它和网络错误走同一条降级路径。
      //
      // 为什么不用 Promise.resolve().then(invoke)（我第一版写法）：
      // 那会把调用推迟一个微任务，改变既有调用时机 —— 实测让
      // 「同一会话两次提交、取 requests[0]」的既有测试失效（它假定 ask 被同步发出）。
      // 同步调用 + try 能同时满足两件事：**不改变时机**、**不炸调用方**。
      return Promise.resolve(invoke());
    } catch (error) {
      return Promise.reject(error);
    }
  };

  /**
   * §5.1/§8：本会话中「确认来自宿主」的记录 id 集合。
   *
   * 为什么需要它：刷新时宿主恒按「首屏=最近一页」下发 hasEarlier/historyCursor，
   * 只要总数 > 一页就永远说「还有更早」。而客户端可能**早已翻到底**、手里握着全部记录。
   * 若照抄宿主这两个字段，一次刷新就把「已到底」覆盖回「还能翻」（**打开浮窗本身就会触发刷新**），
   * 游标也指回加载过的那一页 → 再点一次整段重复渲染（界面 24→28→32，磁盘始终 24）。
   *
   * 所以改由客户端自己算：「我手上来自宿主的记录数」与「宿主总条数」比较。
   * 用 id 集合而不是直接数本地条数，是因为本地可能有**刚追加、宿主还没有**的记录
   * （回答完成时先本地 append，随后才落库）——直接把本地条数当「已加载」，会把这批算进去而少算更早的。
   */
  /**
   * §10：各会话「最后一次打开浮窗」的**单调序号**。
   * 用于丢弃「打开之前发起、打开之后才回来」的过期预取响应。
   *
   * 为什么用序号而不是 Date.now()：预取与打开常常在**同一毫秒内**连续发生，
   * 时间戳会相等，`>` 判定失效（我第一版就是时间戳，测试直接抓到不生效）。
   */
  let everOpenedSeq = 0;
  const lastOpenedSeq = new Map<string, number>();

  const hostKnownIds = new Map<string, Set<string>>();
  const hostIdsFor = (sessionId: string): Set<string> => {
    let set = hostKnownIds.get(sessionId);
    if (!set) { set = new Set<string>(); hostKnownIds.set(sessionId, set); }
    return set;
  };
  /** 从宿主下发的 payload 里读「总条数」（旧版本可能没有 → undefined，调用方退回旧行为）。 */
  const totalRecordsFor = (payload: Record<string, unknown>): number | undefined => {
    const value = payload.totalRecords;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };

  /** 客户端当前持有、且确认来自宿主的记录条数。 */
  const hostLoadedCount = (sessionId: string, records: readonly any[]): number => {
    const known = hostKnownIds.get(sessionId);
    if (!known || known.size === 0) return 0;
    return records.filter(record => known.has(record?.id)).length;
  };

  const refreshState = (sessionId: string, options?: { keepCleared?: boolean }): Promise<void> => {
    return callApi(() => api.state(sessionId)).then(result => {
      if (disposed) return;
      const payload = isObject(result.payload) ? result.payload : {};
      const current = assistantRegistry.get(sessionId);
      const catalog = isObject(payload.catalog) ? payload.catalog : undefined;
      const compactState = isObject(payload.compactState) ? payload.compactState as Record<string, unknown> : undefined;
      // §8「关闭再打开能查看」/ §5.1 分页：
      // 这里**不能**直接用首屏那一页替换本地记录。用户可能已经点过「查看更早历史」，
      // 本地持有的是一条连续的窗口（更早的 + 最新的）；用首屏替换会把中间整段挖掉，
      // 之后再点「查看更早历史」补的是更前面那一页，中间那一段永远看不到。
      // 正确做法：保留本地已有、而这一页没有的更早记录，再接上这一页。
      const incoming: any[] = Array.isArray(payload.records) ? payload.records as never[] : [];
      const incomingIds = new Set(incoming.map((record: any) => record?.id));
      const keptEarlier = current.records.filter((record: any) => !incomingIds.has(record?.id));
      // 这一页来自宿主 → 记入「宿主已知」集合（翻到底的判定就靠它）。
      const known = hostIdsFor(sessionId);
      for (const record of incoming) { if (record?.id) known.add(record.id); }
      const mergedRecords = active.has(sessionId) ? current.records : (incoming.length ? [...keptEarlier, ...incoming] : current.records);
      // §5.1/§8：**不照抄**宿主的 hasEarlier/historyCursor，改用「我手上来自宿主的条数 vs 宿主总条数」自己算。
      // 宿主的这两个字段恒按「首屏=最近一页」给（只要总数>一页就永远说「还有更早」），
      // 照抄会让一次刷新（打开浮窗就会触发）把「已翻到底」覆盖回「还能翻」→ 重复渲染。
      const totalRecords = totalRecordsFor(payload);
      const loadedFromHost = hostLoadedCount(sessionId, mergedRecords as readonly any[]);
      // 宿主的 cursor 语义就是「还有多少条更早的记录」（见 index.ts loadHistory：remaining → from）。
      // 所以**自己算**这个剩余量 = 总数 − 我手上来自宿主的条数。
      //
      // 为什么不能直接用宿主下发的 historyCursor：它恒按首屏算（总数−20），
      // 我已经翻了两页时它还是「总数−20」→ 会把已经加载过的那一页再拉一遍。自己算才自洽。
      const remaining = totalRecords === undefined ? undefined : Math.max(0, totalRecords - loadedFromHost);
      const stillHasEarlier = remaining === undefined
        ? Boolean(payload.hasEarlier)                 // 宿主没给总数（旧版本）→ 退回原行为
        : remaining > 0;
      const nextCursor = remaining === undefined
        ? (typeof payload.historyCursor === 'string' ? payload.historyCursor : undefined)
        : (remaining > 0 ? String(remaining) : undefined);
      assistantRegistry.update(sessionId, {
        records: mergedRecords as never[],
        hasEarlier: stillHasEarlier,
        historyCursor: nextCursor,
        // ── 「宿主响应不得覆盖更新的本地状态」同类排查（本次）────────────────
        // 下面两个字段原先都是**无条件覆盖**，实测有两种「倒退」：
        //
        // §7 model：宿主没下发 model 时（例如用户刚点选、宿主还没落库；或这次读取拿不到），
        //   旧写法把 model 写成 undefined —— 用户刚选的模型**从界面上消失**，看起来像没选上。
        //   修法：只在宿主**确实给了** model 时采纳。宿主没有 ≠ 用户没选。
        //   （将来若要支持「清除已选模型」，必须做成显式动作，不能靠「字段缺失」表达。）
        ...(payload.model ? { model: payload.model as never } : {}),
        //
        // §9.2 占用：回答**进行中**时，本地从 usage 事件学到的占用比宿主那份
        //   （基于落库记录的估算）**更新**。旧写法无条件覆盖 → 刷新一次就把已知占用改回「未知」，
        //   界面圆环在回答过程中熄灭。修法：与 records 同一套守卫 —— 有活动请求时保留本地。
        ...(active.has(sessionId)
          ? {}
          : {
            occupancy: typeof payload.occupancy === 'number' ? payload.occupancy : undefined,
            occupancyKnown: typeof payload.occupancy === 'number',
            occupancyEstimated: payload.occupancyEstimated === true,
          }),
        ...(catalog ? { catalog: catalog as never } : {}),
        // 只在宿主确实给了摘要时覆盖本地状态：正在压缩时不能用旧的落库值盖掉「压缩中」。
        //
        // 宿主的 compactState 是**落库结构**，没有 status 字段（§9.1：只有压缩成功才落库）。
        // 早前这里整份覆盖，导致 status 变 undefined，浮窗把「压缩成功」渲染成「压缩已中断」——
        // 摘要正文明明就在下面。所以这里补回语义：有 summary 即 complete。
        // C2（§9.1「失败清楚提示」）：本次压缩刚失败/中断时，宿主的落库值仍是**上一次成功**的摘要。
        // 若无条件合并，界面会把这次的失败盖成「已压缩」——用户以为成功了，其实没有。
        // 因此：running / error / interrupted 三种进行中或失败态一律保留本地状态，只由新的成功结果改写。
        // §9.1/S1：初次打开（本地还是 idle）或本地已是 complete 时，采用宿主下发的摘要。
        //
        // 旧条件写的是「本地有 status 且不是 complete 才保留本地」，而 store.ts 的初始值恒为
        // { status: 'idle' } —— idle 不是 complete，于是**宿主明明下发了摘要，刷新页面后却被丢成 idle**，
        // 界面回到「没有压缩过」。这正是「压缩结果看不见」在刷新路径上的翻版。
        // 只有本地处于 running / error / interrupted（本次刚发生的状态）才保留本地。
        ...(compactState ? {
          compactState: current.compactState && (current.compactState.status === 'running' || current.compactState.status === 'error' || current.compactState.status === 'interrupted')
            ? current.compactState
            : { ...compactState, status: typeof compactState.summary === 'string' && compactState.summary ? 'complete' : 'error' } as never,
        } : {}),
        // §10/S4：未读是宿主侧的真相（markUnread 落库），刷新后必须恢复，否则徽标消失。
        //
        // 但 §10「打开浮窗后清除」优先：紧随「打开」的那一次刷新**不得**把宿主仍是 true 的值写回来
        // （宿主标记已读可能失败，那时本地清除仍应生效，否则徽标清除后立刻又亮 = 闪烁）。
        // 用**单次标志**而不是持久集合：抑制只针对这次打开引发的刷新，
        // 之后的刷新（例如回答完成后）恢复「宿主为准」，不会把未读永久压住。
        ...(typeof payload.unread === 'boolean' && !(options?.keepCleared === true && payload.unread === true)
          ? { unread: payload.unread }
          : {}),
      });
    }).catch(error => {
      if (!disposed) assistantRegistry.update(sessionId, { error: errorMessage(error), phase: 'error' });
    });
  };

  /**
   * §4/§10 冷启动未读预取。
   *
   * 缺陷（verify-3082 在 3082 上实测）：硬刷新后的冷页面上，入口按钮一直显示「?」，
   * 即使宿主 /state 返回 unread=true；**必须先点开一次浮窗**才变成「? ·」。
   * 根因：unread 只在 refreshState()（/state 回来之后）才写进 registry，而 refreshState
   * 只在 open() / 回答完成后调用。冷页面首次渲染时 registry 里该会话还是初始 unread=false，
   * 按钮读到的就是 false，于是不提示「有新内容」——用户刷新后看不到提示。
   *
   * 设计取舍：
   * - **按会话去重**：同一个会话无论多少个组件来问，只打一次接口（in-flight 复用同一 Promise），
   *   避免 N 个按钮 N 次请求；
   * - **只合并 unread 这一个字段**，不整份 refreshState：冷启动只需要那个布尔值，
   *   整份合并会把 phase/records 一起改掉，风险更大；
   * - **失败静默降级成「?」**：不抛、不写 error 态、不阻塞渲染；
   * - 成功/失败都记住结果，失败后不再自动重试（避免抖动时反复打接口）。
   */
  const primedUnread = new Map<string, Promise<void>>();
  const primeUnread = (sessionId: string): Promise<void> => {
    if (disposed || !sessionId) return Promise.resolve();
    const existing = primedUnread.get(sessionId);
    if (existing) return existing;                       // 去重：同一会话只拉一次
    // 记下发起预取的时刻：响应回来时若「用户已经打开过浮窗」，这份未读就是过期的，不能写回。
    // （实测竞态：冷启动预取挂起中，用户立刻打开浮窗 → 本地已清除未读；
    //   预取响应随后才到，旧写法把 unread:true 写回来，徽标**清除后又自己亮起**。）
    const issuedSeq = everOpenedSeq;
    const task = callApi(() => api.state(sessionId)).then(result => {
      if (disposed) return;
      const payload = isObject(result.payload) ? result.payload : {};
      // 拿不到就保持现状（按钮显示「?」）
      if (typeof payload.unread !== 'boolean') return;
      // **只在宿主说「未读」时才需要这道过期判定**：
      // 若预取发起之后用户打开过浮窗（= 他已看过内容），这份 true 就是过期的，丢弃。
      // 宿主说 false 时照常采纳（不会把未读错误地点亮，也没有「过期」问题）。
      //
      // 刻意**不**用「只要打开过就一律丢弃」那种更宽的规则：那会误伤正常时序 ——
      // 打开过 → 关掉 → 来了新回答（未读）→ 冷启动预取读到 true，这是**合法**的未读，
      // 不该被压掉。只有「true 且晚于某次打开」才是真过期。
      if (payload.unread === true && (lastOpenedSeq.get(sessionId) ?? 0) > issuedSeq) return;
      assistantRegistry.update(sessionId, { unread: payload.unread });
    }).catch(() => {
      // 拿不到就降级显示「?」——不抛、不阻塞、不留下错误态
    });
    primedUnread.set(sessionId, task);
    return task;
  };

  /**
   * §10：打开浮窗后清除未读。
   *
   * 原缺陷（verify-3082 页面实测，0.1.38）：打开浮窗后徽标仍是「? ·」。
   * 机制：`registry.open()` 本地确实置了 `unread:false`，**但紧接着 refreshState()**
   * 又把宿主返回的 `unread:true` 写了回来；而宿主侧只有 markUnread、**没有标记已读的接口**，
   * 所以它永远返回 true —— 清除后立刻又亮。而且即使本地清掉了，刷新页面还会变回 true。
   *
   * 所以清除必须**落到宿主**。顺序上不能「先刷新、后标记」，否则刷新的响应可能先于标记到达，
   * 又把 true 写回来（闪烁）。这里采用**串行链**：先让宿主标记已读，等它结束（无论成败）
   * 再刷新，这样刷新读到的一定是清除后的值。
   *
   * 失败不得影响打开浮窗：整条链 fire-and-forget，本地清除照旧（registry.open 已经做了）。
   */
  const clearUnreadOnHost = (sessionId: string): Promise<void> => {
    // mark-read 与刷新**并行**，互不等待。这里有两个必须并行的理由：
    //
    // 1. **挂起会阻断刷新**（真实缺陷）：早前写成「先 markRead、等它结束、再 refreshState」的串行链，
    //    若 markRead 因网络停滞**永不返回**，refreshState 就永远不执行 —— 界面停在旧状态
    //    （摘要、历史都不更新）。串行等待让一个「锦上添花」的请求有了阻断核心刷新的能力。
    // 2. **多一次往返的延迟**：串行让刷新平白多等一次网络往返，使摘要等状态晚一拍出现。
    //
    // 并行不会引入「闪烁」：紧随的这次刷新带 keepCleared 标志，不会把宿主仍是 true 的未读写回来。
    // 无论 markRead 先到还是后到，结果都一致 —— 顺序正确性由那个标志保证，不靠串行。
    //
    // 调用**必须过 callApi**（同步调用 + try 兜同步抛出 → 转成被拒绝的 Promise）：
    // 本函数承诺「宿主不可用/不支持/超时 → 仅本地清除」。若裸写 `api.markRead(...)`，
    // 遇到没有该方法的 api（旧宿主 / 精简替身），TypeError 会**同步抛出 open()** ——
    // 浮窗整个打不开。这与「锦上添花」的定位不符，也与本函数自己的承诺矛盾。
    // 历史证据：该写法曾让全量 371 条里 **7 条红**（那些替身没有 markRead）；
    // 证伪实验：改回裸调用 → 7 条红，还原 → 全绿。回归闸见 `tests/api-hardening.test.mjs`。
    void callApi(() => api.markRead(sessionId)).catch(error => {
      // 未处理的 Promise 拒绝会被 DSH 启动器视为致命错误并 exit(1)，整站白屏。
      console.error('[dsh-explain-assistant] 清除未读失败（' + sessionId + '）：', errorMessage(error));
    });
    // 这次刷新是「打开浮窗」引发的：不得把宿主仍是 true 的未读写回来（否则闪烁）。
    return refreshState(sessionId, { keepCleared: true }).catch(() => undefined);
  };

  const open = () => {
    if (disposed) return;
    const current = session();
    if (!current) return;
    const sessionId = current.id;
    lastOpenedSeq.set(sessionId, ++everOpenedSeq);       // 记下打开序号：丢弃此前发起的过期预取响应
    assistantRegistry.open(sessionId, current.cwd);      // 本地立即清除未读（不等网络）
    void clearUnreadOnHost(sessionId);                   // 再把清除落到宿主，然后刷新
  };

  const run = (question: string, kind: RequestKind): Promise<void> => {
    if (disposed) return Promise.reject(new Error('解释小助手已关闭'));
    const current = session();
    if (!current) return Promise.reject(new Error('当前没有主对话'));
    const sessionId = current.id;
    if (active.has(sessionId) || phaseBusy(assistantRegistry.get(sessionId))) return Promise.reject(new Error('已有解释请求正在处理中'));

    const request: ActiveRequest = { token: Symbol('explain-request'), controller: new AbortController(), sessionId, question, kind, startedAt: new Date().toISOString(), recorded: false };
    active.set(sessionId, request);
    const state = assistantRegistry.get(sessionId, current.cwd);
    const evidence = state.evidence.slice();
    assistantRegistry.update(sessionId, { draft: '', phase: 'connecting', reasoning: '', text: '', tools: [], error: undefined, unread: false, ...(kind === 'compact' ? { compactState: { status: 'running' as const } } : {}) });
    const onEvent = (event: AskEvent) => applyEvent(request, event);
    // 同样必须包进微任务：若 api 上没有 ask/compact，同步抛出会让 active 永久留住这条请求，
    // 该会话此后一直「已有解析请求正在处理中」——相当于把会话锁死。包起来后走下面的 catch 正常收尾。
    const task = callApi(() => kind === 'compact'
      ? api.compact(sessionId, request.controller.signal, onEvent)
      : api.ask(sessionId, question, request.controller.signal, evidence, onEvent));
    return task.catch(error => {
      if (isCurrent(request)) {
        const lastTerminal = terminalEvent.get(sessionId);
        terminalEvent.delete(sessionId);
        const aborted = isAbortLike(error, request.controller.signal, lastTerminal);
        const message = aborted && !request.controller.signal.aborted ? errorMessage(error) : aborted ? '请求已中断' : errorMessage(error);
        assistantRegistry.update(sessionId, current => {
          current.phase = aborted ? 'interrupted' : 'error'; current.requestId = undefined; current.error = message; current.unread = true;
          if (request.kind === 'compact') current.compactState = { ...current.compactState, status: aborted ? 'interrupted' : 'error', error: message };
        });
        if (aborted) appendRecord(request, 'interrupted', assistantRegistry.get(sessionId));
      }
    }).finally(() => {
      if (active.get(sessionId)?.token === request.token) active.delete(sessionId);
    });
  };

  const submit = (question: string) => {
    const value = question.trim();
    if (!value) return Promise.resolve();
    return run(value, value === '/compact' ? 'compact' : 'ask');
  };
  const loadEarlier = async () => {
    if (disposed) return;
    const current = session();
    if (!current) return;
    const state = assistantRegistry.get(current.id, current.cwd);
    if (state.loadingEarlier) return;
    assistantRegistry.update(current.id, { loadingEarlier: true });
    try {
      // §5.1/§8：带上游标才能真的往上翻页；旧实现不带游标，每次都只能拿回同一批。
      const cursor = assistantRegistry.get(current.id).historyCursor;
      const result = await api.history(current.id, cursor);
      if (disposed) return;
      const payload = isObject(result.payload) ? result.payload : {};
      const older: any[] = Array.isArray(payload.records) ? payload.records as never[] : [];
      // 这一页来自宿主 → 记入「宿主已知」集合（翻到底的判定靠它）。
      const known = hostIdsFor(current.id);
      for (const record of older) { if (record?.id) known.add(record.id); }
      const existing = assistantRegistry.get(current.id).records as readonly any[];
      // §5.1/§8/B：**按 id 去重**再前置拼接。
      // 旧实现是 [...新页, ...已有]，同一批被取回两次就整段重复 —— 界面条目越翻越多，
      // 磁盘却没变（用户可见的「界面在说假话」）。去重是防御性的：任何原因重复取回都不得渲染重复条目。
      const existingIds = new Set(existing.map((record: any) => record?.id));
      const fresh = older.filter((record: any) => record?.id && !existingIds.has(record.id));
      const merged = [...fresh, ...existing];
      const loadedFromHost = hostLoadedCount(current.id, merged);
      assistantRegistry.update(current.id, {
        records: merged as never[],
        // 有 totalRecords 时以「剩余量」为准（与 refreshState 同一套算法），否则沿用宿主字段。
        ...(totalRecordsFor(payload) === undefined
          ? { hasEarlier: Boolean(payload.hasEarlier) }
          : { hasEarlier: Math.max(0, (totalRecordsFor(payload) as number) - loadedFromHost) > 0 }),
        // 游标必须**显式赋值**（包含赋 undefined）：到底时若不写，就会保留上一次的旧游标。
        // 旧实现是「有 cursor 才写」，于是翻到底后 historyCursor 仍是已加载过的那一页的游标 ——
        // 一旦某条路径再触发一次翻页，就会把那一页重新取回来（重复渲染）。
        historyCursor: totalRecordsFor(payload) === undefined
          ? (typeof payload.cursor === 'string' ? payload.cursor : undefined)
          : (() => { const rem = Math.max(0, (totalRecordsFor(payload) as number) - loadedFromHost); return rem > 0 ? String(rem) : undefined; })(),
        loadingEarlier: false,
      });
    } catch (error) {
      if (!disposed) assistantRegistry.update(current.id, { loadingEarlier: false, error: errorMessage(error) });
    }
  };
  /**
   * §5.1/§8/§11.6：展开某条历史记录的完整内容，并把后续页接上。
   *
   * 旧实现里 api.historyResult 全仓**没有任何调用点**（死代码），
   * 宿主的 /history-result 也就永远没人问 —— 记录里被截断的依据、工具结果、图片元数据
   * 在界面上根本没法展开，用户只能看到摘要（§11.6 明确要求「依据可展开核查」）。
   *
   * 两条边界都要如实落到界面（§10「不静默失败」）：
   * - 记录不存在 / 属于别的会话：宿主的 RECORD_NOT_FOUND（404）带中文原因回来，显示在展开区；
   * - 宿主没实现（503）：同样显示原因，而不是显示成「这条记录没有内容」。
   */
  const openHistoryDetail = async (recordId: string) => {
    if (disposed) return;
    const current = session();
    if (!current) return;
    const id = current.id;
    if (!recordId) return;
    // 先置 loading：用户点了要有反应，不能让按钮看起来没生效。
    assistantRegistry.update(id, { historyDetail: { recordId, status: 'loading', hasEarlier: false, loadingMore: false } });
    try {
      const result = await api.historyResult(id, recordId);
      if (disposed) return;
      // 用户在等待期间又点了另一条：这份迟到的回包属于上一条记录，不能覆盖当前展开的那条。
      if (assistantRegistry.get(id).historyDetail?.recordId !== recordId) return;
      const payload = isObject(result.payload) ? result.payload : {};
      const record = isObject(payload.record) ? payload.record : undefined;
      const counts = isObject(payload.counts) ? payload.counts as HistoryDetailState['counts'] : undefined;
      // §8：返回体自报的 sessionId 若与当前会话不符，说明拿回来的不是这次该看的东西，拒绝显示。
      if (typeof payload.sessionId === 'string' && payload.sessionId !== id) {
        assistantRegistry.update(id, { historyDetail: { recordId, status: 'error', hasEarlier: false, loadingMore: false, error: '这份记录属于另一个主对话，已拒绝显示。' } });
        return;
      }
      assistantRegistry.update(id, {
        historyDetail: {
          recordId,
          status: record ? 'ready' : 'error',
          record,
          counts,
          cursor: typeof payload.cursor === 'string' ? payload.cursor : null,
          hasEarlier: payload.hasEarlier === true,
          loadingMore: false,
          ...(record ? {} : { error: '服务端没有返回这条记录的内容。' }),
        },
      });
    } catch (error) {
      if (!disposed && assistantRegistry.get(id).historyDetail?.recordId === recordId) {
        assistantRegistry.update(id, { historyDetail: { recordId, status: 'error', hasEarlier: false, loadingMore: false, error: errorMessage(error) } });
      }
    }
  };

  /** §5.1：继续读同一记录的下一页；没有下一页时什么都不做。 */
  const loadMoreHistoryDetail = async () => {
    if (disposed) return;
    const current = session();
    if (!current) return;
    const id = current.id;
    const detail = assistantRegistry.get(id).historyDetail;
    if (!detail || !detail.hasEarlier || detail.loadingMore) return;
    const cursor = detail.cursor;
    assistantRegistry.update(id, { historyDetail: { ...detail, loadingMore: true, error: undefined } });
    try {
      const result = await api.historyResult(id, detail.recordId, cursor ?? undefined);
      if (disposed) return;
      const payload = isObject(result.payload) ? result.payload : {};
      const record = isObject(payload.record) ? payload.record : {};
      const latest = assistantRegistry.get(id).historyDetail || detail;
      const previous = isObject(latest.record) ? latest.record : {};
      // 数组字段按页累加：三组各自接上本页的新条目，不能整份替换（替换会把第一页丢掉）。
      //
      // 与 loadEarlier 同一类防护：**按 id 去重**。宿主按游标切页，若同一页被取回两次
      // （游标陈旧、宿主索引位移、用户连点），旧写法会把整页再拼一遍 ——
      // 展开区里的「依据」会重复显示（用户看到同一份依据出现两遍，且与磁盘条数不符）。
      // 没有 id 的元素无法去重，只能原样接上（不能为了去重把内容丢掉）。
      const merge = (key: 'evidence' | 'tools' | 'images') => {
        const before = Array.isArray(previous[key]) ? previous[key] as unknown[] : [];
        const added = Array.isArray(record[key]) ? record[key] as unknown[] : [];
        const seen = new Set(before.map(item => (isObject(item) ? (item as any).id : undefined)).filter(id => id !== undefined));
        const fresh = added.filter(item => {
          const id = isObject(item) ? (item as any).id : undefined;
          if (id === undefined) return true;              // 没有 id → 无法判定重复，保留（宁可重复也不丢）
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        return [...before, ...fresh];
      };
      assistantRegistry.update(id, {
        historyDetail: {
          ...latest,
          status: 'ready',
          record: { ...previous, ...record, evidence: merge('evidence'), tools: merge('tools'), images: merge('images') } as Record<string, unknown>,
          cursor: typeof payload.cursor === 'string' ? payload.cursor : null,
          hasEarlier: payload.hasEarlier === true,
          loadingMore: false,
        },
      });
    } catch (error) {
      if (!disposed) {
        const latest = assistantRegistry.get(id).historyDetail || detail;
        assistantRegistry.update(id, { historyDetail: { ...latest, loadingMore: false, error: errorMessage(error) } });
      }
    }
  };

  /** 收起展开区：用户看完了，不再占浮窗空间。 */
  const closeHistoryDetail = () => {
    const current = session();
    if (!current) return;
    assistantRegistry.update(current.id, { historyDetail: undefined });
  };

  /**
   * §4/§8 F6：主对话被归档时，让宿主清理本插件为它保存的记录。
   *
   * 复用宿主的 forget（置 archived、清记录与摘要、走 cleanupArchived），
   * 失败不抛给调用方——归档通知是「尽力而为」，不能因为一次清理失败就把订阅打断。
   */
  const forget = async (sessionId: string): Promise<void> => {
    if (disposed) return;
    if (!sessionId) return;
    try {
      await api.forget(sessionId);
      // 本地也立刻收起来：归档的会话不该继续显示在浮窗里。
      assistantRegistry.update(sessionId, { records: [], compactState: undefined, unread: false, archived: true });
    } catch (error) {
      // 记日志但不抛：拿不到宿主就保留数据，交给周期检查兜底。
      console.error('[dsh-explain-assistant] 归档清理请求失败（' + sessionId + '）：', errorMessage(error));
    }
  };

  /** 用户点「停止」：中断当前会话正在跑的请求，并把状态落到「已停止」。 */
  const cancel = () => {
    const current = session();
    if (!current) return;
    const request = active.get(current.id);
    if (!request) return;
    request.controller.abort();
    // 先把 requestId 取到局部常量：放进闭包后 TS 无法沿用 if 的收窄。
    const cancelId = request.requestId;
    if (cancelId) void callApi(() => api.cancel(request.sessionId, cancelId)).catch(() => undefined);
    assistantRegistry.update(request.sessionId, { phase: 'interrupted', requestId: undefined, error: '已按你的要求停止本次解释' });
    appendRecord(request, 'interrupted', assistantRegistry.get(request.sessionId));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const request of active.values()) {
      request.controller.abort();
      // dispose 尤其要包：它抛出来会中断清理（样式、订阅、注册都留在原地 = 泄漏）。
      const cancelId = request.requestId;
      if (cancelId) void callApi(() => api.cancel(request.sessionId, cancelId)).catch(() => undefined);
    }
    active.clear();
    assistantRegistry.sessions().forEach(state => { if (state.open) assistantRegistry.close(state.sessionId); });
    assistantRegistry.setCurrent(undefined);
  };
  const setSession = (id?: string, cwd?: string) => {
    selectedSession = id ? { id, cwd } : undefined;
    assistantRegistry.setCurrent(id);
  };
  return { api, registry: assistantRegistry, open, submit, loadEarlier, cancel, dispose, setSession, openHistoryDetail, loadMoreHistoryDetail, closeHistoryDetail, forget, primeUnread };
}
