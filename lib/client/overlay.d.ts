import type { AssistantClientState } from './store.js';
import { type WindowController } from './window.js';
import { type MarkdownView } from './markdown.js';
import type { createClientPlugin } from './index.js';
import { type HistoryWindow, type HistoryWindowState } from './history-window.js';
import { type TextFieldHandle } from './text-field.js';
type OverlayProps = {
    state: AssistantClientState;
    plugin: ReturnType<typeof createClientPlugin>;
    onClose?: () => void;
};
type PluginLike = OverlayProps['plugin'] & {
    api?: {
        models?: (signal?: AbortSignal) => Promise<{
            payload?: Record<string, unknown>;
        }>;
        selectModel?: (sessionId: string, model: unknown, signal?: AbortSignal) => Promise<unknown>;
    };
    cancel?: () => void;
    /** 关窗（含把「已读」补落到宿主）。旧宿主没有这个方法时退回 registry.close。 */
    close?: () => void;
    /** §5.1/§11.6：展开某条历史记录的完整内容，并继续读下一页。 */
    openHistoryDetail?: (recordId: string) => void | Promise<void>;
    loadMoreHistoryDetail?: () => void | Promise<void>;
    closeHistoryDetail?: () => void;
    /** 让宿主记住浮窗的位置与大小（关掉再打开回到原处）。 */
    saveGeometry?: (sessionId: string, geometry: {
        x: number;
        y: number;
        width: number;
        height: number;
    }) => void;
    /** 状态读取失败后的「重试」入口：失败结局必须给用户一条出路，而不是只能关掉重开。 */
    retryState?: (sessionId?: string) => void | Promise<void>;
    /** 兜底读取（按会话 in-flight 去重）：供入口侧在浮窗打开时保证「这个会话至少问过一次状态」。 */
    ensureState?: (sessionId?: string) => void | Promise<void>;
};
/**
 * 这一段是「打开浮窗不再先露出错值」的界面判据（对应 store.stateReady / stateError）。
 *
 * ── 要解决的问题 ────────────────────────────────────────────────
 * /state 回来之前，store 里全是**初始空值**：records 空、catalog 未定义、occupancyKnown=false。
 * 旧实现照常把各区块渲染出来，于是用户第一眼看到的是
 * 「暂时没有可用的模型」「还没有小助手历史」「占用未知」——
 * 这些文案在**读法**上都是**结论**（「你没有模型」「你没有历史」「算不出来」），
 * 而不是「正在加载」。用户的第一反应是「插件坏了 / 我的数据没了」。
 *
 * ── 三档界面 ────────────────────────────────────────────────────
 *   loading → 明确的加载页；下面那些区块**一个都不渲染**（空态文案一律不出现）
 *             （底部输入区保留：它不是「空值结论」，收起反而会让窗口显得空了）
 *   failed  → /state 失败或超时，且**没有任何已经正确的旧内容**：
 *             显示明确的中文错误 + 重试。**不显示空态**（否则等于把「没读到」说成「真的没有」）
 *   ready   → 正常界面（数据已到位，一次到位）
 *
 * ── 为什么 failed 只在「没有旧内容」时整块接管 ──────────────────
 * 契约给了两条并列的出路：走明确的中文错误**或**继续展示已经正确的旧内容。
 * 首次打开就失败时后者不成立（没有任何旧内容可留），只能走前者；
 * 而「刷新失败、但页面上已经有上次成功拿到的历史/目录」时必须保留旧内容
 * （§8「关掉再打开能查看」、§10「保留已有问答」），只在顶部补一条错误提示与重试。
 * 两种情形用 hasLoadedContent() 区分，不做成二选一。
 */
type SurfaceGate = 'loading' | 'failed' | 'ready';
/**
 * 决定这次渲染走哪一档。
 *
 * 关于 `state.stateReady === false` 这个写法的说明（**不是**把 undefined 当成已就绪的偷懒）：
 * stateReady 的唯一来源是 store 的 initial()（恒为 false）与 index.ts 里 /state 的两种结局。
 * 凡是从 registry 取出来的状态这个字段**一定是布尔值**，所以真实用户路径上
 * 「未就绪」永远命中 `=== false` 这一支。写成显式比较是为了让**手工构造的状态对象**
 * （几十条既有单测直接传字面量）保持原行为，不被这次改动连带影响。
 * 新增的单测走的是真实 registry（见 tests/state-readiness.test.mjs），
 * 那里断言的是 initial() 的初值与两种结局，不受这个兼容写法影响。
 */
