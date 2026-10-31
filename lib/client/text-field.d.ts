/**
 * 平滑光标 + 蓝色选区（从 More 设置向导 2026-10-25 版移植）。
 *
 * ── 挪过来的是什么 ────────────────────────────────────────────
 * 原版把这套东西做在「输入框 + 独立文字层」上：原生文字透明，看得见的字由
 * .input-layer 重画，光标和选区才有东西可垫。搬进插件时**去掉了文字层**：
 *   · 插件里输入的是中文，输入法组字期间那句话不在 value 里，
 *     文字层一旦接管会把组字过程画丢；
 *   · 原件那层文字是为了做「边缘模糊带」，插件浮窗窄，用不上。
 * 所以这里保留原生文字渲染，只接管眼睛看得见的两个东西：光标和选区高亮。
 *
 * ── 关键取舍 ─────────────────────────────────────────────────
 * 1. 原生光标关掉（caret-color: transparent），由我们自己画一根 2px 的竖条，
 *    位置由弹簧驱动 —— 这就是「打字时平滑滑动」的来源。浏览器原生光标只会瞬移。
 * 2. 原生选中色关掉（::selection background: transparent），蓝色矩形改由
 *    .ea-field-sel-box 画，垫在文字**下面**（z-index 低于输入框），
 *    于是字不会因为盖了一层半透明色而变粗。
 * 3. 几何量取走「隐形镜面」：一个和输入框同字体、同内边距、同宽度的 div，
 *    用 Range.getClientRects() 拿到插入点与每一行的选区矩形。
 *    这样 textarea 自动换行、多行选区都能算对，不需要自己排版。
 *
 * ── 本轮修正（2026-10-31 审计）─────────────────────────────────
 * · 镜面宽度取 clientWidth 而不是 offsetWidth：textarea 一旦滚起来，右侧会多一条
 *   15px 滚动条，offsetWidth 含它。按 offsetWidth 排，镜面比真实可用宽度宽 15px，
 *   换行点与真机不同 —— 实测 6.9%–12.5% 的插入点落到错误的行上，最大偏差整整一行。
 * · 输入框尺寸变化要重算：浮窗拖边改宽走的是 window.ts 的 pointermove，不会触发
 *   window.resize，所以补一个 ResizeObserver。
 * · 有选区时把光标藏起来（原件 more-input.js:557 hasSelection → hideInstant）。
 * · 每次移动都重置闪烁静默期（原件 moveTo 里 stopBlinking + scheduleBlink(500)），
 *   于是打字时是常亮的，只有停下来 500ms 之后才开始闪。
 * · prefers-reduced-motion 是可以在运行中改变的，监听 change，别只在挂载时采样一次：
 *   否则 CSS 把自绘层 display:none 了，而原生光标/选区还是 transparent，两边都没有。
 * · 输入框随内容长高（到 max-height 封顶），不再固定两行 + 内部滚动。
 *
 * ── 降级 ─────────────────────────────────────────────────────
 * prefers-reduced-motion: reduce 时**不接管**：保持浏览器原生光标与选区。
 * 引擎自己挂了（异常、被 dispose）也退回原生，不会出现「没有光标」的输入框。
 */
export type TextFieldConfig = {
    /** 光标横移弹簧：周期（秒）与阻尼比（1 = 临界阻尼，不过冲） */
    readonly caretResponse: number;
    readonly caretDamping: number;
    /** 选区横移弹簧 */
    readonly selectionResponse: number;
    /** 选区淡入淡出弹簧 */
    readonly selectionFade: number;
    /** 光标出现后多久开始闪（毫秒） */
    readonly blinkDelayMs: number;
    /** 仿真步长与单帧最大步长（秒） */
    readonly substep: number;
    readonly maxDt: number;
};
export declare const DEFAULT_CONFIG: TextFieldConfig;
export type Spring = {
    x: number;
    v: number;
    target: number;
    k: number;
    c: number;
};
export declare function springConfig(response: number, dampingRatio: number): {
    k: number;
    c: number;
};
export declare function createSpring(value: number, response: number, damping: number): Spring;
/** 推进一个弹簧；返回是否还在动。与 caret.js 的 stepSpring 同一份积分器。 */
export declare function stepSpring(s: Spring, dt: number, substep: number): boolean;
export type TextFieldHandle = {
    /** 包裹后的根节点（表单里应当 append 它，而不是原来的输入框） */
    readonly root: HTMLElement;
    /** 原输入框，监听器仍然挂在它身上 */
    readonly input: HTMLTextAreaElement | HTMLInputElement;
    /** 是否真的接管了（reduced-motion 或环境不支持时为 false） */
    readonly active: boolean;
    refresh(): void;
    destroy(): void;
};
/**
 * 把输入框包进一层「白底板」，并在里面挂上自定义光标与选区高亮。
 * 幂等：同一个输入框重复调用只会拿到同一个 handle。
 */
export declare function mountTextField(input: HTMLTextAreaElement | HTMLInputElement, overrides?: Partial<TextFieldConfig>): TextFieldHandle;
