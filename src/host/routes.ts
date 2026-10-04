import { ExplainAssistantError, SCHEMA_VERSION, toErrorBody, validateEnvelope, type HistoryResultPayload, type Operation, type SseEvent } from './contracts.js';
import { runAssistant, compactAssistant, type AssistantMessage, type AssistantModel } from './llm.js';
import type { ToolContext } from './tools.js';
import { buildRecordContent } from './record.js';
// §10/D1：原因码与中文文案放在 **src/shared/** —— 宿主（落库 + SSE 事件）与客户端（记录重建）
// 都要用同一份文案。本项目吃过「同一件事两处文案不一致」的亏，所以不做第二份拷贝，
// 而是让两边 import 同一个模块（该模块是纯数据+纯函数，无 node 依赖，浏览器端可安全打包）。
import { RECORD_REASON_TEXT, RECORD_REASON_FIELD, deriveRecordReason, deriveCompactReason, deriveErrorReason } from '../shared/record-reason.js';

export interface RouteService {
  loadState?: (id: string, signal?: AbortSignal) => Promise<unknown>;
  loadHistory?: (id: string, cursor?: string, signal?: AbortSignal) => Promise<unknown>;
  /** §5.1/§8：展开单条记录的完整内容（分页）。未实现时路由会给中文错误，不再静默返回空对象。 */
  loadHistoryResult?: (id: string, recordId: string, cursor?: string, signal?: AbortSignal) => Promise<HistoryResultPayload>;
  listModels?: (signal?: AbortSignal) => Promise<unknown>;
  resolveModel?: (id: string, signal?: AbortSignal) => Promise<{ selection: AssistantModel }>;
  /**
   * 0.2：第 5 个参数是**本次调用属于哪条路径**（'ask' 提问 / 'compact' 压缩）。
   *
   * 为什么必须区分：小助手的 /compact 只应压缩「小助手与用户对话产生的上下文」，
   * 主 agent 转移进来的那部分不得被摘要顶替（用户明确要求）。而 ask 与 compact
   * 共用本函数、且下游 compactAssistant 会把**整份** messages 送去摘要，
   * 所以唯一的隔离点就是「压缩时不把主 agent 段放进来」。
   * 省略该参数时按 'ask' 处理（保持既有调用方与测试的行为不变）。
   */
  buildMessages?: (id: string, question: string, payload: Record<string, unknown>, signal?: AbortSignal, mode?: 'ask' | 'compact') => Promise<AssistantMessage[]>;
  llm?: unknown;
  tokenMeter?: unknown;
  /** §10 调用限额：总超时与空闲超时。省略时用 llm.ts 的默认值。 */
  llmTimeouts?: { totalTimeoutMs?: number; idleTimeoutMs?: number };
  toolContext?: (id: string, signal?: AbortSignal) => Promise<ToolContext>;
  saveRecord?: (id: string, record: unknown) => Promise<void>;
  /** §9.1 压缩结果落库通道。可选：未实现时压缩仍可用，只是结果不进状态。 */
  saveCompact?: (id: string, compact: { summary: string; reasoning: string; sourceRecordIds: string[]; model?: unknown }, signal?: AbortSignal) => Promise<void>;
  markUnread?: (id: string) => Promise<void>;
  /** §4/§8 F6：主对话归档时清理本插件为它保存的记录（复用 index.ts 已有的 forget 实现）。 */
  forget?: (id: string) => Promise<unknown>;
  /** §10：把该会话标记为已读（打开浮窗后清除未读）。 */
  markRead?: (id: string) => Promise<void>;
  selectModel?: (id: string, model: unknown, signal?: AbortSignal) => Promise<unknown>;
  isSessionAllowed?: (id: string, signal?: AbortSignal) => Promise<boolean>;
  isArchived?: (id: string, signal?: AbortSignal) => Promise<boolean>;
}
export interface RouteOptions { service: RouteService; active?: Map<string, { requestId: string; controller: AbortController }>; }
type Handler = (request: Request) => Promise<Response>;

