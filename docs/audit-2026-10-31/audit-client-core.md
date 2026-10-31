# 客户端非 UI 逻辑审计（audit-client-core）

- 仓库：/mnt/d/projects/dsh-explain-assistant（v0.3.0 工作区现状）
- 审查范围：src/client/{api,archive-watch,busy-gate,entry,exit-anim,header-badge,history-window,index,markdown,open-gate,pick-marks,selection,store,window}.ts
- 方式：只读源码 + 只读 Node/fixture 复现；未修改任何源码，未 build，未启动或重启 3081/3082。
- 结论：未发现 markdown XSS；history-window 纯逻辑边界未发现硬缺陷；以下按严重度和类别列出可复核项。

## A. 真 bug（可复现）

### A-01 展开记录的“继续加载”缺少记录身份/请求代次守卫
- 类型：真 bug / 竞态
- 严重度：P1
- 位置：src/client/index.ts:864-903（关键在 873、895-900）
- 现象：用户收起一条记录的完整内容，或切换去展开另一条记录后，先前发出的“继续加载”回包到达时，已收起的面板会自己重新出现；更严重时，B 记录的展开区里会出现 A 记录的依据，而 recordId 仍是 B。
- 触发路径：在 3081 展开记录 A，点“继续加载”，在回包到达前立刻点“收起”（或展开 B）；让 A 的分页请求延迟返回。
- 证据：代码没有校验 latest.recordId、cursor 或请求代次：
    const latest = assistantRegistry.get(id).historyDetail || detail;
    const previous = isObject(latest.record) ? latest.record : {};
    ...
    record: { ...previous, ...record, evidence: merge(...), tools: merge(...), images: merge(...) }
  只读 fixture 复现（A 第二页延迟，先打开 B 再放行 A）：最终 historyDetail 为 recordId="B"，但 record.id="A"，evidence 为 [{"id":"b0"},{"id":"a20"}]。收起路径同样会在迟到回包后从 undefined 重新生成 A 的 detail。
- 判定理由：分页回包属于发起时的记录；回包不能写入另一条记录，也不能撤销用户已经执行的收起。这不是可接受的设计选择。
- 修复代价：中（index.ts 单文件约 20 行，增加 recordId + cursor/request token 校验；同一记录的正常下一页仍需合并）。
- 波及：历史展开、收起、切记录、分页去重；不要误伤同一记录连续翻页。
- 用户自测：3081 展开 A → 点“继续加载” → 立刻收起；让 A 的回包延迟 1–2 秒到达（仍在 10 秒读超时内）仍应保持收起；再展开 B，检查依据里没有 A 的内容。

### A-02 多个 /state 刷新并发时，晚到的旧响应覆盖新状态
- 类型：真 bug / 前后端状态合并覆盖
- 严重度：P1
- 位置：src/client/index.ts:451-453、506-578（关键 578 的无条件 update）
- 现象：打开浮窗时连点 ?，或“打开刷新”和“回答完成后的刷新”交叠，后返回的旧响应会把新模型、新占用、较新的记录状态覆盖回去；历史顺序也可能变成新记录在前、旧记录在后。
- 触发路径：3081 用慢 /state 打开会话 A，快速连点两次入口（或完成一次回答触发第二次刷新）；让第二次响应先回、第一次响应后回。
- 证据：refreshState 没有序号、没有取消上一次请求；ensureState 的 inFlightState 只用于 ensureState 去重，open/retry/完成后的 refreshState 都绕过它。核心代码：
    const task = withStateTimeout(callApi(() => api.state(sessionId, controller.signal)), ...).then(result => {
      ...
      assistantRegistry.update(sessionId, patch);
    });
  只读 fixture 复现：第二次响应先写 model="new"、occupancy=77、records=["new"]；第一次旧响应后写 model="old"、occupancy=10、records=["new","old"]。
- 判定理由：同一会话的较新响应必须胜出，旧响应不能回退用户刚选中的模型或刚拿到的占用。
- 修复代价：中（增加每会话 refresh generation/AbortController，旧响应到达时直接丢弃；保留 timeout 清理）。
- 波及：模型选择、占用环、未读、历史游标、records 合并；需避免丢掉合法的旧分页记录。
- 用户自测：用慢 host 连点两次 ?，观察模型/占用是否回退；或在 DevTools 里延迟第一条 /state 响应。

