/**
 * 关闭浮窗的退场。
 *
 * ── 为什么是"原地留着播完"，而不是"克隆一份播动画" ─────────────
 * 曾经的做法是把面板 cloneNode 一份留在原地播 180ms。两个真问题：
 *
 * 1. **滚动位置丢了**：克隆体不继承 scrollTop，于是它从**对话最上面**开始播 ——
 *    用户看到的就是"关掉的过程中画面弹回上下文顶部"。这是用户报的 bug。
 * 2. **卡**：克隆整棵面板（几百个节点、还带 backdrop-filter）本身就是一次十几毫秒的
 *    长任务，正好压在关闭动画的第一帧上。
 *
 * 现在改成：**原节点原地不动**，只摘掉监听器（不再接收任何输入）、挂 data-leaving，
 * 让 CSS 播完再把节点摘掉。滚动位置天然保留，也没有克隆开销。
 *
 * 三条约束：
 *   · 动画只动 opacity / transform（不 blur、不 scale）：blur 与 scale 会让
 *     backdrop-filter 每帧重新栅格化，420×620 的一块玻璃上就是明显的掉帧；
 *   · 退场期间 pointer-events:none + aria-hidden，绝不拦住用户的下一次点击；
 *   · prefers-reduced-motion 下不播（调用方直接摘掉）。
 */
/** 与 styles.css 的 --ea-exit-dur（180ms）对齐，多留 40ms：定时器与最后一帧同值时容易赛跑。 */
export declare const EXIT_MS = 220;
type HostLike = {
    firstElementChild: Element | null;
    replaceChildren(...nodes: Element[]): void;
};
type NodeLike = Element & {
    style?: {
        pointerEvents?: string;
    };
    parentElement?: Element | null;
};
export declare function prefersReducedMotion(): boolean;
/**
 * 让刚被摘下来的浮窗原地播完退场。
 *
 * @param host 浮窗的宿主容器。
 * @param element 刚才那个浮窗节点（**必须在 host 里**，调用方不要先 remove）。
 * @param options.animate false = 强制不播（宿主销毁、插件卸载这类"立刻消失"的场合）。
 * @returns 是否真的在播（false 表示调用方应当立刻把它摘掉）。
 */
export declare function beginExit(host: HostLike, element: NodeLike | null | undefined, options?: {
    animate?: boolean;
}): boolean;
export {};
