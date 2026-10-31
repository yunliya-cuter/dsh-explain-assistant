# 宿主侧审计（src/index.ts + src/host/*.ts + src/shared/*）

审查基线：2026-10-31 工作区当前源码（含未提交改动）。只读审查，未修改 src/、tests/、lib/。以下 18 条按严重度排序，另有「存疑」与「静默失败补充」。

### A-01 finish.reason.kind='max-tokens' 被当成正常完成
- 类型：真bug
- 严重度：P1
- 位置：src/host/llm.ts:57-61、196-197
- 现象：模型因输出上限被截断时，界面显示「完成」，历史记录 status=complete；截断的后半段没有任何「触及上限/未完成」提示。
- 触发路径：在 3081 选一个长回答会撞 max output tokens 的模型，问一个需要长回答的问题；或单测 fake stream 依次 yield text-delta 与 finish{reason:{kind:'max-tokens'}}。
- 证据：
~~~ts
57|   if(type==='finish'){
58|     const kind=chunk.reason?.kind;
59|     if(kind==='error')return {done:true,failure:{code:String(chunk.reason?.failure?.code??'LLM_FAILED'),message:String(chunk.reason?.failure?.message??'模型调用失败')}};
60|     if(kind==='aborted')return {done:true,failure:{code:'ABORTED',message:String(chunk.reason?.failure?.message??'模型调用已中断')}};
61|     return {done:true};
...
196|   const normalized=calls.map(call=>({id:call.id,name:call.name,arguments:toolArguments(call.arguments??call.raw)}));
197|   if(!normalized.length) return {text,reasoning,usage,toolTrace:trace,complete:true};
~~~
DSH 真实协议 FinishReasonMap 明确含 'max-tokens'（dsh-cordis-host-runner/lib/typert.host.js:1406）。实测当前源码：text-delta「前半段」+ finish(max-tokens) 得到 {"text":"前半段","reasoning":"","toolTrace":[],"complete":true}。
- 判定理由：max-tokens 是「被截断」而不是「正常结束」；complete:true 会让 routes 写 complete 记录、发 complete 事件，用户把截断答案当完整答案。
- 修复代价：小（单文件，<=20 行）
- 波及：routes 的 cleanSuccess、SSE 完成/aborted 分支、历史记录状态、追问上下文。
- 用户自测：用会输出很长的模型提问，直到 finish 为 max-tokens；若界面显示「完成」且没有超时/上限提示，即确认。

### A-02 回答完成后的收尾失败被当成整次失败，写出两条同 id 记录
- 类型：真bug
- 严重度：P1
- 位置：src/host/routes.ts:190-196、200-202、226、236-244
- 现象：saveRecord 成功之后，saveCompact 或 markUnread 抛错会进入同一个 catch；catch 又调用一次 saveRecord，用同一个 requestId 再写一条 status=interrupted 的记录，并在 SSE 的 complete 之后补发 error。重载后同一条回答出现两条同 id 记录，其中一条被标成失败。
- 触发路径：磁盘满、目录只读、序列化失败等导致 markUnread/saveCompact 抛错；或单测中让 saveRecord 成功、markUnread 立即 throw。
- 证据：
~~~ts
190|             await service.saveRecord?.(id!, {
191|               id: requestId, kind: op, status: cleanSuccess ? 'complete' : 'interrupted', complete: cleanSuccess, question,
...
200|             if (op === 'compact' && result.complete && service.saveCompact) {
201|               const summary = ('summary' in result ? result.summary : '').trim();
202|               if (summary) await service.saveCompact(id!, { summary, reasoning: result.reasoning, sourceRecordIds: [], model }, signal);
...
226|             await service.markUnread?.(id!); controllerStream.close();
227|           } catch (error) {
...
238|               await service.saveRecord?.(id!, {
239|                 id: requestId, kind: op, status: 'interrupted', complete: false, question,
240|                 answerText: partialText, reasoningText: '',
241|                 evidence: [], tools: [], images: [],
242|                 startedAt: now, updatedAt: new Date().toISOString(),
243|                 [RECORD_REASON_FIELD]: reason,
244|               });
~~~
实测（当前 routes）：fake markUnread 抛错 -> saveRecord 被调用 2 次，两条记录 id 相同；SSE 事件顺序 complete、error。
- 判定理由：记录 id 唯一、一次请求一条记录是既有不变式；收尾失败不应改变已经成功的回答状态，更不应写第二条记录。
- 修复代价：小（routes.ts 拆 try 或加 saved 标记）
- 波及：SSE 顺序、客户端 phase、历史去重、追问上下文。
- 用户自测：正常回答结束后让落库目录不可写（或单测伪造 markUnread 失败）；重载历史若出现两条同 id 记录、一条 complete 一条 interrupted，即确认。

### A-03 模型调用前的外部读取没有截止时间，取消也无法释放会话
- 类型：真bug
- 严重度：P1
- 位置：src/index.ts:508-510、529-537、431-432；src/host/routes.ts:139-140；src/host/session-context.ts:316
- 现象：ask/compact 在真正调用模型前会读主 agent 表面、模型目录、模型信息；这些调用都没有截止时间，且 readSurface 根本不接收 signal。用户按下停止后，active 仍被占用，后续发送得到 409「已经有一个解释请求在处理中」；如果 toolContext 在返回 Response 前挂住，连 start 事件都发不出去，客户端无法取消。
- 触发路径：44MB 主会话打开提问（readSurface 实测 5.8–17 秒）后立刻点停止，再发第二条；或宿主 llm.listProviders/listModels/resolveModelInfo 永不 settle。
- 证据：
~~~ts
139|       const controller = new AbortController(); const signal = AbortSignal.any([request.signal, controller.signal]); active.set(id, { requestId, controller });
140|       const encoder = new TextEncoder(); const serviceContext = service.toolContext ? await service.toolContext(id, signal) : undefined;
...
508|       const mainline = mode === 'compact'
509|         ? undefined
510|         : await readMainlineContext({ sessionQuery, sessionId: id, signal });
...
536|       if (model?.provider && model?.model && typeof ctx?.llm?.resolveModelInfo === 'function') {
537|         modelContext = await ctx.llm.resolveModelInfo(model.provider, model.model).catch(() => undefined);
~~~
实测（fake buildMessages 永不 resolve）：cancel 路由返回 200，active.size 仍为 1，紧接着第二次 ask 返回 409。
- 判定理由：用户取消应尽快结束本次请求并释放会话；当前取消只 abort controller，前置 await 不观察 signal，active 只能等到前置 Promise 自己结束。
- 修复代价：中（index.ts 前置读取加 deadline；readSurface 无法取消则至少 race；toolContext 放到 Response 之后并设置超时）
- 波及：ask/compact 路由、active 锁、client 停止按钮、超时提示。
- 用户自测：大会话点发送后立刻点停止，再点发送；若持续看到 409 直到十几秒后才恢复，即确认。

### A-04 /state 仍会被模型目录/模型信息无限阻塞，且目录读取不在第一步并行
- 类型：真bug（性能/可用性）
- 严重度：P1
- 位置：src/index.ts:287-296、54；src/host/catalog.ts:126、148
- 现象：500ms deadline 只包住主 agent 表面读取；模型目录 loadCatalog 在 Promise.all 之后才发起（先等 state/mainline 最多 500ms），且 callLlm 没有 signal/超时；resolveModelInfo 也没有 signal。宿主 listModels 或 resolveModelInfo 不返回时，/state 永远不返回，浮窗打不开。
- 触发路径：宿主模型提供方网络不通/挂住，打开浮窗；或冷启动第一次 /state（目录本可并行却排在 500ms 之后）。
- 证据：
~~~ts
287|       const [state, mainline] = await Promise.all([
288|         stateTask,
289|         withDeadline(mainlineTask.catch(() => undefined), MAINLINE_DEADLINE_MS),
290|       ]) as [any, Awaited<ReturnType<typeof readMainlineCached>> | undefined];
291|       const explicit = state.explicitModel as { provider?: string; model?: string } | undefined;
294|       const occupancyTask = mainline === undefined ? Promise.resolve(undefined) : readOccupancy(ctx, state, mainline);
295|       const catalogTask = loadCatalog(signal).catch(error => catalogReadFailure(error));
296|       const [occupancy, catalog] = await Promise.all([occupancyTask, catalogTask]);
~~~
callLlm（catalog.ts:70-89）没有 signal；discoverCatalog 只在 provider 循环间检查 signal，listProviders/listModels 本身无法取消。
- 判定理由：模型目录与本地 state/主 agent 读取相互独立，应在请求开始就并行并加 deadline；现在既串行又无超时，和注释「四步并行、总耗时≈最慢一项」不符。
- 修复代价：中（index.ts 提前启动 catalog；catalog 加超时/可注入 signal；readOccupancy 传 signal）
- 波及：浮窗首次打开、模型面板、state 超时重试。
- 用户自测：把模型提供方网络断开或让 listModels 卡住，打开浮窗；若 15 秒后仍失败且每次重试都卡住，即确认。

### A-05 空主线也返回 occupancyPending=true，客户端会每 3 秒无限刷新 /state
- 类型：反直觉
- 严重度：P2
- 位置：src/index.ts:332；src/host/session-context.ts:318-319；src/client/index.ts:440-447
- 现象：mainline === undefined 被当成「没赶上 500ms 截止」，但空会话/只有系统事件的主线本来就会返回 undefined。host 于是永久返回 occupancyPending:true，客户端注释说「只补一次」，实际没有次数上限，浮窗开着期间每 3 秒自动打一次 /state。
- 用户预期：占用待补最多自动重试一次，之后等用户下次打开。
- 实际情况：空会话每次刷新仍是 pending，客户端无限循环，/state 持续每 3 秒一次直到关窗。
- 触发路径：在 3081 新建一个还没有任何主 agent 消息的对话，打开小助手浮窗，看 Network 里 /state 的周期请求。
- 证据：
~~~ts
332|         occupancyPending: mainline === undefined,
~~~
~~~ts
440|   const scheduleOccupancyRefresh = (sessionId: string): void => {
441|     if (disposed || occupancyRefreshTimers.has(sessionId)) return;
442|     const timer = setTimeout(() => {
443|       occupancyRefreshTimers.delete(sessionId);
444|       const state = assistantRegistry.get(sessionId);
445|       if (disposed || !state?.open || state.occupancyKnown) return;
446|       void refreshState(sessionId, { keepCleared: true }).catch(() => undefined);
447|     }, options.occupancyRetryDelayMs ?? 3000);
~~~
实测：host 对 readSurface => {events:[]} 返回 occupancyPending:true；client 在永久 pending 下以 5ms 间隔测试 80ms 内打了 15 次 /state。
- 判定理由：pending 语义应是「这次超时、后台还在读」，不是「没有主线内容」；客户端也没有「最多补一次」的计数。
- 修复代价：小（host 用超时哨兵区分 undefined；client 加 retry 上限）
- 波及：/state 请求量、store.load、浮窗 CPU/网络、占用圆环状态。
- 用户自测：新会话打开浮窗，Network 面板观察 /state 是否每 3 秒重复；如果是，即确认。

### A-06 占用圆环按全部历史估算，实际只发最近 6 轮
- 类型：真bug
- 严重度：P2
- 位置：src/host/occupancy.ts:158-174；src/host/prompts.ts:315-316；src/index.ts:59
- 现象：carriedRecords 只过滤 compact 日志，把压缩后的全部 ask 记录都计入 ownTokens；而 buildMessages 只取 maxHistoryTurns 默认 6 轮。问得越多，圆环越高，但实际发给模型的历史并没有那么多；可能虚报接近 100%，让用户误以为需要压缩。
- 触发路径：同一会话连续问 7 次以上且不压缩，打开浮窗看占用；或单测 10 条记录对比 buildMessages 实际轮数。
- 证据：
~~~ts
163|   const list = (records ?? []).filter(record => record.kind !== 'compact');
...
168|   if (!compactCreatedAt) return list.map(carry);
169|   return list
170|     .filter(record => {
171|       const at = record.startedAt ?? record.createdAt;
172|       return typeof at === 'string' && at > compactCreatedAt;
173|     })
174|     .map(carry);
...
315|   const turns = (deps.history ?? []).filter(turn => textOf(turn?.question) || textOf(turn?.answer));
316|   const limit = Math.max(0, deps.maxHistoryTurns ?? 6);
322|   turns.slice(-limit).forEach((turn, index) => {
~~~
实测：10 条记录时 ownTokens=425，但 buildMessages 实际只带 6 轮。
- 判定理由：occupancy 模块头注释明确说「完整保存的历史长度不等于本次交给模型的上下文长度」，index 注释也说两块之和等于本次实际注入量；当前实现违背这条契约。
- 修复代价：小（occupancy 传入同样的 maxHistoryTurns/字符预算，或直接从 buildMessages 的消息计算）
- 波及：占用百分比、hover 构成、用户是否误触发 compact。
- 用户自测：连续问 7 次以上，展开圆环 hover；若占用包含早已不在最近 6 轮里的历史，且与提问后实际上下文不符，即确认。

### A-07 归档周期检查直接删文件，不写 forgotten 墓碑，晚到写入会把文件重建
- 类型：真bug
- 严重度：P2（若 DSH 正式提供 archived 标识则升 P1）
- 位置：src/index.ts:220-238、251-256、585-599
- 现象：周期 sweeper 的 removeSession 直接调用 store.remove(id)，没有像 forget 那样把 id 放进 forgotten；删除后 isForgotten 通过 store.load 得到空状态（archived=false），晚到的 saveRecord/markUnread 会走 store.update 新建文件，归档记录复活，isArchived 也回到 false。
- 触发路径：构造一个 archived=true 的会话（或 DSH 将来提供归档标识），让 sweeper 跑一次删除，然后触发一次晚到 saveRecord；文件重新出现。
- 证据：
~~~ts
220|   const archiveSweeper = store ? createArchiveSweeper({
221|     listSessionIds: () => store.listSessionIds(),
...
235|     removeSession: (id: string) => store.remove(id),
236|     logger: (message: string) => console.error('[dsh-explain-assistant]', message),
237|   }) : undefined;
...
251|   const forgotten = new Set<string>();
252|   /** 该会话是否已被归档清理（磁盘已删或已被标记归档）。写入侧必须先用它把关。 */
253|   const isForgotten = async (id: string): Promise<boolean> => {
254|     if (forgotten.has(id)) return true;
255|     if (!store) return false;
256|     try { return Boolean((await store.load(id)).state.archived); } catch { return false; }
~~~
- 判定理由：forget 路径专门用墓碑解决「删除后 load 返回空状态」的问题；sweeper 绕过了同一条保护，等于给归档留下一个可复活的漏洞。
- 修复代价：小（removeSession 包一层：forgotten.add(id) 后再 store.remove(id)；并考虑 abort active）
- 波及：归档隐私、isArchived、loadState、saveRecord。
- 用户自测：单测 seed archived 会话，手动 run sweeper 后调用 saveRecord；若记录文件重新出现，即确认。

### A-08 归档只清记录/删文件，不取消正在运行的 ask/compact
- 类型：真bug
- 严重度：P2
- 位置：src/index.ts:558-579；src/host/routes.ts:137-139
- 现象：forget 只做 store.update 标记 archived、forgotten.add、store.remove；没有 abort active 里的 controller。归档一个正在流式回答的会话，模型调用和 SSE 仍继续，直到自然结束或超时；规范 §8 明确要求「取消活动请求」。
- 触发路径：发起一个长回答，在流式过程中归档该主对话；观察浮窗/宿主仍在产生 text 事件，模型调用未停止。
- 证据：
~~~ts
558|     forget: async (id: string) => {
559|       if (!store) return { removed: false };
...
563|       await store.update(id, (state: any) => { state.archived = true; state.records = []; state.compactState = undefined; state.unread = false; });
...
566|       forgotten.add(id);
...
571|       try {
572|         await store.remove(id);
573|         removed = true;
574|       } catch (error) {
575|         failure = error instanceof Error ? error.message : String(error);
576|         console.error('[dsh-explain-assistant] 归档清理删除失败（' + id + '），已进入重试队列：', failure);
577|       }
~~~
函数体没有出现 active.get(id)/controller.abort()；如需要可对照 routes.ts:139 active.set(id, {requestId, controller})。
- 判定理由：实现文档 §8 有明文要求；当前只删除历史不停止模型，既浪费 token，也可能把晚到事件写成新记录（叠加 A-07 更严重）。
- 修复代价：小（forget 开头 active.get(id)?.controller.abort()；sweeper 同样）
- 波及：归档、SSE、模型费用、active 锁。
- 用户自测：长回答中点归档；若回答继续滚动、宿主仍收到 text/complete，即确认。

### A-09 删除失败队列只在内存，重启后启动清理是空操作；仅图片目录的残留永远扫不到
- 类型：真bug
- 严重度：P2
- 位置：src/host/persistence.ts:58、187-214、154-165；src/index.ts:188-201
- 现象：pendingDeletes 是内存 Set。插件重启后新 store 的 Set 为空，启动时 retryPendingDeletes() 返回 attempted:0；forget 当次的失败删除永远不会在重启后重试。若 store.remove 已删掉 JSON 但删除图片目录失败，listSessionIds 只枚举 *.json，后续周期检查也永远发现不了这个孤儿图片目录。
- 触发路径：目录只读/磁盘忙时归档，store.remove 失败；重启插件；观察文件仍在，pendingDeletes 为空。或让 JSON 删除成功、图片目录 rm 失败。
- 证据：
~~~ts
187|   async remove(sessionId: string): Promise<void> {
188|     this.ensureOpen();
189|     const id = safeSessionId(sessionId);
190|     try {
191|       await this.enqueue(id, async () => {
192|         await rm(this.pathFor(id), { force: true });
193|         await rm(join(this.rootDir, 'sessions', id), { recursive: true, force: true });
194|       });
195|       this.pendingDeletes.delete(id);
196|     } catch (error) {
197|       this.pendingDeletes.add(id);
198|       throw persistenceError('删除小助手的本地记录或图片快照失败。', error);
199|     }
200|   }
...
207|   async retryPendingDeletes(): Promise<{ attempted: number; failed: number }> {
208|     const ids = [...this.pendingDeletes]; let failed = 0;
209|     for (const id of ids) { try { await this.remove(id); this.pendingDeletes.delete(id); } catch { failed++; } }
210|     return { attempted: ids.length, failed };
~~~
实测：第一次 store.remove 失败后 pendingDeleteIds() == ['x']；新建同 rootDir 的 store 后 pending 为空，retryPendingDeletes() 返回 {attempted:0,failed:0}。
- 判定理由：index.ts 注释说启动清理正是为了补「插件重启就永久丢失」，但队列没有持久化，启动清理永远看不到失败项；这是承诺与实现不一致的数据残留。
- 修复代价：中（把失败 id 落盘，或启动时扫描 archive 标记/图片目录；listSessionIds 同时枚举目录）
- 波及：归档隐私、磁盘占用、周期检查。
- 用户自测：制造一次归档删除失败并重启；若文件/图片仍在且日志显示 attempted 0，即确认。

### A-10 15s 工具超时从未生效：executeToolLoop 无调用方，withTimeout 只 abort 不 race
- 类型：真bug
- 严重度：P1
- 位置：src/host/tools.ts:51、58；src/host/llm.ts:217
- 现象：DEFAULT_TOOL_LIMITS.toolTimeoutMs=15_000、executeToolLoop 的 maxRounds/maxCalls/totalTimeoutMs 只在死代码里使用；llm.ts 的工具循环直接 executeTool(...)，没有每工具计时。withTimeout 也只是 c.abort()，不 Promise.race，工具实现不响应 signal 时 Promise 永远不 settle。结果是某个 sessionQuery/文件读取挂住，ask 会一直停在「正在解释」直到外层 300s，且超时后工具仍在后台跑。
- 触发路径：让 sessionQuery.readEvent/searchEvents 或工作区 fs.readFile 永不返回，提问触发工具调用；观察 ask 不结束、取消后 active 仍被占。
- 证据：
~~~ts
51| function withTimeout<T>(work:(s:AbortSignal)=>Promise<T>,parent:AbortSignal|undefined,ms:number):Promise<T>{const c=new AbortController();const timer=setTimeout(()=>c.abort(),ms);const abort=()=>c.abort();if(parent?.aborted)c.abort();parent?.addEventListener('abort',abort,{once:true});return work(c.signal).finally(()=>{clearTimeout(timer);parent?.removeEventListener('abort',abort);});}
...
58| export async function executeToolLoop(ctx:ToolContext,calls:readonly ToolCall[],options:Partial<ToolLimits>={}):Promise<ToolLoopResult>{const limits={...DEFAULT_TOOL_LIMITS,...ctx.limits,...options};const started=Date.now();const results:ToolLoopResult['results']=[];let totalBytes=0;let rounds=0;for(const call of calls){rounds++;if(rounds>limits.maxRounds)return{...};...const result=await withTimeout(s=>executeTool({...ctx,signal:s,limits},call),ctx.signal,limits.toolTimeoutMs);...
~~~
llm.ts:217 是实际的 const result:ToolResult=await executeTool(ctx.tools??{sessionId:''}, {name,arguments:call.arguments});。
- 判定理由：常量与函数存在但不能影响真实路径；withTimeout 的语义也不是超时拒绝，只是发 abort，不能保证 bounded wait。
- 修复代价：中（llm 循环接 executeToolLoop，或每工具 Promise.race 定时 reject；保留 abort 给协作式工具）
- 波及：工具耗时、总超时、停止按钮、active 释放。
- 用户自测：用一个永不返回的假 sessionQuery 触发 readEvent 工具；若 15s 后没有 TOOL_TIMEOUT/工具错误，而是一直等到外层超时，即确认。

### A-11 工作区读取整文件入内存，搜索递归无深度/文件数/总字节上限
- 类型：真bug（边界/资源）
- 严重度：P2
- 位置：src/host/evidence.ts:82-87、95-98；src/host/tools.ts:56
- 现象：readWorkspaceText 先 fs.readFile(target) 读完整个文件，之后才按 offset/length 与 maxBytes 截断；searchWorkspace 的 walk 没有 maxDepth/文件总数/总字节预算，逐文件 readFile 全读，只有 results.length >= 200 才停（只数命中）。工作区里一个大文件或大目录树就足以让一次工具调用占满内存/CPU，甚至把宿主进程拖死。
- 触发路径：工作区放一个 1GB 文件，问「读一下这个文件」触发 explain_read_workspace_file；或放一个几十万文件的目录，触发 explain_search_workspace。
- 证据：
~~~ts
82| export async function readWorkspaceText(workspace: string, relative: string, options: { offset?: number; length?: number; limits?: EvidenceLimits; signal?: AbortSignal; sessionId?: string } = {}): Promise<EvidenceEnvelope> {
83|   const target = await verifyWorkspacePath(workspace, relative); const statBefore = await fs.stat(target); if (!statBefore.isFile()) throw new Error('WORKSPACE_NOT_FILE');
84|   const bytes = await fs.readFile(target); options.signal?.throwIfAborted();
...
95| export async function searchWorkspace(workspace: string, query: string, relative = '.', signal?: AbortSignal, sessionId = ''): Promise<EvidenceEnvelope[]> {
96|   if (!query || query.length > 512) throw new Error('SEARCH_QUERY_INVALID'); const root = await verifyWorkspacePath(workspace, relative); const results: EvidenceEnvelope[] = [];
97|   async function walk(dir: string): Promise<void> { signal?.throwIfAborted(); if (results.length >= DEFAULTS.maxItems) return; for (const item of await fs.readdir(dir, { withFileTypes: true })) { ... const bytes = await fs.readFile(full); const text = bytes.toString('utf8'); const index = text.indexOf(query); ...
~~~
- 判定理由：工具契约是只读、限额、可截断；当前没有任何前置大小/深度/总量限制，也没有用 stat 做预拒绝。
- 修复代价：中（读取前 stat 大小上限；流式读；walk 加 maxDepth/maxFiles/maxTotalBytes）
- 波及：宿主内存、工具延迟、ask 超时、工作区大项目。
- 用户自测：在工作区放一个超大文件或大目录，观察 explain_read_workspace_file/search_workspace 的耗时和进程内存；若明显卡顿/OOM，即确认。

### A-12 损坏的会话 JSON 被静默恢复成空历史，用户看不到任何损坏提示
- 类型：真bug
- 严重度：P1
- 位置：src/host/persistence.ts:94-103、216-228；src/index.ts:278、356、387
- 现象：store.load 遇到 JSON 损坏会把它改名为 .corrupt.<ts>，写入全新空 state 并返回 recoveredCorrupt；但 loadState 只取 loaded.state，loadHistory/loadHistoryResult 同样丢弃该字段。客户端看到的是 200、records=[]，显示「还没有小助手历史」，用户以为记录真的没有发生过。
- 触发路径：手工截断/写入非法 JSON 到 <DSH_HOME>/explain-assistant/sessions/<id>.json，重开浮窗或调用 /state、/history。
- 证据：
~~~ts
94|       let parsed: unknown;
95|       try {
96|         parsed = JSON.parse(raw);
97|         assertState(parsed, id);
98|       } catch (error) {
99|         if (error instanceof ExplainAssistantError && error.code === 'UNSUPPORTED_SCHEMA') throw error;
100|         const quarantined = await this.quarantine(file);
101|         const state = createEmptyState(id, this.now().toISOString());
102|         await this.writeAtomic(state);
103|         return { state, created: true, recoveredCorrupt: quarantined };
104|       }
...
278|       const stateTask = store ? store.load(id).then(loaded => loaded.state) : Promise.resolve({ sessionId: id, records: [], unread: false, archived: false });
~~~
实测：写入 {not json 后调用 /state -> 200、records=0、目录同时出现 .corrupt.*，但 payload 没有任何恢复/损坏字段。
- 判定理由：StateLoadResult 专门提供了 recoveredCorrupt，说明设计上要告知调用方；这是数据丢失类静默失败，用户无法知道可恢复文件在哪。
- 修复代价：小（把 recoveredCorrupt 放进 payload 或 error；三处 load 都透传）
- 波及：history、state、history-result、客户端错误提示。
- 用户自测：破坏一个会话 JSON，重开浮窗；若历史显示为空且没有「记录损坏/已隔离」的提示，但目录里有 .corrupt.*，即确认。

### A-13 插件卸载时 pending 只等 Response，不等 SSE 的 run()，流式回答可能来不及落库
- 类型：真bug（生命周期）
- 严重度：P2
- 位置：src/index.ts:642、674-687；src/host/routes.ts:253
- 现象：SSE 路由的 handler 在 new ReadableStream 后立即返回 Response，真正的 run() 是 void run().catch(...) 的游离 Promise。index.ts 的 pending 跟踪的是 route handler 的 Response Promise，SSE 一返回就 delete；插件 dispose 时 await Promise.allSettled([...pending]) 不会等流式 run，随后 store.close() 把 closed 置 true，run 的 catch 里 saveRecord 会因 ensureOpen 失败（catch 又吞掉），半截回答丢失。
- 触发路径：发起长回答，在流式过程中禁用/热重载插件（或触发 dispose）；重载后历史里没有这次回答。
- 证据：
~~~ts
642|   ctx.effect?.(() => async () => { lifetime.abort(); archiveSweeper?.stop(); await Promise.allSettled([...pending]); await store?.close(); });
...
674|     fetch: (request: Request) => {
675|       const task = routes.get(mapKey)?.(new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) })) ?? Promise.resolve(new Response('Not found', { status: 404 }));
...
685|       pending.add(settled);
686|       void settled.finally(() => pending.delete(settled)).catch(() => undefined);
687|       return settled;
~~~
routes.ts:253：void run().catch(error => { try { controllerStream.enqueue(send('error', toErrorBody(error))); controllerStream.close(); } catch {} });
- 判定理由：生命周期注释和实现都以为 pending 覆盖了在途请求；对 SSE 而言只覆盖了建流，不覆盖落库，属于关停时数据丢失。
- 修复代价：小（让 stream handler 返回一个在 run finally 后 resolve 的 promise，或把 run promise 放进 active/pending）
- 波及：插件热重载、进程退出、最后一条回答。
- 用户自测：回答到一半热重载插件；重载后看历史，若这条回答不存在，即确认。

### A-14 选中依据在发模型前没有条数/字节上限
- 类型：真bug（约束缺失）
- 严重度：P2
- 位置：src/host/prompts.ts:191-229、288-301；src/client/index.ts:701
- 现象：buildMessages 把 payload.evidence 全部交给 renderEvidence，每条 summary 最多 4000 字，没有条数上限；客户端 state.evidence.slice() 也没有 cap。用户 Ctrl 多选几十/几百张卡片后提问，prompt 可能是几百 KB 到 MB，模型上下文超限、费用高、首字延迟大。record.ts 的 RECORD_MAX_EVIDENCE=200 只限制落库，不限制发给模型。
- 触发路径：在 3081 开启选择模式，按住 Ctrl 连续选 200 张卡片，然后提问。
- 证据：
~~~ts
191| export function renderEvidence(evidence: readonly unknown[] | undefined, hasMainline = false): string {
192|   const items = (evidence ?? []).filter(isRecord);
...
211|   const lines: string[] = ['【用户选中的步骤依据】'];
212|   items.forEach((item, index) => {
...
215|     const summary = textOf(item.summary);
...
223|     if (summary) lines.push('- 内容：' + summary);
224|     else lines.push('- 内容：' + INSUFFICIENT_MARKER + '（这条依据没有可读的摘要）');
225|     if (!summary || tier === EVIDENCE_TIERS[2]) {
226|       lines.push('- 处理要求：关于这条依据，你必须写明「' + INSUFFICIENT_MARKER + '」，不得推测其内容。');
227|     }
228|   });
229|   return lines.join('\n');
~~~
- 判定理由：§5.1 要求不能无节制把上下文交给模型；记录层已有 cap，提示词层却没有，属于同一约束只做了一半。
- 修复代价：小/中（buildMessages 复用 RECORD_MAX_EVIDENCE 或按总字节截断；超出时留痕）
- 波及：模型上下文、费用、响应时间、选中多张的可用性。
- 用户自测：多选大量卡片提问；若请求体/模型输入明显巨大、模型报上下文超限，即确认。

### A-15 maxHistoryTurns 传 0 会变成「全部历史」
- 类型：真bug
- 严重度：P3
- 位置：src/host/prompts.ts:315-316、322
- 现象：Math.max(0, deps.maxHistoryTurns ?? 6) 允许 0，但 turns.slice(-0) 在 JS 中等价于 slice(0)，会把全部历史发给模型，而不是 0 轮。
- 触发路径：任何调用方传 maxHistoryTurns: 0（将来做配置/测试；当前生产默认 6）。
- 证据：
~~~ts
315|   const turns = (deps.history ?? []).filter(turn => textOf(turn?.question) || textOf(turn?.answer));
316|   const limit = Math.max(0, deps.maxHistoryTurns ?? 6);
...
322|   turns.slice(-limit).forEach((turn, index) => {
~~~
实测：3 条 history + maxHistoryTurns:0 -> 3 条历史消息仍全部在 messages 里。
- 判定理由：参数语义是「最多带几轮」，0 应当是合法的最小值；当前实现把 0 变成无限。
- 修复代价：小（if (limit === 0) return; 或 turns.slice(Math.max(0, turns.length - limit))）
- 波及：历史上下文、测试、未来配置。
- 用户自测：单测传 0，断言 messages 中无历史 user/assistant 对；当前会失败。

### A-16 成功记录的 startedAt 写成完成时刻，失败记录却写开始时刻
- 类型：反直觉
- 严重度：P3
- 位置：src/host/routes.ts:147、170、190-195
- 现象：now 在 try 开头初始化，模型返回后又重新赋值；saveRecord 用 startedAt: now，所以成功记录的开始时间等于结束时间。异常路径沿用开头的 now，两类记录时间语义不一致；客户端按 startedAt 显示历史时间，compact 时间线也用它比较。
- 用户预期：startedAt 是用户按下发送的时间。
- 实际情况：成功记录显示的是回答完成的时间，长回答尤其明显。
- 触发路径：任何一次成功 ask；单测让 stream 延迟 80ms，记录 startedAt 比请求开始晚约 124ms。
- 证据：
~~~ts
147|           let now = new Date().toISOString();
...
170|             now = new Date().toISOString();
...
190|             await service.saveRecord?.(id!, {
191|               id: requestId, kind: op, status: cleanSuccess ? 'complete' : 'interrupted', complete: cleanSuccess, question,
192|               answerText: 'text' in result ? result.text : result.summary, reasoningText: result.reasoning, usage: result.usage,
193|               evidence: content.evidence, tools: content.tools, images: content.images,
194|               startedAt: now, updatedAt: now,
~~~
- 判定理由：字段名与客户端展示都表明是开始时间；同一字段在成功/失败路径语义不同，会让历史排序/时间线出现不可解释的偏差。
- 修复代价：小（在 try 开头单独 const startedAt = now，成功路径保留 now 给 updatedAt）
- 波及：历史时间显示、compact 时间线、occupancy carriedRecords 的压缩前后判断。
- 用户自测：提一个耗时几秒的问题，查看历史记录时间；若显示的是回答完成时刻而不是发送时刻，即确认。

### A-17 单会话 records 只增不减，历史文件与 /state 解析成本无界增长
- 类型：设计取舍（风险）
- 严重度：P2
- 位置：src/index.ts:585-599；src/host/persistence.ts:82-114
- 现象：saveRecord 只 state.records.push(record)，没有保留上限/归档/按时间分段；compact 日志也永久写盘。每条记录可带最多 256KB 的 evidence/tools/images。长期使用后单个 session JSON 可持续增长到很大，/state、/history 每次都 JSON.parse 整个文件，浮窗首屏和每次写盘都会变慢。
- 触发路径：同一会话持续使用 1000 次以上，尤其包含工具证据；打开浮窗或查看历史。
- 证据：
~~~ts
585|     saveRecord: async (id: string, record: unknown) => {
586|       if (!store) return;
587|       if (await isForgotten(id)) return;
...
596|       await store.update(id, (state: any) => {
597|         if (state.archived) return;                 // 双保险：磁盘上标记了归档也拒绝
598|         state.records.push(record as any);
599|       });
600|     },
~~~
loadState/loadHistory 都先 store.load(id)，而 persistence.load 对整份文件 readFile + JSON.parse。
- 判定理由：这不是立即的功能错误，但「记录永久保存」与「每次全量读」组合会随使用时间退化；目前没有 retention 策略或分页存储。
- 修复代价：中（按会话保留最近 N 条/最大字节；旧记录归档到单独文件；或按记录分文件）
- 波及：存储、首屏延迟、归档扫描、备份。
- 用户自测：造 1000 条记录后打开浮窗，测 /state 与文件大小；若明显变慢，即确认。

### A-18 capByBytes 每删一条就重新序列化整个数组，O(n²) 阻塞
- 类型：真bug（性能）
- 严重度：P2
- 位置：src/host/record.ts:218-236
- 现象：size() 每次调用都 stableJson 整个剩余 evidence/tools/images；while 每次只删一条，最坏要循环几百次。用户选中 200 条 4KB 摘要时，buildRecordContent 实测 729ms；10KB 时 1610ms，都在请求线程里同步执行，期间事件循环被阻塞。
- 触发路径：一次提问带上大量选中依据，回答结束后 routes 调 buildRecordContent 组装落库内容。
- 证据：
~~~ts
222|   let dropped = 0;
223|   const size = () => Buffer.byteLength(stableJson({ evidence: state.evidence, tools: state.tools, images: state.images }), 'utf8');
224|   while (size() > maxBytes) {
225|     if (state.tools.length) { state.tools = state.tools.slice(0, -1); dropped++; continue; }
226|     if (state.images.length) { state.images = state.images.slice(0, -1); dropped++; continue; }
227|     if (state.evidence.length) { state.evidence = state.evidence.slice(0, -1); dropped++; continue; }
228|     break;
229|   }
~~~
实测 record.buildRecordContent：200x4000B -> 729ms；200x10000B -> 1610ms。
- 判定理由：截断本应是 O(n) 的预算操作；当前在正常可选的证据数量内就能造成可见卡顿，且发生在每个回答结束时。
- 修复代价：小（先按单条估算/累计字节，确定切入位置后只序列化一次；或二分）
- 波及：回答结束延迟、UI 卡顿、超大证据场景。
- 用户自测：多选大量卡片后提问，观察回答完成瞬间是否卡住半秒以上；或单测计时。

## 存疑（需实测确认，不计入 18 条）

1. writeAtomic 没有 fsync（持久化崩溃窗口）：persistence.ts:248-259 是 temp file + rename，rename 对读者原子，但没有 fsync(file) 或 fsync(dir)；进程崩溃/断电后最后一条 saveRecord 可能丢失。验证：在 save 返回后立刻断电/杀进程模拟，或注入 fsync 缺失；需要真实故障注入，当前不能仅凭代码判定是否达到用户可接受级别（P2/P3 风险）。
2. verifyWorkspacePath 返回 target 而不是 realTarget，存在 TOCTOU：evidence.ts:76-87 先 ensureContained，随后用未解析符号链接的 target 去 stat/readFile；如果工作区内的符号链接在两步之间被替换，仍可能读到工作区外文件。验证：循环替换 symlink 指向外部文件，同时调用 explain_read_workspace_file，检查 evidence 是否出现外部内容。COVERAGE.md 也标注「TOCTOU 链接替换压力待补」。
3. 中文 token 估算按 4 chars/token 会低报：occupancy.ts:27-29 与 session-context.ts:289 用 text.length/4，中文实际 token 密度接近 1 字/token；圆环可能显示远低于真实占用。验证：用真实 tokenizer 对一段中文 system prompt+问答对比 estimate；若偏差数倍，则确认。

## 静默失败补充（catch 吞错点，不单列编号）

- record.buildRecordContent 的 catch 直接返回 {evidence:[],tools:[],images:[]}，不记录原因（record.ts:272-274）：一旦序列化/形状异常，用户只看到「查看完整内容」为空，不知道证据被丢弃。
- routes.ts:245 的 catch { /* 落库失败不得连累事件发送 */ } 把 saveRecord 失败完全吞掉；用户只看到 error 事件，重载后没有记录，也没有服务端日志。
- persistence.listSessionIds 的 catch { return [] }（persistence.ts:162-164）让归档扫描在目录不可读时静默变成空扫描。
- index.isForgotten 的 catch { return false }（index.ts:256）在读取失败时把写入闸门放开，可能让保存继续走。
- session-context.readMainlineContext 的 catch { return undefined }（session-context.ts:323-325）让主 agent 读取失败和「本来就没有内容」不可区分，进一步触发 A-05 的 pending 循环。