### A-03 归档 forget 清空后没有隔离在途状态与回答，迟到回包会把记录写回来
- 类型：真 bug / 竞态 + 生命周期
- 严重度：P1
- 位置：src/client/index.ts:925-935（forget）；配合 451-578（refreshState）和 124-228（applyEvent）
- 现象：会话被归档后记录先清空，随后一个迟到的 /state 响应或 SSE complete 又把 records、text、phase 写回；本地出现 archived=true 但仍有记录的幽灵会话。
- 触发路径：打开会话触发慢 /state（或正在回答）→ 归档该会话 → 在回包/complete 到达前等待。
- 证据：forget 只有：
    await api.forget(sessionId);
    assistantRegistry.update(sessionId, { records: [], ..., archived: true, ... });
  但没有 abort active request、没有取消 in-flight refreshState、refreshState 和 applyEvent 也没有 archived 守卫。只读 fixture 复现：forget 后 records=0；迟到 /state 到达后 records=1；迟到 complete 到达后 records=1、phase=complete。
- 判定理由：归档是终态；归档之后任何旧请求都不能重新创建用户可见记录，否则用户会看到“已经删掉的内容”。
- 修复代价：中（forget 中 abort active + 标记/取消 in-flight state，refreshState/applyEvent 检查 archived；顺带清 historyDetail/evidence）。
- 波及：archive-watch、host forget、正在流式回答、状态刷新、未读；必须保持正常“归档后不重建磁盘文件”。
- 用户自测：提问中归档该会话，等回答/状态回包；记录应保持空，且不应再出现回答气泡。

### A-04 未读预取只对 true 做过期判断：false 会清掉新未读，true 会在窗口已打开时点亮
- 类型：真 bug / 未读状态竞态
- 严重度：P2
- 位置：src/client/index.ts:613-634
- 现象：冷启动的未读预取（primeUnread）慢返回时，可能把用户刚产生的新未读清掉；反过来，窗口已经打开时，预取返回 true 又可能把未读点点亮。
- 触发路径：页面刚加载，HeaderButton 发起慢 /state；期间完成一条回答（本地 unread=true），随后预取返回 unread=false；或先打开窗口，再让预取返回 unread=true。
- 证据：只拦截 true 且“预取发起后打开过”的情况：
    if (payload.unread === true && (lastOpenedSeq.get(sessionId) ?? 0) > issuedSeq) return;
    assistantRegistry.update(sessionId, { unread: payload.unread });
  没有检查当前 state.open，也没有为 false 做“是否晚于本地新回答”的版本判断。只读 fixture 复现：本地先置 unread=true，迟到的 false 预取把它改成 false；open=true 时预取 true 会得到 open=true/unread=true。
- 判定理由：未读是用户可见状态；预取是补充信息，不应覆盖比它更新的本地事实。
- 修复代价：小（index.ts 一处：请求带序号/时间，响应同时检查 state.open 和本地 revision）。
- 波及：header 徽标、打开/关闭、mark-read、冷启动；不要让正常“打开后新完成回答仍算未读”失效。
- 用户自测：在 3081 用慢 /state 打开页面，期间完成一条回答；检查徽标是否被迟到的预取错误清除，以及窗口打开时是否仍亮未读点。

### A-05 occupancyPending 的自动补取没有次数上限，实际是每 3 秒无限轮询
- 类型：真 bug / 定时器生命周期
- 严重度：P2
- 位置：src/client/index.ts:439-448、579-580
- 现象：只要 /state 持续返回 occupancyPending=true，客户端每 3 秒自动重取一次，永不停止；窗口开着就一直打状态接口，可能反复覆盖占用和触发其他刷新。
- 触发路径：宿主主 agent 上下文读取持续超时（大上下文、慢会话）→ 打开浮窗 → 观察 /state 请求。
- 证据：scheduleOccupancyRefresh 只检查“已有 timer”，没有 attempted 计数；refreshState 成功后再次满足条件会重新 schedule：
    if (payload.occupancyPending === true && !active.has(sessionId)) scheduleOccupancyRefresh(sessionId);
  只读 fixture（occupancyRetryDelayMs=5，state 恒返回待补）实测 55ms 内调用 11 次；默认 3000ms 即每 3 秒一次，直到关闭窗口。注释写“只补一次”，实现不是。
