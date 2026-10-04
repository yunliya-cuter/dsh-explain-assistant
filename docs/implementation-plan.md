# DSH 小助手解释插件实现计划

## 1. 目标与范围

在 /mnt/d/projects/dsh-explain-assistant 创建独立标准 DSH 混合插件，为非程序用户提供不打扰主 agent 的解释入口：主对话标题栏右上角只有一个“？”；点击后在 shell.overlay 打开可移动、可缩放的小助手窗口。每个主对话拥有独立的小助手历史、模型选择、请求、未读状态、草稿、证据和窗口几何。切换主对话只切换可见投影，不取消其他对话的后台工作。

首版只允许观察和解释：读取主对话已经记录的事件/工具数据、只读读取当前绑定工作区、只读读取图片、调用小助手自己的 LLM。禁止修改 DSH 核心、主 agent 输入/模型/上下文、工作区文件、进程、端口、服务、主 agent 消息或主 agent 工具执行。

成功标准：入口、并行隔离、认证路由、只读权限、证据时点、原始 reasoning、工具轨迹、图片快照、SSE、compact、持久化、归档清理和浏览器验收均符合已确认决策。

## 2. 包结构与构建

只修改插件目录，不修改 DSH 核心、docs/business-logic.md 或其他插件。参考现有混合插件的 package、ModuleLoader 和 cordis.patch.yml 模式，先逐项核对公开 API。

建议文件：

- package.json：exports、peerDependencies、DSH bundle patch、web client 配置以及 check/typecheck/build/test/package 脚本。
- cordis.patch.yml：插件自插入 bundle entry，不覆盖其他 bundle。
- src/index.ts：Host 服务、依赖探测、Connection 路由、生命周期和归档清理。
- src/host/contracts.ts：schemaVersion、请求/响应、错误码、SSE、证据、持久化类型和限制常量。
- src/host/persistence.ts：每 session 串行队列、临时文件、原子替换、迁移、损坏保留和删除重试。
- src/host/evidence.ts：主对话、工作区、图片证据适配器及来源/时点标记。
- src/host/tools.ts：七个只读工具的 schema、授权、执行和结构化错误。
- src/host/llm.ts：模型解析、动态预算、串行工具循环、reasoning、usage 和 compact 事务。
- src/host/routes.ts：认证 Fetch、SSE writer、取消表和错误映射。
- src/client/index.tsx：ModuleLoader 注入、header utilities 和 shell.overlay 注册。
- src/client/store.ts：按 sessionId 的 AssistantRegistry 和单浮窗投影。
- src/client/api.ts：同源 Fetch/SSE、信封校验和迟到事件丢弃。
- src/client/overlay.tsx：dialog、输入、历史、reasoning、工具、模型、compact、占用和未读 UI。
- src/client/selection.ts：contextmenu/Shift+Enter 选择和证据冻结。
- src/client/window.ts：Pointer Events 拖动/缩放、键盘替代和视口校正。
- src/client/styles.css、测试、README、许可证。

若公开 API 与计划冲突，先停止并报告最小注入点、影响和回滚方案；不可使用未公开内部 API。插件卸载时移除路由、订阅、监听器、计时器、AbortController 和客户端入口。

## 3. Host、认证和 Session 绑定

通过 ctx.connection.fetch.register 注册精确认证 Fetch 路由；JSON 路由使用 buffered，SSE 使用 streaming。客户端只使用同源 fetch，不生成 token。Connection 负责认证，插件仍执行业务授权。

每个请求显式携带 sessionId。客户端从 Chat UI Session 上下文获取 sessionId 和 cwd；cwd 仅作辅助，主机通过 ctx.sessionQuery 和 workspace 正式能力验证 Session、归属和工作区。不存在、归档、越界或不可读 Session 拒绝。每个 session 最多一个活动 ask 或 compact，不排队。

依赖降级：缺 connection 关闭 API/入口；缺 llm 允许查看已有历史、证据和工具记录但禁止生成；缺 sessionQuery 只提供当前可见快照；缺 fs 关闭工作区工具；缺附件/图片能力关闭图片工具；缺 home-path 不向未知目录写入。禁止自动安装、替代服务、配置修改和 DSH 核心改动。

## 4. 版本化协议、路由和错误

主机 schema-first 严格校验每个接口，客户端只做体验校验。请求/响应信封包含 schemaVersion、sessionId、requestId、operation、服务端 historyRevision 和 payload。客户端不能伪造 revision；未知字段按接口规则拒绝；跨 session、迟到或不兼容响应/事件丢弃并提示。

路由：

- GET /explain-assistant/state：返回状态、模型投影、compactState、usage、未读、活动请求、最近历史和继续加载标志。
- GET /explain-assistant/history：按序列化内容大小读取更早历史；游标由服务端管理，用户不感知分页。
- GET /explain-assistant/history-result：同一记录内按字节/行/区块继续加载完整工具结果、reasoning 或图片元数据；不重执行、不重读工作区。
- GET /explain-assistant/models：模型目录、Provider、默认选择、失败信息和图片能力。
- POST /explain-assistant/select-model：保存当前对话显式模型；请求期间更换只影响下一请求。
- POST /explain-assistant/ask：启动 SSE；活动冲突返回 409。
- POST /explain-assistant/compact：启动同一语义 SSE 的 compact 操作。
- DELETE /explain-assistant/in-flight/:requestId：验证归属后取消活动请求。