function json(value: unknown, status = 200, headers?: HeadersInit): Response { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } }); }
function operation(path: string): Operation { const name = path.split('/').filter(Boolean).pop(); return (name === 'state' || name === 'history' || name === 'history-result' || name === 'models' || name === 'select-model' || name === 'ask' || name === 'compact' || name === 'cancel' || name === 'forget' || name === 'mark-read') ? name as Operation : name === 'in-flight' ? 'cancel' : 'state'; }
function failure(error: unknown, sessionId?: string, op?: Operation, status = 500, requestId?: string): Response { return json({ schemaVersion: SCHEMA_VERSION, ok: false, ...(sessionId ? { sessionId } : {}), ...(requestId ? { requestId } : {}), ...(op ? { operation: op } : {}), error: toErrorBody(error) }, status); }
async function body(request: Request): Promise<Record<string, unknown>> { try { const value = await request.json(); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body'); return value as Record<string, unknown>; } catch { throw new ExplainAssistantError('INVALID_REQUEST', '请求内容必须是一个 JSON 对象。'); } }
function eventText(event: SseEvent): string { return 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n'; }
function statusFor(error: unknown): number { const code = error instanceof ExplainAssistantError ? error.code : ''; if (code === 'SESSION_FORBIDDEN') return 403; if (code === 'SESSION_ARCHIVED' || code === 'REQUEST_IN_FLIGHT' || code === 'HISTORY_CONFLICT') return 409; if (code === 'RECORD_NOT_FOUND' || code === 'SESSION_NOT_FOUND') return 404; if (code === 'LIMIT_EXCEEDED') return 413; if (code === 'DEPENDENCY_UNAVAILABLE') return 503; if (code === 'UNSUPPORTED_SCHEMA' || code === 'INVALID_REQUEST') return 400; return 500; }
function clearActive(active: Map<string, { requestId: string; controller: AbortController }>, sessionId: string, requestId: string): void { if (active.get(sessionId)?.requestId === requestId) active.delete(sessionId); }

export function createExplainAssistantRoutes(options: RouteOptions): Map<string, Handler> {
  const service = options.service;
  const active = options.active ?? new Map<string, { requestId: string; controller: AbortController }>();
  const guard = async (id: string, signal?: AbortSignal) => {
    if (service.isSessionAllowed && !(await service.isSessionAllowed(id, signal))) throw new ExplainAssistantError('SESSION_FORBIDDEN', '当前主对话不可用，小助手无法读取它。');
    if (service.isArchived && await service.isArchived(id, signal)) throw new ExplainAssistantError('SESSION_ARCHIVED', '当前主对话已归档，小助手不能再读取它。');
  };
  const plain: Handler = async request => {
    const url = new URL(request.url); const op = operation(url.pathname); const id = url.searchParams.get('sessionId') ?? undefined;
    try {
      if (!id) throw new ExplainAssistantError('INVALID_REQUEST', '缺少会话标识（sessionId）。');
      // §4/§8 F6：forget 是「会话被归档之后」才发生的动作，**不能**再被 guard 的
      // 「已归档则拒绝读取」挡回去——否则第一次清理把自己标成 archived 之后，
      // 这个接口就永远 409（用户取消归档、再重新归档时再也清不掉新产生的记录）。
      // 因此这里只做「这个会话允不允许访问」的检查，跳过 isArchived 那一半。
      // §10：打开浮窗后清除未读。与 forget 同样走在 guard 之前——
      // 它是「用户已经看到内容了」的收尾动作，不该被「已归档则拒绝读取」挡回去。
      if (op === 'mark-read') {
        if (service.isSessionAllowed && !(await service.isSessionAllowed(id, request.signal))) {
          throw new ExplainAssistantError('SESSION_FORBIDDEN', '当前主对话不可用，小助手无法读取它。');
        }
        if (!service.markRead) throw new ExplainAssistantError('DEPENDENCY_UNAVAILABLE', '小助手当前版本不支持清除未读。');
        await service.markRead(id);
        return json({ schemaVersion: SCHEMA_VERSION, sessionId: id, operation: op, payload: { unread: false } });
      }
      if (op === 'forget') {
        if (service.isSessionAllowed && !(await service.isSessionAllowed(id, request.signal))) {
          throw new ExplainAssistantError('SESSION_FORBIDDEN', '当前主对话不可用，小助手无法读取它。');
        }
        if (!service.forget) throw new ExplainAssistantError('DEPENDENCY_UNAVAILABLE', '小助手当前版本不支持归档清理。');
        return json({ schemaVersion: SCHEMA_VERSION, sessionId: id, operation: op, payload: await service.forget(id) });
      }
      await guard(id, request.signal);
      if (op === 'state') return json({ schemaVersion: SCHEMA_VERSION, sessionId: id, operation: op, payload: await service.loadState?.(id, request.signal) ?? {} });
      if (op === 'history') return json({ schemaVersion: SCHEMA_VERSION, sessionId: id, operation: op, payload: await service.loadHistory?.(id, url.searchParams.get('cursor') ?? undefined, request.signal) ?? {} });
      // §5.1/§11.6：查看某条记录的完整内容。宿主没实现时必须给中文错误，
      // 不能像旧版那样回落到空对象 —— 那会让界面显示「没有内容」，用户以为这条记录真的没有依据。
      if (op === 'history-result') {
        if (!service.loadHistoryResult) throw new ExplainAssistantError('DEPENDENCY_UNAVAILABLE', '小助手当前版本不支持查看单条记录的完整内容。');
        return json({ schemaVersion: SCHEMA_VERSION, sessionId: id, operation: op, payload: await service.loadHistoryResult(id, url.searchParams.get('recordId') ?? '', url.searchParams.get('cursor') ?? undefined, request.signal) });
      }
      if (op === 'models') return json({ schemaVersion: SCHEMA_VERSION, operation: op, payload: await service.listModels?.(request.signal) ?? {} });
      if (op === 'select-model') {
        const parsed = await body(request);
        // 客户端发的是 { payload: { model: { provider, model } } }，而这里曾只认顶层 provider/model，
        // 结果每次选择都被拒（英文报错 "A provider and model are required."），
        // 界面又因为乐观更新显示成「已选」——用户以为选上了，实际没落库。
        // 现在两种形状都接受，与 catalog.toModelSelection 保持一致。
        const raw = (parsed.payload ?? parsed) as Record<string, unknown>;
        const selection = (raw && typeof raw === 'object' && raw.model && typeof raw.model === 'object' && !Array.isArray(raw.model)) ? raw.model : raw;
        if (!selection || typeof selection !== 'object' || typeof (selection as any).provider !== 'string' || typeof (selection as any).model !== 'string') throw new ExplainAssistantError('INVALID_REQUEST', '请提供一个模型提供方和一个模型名。');
        const selected = await service.selectModel?.(id, selection, request.signal) ?? selection;
        return json({ schemaVersion: SCHEMA_VERSION, sessionId: id, operation: op, payload: { selected: true, selection: selected } });
      }
      if (op === 'cancel') { const requestId = url.searchParams.get('requestId') ?? url.pathname.split('/').pop() ?? ''; const current = active.get(id); if (!current || current.requestId !== requestId) throw new ExplainAssistantError('RECORD_NOT_FOUND', '这次请求已经结束，无法再取消。'); current.controller.abort(); return json({ schemaVersion: SCHEMA_VERSION, sessionId: id, requestId, operation: op, payload: { cancelled: true } }); }
      throw new ExplainAssistantError('INVALID_REQUEST', '小助手不支持这个操作。');
    } catch (error) { return failure(error, id, op, statusFor(error)); }
  };
  const stream: Handler = async request => {
    const url = new URL(request.url); const op = operation(url.pathname); let id: string | undefined; let requestId = crypto.randomUUID();
    try {
      const parsed = await body(request); validateEnvelope(parsed, op); id = parsed.sessionId;
      await guard(id, request.signal); if (active.has(id)) throw new ExplainAssistantError('REQUEST_IN_FLIGHT', '已经有一个解释请求在处理中，请等它结束再试。');
      const controller = new AbortController(); const signal = AbortSignal.any([request.signal, controller.signal]); active.set(id, { requestId, controller });
      const encoder = new TextEncoder(); const serviceContext = service.toolContext ? await service.toolContext(id, signal) : undefined;
      const send = (type: SseEvent['type'], payload?: unknown) => { if (payload && typeof payload === 'object' && 'sessionId' in payload && (payload as any).sessionId !== id) throw new ExplainAssistantError('SESSION_FORBIDDEN', '拒绝了一条属于其他会话的事件，已拦截。'); return encoder.encode(eventText({ schemaVersion: SCHEMA_VERSION, sessionId: id!, requestId, operation: op as 'ask' | 'compact', type, ...(payload === undefined ? {} : { payload }) })); };
      const streamBody = new ReadableStream<Uint8Array>({ start(controllerStream) {
        const run = async () => {
          // 这两个变量必须在 try **外面**声明：catch 里的落库要用到它们
          // （异常可能发生在 try 的第一行，那时它们还没被赋值 → 用 ?? 兜底）。
          let question = '';
          let now = new Date().toISOString();
          // 异常/取消时，用户可能**已经看到了一部分回答**（例如模型吐了一半就断了）。
          // 那条记录若写空正文，重载后与用户当时的所见不符 —— 所以把已产出的文本累积下来一并落库。
          let partialText = '';
          try {
            controllerStream.enqueue(send('start', { requestId }));
            const payload = (parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {}) as Record<string, unknown>; question = typeof payload.question === 'string' ? payload.question.trim() : ''; if (op === 'ask' && !question) throw new ExplainAssistantError('INVALID_REQUEST', '请先输入要问的问题。');
            // 0.2：把 op 传下去 —— compact 模式下宿主不注入主 agent 段，
            // 从而保证「小助手 /compact 只压小助手与用户对话产生的上下文」。
            // op 在这里只可能是 'ask' 或 'compact'：stream 处理器只挂在两条 SSE 路由上
            // （operation() 对其它路径返回别的名字，但那些走的是 plain 处理器）。
            const mode = op === 'compact' ? 'compact' as const : 'ask' as const;
            const messages = service.buildMessages ? await service.buildMessages(id!, question, payload, signal, mode) : [{ role: 'user', content: question } as AssistantMessage];
            const model = service.resolveModel ? (await service.resolveModel(id!, signal)).selection : { provider: 'default', model: 'default' };
            const context = { llm: service.llm, tokenMeter: service.tokenMeter, model, tools: serviceContext, signal, ...(service.llmTimeouts ?? {}), onEvent: (item: Record<string, unknown>) => { const type = item.type as SseEvent['type']; if (type === 'text' && typeof item.delta === 'string') partialText += item.delta; controllerStream.enqueue(send(type, item)); } };
            const result = op === 'compact' ? await compactAssistant(context, messages) : await runAssistant(context, messages);
            // §11.6「依据可展开核查」/ §6.3「依据分级」/ §8：落库必须带上**可核查材料**。
            //
            // 旧实现只写 9 个字段（id/kind/status/complete/question/answerText/reasoningText/usage/
            // startedAt/updatedAt），**没有 evidence、没有 tools、没有 images**：
            // llm.ts 明明算出了 toolTrace，却在落库这一步被丢掉。后果是界面上「查看完整内容」
            // 点开也只有回答正文，用户看不到「这条结论当时读了什么、跑了哪些工具」——
            // 而这正是他要核对的东西。实测落库目录下 15 个文件，带 tools/evidence 的为 0。
            now = new Date().toISOString();
            const selected = (payload.evidence ?? (parsed.payload as Record<string, unknown> | undefined)?.selectedEvidence);
            // compact 的结果没有 toolTrace（压缩不跑工具），ask 才有；两者共用同一条落库路径。
            const toolTrace = 'toolTrace' in result && Array.isArray(result.toolTrace) ? result.toolTrace : [];
            const content = buildRecordContent({ sessionId: id!, selectedEvidence: selected, toolTrace, now });
            // §10/D1：记录**留在磁盘上**，所以「为什么没完成」必须一起留下。
            // 否则整页重载后用户只看到「未完成」却不知道为什么，追问时模型也拿不到原因。
            // 没有原因时**不写这个字段**（老记录的磁盘形状保持不变，向后兼容）。
            //
            // compact 还要多一种形态（D1 跟进）：模型**正常结束但没吐出摘要** ——
            // 这时 result.complete 是 true，通用推导会认为「没失败」，
            // 但界面其实已经显示「压缩失败」了。这条路径原先完全不落痕迹，重载后
            // 记录看起来像成功。所以 compact 走 deriveCompactReason 补上 empty_result。
            const recordReason = op === 'compact' ? deriveCompactReason(result as any) : deriveRecordReason(result as any);
            // 状态与「是否干净成功」保持一致：**带了原因就说明这条没干净地完成**。
            // 为什么不能只看 result.complete：compact 的 empty_result 形态里 result.complete 是 true
            // （模型确实正常结束了），但它没产出摘要 —— 界面当时显示的是「压缩失败」。
            // 若照写 status='complete'，重载后这条记录看起来像成功，用户以为压缩过了。
            // 向后兼容：没有原因时判定与以前完全一样（老记录不受影响）。
            const cleanSuccess = result.complete === true && recordReason === undefined;
            await service.saveRecord?.(id!, {
              id: requestId, kind: op, status: cleanSuccess ? 'complete' : 'interrupted', complete: cleanSuccess, question,
              answerText: 'text' in result ? result.text : result.summary, reasoningText: result.reasoning, usage: result.usage,
              evidence: content.evidence, tools: content.tools, images: content.images,
              startedAt: now, updatedAt: now,
              ...(recordReason ? { [RECORD_REASON_FIELD]: recordReason } : {}),
            });
            // §9.1：只有压缩**成功**才落库。失败或未跑完时必须保留此前可用的 compactState，
            // 否则一次失败的压缩会把用户原有的可用摘要清掉。
            // §9.1：失败/超时不落库；而且失败必须让界面知道（不能留下一个「正在压缩」的假状态）。
            if (op === 'compact' && result.complete && service.saveCompact) {
              const summary = ('summary' in result ? result.summary : '').trim();
              if (summary) await service.saveCompact(id!, { summary, reasoning: result.reasoning, sourceRecordIds: [], model }, signal);
            }
            // §10：失败、超时、触及上限是三种不同的事，必须给不同的中文原因，
            // 用户才知道该改配置、该等、该缩范围，还是该换模型。
            //
            // 这里此前只有两条分支，把「模型调用失败」也归进「已中断」——而模型调用失败最常见的形态
            // 恰恰是「一个字都没说」，于是界面显示成功、内容空白（本轮实测：同一会话追问第二次，
            // 108 个文本分片变成 0 个，却报 complete:true）。失败必须走 error 事件，不能冒充成功或中断。
            const failure = (result as { failure?: { code?: string; message?: string } }).failure;
            if (failure && (failure.code ?? '') === 'ABORTED') {
              // 提供方侧中断（不是用户点停止：那种情况根本走不到这里）算「已停止」，不算出错。
              controllerStream.enqueue(send('aborted', { message: '这次解释在模型那边被中断了，没有拿到完整回答。你可以再问一次。' }));
            } else if (failure) {
              const code = failure.code ?? 'LLM_FAILED';
              // 适配器故障文案多为英文，这里给一句用户看得懂的中文，并把原文留在 details 里供排查。
              const friendly = code === 'MODEL_UNAVAILABLE'
                ? '这个主对话还没有可用的小助手模型，无法生成解释。你可以先在上面选一个模型，再问一次。'
                : RECORD_REASON_TEXT.model_failed;   // 唯一来源：与记录重建时显示的是同一句
              controllerStream.enqueue(send('error', { code, message: friendly, retryable: false, details: { cause: failure.message } }));
            } else if (!result.complete) {
              controllerStream.enqueue(send('aborted', { message: (result as { timeout?: boolean }).timeout
                ? RECORD_REASON_TEXT.timeout            // 唯一来源：与记录重建时显示的是同一句
                : RECORD_REASON_TEXT.limit }));
            } else controllerStream.enqueue(send('complete', result));
            await service.markUnread?.(id!); controllerStream.close();
          } catch (error) {
            // §10/D1-c：**异常路径也必须留痕**。
            //
            // 原先这里只发一个事件、**不落库** —— 适配器抛异常、用户点停止都会走到这里，
            // 于是那次提问在磁盘上**彻底不存在**：用户重载后连「我问过这句话」都看不到，
            // 追问时模型也不知道「上次试过但挂了」。这是 D1 家族的第三个程度
            // （a 有记录没原因 → b 有记录但记成成功 → c 连记录都没有）。
            //
            // 判据与客户端一致：**用户主动停止不是失败**，给的是不同的话（stopped）。
            const reason = deriveErrorReason(error);
            try {
              await service.saveRecord?.(id!, {
                id: requestId, kind: op, status: 'interrupted', complete: false, question,
                answerText: partialText, reasoningText: '',
                evidence: [], tools: [], images: [],
                startedAt: now, updatedAt: new Date().toISOString(),
                [RECORD_REASON_FIELD]: reason,
              });
            } catch { /* 落库失败不得连累事件发送：用户仍应看到那条中文提示 */ }
            controllerStream.enqueue(send((error as any)?.code === 'ABORTED' ? 'aborted' : 'error', toErrorBody(error)));
            controllerStream.close();
          }
          finally { clearActive(active, id!, requestId); }
        };
        // 游离的 run() 必须自带兜底：其 catch 块内的 enqueue 对已关闭流会抛错，
        // 若放任其拒绝，DSH 启动器会把它当致命错误并 exit(1)，整站白屏。
        void run().catch(error => { try { controllerStream.enqueue(send('error', toErrorBody(error))); controllerStream.close(); } catch { /* 流已不可用，忽略 */ } });
      }, cancel() { controller.abort(); } });
      return new Response(streamBody, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' } });
    } catch (error) { if (id) clearActive(active, id, requestId); return failure(error, id, op, statusFor(error), requestId); }
  };
  return new Map([
    ['/explain-assistant/state', plain], ['/explain-assistant/history', plain], ['/explain-assistant/history-result', plain], ['/explain-assistant/models', plain], ['/explain-assistant/select-model', plain], ['/explain-assistant/in-flight', plain], ['/explain-assistant/forget', plain], ['/explain-assistant/mark-read', plain], ['/explain-assistant/ask', stream], ['/explain-assistant/compact', stream]
  ]);
}