- 判定理由：一次性的补取变成无界轮询，且没有任何退避；用户会在后台承受持续请求。
- 修复代价：小（增加 attempt 上限/指数退避，或在连续 pending 后停止，窗口关闭时清理）。
- 波及：状态刷新竞态、CPU/网络、占用显示；不要阻止用户手动重试。
- 用户自测：用慢 host 或大上下文让 occupancyPending 常为 true，保持浮窗打开，Network 面板应只看到有限次请求（当前会每 3 秒一次）。

### A-06 “更早历史”加载失败后，成功重试不清 error，错误条永久残留
- 类型：真 bug / 状态清理
- 严重度：P2
- 位置：src/client/index.ts:789-804
- 现象：用户点“查看更早历史”遇到网络失败，再点一次成功拿到记录，但顶部仍显示“网络断了/读取失败”，直到重新打开或刷新。
- 触发路径：3081 打开历史 → 第一次 history 请求失败 → 第二次成功。
- 证据：成功分支只写 records/hasEarlier/historyCursor/loadingEarlier，没有 error: undefined；catch 明确写入 error。只读 fixture 复现：第一次失败后 error="网络断了"；第二次成功 records=1，error 仍为“网络断了”。
- 判定理由：错误属于上一次操作，成功完成后应清除；否则界面持续说假话。
- 修复代价：小（成功 update 加 error: undefined，或把分页错误独立成字段）。
- 波及：历史分页、顶部错误条、其他操作写入的 error；要避免清掉当前回答真正需要的错误。
- 用户自测：断网/DevTools 让第一次 history 失败，恢复后重试成功；错误条应消失。

### A-07 证据摘要截到 4000 字却标 truncated:false
- 类型：真 bug / 数据完整性
- 严重度：P2
- 位置：src/client/selection.ts:65
- 现象：选中一段超过 4000 字的工具输出/步骤后，浮窗只拿到前 4000 字，但元数据告诉界面/宿主“没有截断”，用户和模型都以为依据完整。
- 触发路径：在主对话选择一张 textContent 超过 4000 字的工具卡或步骤。
- 证据：
    summary: (element.textContent || "").trim().slice(0, 4000),
    ...
    truncated: false,
  只读 fixture 实测：5000 字 card 返回 summary.length=4000、truncated=false。overlay 只有在 truncated===true 时才显示“原始依据仍有未取回的部分”。
- 判定理由：截断必须留痕；这是数据真实性问题，不是展示细节。
- 修复代价：小（先取原始 text，再按长度计算 truncated；或同步设置 incomplete）。
- 波及：证据序列化、宿主 prompt 的截断警告、overlay 提示、用户判断依据是否完整。
- 用户自测：选一张很长的工具输出，展开“完整内容”，应看到“仍有未取回部分”（当前没有）。

### A-08 初始化异常路径只返回 no-op，不回收已创建的 style/plugin/archive watcher
- 类型：真 bug / 资源泄漏
- 严重度：P2
- 位置：src/client/entry.ts:34-44、417-442
- 现象：插件初始化中途失败时，页面可能已经多了样式标签、一个仍然存活的 plugin/registry 和归档订阅；错误被吞掉后没有任何清理，反复初始化会叠加。
- 触发路径：ctx.slots.register/inject 在 style 已 append 后抛错（例如重复 id、slot 冲突、热重载时序），或 archive watcher 构造/注册阶段出现异常。
- 证据：
    const style = document.createElement("style");
    ...
    document.head.appendChild(style);
    ...
    } catch (error) {
      console.error("[dsh-explain-assistant] client init failed", error);
      return () => undefined;
    }
  catch 里没有 style.remove()、archiveWatcher.dispose() 或 plugin.dispose()；这些局部变量都在 try 作用域内，清理函数返回空。
