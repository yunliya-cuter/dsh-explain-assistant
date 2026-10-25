/**
 * 关闭浮窗的退场：把面板克隆一份留在原地把动画播完，再把真节点摘掉。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────
 * 浮窗是 React 渲染出来、由一个 effect 的清理函数摘掉的。清理函数里
 * `host.replaceChildren()` 一执行节点就没了 —— 没有任何一帧可以拿来播动画，
 * 用户看到的就是"啪"一下消失（这正是用户这一轮说的"关闭小助手后的动画"）。
 * 模型选择页早就解决了同类问题（挂 data-closing → 播完再摘，见 overlay.tsx 的
 * closeModelPanel）；浮窗本体一直没跟上。
 *
 * ── 为什么用"克隆体"而不是延迟摘真节点 ────────────────────────
 * 延迟摘真节点要处理一串竞态：期间又被打开、切会话、宿主销毁、插件卸载……
 * 而且真节点上挂着监听器，多留 220ms 就意味着这段时间里它仍然吃点击和键盘。
 * 克隆体没有监听器、不参与状态、pointer-events:none，播完就删 —— 它只是一张画面。
 * 真节点该释放的全部**立刻**释放（controller.dispose / selection.dispose），语义不变。
 */
/** 与 styles.css 的 --ea-exit-dur（180ms）对齐，多留 40ms：定时器与最后一帧同值时容易赛跑。 */
export const EXIT_MS = 220;
export function prefersReducedMotion() {
    // 假 DOM 里没有 matchMedia：当作"可以播动画"，于是测试跑的是带过渡的真实路径。
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
/**
 * 摘掉浮窗，并在关闭时留一份会播退场的克隆体。
 *
 * @param host 浮窗的宿主容器（浮窗是它的 firstElementChild）。
 * @param removeReal 立刻释放真节点（解监听、dispose markdown 增量器等）。**必须先跑**。
 * @param options.animate false = 强制不播（宿主销毁、插件卸载这类"立刻消失"的场合）。
 * @returns 是否真的挂上了一份退场克隆体（测试据此区分两条路径）。
 */
export function withExitGhost(host, removeReal, options = {}) {
    const node = host.firstElementChild;
    const animate = options.animate !== false && Boolean(node) && !prefersReducedMotion();
    if (!animate || !node) {
        removeReal();
        host.replaceChildren();
        return false;
    }
    const ghost = node.cloneNode(true);
    // 克隆体会让页面上出现两份同名 id（aria-labelledby 会指到错的那一份），一并剥掉。
    if (typeof ghost.removeAttribute === 'function')
        ghost.removeAttribute('id');
    const marked = typeof ghost.querySelectorAll === 'function' ? Array.from(ghost.querySelectorAll('[id]')) : [];
    for (const child of marked)
        child.removeAttribute('id');
    ghost.setAttribute('data-leaving', 'true');
    ghost.setAttribute('aria-hidden', 'true');
    // 真节点先摘、克隆体紧接着占住同一个位置：两张图重合，看不出接缝。
    removeReal();
    host.replaceChildren(ghost);
    setTimeout(() => { if (ghost.parentElement === host)
        ghost.remove(); }, EXIT_MS);
    return true;
}
