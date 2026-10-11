import type { AssistantClientState } from './store.js';
import type { createClientPlugin } from './index.js';
type OverlayProps = {
    state: AssistantClientState;
    plugin: ReturnType<typeof createClientPlugin>;
    onClose?: () => void;
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
}): HTMLElement;
/** 状态变化时原地重画各区块。骨架、输入框、滚动位置都不动。 */
export declare function updateOverlay(root: HTMLElement, state: AssistantClientState, plugin: OverlayProps['plugin']): void;
export {};