- 判定理由：初始化失败也必须回收已获得资源；返回 no-op 等于把泄漏留给宿主生命周期。
- 修复代价：小到中（把资源声明提到 try 外，catch 中逐项清理；并用幂等标志防重复）。
- 波及：插件重载、样式叠加、归档订阅、全局 registry；不要影响正常 cleanup。
- 用户自测：用 fake ctx 让 slots.register 抛错，检查 document.head 中是否仍残留 data-dsh-explain-assistant=styles 的 style（当前会残留）。

### A-09 部分读请求没有超时/取消：超时只 race，底层 fetch 继续；selectModel 等没有超时
- 类型：真 bug / 风险
- 严重度：P2
- 位置：src/client/api.ts:94-106、181、186-189；src/client/index.ts:340-346、774、827、869
- 现象：selectModel、markRead、geometry、forget、cancel 以及冷启动 primeUnread 的状态读取都可能永久 pending；history/detail 的 10 秒超时只让界面失败，底层请求并不会取消，用户重试会叠加请求。
- 触发路径：宿主处理 select-model 或 mark-read 时挂起；或 history 响应超过 10 秒后用户重试。
- 证据：json 只是裸 fetch：
    response = await fetch(url, { credentials: "same-origin", ...init });
  callers 不传 signal；withReadTimeout 的注释和实现都承认没有 controller，只 Promise.race：
    return Promise.race([task, timeout]).finally(...)
  因而超时后 task 仍会继续跑；primeUnread 直接 api.state(sessionId) 没有 signal/超时。
- 判定理由：可见的乐观状态（选模型）或后台清理不能在无终止点的情况下永远悬挂；这是用户明确要求的 fetch 超时/取消边界。
- 修复代价：中（统一给 json 加 AbortSignal.timeout 或请求包装，记录并 cancel 控制器；readTimeout 同步 abort）。
- 波及：模型选择、未读、几何、归档、历史详情；注意取消后不要把 AbortError 显示成业务失败。
- 用户自测：DevTools 把 select-model 请求挂起，界面会一直显示已选但宿主未确认；history 超时后重试，Network 仍能看到旧请求。

## B. 反直觉（用户预期与实际行为不一致）

### B-01 侧栏切换主对话时浮窗会消失，切回来又自动出现
- 类型：反直觉 / 会话生命周期
- 严重度：P1
- 位置：src/client/entry.ts:96-106；src/client/index.ts:1016-1019；src/client/open-gate.ts:65-68
- 用户预期：浮窗打开时切换到另一个主对话，浮窗应保持打开并显示新会话（代码注释也写着“切会话不藏窗”）。
- 实际情况：HeaderButton 的 effect 只 setSession，不迁移 open；新会话的 initial().open 为 false，shouldMountOverlay 直接返回 false。若切回 A，A 的 open 仍是 true，于是浮窗又自动出现。
- 触发路径：3081 在会话 A 点 ? 打开浮窗 → 从左侧会话列表切到 B（不点 B 的 ?）→ 再切回 A。
- 证据：
    selectedId = id;
    plugin.setSession(id, props?.cwd);
    ...
    registry.setCurrent(undefined);
  以及 setSession 只有：
    selectedSession = id ? { id, cwd } : undefined;
    assistantRegistry.setCurrent(id);
  没有任何 open/visible 状态迁移；open-gate 在 input.open !== true 时直接不挂载。
- 判定理由：同一“浮窗”在会话切换时出现又消失，且伴随 A 的旧 open 状态残留；这不是一致的产品语义。若产品要“每个主对话各有一个窗口”，也需要显式规则和 UI，而不是这个副作用。
- 修复代价：中（明确全局浮窗 vs 每会话窗口；在 setSession 时迁移/关闭 open，或引入独立 visible 状态）。
- 波及：会话切换、未读、草稿、几何、historyDetail；不要把一个会话的记录带进另一个会话。
- 用户自测：打开 A 的浮窗，切到 B 看是否还在；再切回 A 看是否自动出现。当前应先消失、后自动出现。

