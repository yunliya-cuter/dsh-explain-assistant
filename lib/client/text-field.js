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
export const DEFAULT_CONFIG = {
    // 取自 caret.js:26-35：光标 0.3s、选区 0.2s、淡入 0.12s
    caretResponse: 0.3,
    caretDamping: 1,
    selectionResponse: 0.2,
    selectionFade: 0.12,
    blinkDelayMs: 500,
    substep: 1 / 240,
    maxDt: 0.064,
};
export function springConfig(response, dampingRatio) {
    const w = (2 * Math.PI) / response;
    return { k: w * w, c: 2 * dampingRatio * w };
}
export function createSpring(value, response, damping) {
    const { k, c } = springConfig(response, damping);
    return { x: value, v: 0, target: value, k, c };
}
/** 推进一个弹簧；返回是否还在动。与 caret.js 的 stepSpring 同一份积分器。 */
export function stepSpring(s, dt, substep) {
    const steps = Math.ceil(dt / substep);
    const h = steps ? dt / steps : 0;
    for (let i = 0; i < steps; i++) {
        s.v += (-s.k * (s.x - s.target) - s.c * s.v) * h;
        s.x += s.v * h;
    }
    if (Math.abs(s.x - s.target) < 1e-3 && Math.abs(s.v) < 1e-2) {
        s.x = s.target;
        s.v = 0;
        return false;
    }
    return true;
}
/** 一屏最多画多少个选区矩形。输入框最多 150px 高（约 7 行），24 是两倍余量。 */
const MAX_BOXES = 24;
/** 与 .ea-input 的 min-height / max-height 保持一致：自动长高的上下限 */
const AUTOSIZE_MIN = 52;
const AUTOSIZE_MAX = 150;
const instances = new WeakMap();
function prefersReducedMotion() {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    catch {
        return false;
    }
}
function round(n) {
    return Math.round(n * 100) / 100;
}
/**
 * 把输入框包进一层「白底板」，并在里面挂上自定义光标与选区高亮。
 * 幂等：同一个输入框重复调用只会拿到同一个 handle。
 */