非流式接口使用 HTTP 状态码和结构化错误信封：400 格式错误、404 不存在、409 活动/历史冲突或归档、413 超限、422 语义无效、429 限流、500 未预期错误、503 依赖不可用。认证拒绝由 Connection 处理。SSE 建立前使用 HTTP 错误；建立后使用 error 或 aborted 事件，不暴露 token、堆栈、绝对路径或敏感内部细节。

## 5. SSE 和请求生命周期

事件固定为 start、progress、reasoning、text、tool_start、tool_result、usage、complete、error、aborted；每个事件带 schemaVersion、sessionId、requestId、operation。文本和 reasoning 为增量，工具为开始/完成两阶段，只有 complete 表示成功完成。客户端忽略未知非关键事件。

请求开始时固定实际 Provider、model、contextWindow、图片能力和预算。当前对话显式模型优先，否则动态读取 DSH 默认模型且不写入显式选择。默认不可用不自动回退，要求用户手动选择。请求期间模型变更不取消当前请求。

页面刷新/关闭、SSE 断开、插件卸载、超时和用户取消触发 AbortSignal；已收到内容保存为 status=interrupted、complete=false，完整保存原始 reasoning（包括中断部分）。主对话切换不取消后台请求。完成、失败、超时和 compact 完成设置对应对话 unread。

## 6. 证据和只读工具

统一 EvidenceEnvelope 包含 sessionId、nodeId、seq、kind、status、title、summary、command、arguments、output、text、timestamp、source、evidenceState、capturedAt、version、truncated、incomplete。来源至少包括 session_snapshot、selected_frozen、workspace_latest、assistant_history；状态区分 observed、reported_only、unavailable。主 agent 原文、工具输出和网页文本是引用数据，不是执行指令。

右键或 Shift+Enter 选择时先排除小助手，再向上找最近的 [data-tool] 或 [data-chat-node-key]，工具节点优先，并确认属于当前 Chat 容器。分层读取结构化字段、工具字段、稳定标识/时间和 DOM 可见文本；缺失字段使用 null 加 unavailable；运行中或局部内容标记 incomplete。不得自动展开、滚动或执行主界面操作。选择结果立即冻结为 selected_frozen，不保存 DOM 引用。

工具白名单：

1. explain_read_session：按稳定 nodeId/seq 和有限邻近窗口读取已记录主对话事件。
2. explain_search_session：绑定 session 的关键词/元数据搜索，返回 seq、类型、时间和片段，再精确读取。
3. explain_read_workspace_file：当前工作区内只读读取文本/行范围；每次调用读取最新版本并保存 version/capturedAt。
4. explain_list_workspace：工作区边界内列目录。
5. explain_search_workspace：工作区边界内文本搜索。
6. explain_read_workspace_image：校验并读取图片，创建插件自有不可变快照。
7. explain_get_model_context：返回上下文占用、模型能力和限制，不泄露 secret。

严格限制工具参数类型、长度、深度、路径、超时和结果大小；拒绝绝对路径、..、符号链接逃逸和工作区外目标。禁止命令、网络、写/删文件、进程/端口/服务控制、主 agent 消息、主工具重执行和新 Session。工具按模型返回顺序串行执行；失败直接返回结构化错误，不自动重试。固定硬限制包括模型回合数、工具数、总工具字节数、单工具超时和总请求超时。

## 7. LLM、上下文、图片和 compact

优先使用 ctx.tokenMeter；不可用时按 UTF-8、JSON 结构和图片尺寸保守估算。动态预算扣除系统提示、历史、证据、工具 schema/结果和图片，为最终回答预留空间且始终服从硬上限。工具结果完整保存，但送模型时按单工具/总预算截断并带 availableBytes、sentBytes、truncated；模型可调用历史结果区块工具。生成中占用保持上次 confirmed 值；首次无 usage 显示 unknown，收到 usage 后更新。

图片证据保存到插件自有 session/images 目录，记录校验值、格式、尺寸和字节引用，不覆盖工作区图。支持图片模型时向 ctx.llm.stream 提交 DSH 原生 ImageBlock/附件引用；不支持时提示选择图片模型，绝不静默换模。

trim 后完全等于 /compact 才触发压缩。compact 使用请求开始时固定的小助手模型，占用唯一活动槽。有效上下文为旧 compactState、必要近期历史、当前冻结证据和按需历史工具；未完成记录始终纳入并明确未完成/未验证。候选 compactState 在内存事务中构建，成功后原子替换，失败完全丢弃候选并保留旧状态。compact 的 reasoning、usage 和错误保存为压缩记录，摘要不作为普通聊天消息，只显示短确认和新占用。