### B-02 浏览器窗口缩小/换屏后，浮窗不会重新 clamp 到视口内
- 类型：反直觉 / 几何
- 严重度：P2
- 位置：src/client/window.ts:38-48、237-248
- 用户预期：浏览器窗口变小或换到更小屏幕后，浮窗应自动缩回可视区域，至少标题栏和关闭按钮仍可点到。
- 实际情况：clampGeometry 只在创建、拖动/缩放结束和 updateOverlay 的 state.geometry 变化时执行；window.ts 没有 resize 监听，缩小浏览器后浮窗保持旧坐标/尺寸，可能整个跑到视口外。
- 触发路径：3081 把浮窗放到右下 → 把浏览器窗口宽度缩到原来一半（或切到小屏）。
- 证据：attachWindowInteractions 只注册 pointerdown/pointermove/pointerup/pointercancel/keydown，没有 window.resize；只读 fake DOM 实测初始 600,400 400x300，视口改为 500x400 后 style 仍是 600px/400px/400px/300px。
- 判定理由：浮窗位置持久化必须适配视口变化；否则用户会以为窗口消失且无法操作。
- 修复代价：小（增加 resize 监听，调用 clampGeometry；保存时也 clamp）。
- 波及：拖拽、缩放、几何持久化、切会话的 previousGeometry；注意拖动中的 resize 不要打断用户。
- 用户自测：把浮窗拖到右下角，缩小浏览器；当前浮窗仍在旧坐标，应该自动回到可视区。

### B-03 401/403 或登录页返回时，状态区显示英文 JSON 解析错误和 HTML 片段
- 类型：反直觉 / 错误文案
- 严重度：P2
- 位置：src/client/api.ts:83-103（尤其 readJsonResponse 与 JSON_PARSE_FAILED）
- 用户预期：登录/token 失效时看到“登录已失效，请刷新页面”之类中文提示，并知道要重新登录。
- 实际情况：认证中间件返回 HTML 登录页时，客户端先执行 JSON.parse，抛出 “Invalid JSON response from /api/...: <html>login</html>”，stateError 再拼成中文前缀，用户看到一段英文和 HTML。
- 触发路径：3081 清除/过期会话 cookie，点击 ? 打开浮窗。
- 证据：只读 mock 实测 401 + text/html 返回：code=JSON_PARSE_FAILED、status=401、message="Invalid JSON response from /api/explain-assistant/state?...: <html>login</html>"。json 在解析后才检查 response.ok，因此 401 的语义被解析失败覆盖。
- 判定理由：401/403 是认证状态，不是 JSON 语法问题；错误应可操作、中文、不能把 HTML 原文塞进用户界面。
- 修复代价：小（先按 status 映射 401/403，再尝试解析 JSON；text fallback 只保留短摘要）。
- 波及：state、ask、history、select-model 等所有 JSON 请求；不要把宿主真实业务错误误映射成登录失效。
- 用户自测：删除登录 cookie 后点 ?；应看到中文重新登录提示，当前会看到英文 Invalid JSON 和 HTML。

### B-04 SSE 断线/无终止事件时显示英文内部错误和 URL
- 类型：反直觉 / SSE 错误处理
- 严重度：P2
- 位置：src/client/api.ts:119-175（尤其 174）；src/client/index.ts:725-740
- 用户预期：回答中途网络断开时，应明确说“连接中断，已保留/未保留部分回答”，中文且可重试。
- 实际情况：stream 结束时若没有 complete/error/aborted，抛出 “SSE stream ended without a terminal event at /api/explain-assistant/ask”；run 的 catch 把 errorMessage 原样写进 current.error，用户看到英文内部错误和 API URL。
- 触发路径：3081 回答流式中断网、杀掉连接，或代理返回 200 后提前关闭流。
- 证据：只读 mock 发送 start 后关闭流，实测 AssistantApiError code=SSE_TERMINAL_MISSING、message="SSE stream ended without a terminal event at /api/explain-assistant/ask"。
- 判定理由：断线是正常网络事件，应映射成用户可理解的中文；技术 URL 只应进日志。
- 修复代价：小（api 或 index 将 SSE_TERMINAL_MISSING/SSE_CONNECTION_FAILED 映射为中文，并保留部分文本）。
- 波及：流式回答、错误状态、重试/停止按钮；不要吞掉真正的服务端 error message。
- 用户自测：回答到一半断网；当前错误条应显示英文 terminal event/URL，修复后应显示中文断线说明。

## C. 设计取舍 / 风险（不是立刻可复现的功能坏，但会积累问题）