/**
 * 这个档位下「提交」是否合法（t8 的 F-B）。
 *
 * 加载页与失败页上都**不允许**提交：这两档下数据还没到位/没读到，
 * 而按下去却会真的发出 /api/explain-assistant/ask ——
 * 实测（t8 在真实页面上）：加载页打字后点发送，请求确实发出去了（命中 t1 清单 L15）。
 *
 * 抽成纯函数是为了让「真的不许发出去」这条判据能被逐条断言，
 * 而不是只测到「按钮变灰」—— 后者在 submit 路径没被拦住时照样会绿。
 */
export declare function canSubmit(state: AssistantClientState): boolean;
/**
 * 发送按钮的文案。
 *
 * 不能提交的档位必须**看得出**不可提交，而不是仍然写着「发送」并只靠灰化表达 ——
 * 灰化在浅色主题下很弱，用户仍会以为按得动（t8 的 F-B 现象就是这个）。
 */
export declare function sendLabel(state: AssistantClientState, gate: SurfaceGate): string;
type ModelTrigger = {
    root: HTMLButtonElement;
    prefix: HTMLElement;
    label: HTMLElement;
    warn: HTMLElement;
    caret: HTMLElement;
};
type ModelPanel = {
    root: HTMLElement;
    count: HTMLElement;
    current: HTMLElement;
    search: HTMLInputElement;
    list: HTMLElement;
    failures: HTMLElement;
    /** 「刷新」失败时的就地错误条：必须显示在**当前这一页**上（对话页此刻是隐形的）。 */
    error: HTMLElement;
    refresh: HTMLButtonElement;
};
type TutorialPanel = {
    root: HTMLElement;
    body: HTMLElement;
    back: HTMLButtonElement;
};
type OverlayContext = {
    state: AssistantClientState;
    plugin: PluginLike;
    body: HTMLElement;
    phase: HTMLElement;
    selectionStatus: HTMLElement;
    /** 选择模式的浮动条（挂在 body 上，进出模式时挂/摘）。 */
    selectBar: HTMLElement;
    selectBarCount: HTMLElement;
    selectBarDone: HTMLButtonElement;
    errorSlot: HTMLElement;
    /** 属于「当前这一问」的错误条（贴在那—问下面，见 renderOverlay 里的说明）。 */
    errorTailSlot: HTMLElement;
    /** 上一次渲染过的错误文案：判断这次是不是"新出现"（决定要不要播进场动画）。 */
    lastErrorText?: string;
    /** 上一次重画历史时「详情签名」的值：用来判断这次重画是不是由展开/收起详情引起的（决定要不要保住滚动位置）。 */
    detailSig?: string;
    /** 详情面板「摆进视野」的逐帧重试计数（面板要下一帧才挂得上）。 */
    detailFitTries?: number;
    /** 上一次重画压缩那一行用的签名：流式期间没变就不重画（省下整份摘要的 Markdown 重建）。 */
    compactRenderSig?: string;
    currentSlot: HTMLElement;
    /**
     * 回答正文槽：**增量渲染器的容器**，每次重画只换尾部节点。
     * 它必须与 currentSlot 分开 —— 见 currentStatusNodes 的说明。
     */
    answerSlot: HTMLElement;
    /** 正文的增量渲染器；挂到 answerSlot 上。 */
    answerView: MarkdownView;
    heroSlot: HTMLElement;
    quickSlot: HTMLElement;
    /** 目录里有提供方读失败时的提示条（宿主下发的事实，不打开选择页也要看得见）。 */
    catalogNoteSlot: HTMLElement;
    /** 模型选择页的槽位：它是「另一页」，所以与正文各区块互斥显示（见 data-view）。 */
    modelPanelSlot: HTMLElement;
    /** 选择页按需创建（打开才建、关掉就摘掉）：关着的时候 DOM 里不该有它的任何文本。 */
    modelPanel?: ModelPanel;
    modelTrigger: ModelTrigger;
    /** 选择页里的筛选词。关掉选择页时清空，重开不带上次的筛选。 */
    modelQuery: string;
    /** 关闭动画的代号：每次开/关都自增，用来丢弃过期的「延迟摘除」。 */
    modelCloseToken: number;
    evidenceSlot: HTMLElement;
    compactSlot: HTMLElement;
    /** 压缩摘要是否展开（默认折叠，用户要求）。重画时保留。 */
    compactOpen?: boolean;
    /** 上一次看到的压缩状态签名：只在状态真的变了时把卡片带进视野。 */
    compactSig?: string;
    /** 标题栏那颗 /compact 按钮（忙碌时要真的置灰）。 */
    compactBtn: HTMLButtonElement;
    tutorialBtn: HTMLButtonElement;
    tutorialSlot: HTMLElement;
    tutorialPanel?: TutorialPanel;
    tutorialOpen: boolean;
    tutorialCloseToken: number;
    historySlot: HTMLElement;
    /** 当前这一问（问句气泡 + 正在写的回答）。和历史同属一条对话流，只是位置在最下面。 */
    liveTurn: HTMLElement;
    /** 当前这一问的问句气泡。 */
    liveQuestion: HTMLElement;
    /**
     * 流式期间「回到最新」那颗浮动按钮。
     *
     * 它挂在**正文滚动区里**（sticky + 负 margin，与历史的「回到最近」同一套），
     * 不是 absolute 定位的独立层：绝对定位的后代会被算进滚动容器的 scrollHeight，
     * 正是上一轮 warm-ui「能滚到空白」的根因；sticky 元素的负 margin 正好抵掉自己占的高度。
     */
    followJump: HTMLButtonElement;
    /** 历史窗口：只挂最近一段；记 id 而不是下标（宿主往前插页时下标会整体后移）。 */
    historyWindow?: HistoryWindowState;
    /** 上次渲染历史用的签名。没变就不重画 —— 流式期间每个分片都重画整段历史是纯浪费。 */
    historySig?: string;
    /** 这一次要额外往上补几条（点「更早的 N 条」时置上，渲染完清掉）。 */
    pendingOlder?: number;
    /**
     * 补挂之前记下的「参照物」：第一条还看得见的那一轮，以及它当时的屏幕位置。
     *
     * 为什么按元素记、不按 scrollHeight 差值算：差值是「总量」口径，
     * 一旦浏览器自己也做了一次滚动锚定，我们再加一遍就会双倍偏移
     * （实测把锚点从 y=725 顶到 y=-343）。按元素记则是**闭环**的：
     * 无论浏览器有没有动过，量一下这个元素现在在哪，补差值就行。
     */
    anchor?: {
        id: string;
        top: number;
    };
    /** 「回到最近」按过之后滚到底。 */
    scrollToTail?: boolean;
    /** 首次就绪时是否已经自动停在最新一轮。 */
    autoScrolled?: boolean;
    /** 首开「滚到最新一轮」的重试次数（首帧还没挂进文档时量不到布局）。 */
    autoScrollTries?: number;
    /**
     * 流式回答的「跟随」开关（用户 2026-10-31 的决定：贴底时自动跟随，
     * 「当用户发出的消息到达顶端时停止自动跟随，避免模型输出太快导致用户读不完」）。
     *
     * 两种停法共用这一个布尔，因为对界面来说是同一件事：**不再自动把视野往下拽**。
     *   · 用户自己往上滚 → 他正在读上面的内容，不能抢他的滚动条；
     *   · 用户这一问的气泡顶到正文区顶端 → 再跟下去，正文会以人读不过来的速度往上跑，
     *     此后一律不动，让他按自己的速度往下读。
     * 只在「原本就贴着底」时才跟随：用户明确滚上去之后还把他拽回来，是最招人烦的一种"聪明"。
     */
    followPaused?: boolean;
    /** 缓动跟随的 rAF 句柄（见 startFollowLoop）。 */
    followRaf?: number;
    /** 跟随用的**浮点**滚动位置：浏览器读回的 scrollTop 可能是整数，只靠它累加会丢小数（台阶来源）。 */
    followPos?: number;
    /** 上一次由**程序**写出去的 scrollTop 位置：scroll 事件用它判断这次是不是自己滚的。
     *  以前存的是「时刻 + 160ms 窗口」，而跟随循环每帧都在写 —— 窗口永远不空，
     *  用户的上滚事件被无限吞掉（实测：滚到 100px 后下一帧被写回 797px）。 */
    programmaticTop?: number;
    /** 这一问的标识（问句文本）：换了一问就从头开始跟随。 */
    followTurnKey?: string;
    /** 用户手动展开过的记录 id（默认只有最新一条展开）。 */
    expandedIds: Set<string>;
    /** 本次要播「刚落地」动画的那条记录。 */
    pendingEnterId?: string;
    /** 上一次已经处理过的「最新一条」，用来判断是不是真的多了一条。 */
    enteredTurnId?: string;
    /** 这份上下文属于哪个会话：切会话时窗口与展开态必须重置。 */
    sessionId?: string;
    /** 加载页槽位：未就绪时只有它里面有东西（见 surfaceGate）。 */
    loadingSlot: HTMLElement;
    /** /state 失败且没有旧内容时的中文错误 + 重试（与 loadingSlot 互斥）。 */
    stateErrorSlot: HTMLElement;
    /** 浮窗根元素：挂 data-surface，供样式与页面实测定位当前档位。 */
    root: HTMLElement;
    /** §5.1：展开中的那条记录的完整内容面板（打开时置顶显示）。 */
    detailSlot: HTMLElement;
    /** 上一次展开的 recordId：只有换成另一条记录时才把面板滚到可见处。 */
    detailRecordId?: string;
    /** 上一次渲染用的窗口：就地展开/收起之后要拿它重算签名（见 historySignature）。 */
    lastWin?: HistoryWindow;
    /** 这一次重画里，完整内容面板是不是已经挂在那一轮记录下面了（见 historyNodes）。 */
    detailInline?: boolean;
    /** 面板内容还在路上：等它从「正在读取」变成正文后要再摆一次（那时高度才定型）。 */
    detailFit?: boolean;
    /** 拖动/缩放控制器。用于把「后到的」几何值补应用上去（见 updateOverlay）。 */
    controller: WindowController;
    /** 上一次已经套用到 DOM 的几何值。用来判断宿主这次给的是不是新值 —— 相同就不动，避免每次重画都重设位置。 */
    appliedGeometry?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    ringSlot: HTMLElement;
    /** §5.2 输入框上方的常驻提示：正在围绕哪条内容提问。 */
    targetBar: HTMLElement;
    form: HTMLFormElement;
    input: HTMLTextAreaElement;
    /** 输入框的平滑光标句柄（text-field.ts）：程序改 value 之后要手动刷一次镜面。 */
    field: TextFieldHandle;
    send: HTMLButtonElement;
    modelOpen: boolean;
    /** 原地重画自己：用于只影响本浮窗、不改 registry 的交互（例如展开模型列表）。 */
    rerender: () => void;
    /** 还没送达的「打开即聚焦」：等浮窗挂进文档、且已经从加载页切到就绪档之后再投递（见 deliverFocus）。 */
    pendingFocus?: boolean;
};
/**
 * 把焦点送进输入框：**一条明确路径**，不是「调一次 focus() 就算完」。
 *
 * 三个必须处理的现实（都是实测踩过的）：
 * 1. 调用这一刻浮窗可能还没挂进文档（entry.ts 是 renderOverlay 返回之后才 appendChildren），
 *    也可能还停在加载页（/state 没回来时输入区是收起的）→ 等它就绪，最多等 60 帧。
 * 2. 挂载那一帧焦点可能被宿主或其它模块抢走 → 下一帧再校验一次，仍失败再补一次并记一条日志。
 * 3. 用户在打开的同一瞬间已经点去别处（典型：点了主对话输入框继续打字）→ **不许抢回来**：
 *    只有焦点空着（body/浮窗自己）时才动手。
 *
 * 之所以要「校验」，是因为 focus() 是**异步生效**的（浏览器在下一帧才真正把焦点交给元素，
 * 期间的 focus 事件可能被别的模块的 focus() 覆盖）。只看「有没有调用过」，就会出现
 * 「看起来打开了但打不了字」。
 */