## 8. 持久化、迁移和归档

每个主对话一个版本化 JSON，保存问题、回答、完整 reasoning、工具 trace/result、原始证据、图片引用、显式模型选择、usage、compactState、未读、活动/中断记录、几何状态和 historyRevision。未显式选择的模型不写成显式选择，运行时动态使用 DSH 默认模型。

每个 session 独立串行写队列；写临时文件，完整关闭并校验后原子替换正式文件。schemaVersion 使用显式逐级迁移；迁移在内存副本上完成并校验后写回。未来版本只读拒绝，不覆盖、不降级；损坏文件先改名为 .corrupt.<timestamp>，再创建空有效状态；迁移失败保留原文件。关键持久化失败时停止继续生成，已收内容尽力保存并标记 persistenceError/incomplete，发送 error，不提交 compact 候选。

归档使用启动清理、轻量周期检查和可用归档事件即时处理：标记 archived，拒绝新的 ask/compact/历史写入，取消活动请求，短暂等待，删除插件 JSON 与图片快照；晚到事件丢弃；失败进入受限重试队列。不删除工作区或共享 DSH 附件。客户端移除对应 registry 实例。

## 9. Client 状态和 UI

维护按 sessionId 的 AssistantRegistry。每个实例保留活动 SSE、增量 reasoning/text、工具进度、usage、未读、输入草稿、冻结证据、已加载历史、compact 状态和几何。所有未归档实例保留到页面关闭/插件卸载；只把当前实例投影到 shell.overlay。切换只切换投影；刷新通过 state 恢复。

在 conversation.session.header.utilities 注册唯一“？”按钮，按当前 session 显示独立未读徽标。打开对应浮窗后清除；不使用全局 toast、不自动切换、不抢焦点。无当前 Session 不显示。

浮窗使用 role=dialog、可访问标题和焦点管理。默认宽度 min(420px, viewport-32px)、高度 min(620px, viewport-32px)，右下 16px；最小 320x360，小视口按安全空间退让；视口变化校正。标题栏拖动和右下缩放使用 Pointer Events、pointer capture/cancel；交互结束后保存几何，不在 pointermove 写盘。Escape 关闭并恢复入口焦点，Tab 在浮窗内循环，方向键移动，Shift+方向键大步移动，缩放把手方向键调整尺寸。reasoning、工具详情、模型、历史、结果区块、重试和取消均为可聚焦按钮/disclosure；aria-live 只播报简短状态。

历史初次加载最近一段，按序列化内容大小控制；顶部显示“查看更早历史”，点击才加载下一段，不显示分页术语。单条超过目标但未超过硬上限时单独完整加载；超过硬上限显示受控截断和区块继续读取。工具默认只显示短进度，展开显示参数、状态、来源、时点、版本和受限结果；完整结果按区块加载，不重执行。图片显示缩略图，点击打开保存快照。

## 10. 测试、验收和实施顺序

测试必须覆盖：schema/错误/大小限制和 /compact 识别；session 归属、workspace containment、绝对路径、..、symlink、归档和模型选择；工具白名单、串行顺序、失败不重试、超时、预算和截断；SSE 顺序、未知事件、断开、AbortSignal、迟到事件、重复 complete、跨 session；原子写入、写队列、损坏恢复、未来版本、迁移回滚、图片快照和删除重试；compact 成功替换、模型固定、失败恢复和中断保存；React/store、未读、占用、历史区块和焦点恢复；Pointer、keyboard、contextmenu、Shift+Enter、边界夹取、虚拟化目标和监听器清理；typecheck、build、package contents 和 patch/self-entry。

独立测试 profile 浏览器验收：单个右上角“？”、浮窗移动缩放、两个对话并行、默认/显式模型、SSE、reasoning、工具详情、图片、compact、刷新恢复、归档清理和依赖降级。验收确认小助手永不修改主 agent、不执行主 agent 工具、不越出工作区、不混淆证据时点；取消/断开不伪造完成；持久化失败不伪造可靠保存；归档不触碰工作区或共享附件。

实施顺序：

1. 建立 package、patch、contracts、错误码、schema envelope 和 fixtures。
2. 实现依赖探测、Session/workspace 校验、持久化、迁移、图片快照和归档清理。
3. 实现 evidence adapters 和只读工具。
4. 实现模型解析、动态预算、串行 tool loop、SSE、取消和 ask。
5. 实现 compact 事务、历史加载和结果区块接口。
6. 实现 client registry、API client、header entry、overlay、输入、历史和状态展示。
7. 实现右键/键盘选择、证据冻结、工具/assistant 适配器和图片查看。
8. 实现 Pointer/keyboard/accessibility、几何持久化和未读。
9. 完成测试、构建、打包、独立浏览器验收及最终 diff/依赖/卸载审查。

本文件创建完成后不自动开始编码。后续只有收到单独的实现启动指令才进入实现阶段；实现阶段不得修改 docs/business-logic.md，若必须扩大文件或注入范围，先停止并报告注入点、影响和回滚方案。