### C-01 SSE 收到 complete 后不停止读取，active 请求要等服务器 EOF 才释放
- 类型：设计取舍 / SSE 生命周期风险
- 严重度：P2
- 位置：src/client/api.ts:136-174
- 现象：complete 只把 terminal=true，循环仍继续 reader.read；若服务器或代理在 complete 后保持连接（keep-alive、close 丢失），ask Promise 不 resolve，active Map 不释放，发送按钮会一直认为“已有请求”，占用刷新也会被 active 守卫挡住。
- 触发路径：用代理保持 SSE 连接，或服务器 close 延迟；host 当前正常路径会在 complete 后 close，所以 3081 默认路径不一定触发。
- 证据：
    if (type === "complete" || ...) terminal = true;
    ...
    while (true) { const read = await reader.read(); if (read.done) break; ... }
  terminal 只在循环结束后检查。只读 ReadableStream mock（complete 后不 close）50ms 后 ask Promise 仍未 settle。
- 判定理由：终止事件就是协议终点；不应把“服务器是否及时 close”当作客户端完成条件。
- 修复代价：小（consume complete 后 break/cancel reader；或在 run 的 complete 分支立即释放 active，但需保证后续事件不写入）。
- 波及：ask/compact、active 锁、停止按钮、占用刷新；不要提前 cancel 掉服务端仍需发送的收尾事件。
- 用户自测：用 DevTools/代理延迟关闭 SSE 流，complete 已到但发送按钮仍不可用，即为触发。

### C-02 定稿 Markdown 缓存有条目上限但单条无字节上限，关闭浮窗也不清理
- 类型：设计取舍 / 内存风险
- 严重度：P2
- 位置：src/client/markdown.ts:1016-1061
- 现象：每条历史回答的完整文本和 Node[] 都进入模块级 settledCache；SETTLED_CACHE_MAX=40 只限制条数，单条大回答没有上限，且 clearSettledCache() 全仓没有调用点。长会话后关闭浮窗，内存仍保留最多 40 棵完整 DOM。
- 触发路径：在长会话中打开多条长回答的历史 → 关闭/重开浮窗；或用大 Markdown 回答反复渲染。
- 证据：
    const settledCache = new Map<string, Node[]>();
    const SETTLED_CACHE_MAX = 40;
    ...
    settledCache.set(cacheKey, nodes);
  clearSettledCache 只有导出定义，没有 import/调用。
- 判定理由：缓存命中是性能设计，但应在会话关闭/插件 dispose 时可清，或设置总字节预算；40 条 × 大回答会明显抬内存。
- 修复代价：小（加字节预算/LRU，overlay dispose 或 session 关闭时 clear；不要清理当前正在显示的行）。
- 波及：Markdown 性能、历史重绘、切会话；清缓存不能让已挂载节点消失。
- 用户自测：打开多条超长历史回答，关闭浮窗后用 Chrome Memory 快照看 detached/Node 数；或检查 settledCacheSize 是否仍为 40。

### C-03 AssistantRegistry.states 没有淘汰路径，长会话累积完整 records/tools
- 类型：设计取舍 / 无界增长
- 严重度：P2
- 位置：src/client/store.ts:181-196
- 现象：每个 sessionId 首次 get 后永久留在 Map；remove() 全仓没有调用点。用户在同一页面切换很多主对话而不刷新时，每个会话的 records、tools、historyDetail、evidence 都留在内存。
- 触发路径：在 3081 连续打开/切换大量会话（尤其每条有长历史），用调试器查看 registry.sessions().length。
- 证据：
    private states = new Map<SessionId, AssistantClientState>();
    ...
    remove(sessionId: string): void { this.states.delete(sessionId); ... }
  remove 是唯一删除入口，但 grep 全仓无调用；forget 只清 records，不删 state。
- 判定理由：单实例多会话的缓存需要上限或归档清理；否则内存随使用时长单调增长。
- 修复代价：中（按最近使用淘汰，或会话关闭/归档时 remove；注意多组件仍可能读同一 state）。
- 波及：多会话切换、未读、历史窗口、归档；删除 state 前要确认无 header/overlay 订阅。
- 用户自测：连续切换 50 个会话，观察 registry.sessions().length 只增不减；刷新页面才归零。