export declare function deliverFocus(ctx: OverlayContext, attempt?: number): void;
/**
 * @param initialGeometry 重建前那个浮窗**实际显示在屏幕上的**几何。
 *
 *   为什么需要它（t8 的 F-A）：切会话时 entry.ts 会重建整棵浮窗 DOM，而新会话此刻
 *   还没有几何（它的 /state 还没回来）。不传这个值时 renderOverlay 只能退回
 *   window.ts 的默认值，用户就会看到浮窗**先跳回默认位置/大小、过一会再跳到该会话
 *   真实几何** —— 位置和大小都变。
 *
 *   传进来之后：加载页首帧几何 == 重建前的实际几何，从「浮窗可见」到「数据到位」
 *   全程零几何变化；只有目标会话的 /state 带回**不同的**存储几何时，才会在
 *   「内容到位那一刻」一次性归位（这是允许的，且不是「先跳默认值再跳回来」）。
 *
 *   没有已知位置时（第一次打开某个会话、且从未有过浮窗）不传 → 仍落默认值，
 *   这正是默认值唯一该服务的场景。
 */
export declare function renderOverlay(state: AssistantClientState, plugin: OverlayProps['plugin'], initialGeometry?: {
    x: number;
    y: number;
    width: number;
    height: number;
}, options?: {
    autoFocus?: boolean;
}): HTMLElement;
/** 状态变化时原地重画各区块。骨架、输入框、滚动位置都不动。 */
export declare function updateOverlay(root: HTMLElement, state: AssistantClientState, plugin: OverlayProps['plugin']): void;
export {};