export function mountTextField(input, overrides = {}) {
    const existing = instances.get(input);
    if (existing)
        return existing;
    const cfg = { ...DEFAULT_CONFIG, ...overrides };
    const root = document.createElement('div');
    root.className = 'ea-field';
    input.parentNode?.insertBefore(root, input);
    root.appendChild(input);
    const mirror = document.createElement('div');
    mirror.className = 'ea-field-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    const textNode = document.createTextNode('');
    mirror.appendChild(textNode);
    const selectionLayer = document.createElement('div');
    selectionLayer.className = 'ea-field-selection';
    selectionLayer.setAttribute('aria-hidden', 'true');
    const caret = document.createElement('div');
    caret.className = 'ea-field-caret';
    caret.setAttribute('aria-hidden', 'true');
    root.append(mirror, selectionLayer, caret);
    const boxes = [];
    for (let i = 0; i < MAX_BOXES; i++) {
        const boxEl = document.createElement('div');
        boxEl.className = 'ea-field-sel-box';
        selectionLayer.appendChild(boxEl);
        boxes.push({
            el: boxEl,
            left: createSpring(0, cfg.selectionResponse, 1),
            width: createSpring(0, cfg.selectionResponse, 1),
            visible: false,
        });
    }
    const caretX = createSpring(0, cfg.caretResponse, cfg.caretDamping);
    const caretOpacity = createSpring(1, cfg.selectionFade, 1);
    let caretVisible = false;
    let rafId = 0;
    let lastTime = 0;
    let blinkTimer = 0;
    let dead = false;
    let lastAutosize = -1;
    // 环境具备吗（测试用的假 DOM、极老的浏览器没有就直接不接管）
    const engineOk = typeof document.createRange === 'function' && typeof requestAnimationFrame === 'function';
    // 当前是否真的接管：reduced-motion 下不接管，退回原生光标与选区
    let active = engineOk && !prefersReducedMotion();
    /** 输入框跟着内容长高（到 AUTOSIZE_MAX 封顶）。textarea 才会长。 */
    function autosize() {
        if (input.tagName !== 'TEXTAREA')
            return;
        const element = input;
        const previous = element.style.height;
        element.style.height = 'auto';
        const measured = element.scrollHeight || 0;
        const next = Math.max(AUTOSIZE_MIN, Math.min(measured, AUTOSIZE_MAX));
        if (Math.abs(next - lastAutosize) > 0.5) {
            lastAutosize = next;
            element.style.height = next + 'px';
        }
        else {
            element.style.height = previous || next + 'px';
        }
    }
    function syncMirror() {
        const cs = getComputedStyle(input);
        // clientWidth：不含滚动条。输入框滚起来之后右侧会多 15px 的滚动条，
        // 而镜面没有 —— 用 offsetWidth 会把换行点排得更靠右，光标随之整行错位。
        mirror.style.width = input.clientWidth + 'px';
        mirror.style.padding = cs.padding;
        mirror.style.font = cs.font;
        mirror.style.fontSize = cs.fontSize;
        mirror.style.lineHeight = cs.lineHeight;
        mirror.style.letterSpacing = cs.letterSpacing;
        mirror.style.textAlign = cs.textAlign;
        mirror.style.whiteSpace = input.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre';
        mirror.style.wordBreak = 'break-word';
        mirror.style.transform = 'translate(' + -input.scrollLeft + 'px,' + -input.scrollTop + 'px)';
        const data = input.value || '\u200b';
        if (textNode.data !== data)
            textNode.data = data;
    }
    function caretRect() {
        if (!textNode.data.length)
            return null;
        const offset = Math.min(Math.max(input.selectionStart ?? 0, 0), textNode.data.length);
        const range = document.createRange();
        range.setStart(textNode, offset);
        range.collapse(true);
        const rects = range.getClientRects();
        return rects.length ? rects[0] : range.getBoundingClientRect();
    }
    function selectionRects() {
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? 0;
        if (end <= start)
            return [];
        const range = document.createRange();
        range.setStart(textNode, Math.min(start, textNode.data.length));
        range.setEnd(textNode, Math.min(end, textNode.data.length));
        return Array.from(range.getClientRects());
    }
    function hasSelection() {
        return (input.selectionStart ?? 0) !== (input.selectionEnd ?? 0);
    }
    function hideCaret() {
        window.clearTimeout(blinkTimer);
        caret.classList.remove('is-blinking');
        caret.style.opacity = '0';
        caretVisible = false;
    }
    /**
     * 光标「刚动过」：点亮并把闪烁的静默期重新计时。
     * 原件 moveTo()（more-input.js:590-598）就是 stopBlinking + scheduleBlink(500)：
     * 打字的整个过程光标是常亮的，停手 500ms 之后才开始闪。
     */
    function restartBlink() {
        window.clearTimeout(blinkTimer);
        caret.classList.remove('is-blinking');
        caret.style.opacity = '1';
        blinkTimer = window.setTimeout(() => {
            if (dead || !caretVisible)
                return;
            caret.classList.add('is-blinking');
        }, cfg.blinkDelayMs);
    }
    function paintCaret() {
        // 有选区时把光标藏起来：原件 hasSelection() → hideInstant()。
        // 留着的话，选区起点会多出一根 2px 的竖条，看着像"多选了一个字符"。
        if (hasSelection()) {
            hideCaret();
            return;
        }
        const r = caretRect();
        if (!r) {
            hideCaret();
            return;
        }
        const fr = root.getBoundingClientRect();
        const cs = getComputedStyle(input);
        const lineHeight = r.height || parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
        caret.style.height = round(lineHeight) + 'px';
        caret.style.top = round(r.top - fr.top) + 'px';
        caretX.target = r.left - fr.left;
        if (!caretVisible) {
            // 从无到有：位置瞬时落位，不从旧位置滑过来
            caretX.x = caretX.target;
            caretX.v = 0;
            caretVisible = true;
            caret.style.left = round(caretX.x - 1) + 'px';
            caret.style.opacity = '1';
        }
    }
    function paintSelection() {
        const rects = selectionRects().slice(0, MAX_BOXES);
        const fr = root.getBoundingClientRect();
        boxes.forEach((box, i) => {
            const r = rects[i];
            if (!r) {
                if (box.visible) {
                    box.visible = false;
                    box.el.style.opacity = '0';
                }
                return;
            }
            if (!box.visible) {
                box.visible = true;
                // 第一次出现直接落位，不从 0 长出来（那会像一道扫过的动画）
                box.left.x = r.left - fr.left;
                box.left.v = 0;
                box.width.x = r.width;
                box.width.v = 0;
                box.el.style.left = round(box.left.x) + 'px';
                box.el.style.width = round(box.width.x) + 'px';
                box.el.style.opacity = '1';
            }
            box.left.target = r.left - fr.left;
            box.width.target = r.width;
            box.el.style.top = round(r.top - fr.top) + 'px';
            box.el.style.height = round(r.height) + 'px';
        });
    }
    function frame(now) {
        if (dead)
            return;
        const dt = Math.min(Math.max((now - lastTime) / 1000, 0), cfg.maxDt);
        lastTime = now;
        let moving = false;
        if (stepSpring(caretX, dt, cfg.substep))
            moving = true;
        caret.style.left = round(caretX.x - 1) + 'px';
        for (const box of boxes) {
            if (!box.visible)
                continue;
            if (stepSpring(box.left, dt, cfg.substep))
                moving = true;
            if (stepSpring(box.width, dt, cfg.substep))
                moving = true;
            box.el.style.left = round(box.left.x) + 'px';
            box.el.style.width = round(box.width.x) + 'px';
        }
        if (stepSpring(caretOpacity, dt, cfg.substep)) {
            moving = true;
            caret.style.opacity = String(round(caretOpacity.x));
        }
        rafId = moving ? requestAnimationFrame(frame) : 0;
    }
    function ensureLoop() {
        if (dead || rafId)
            return;
        lastTime = performance.now();
        rafId = requestAnimationFrame(frame);
    }
    function refresh() {
        if (dead)
            return;
        if (!active)
            return;
        autosize();
        syncMirror();
        paintCaret();
        paintSelection();
        // 每次刷新都算"光标动过"：只有停下来 500ms 之后才该开始闪
        if (caretVisible && !hasSelection())
            restartBlink();
        ensureLoop();
    }
    function onScroll() {
        if (!active)
            return;
        syncMirror();
        paintCaret();
        paintSelection();
        ensureLoop();
    }
    function onFocus() {
        if (!active)
            return;
        caretVisible = false;
        caretOpacity.x = 1;
        caretOpacity.target = 1;
        caret.style.opacity = '1';
        refresh();
    }
    function onBlur() {
        window.clearTimeout(blinkTimer);
        caret.classList.remove('is-blinking');
        caretOpacity.target = 0;
        ensureLoop();
        boxes.forEach(box => { box.visible = false; box.el.style.opacity = '0'; });
    }
    const onSelectionChange = () => { if (document.activeElement === input)
        refresh(); };
    const onViewportChange = () => refresh();
    const listeners = [
        [input, 'input', refresh],
        [input, 'keyup', refresh],
        [input, 'mouseup', refresh],
        [input, 'scroll', onScroll],
        [input, 'focus', onFocus],
        [input, 'blur', onBlur],
        [input, 'compositionstart', refresh],
        [input, 'compositionend', refresh],
        [document, 'selectionchange', onSelectionChange],
        [window, 'resize', onViewportChange],
    ];
    /**
     * 浮窗关掉时插件只是把根节点从文档里摘走，不会通知任何人。
     * 这里挂一个观察者：一旦自己被摘掉就自我销毁，免得 document / window 上的
     * 监听器和 rAF 循环留在那儿（开着关着几十次就是几十份）。
     */
    const observer = typeof MutationObserver === 'function'
        ? new MutationObserver(() => { if (!root.isConnected)
            handle.destroy(); })
        : null;
    /**
     * 浮窗拖边改宽走的是 pointermove 直接改 style，不会触发 window.resize ——
     * 没有这个观察者，镜面宽度会停在旧值，光标和选区继续按旧换行点画。
     */
    const sizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => { if (!dead && active)
            refresh(); })
        : null;
    /** 「减少动态效果」可以在运行中打开/关闭，必须在两个方向都切回对应的那一套。 */
    const motionQuery = (() => {
        try {
            return window.matchMedia('(prefers-reduced-motion: reduce)');
        }
        catch {
            return null;
        }
    })();
    const onMotionChange = () => {
        if (dead || !engineOk)
            return;
        const next = !(motionQuery?.matches ?? false);
        if (next === active)
            return;
        active = next;
        if (active) {
            root.setAttribute('data-smooth', 'on');
            try {
                refresh();
            }
            catch {
                active = false;
                root.removeAttribute('data-smooth');
            }
            return;
        }
        root.removeAttribute('data-smooth');
        hideCaret();
        boxes.forEach(box => { box.visible = false; box.el.style.opacity = '0'; });
        if (rafId)
            cancelAnimationFrame(rafId);
        rafId = 0;
    };
    if (active) {
        listeners.forEach(([target, name, fn]) => target.addEventListener(name, fn, true));
        observer?.observe(document.body, { childList: true, subtree: true });
        sizeObserver?.observe(input);
        motionQuery?.addEventListener?.('change', onMotionChange);
        root.setAttribute('data-smooth', 'on');
        try {
            autosize();
            syncMirror();
            refresh();
        }
        catch {
            // 量取失败就整体退回原生：宁可没有动效，也不能出现一根不动的假光标
            active = false;
            root.removeAttribute('data-smooth');
        }
        // 字体晚到时换行点会变，量一次
        try {
            document.fonts?.ready?.then(() => { if (!dead && active)
                refresh(); });
        }
        catch { /* 老浏览器没有 FontFaceSet */ }
    }
    const handle = {
        root,
        input,
        get active() { return active; },
        refresh,
        destroy() {
            if (dead)
                return;
            dead = true;
            active = false;
            window.clearTimeout(blinkTimer);
            if (rafId)
                cancelAnimationFrame(rafId);
            rafId = 0;
            listeners.forEach(([target, name, fn]) => target.removeEventListener(name, fn, true));
            observer?.disconnect();
            sizeObserver?.disconnect();
            motionQuery?.removeEventListener?.('change', onMotionChange);
            instances.delete(input);
            root.removeAttribute('data-smooth');
            if (root.parentNode) {
                root.parentNode.insertBefore(input, root);
                root.remove();
            }
        },
    };
    instances.set(input, handle);
    return handle;
}