## D. 存疑（需实测确认，先不当作已确认 bug）

### D-01 重复 apply/热重载没有幂等保护，可能出现两套入口和两个浮窗
- 类型：风险（需确认宿主生命周期）
- 严重度：P2
- 位置：src/client/entry.ts:34-44、427-438；src/client/index.ts:90-91
- 现象：apply 内没有模块级 active 标志；每次调用都会创建新 style、新 createClientPlugin、注册新的 HeaderButton/OverlayBridge。若宿主在旧 cleanup 前调用第二次 apply，页面上会出现两套样式、两个入口组件和两个共享同一 assistantRegistry 的 OverlayBridge。
- 触发路径：热重载/重复 inject，或测试/宿主同时加载两次同一插件。
- 证据：apply 开头只有 React/document 能力检查，没有 “已初始化” 守卫；style 直接 append，ctx.slots.inject 直接注册；plugin 是局部变量。
- 判定理由：如果 Cordis 保证 apply 前一定先执行旧 cleanup，这不是 bug；如果热重载会重叠，则会双窗。当前代码没有防御。
- 修复代价：中（模块级单例 guard 或 ctx.effect cleanup 里释放；注册 id 也应有唯一性检查）。
- 波及：插件加载、header、overlay、archive watcher、样式；不要破坏测试中多实例创建。
- 用户自测：fake ctx 连续调用 apply 两次并统计 entries，应只有 1 个 header + 1 个 overlay；当前会翻倍。

### D-02 取消选择后 data-ea-pick 锚点不删除，宿主节点复用时可能复用旧 pickId
- 类型：风险（需真 DOM 验证）
- 严重度：P3
- 位置：src/client/pick-marks.ts:70-80（unmark 只删 MARK/INDEX）
- 现象：取消选择 200ms 后，data-ea-picked 和 data-ea-pick-index 会清掉，但 data-ea-pick=旧锚点仍留在宿主卡片上；如果宿主复用该节点渲染另一条记录，ensurePickId 会直接返回旧锚点。
- 触发路径：选中一张卡 → 取消 → 等 250ms 检查 DOM；或让宿主在同节点上切换记录后再次选择。
- 证据：
    node.removeAttribute(MARK);
    node.removeAttribute(INDEX);
    // 没有 node.removeAttribute(ANCHOR)
  ensurePickId 的逻辑则是 if (existing) return existing。
- 判定理由：锚点是为了在选中期间找回节点；取消后继续留着既污染宿主 DOM，也可能让新选择继承旧身份。是否真的复用节点取决于宿主 key 策略，需要真 DOM 验证。
- 修复代价：小（unmark 完成时删除 ANCHOR；若需要跨重绘找回，应改成按选中状态维护的映射，而不是永久属性）。
- 波及：高亮、编号、取消、选中去重；删除锚点前要确认不会让正在淡出的元素丢失过渡。
- 用户自测：选中后取消，250ms 后检查卡片仍有 data-ea-pick；再选同节点另一条内容，看 pickId 是否还是旧值。

## 复核备注（非发现）

- markdown.ts：全程 createElement/textContent，无 innerHTML；链接只放行 http/https/mailto，javascript/data/file/blob 均退回文本，未发现 XSS。唯一安全边界是 http/https 图片会自动加载（隐私/追踪面），不是注入。
- history-window.ts：resolveHistoryWindow 的 tail、expand、id 锚定、上限 12 的边界与现有测试一致，未发现新的分页缺陷；本次真实分页问题在 index.ts 的回包身份守卫。
- exit-anim.ts：beginExit 的定时器只有 220ms 且删除前检查父节点，连开连关会保留短暂节点但没有发现永久句柄泄漏；如果要严格化，可把 timer 句柄纳入宿主生命周期。
- header-badge.ts：本次未发现未读“计数重复加”的实现（界面只有 dot，不是计数）；watchUnread 的初始读取/订阅清理逻辑本身正常，问题集中在 index.ts 的 primeUnread 与 refreshState。
- busy-gate.ts：setTimeout/clearTimeout 已通过箭头包装规避 Illegal invocation；延迟 150ms/最短 300ms 的状态机本地检查未见非法迁移。