/**
 * 忙碌态的**门控**：延迟出现 + 最短停留。
 *
 * ── 为什么不能只写 CSS ──────────────────────────────────────────────
 * 入口按钮的忙碌态（"/state 还没回来"）在正常宿主下只持续几十毫秒。
 * 如果一进入忙碌就把它画出来，用户看到的是"闪一下"——而这一轮用户已经为三处
 * 类似的"闪"（生成完闪一下、停止突然闪出、切会话闪跳）提过要求，不能在这里再犯。
 *
 * 两条阈值：
 * · 延迟 150ms 出现：40ms 就回来的 /state 全程什么都不画；
 * · 出现后至少留 300ms：避免"刚画出来就被撤掉"，那比不画还糟。
 *
 * 用 setTimeout 而不是 `animation-delay`：CSS 的延迟**无法取消**，
 * 状态在延迟期内翻回去时，动画仍会在之后自己跑起来。
 *
 * 计时器可注入 → 阈值与边界都能单测（见 tests/header-icon.test.mjs）。
 */
export const BUSY_APPEAR_DELAY_MS = 150;
export const BUSY_MIN_VISIBLE_MS = 300;
/**
 * @param timers 计时器（浏览器里就是 setTimeout / clearTimeout）
 * @param onChange 可见性翻转时的回调（只在真的翻转时调用）
 */
export function createBusyGate(timers, onChange) {
    /**
     * ⚠️ 必须先把这两个函数**摘下来**，再用裸调用。
     *
     * 浏览器的 window.setTimeout 一旦被当成某个普通对象的方法调用（this = 这个 timers 对象），
     * 会直接抛 `TypeError: Illegal invocation`。2026-10-31 在 3081 上就是这么炸的：
     * 点开浮窗 → effect 里 gate.set(true) → sync() → 调用 setTimer(...) 抛错
     * → React 把整个入口插槽卸载 → 用户看到「图标消失、点什么都没反应」。
     *
     * 取下引用后调用时 this 是 undefined，才是合法的全局调用。
     */
    const setTimer = timers.setTimeout;
    const clearTimer = timers.clearTimeout;
    let wanted = false;
    let visible = false;
    let showHandle;
    let hideHandle;
    let shownAt = 0;
    let disposed = false;
    const now = () => (timers.now ? timers.now() : Date.now());
    function emit(next) {
        if (disposed || next === visible)
            return;
        visible = next;
        if (next)
            shownAt = now();
        onChange(next);
    }
    function sync() {
        if (wanted) {
            if (hideHandle !== undefined) {
                clearTimer(hideHandle);
                hideHandle = undefined;
            }
            if (visible || showHandle !== undefined)
                return;
            showHandle = setTimer(() => {
                showHandle = undefined;
                if (wanted)
                    emit(true);
            }, BUSY_APPEAR_DELAY_MS);
            return;
        }
        if (showHandle !== undefined) {
            clearTimer(showHandle);
            showHandle = undefined;
        }
        if (!visible)
            return;
        const remaining = BUSY_MIN_VISIBLE_MS - (now() - shownAt);
        if (remaining <= 0) {
            emit(false);
            return;
        }
        if (hideHandle !== undefined)
            return;
        hideHandle = setTimer(() => {
            hideHandle = undefined;
            if (!wanted)
                emit(false);
        }, remaining);
    }
    return {
        set(next) {
            if (disposed)
                return;
            if (next === wanted)
                return;
            wanted = next;
            sync();
        },
        dispose() {
            disposed = true;
            if (showHandle !== undefined) {
                clearTimer(showHandle);
                showHandle = undefined;
            }
            if (hideHandle !== undefined) {
                clearTimer(hideHandle);
                hideHandle = undefined;
            }
        },
        get visible() { return visible; },
    };
}
