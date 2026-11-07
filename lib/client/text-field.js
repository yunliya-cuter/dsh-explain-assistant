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
/** 推进一个弹簧；返回是否还在动。与 caret.js 的 stepSpring 是同一份积分器。 */
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
/** 只写「真的变了」的样式值：字符串相等就跳过。 */
function writeStyle(el, prop, value, cache) {
    if (cache[prop] === value)
        return;
    cache[prop] = value;
    el.style[prop] = value;
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
        boxes.push({ el: boxEl, left: createSpring(0, cfg.selectionResponse, 1), width: createSpring(0, cfg.selectionResponse, 1), visible: false, top: 0 });
    }
    const caretX = createSpring(0, cfg.caretResponse, cfg.caretDamping);
    /** 光标当前所在的行（相对 .ea-field）。与 caretX 一起走 transform。 */
    let caretY = 0;
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
    /* ── 焦点归属：所有「焦点态」视觉的唯一判据（2026-11-07）──────────────────
     *
     * 用户原话：「会出现焦点不在输入框、无法输入，却光标仍在闪动或者有光圈的问题」。
     * 两个都是真的，根因是**焦点态视觉没有跟焦点绑在一起**：
     *  · 挂载时那一次 refresh 就画了一根光标并把闪烁打开 —— 那一刻焦点还在「?」按钮上；
     *  · 之后任何一次 refresh（窗口改大小、拖浮窗、主题变化、字体晚到…）都会
     *    在结尾调 restartBlink()，于是**失焦之后再被刷新一次，光标就自己亮回来了**。
     * 现在：paint 之前一律过 focused()。它读的是 document.activeElement，不是任何缓存位，
     * 所以「看着有光标、其实没焦点」在结构上不可能出现。
     */
    /** 真的持有焦点吗（focus 事件进来、blur 事件出去）。 */
    let hasFocus = false;
    /** 最近一次指针按下 / Tab 键的时刻：焦点环只给键盘焦点，鼠标点进来不留一圈常驻描边。 */
    let lastPointerAt = -Infinity;
    let lastKeyAt = -Infinity;
    /* ── 量取的缓存 ────────────────────────────────────────────────────
     *
     * 2026-11-07（用户报「输入文字时卡顿」）实测：一次 refresh 里先后做了
     * ① autosize 的「height=auto → 读 scrollHeight」、② syncMirror 的 getComputedStyle、
     * ③ 读 clientWidth、④ 光标/选区的 getClientRects、⑤ root.getBoundingClientRect。
     * 每一步都会强制一次**整页**布局；而 input / selectionchange / keyup 三个事件
     * 每个字都各触发一次 refresh —— 打一个字 4~6 次强制布局。3082 真机剖面：
     * autosize 690ms + syncMirror 435ms，占打字总耗时的 59%。
     *
     * 现在改成「一次写 → 一次读 → 一次写」：镜面的排版属性只在宽度/主题变了时才重写
     * （chromeDirty），文字只在真的变了时才写进镜面，随后**一次**读就把高度和光标矩形
     * 一起量完，最后才写输入框高度与光标样式。
     */
    /** 镜面排版属性（宽度/字体/内边距）脏了没有 —— 只在输入框尺寸或主题变化时才置真 */
    let chromeDirty = true;
    /** 已写入镜面的宽度（clientWidth，不含滚动条） */
    let mirrorWidth = -1;
    /** 缓存的计算样式里只留光标需要的那两项，避免每次 refresh 都 getComputedStyle */
    let lineHeightCache = '';
    let fontSizeCache = '';
    /** 写样式时的「上次值」缓存，避免同一帧重复写同一个属性 */
    const caretStyle = {};
    const boxStyle = boxes.map(() => ({}));
    /**
     * 重写镜面的排版属性。**只做一次写、不读**（clientWidth 除外，它是入参）。
     *
     * 为什么这些属性可以缓存：它们只随「输入框宽度」与「主题」变 —— 前者由
     * ResizeObserver 盯着（拖边改宽不会触发 window.resize），后者由主题翻转时的
     * mutation 观察者盯着。打字过程中它们一个都不会变。
     */
    function syncMirrorChrome() {
        if (!chromeDirty)
            return;
        chromeDirty = false;
        const cs = getComputedStyle(input);
        const width = input.clientWidth;
        mirrorWidth = width;
        mirror.style.width = input.clientWidth + 'px';
        mirror.style.padding = cs.padding;
        mirror.style.font = cs.font;
        mirror.style.fontSize = cs.fontSize;
        mirror.style.lineHeight = cs.lineHeight;
        mirror.style.letterSpacing = cs.letterSpacing;
        mirror.style.textAlign = cs.textAlign;
        mirror.style.whiteSpace = input.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre';
        mirror.style.wordBreak = 'break-word';
        lineHeightCache = cs.lineHeight;
        fontSizeCache = cs.fontSize;
    }
    /** 镜面里的文字与滚动偏移。文字没变就一个字节都不写。 */
    function syncMirrorText() {
        const data = input.value || '\u200b';
        if (textNode.data !== data)
            textNode.data = data;
        const transform = 'translate(' + -input.scrollLeft + 'px,' + -input.scrollTop + 'px)';
        if (mirror.style.transform !== transform)
            mirror.style.transform = transform;
    }
    /**
     * 浏览器能不能自己按内容排版输入框（Chrome 123+ 的 field-sizing: content）。
     *
     * 能的话就**完全不量高度**：让 textarea 自己长、自己滚（min/max-height 仍然生效）。
     * 这条值一次强制布局 —— 而且是每个字一次，因为文字一变高度就可能变。
     */
    const fieldSizing = (() => {
        try {
            return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');
        }
        catch {
            return false;
        }
    })();
    /**
     * 输入框该有多高（**老浏览器兜底**；支持 field-sizing 时直接返回 0，一个字都不量）。
     *
     * 读的是**镜面**的 scrollHeight，不是输入框的：旧写法先把输入框 height 写成 auto
     * 再读它的 scrollHeight —— 那是一次「写 → 读」，而且改的是输入框自身高度，
     * 连带整个输入区（还有浮窗底部的按钮行）一起重排。
     * 镜面本来就与输入框同字体同内边距同宽，它的 scrollHeight 就是内容高度。
     */
    function measureHeight() {
        if (fieldSizing)
            return 0;
        if (input.tagName !== 'TEXTAREA')
            return 0;
        if (typeof mirror.scrollHeight !== 'number')
            return 0;
        return mirror.scrollHeight || 0;
    }
    function applyHeight(measured) {
        if (input.tagName !== 'TEXTAREA' || !(measured > 0))
            return;
        const element = input;
        const next = Math.max(AUTOSIZE_MIN, Math.min(measured, AUTOSIZE_MAX));
        if (Math.abs(next - lastAutosize) <= 0.5)
            return;
        lastAutosize = next;
        element.style.height = next + 'px';
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
    /**
     * 现在到底有没有焦点。
     *
     * 同时要求「我们自己记的 hasFocus」与「document.activeElement 真的还是它」：
     * 前者保证 blur 之后立刻为假（哪怕 activeElement 还没来得及更新），
     * 后者保证「焦点被宿主悄悄挪走、而我们没收到 blur」时也能兜住。
     */
    function focused() {
        if (dead || !hasFocus)
            return false;
        try {
            return document.activeElement === input;
        }
        catch {
            return false;
        }
    }
    /** 把选区块全部收掉（失焦、降级、销毁时共用）。 */
    function hideSelectionBoxes() {
        boxes.forEach((box, i) => { box.visible = false; box.el.style.opacity = '0'; boxStyle[i] = {}; });
    }
    function hideCaret() {
        window.clearTimeout(blinkTimer);
        caret.classList.remove('is-blinking');
        if (caretVisible || caret.style.opacity !== '0')
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
    /**
     * 读阶段：把这一帧要用的几何**一次读完**。
     *
     * 顺序很重要：先把镜面文字写进去（唯一一次写），随后的第一次读会把镜面排好版，
     * 之后的所有读（高度、光标、选区、根矩形）都落在同一份干净布局上，全是便宜的。
     */
    function snapshot() {
        syncMirrorChrome();
        syncMirrorText();
        const height = measureHeight();
        const frame = root.getBoundingClientRect();
        const selected = hasSelection();
        return {
            frame: { left: frame.left, top: frame.top },
            caret: selected ? null : caretRect(),
            boxes: selected ? selectionRects().slice(0, MAX_BOXES) : [],
            height,
        };
    }
    function paintCaret(snap) {
        // 没有焦点就没有光标 —— 这是唯一判据，不看任何「上次画过」的状态。
        if (!focused()) {
            hideCaret();
            return;
        }
        // 有选区时把光标藏起来：原件 hasSelection() → hideInstant()。
        // 留着的话，选区起点会多出一根 2px 的竖条，看着像"多选了一个字符"。
        if (hasSelection()) {
            hideCaret();
            return;
        }
        const r = snap.caret;
        if (!r) {
            hideCaret();
            return;
        }
        const lineHeight = r.height || parseFloat(lineHeightCache) || parseFloat(fontSizeCache) * 1.2;
        writeStyle(caret, 'height', round(lineHeight) + 'px', caretStyle);
        /* 位置走 transform，不走 left/top：left/top 是布局属性，弹簧每推进一步就是一次布局，
           打字时（每 16ms 一步、持续 0.3s）等于把整个输入区反复重排。 */
        caretY = r.top - snap.frame.top;
        writeStyle(caret, 'top', '0px', caretStyle);
        caretX.target = r.left - snap.frame.left;
        if (!caretVisible) {
            // 从无到有：位置瞬时落位，不从旧位置滑过来
            caretX.x = caretX.target;
            caretX.v = 0;
            caretVisible = true;
            writeStyle(caret, 'transform', 'translate3d(' + round(caretX.x - 1) + 'px,' + round(caretY) + 'px,0)', caretStyle);
            caret.style.opacity = '1';
        }
    }
    function paintSelection(snap) {
        if (!focused()) {
            hideSelectionBoxes();
            return;
        }
        const rects = snap.boxes;
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
                box.left.x = r.left - snap.frame.left;
                box.left.v = 0;
                box.width.x = r.width;
                box.width.v = 0;
                writeStyle(box.el, 'transform', 'translate3d(' + round(box.left.x) + 'px,' + round(r.top - snap.frame.top) + 'px,0)', boxStyle[i]);
                writeStyle(box.el, 'width', round(box.width.x) + 'px', boxStyle[i]);
                writeStyle(box.el, 'left', '0px', boxStyle[i]);
                writeStyle(box.el, 'top', '0px', boxStyle[i]);
                box.el.style.opacity = '1';
            }
            box.left.target = r.left - snap.frame.left;
            box.width.target = r.width;
            box.top = r.top - snap.frame.top;
            writeStyle(box.el, 'height', round(r.height) + 'px', boxStyle[i]);
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
        writeStyle(caret, 'transform', 'translate3d(' + round(caretX.x - 1) + 'px,' + round(caretY) + 'px,0)', caretStyle);
        for (let i = 0; i < boxes.length; i++) {
            const box = boxes[i];
            if (!box.visible)
                continue;
            if (stepSpring(box.left, dt, cfg.substep))
                moving = true;
            if (stepSpring(box.width, dt, cfg.substep))
                moving = true;
            writeStyle(box.el, 'transform', 'translate3d(' + round(box.left.x) + 'px,' + round(box.top) + 'px,0)', boxStyle[i]);
            writeStyle(box.el, 'width', round(box.width.x) + 'px', boxStyle[i]);
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
    /**
     * 一次完整的刷新：读一次 → 写一次。
     *
     * 旧写法有五个各自触发强制布局的测量步骤（见文件上方「量取的缓存」）。现在：
     * 镜面文字写一次 → 之后的读全落在同一份干净布局上 → 高度与光标样式最后一起写。
     */
    function refresh() {
        if (dead)
            return;
        if (!active)
            return;
        let snap;
        try {
            snap = snapshot();
        }
        catch {
            // 量取失败就整体退回原生：宁可没有动效，也不能出现一根不动的假光标
            active = false;
            root.removeAttribute('data-smooth');
            return;
        }
        applyHeight(snap.height);
        // 焦点态只跟焦点走：没焦点时这一次刷新只更新高度，一根线都不画。
        // （旧写法在这里无条件 paintCaret + restartBlink —— 失焦之后随便一次刷新就把光标点亮，
        //   这就是「焦点不在输入框、却仍在闪」的那条路径。）
        if (!focused()) {
            hideCaret();
            hideSelectionBoxes();
            return;
        }
        paintCaret(snap);
        paintSelection(snap);
        // 每次刷新都算"光标动过"：只有停下来 500ms 之后才该开始闪
        if (caretVisible && !hasSelection())
            restartBlink();
        ensureLoop();
    }
    /**
     * 一帧最多刷新一次。
     *
     * 旧写法里 input / selectionchange / keyup 三个监听各调一次 refresh ——
     * 打一个字就是 3 次「整页强制布局 + 全量重写」。合并到 rAF 之后一帧最多一次，
     * 而且用的永远是**最新**的 value 与选区。
     */
    let refreshRaf = 0;
    function scheduleRefresh() {
        if (dead || !active || refreshRaf)
            return;
        refreshRaf = requestAnimationFrame(() => {
            refreshRaf = 0;
            if (!dead && active)
                refresh();
        });
    }
    /**
     * 浮窗正在被拖动改大小：**先别量**。
     *
     * 拖动时 ResizeObserver 每帧都会响（输入框宽度真的在变），而每一次 refresh 都要
     * 强制一次布局 —— 和浏览器自己的重排叠在一起，就成了「拉一下就卡一下」。
     * 尺寸稳定之后补一次即可：拖动过程中用户不会在看光标。
     */
    let settleRaf = 0;
    function whenResizeSettled(fn) {
        const panel = (root.closest?.('.dsh-explain-assistant-overlay') || null);
        if (!panel || panel.getAttribute('data-resizing') !== 'true') {
            fn();
            return;
        }
        if (settleRaf)
            return;
        const step = () => {
            settleRaf = 0;
            if (dead)
                return;
            if (panel.getAttribute('data-resizing') === 'true') {
                settleRaf = requestAnimationFrame(step);
                return;
            }
            fn();
        };
        settleRaf = requestAnimationFrame(step);
    }
    function onScroll() {
        if (!active)
            return;
        scheduleRefresh();
    }
    /**
     * 焦点真的进来了。
     *
     * data-focus 是焦点环的唯一开关（样式里只认 [data-focus="keyboard"]）：
     * 键盘进来的焦点给环，鼠标点进来的不给 —— 文本输入框在 Chrome 里连「点一下」
     * 都算 :focus-visible，旧写法于是点一下输入框就常驻一圈亮环（用户说的「光圈」）。
     */
    function onFocus() {
        hasFocus = true;
        root.setAttribute('data-focus', lastKeyAt > lastPointerAt ? 'keyboard' : 'on');
        if (!active)
            return;
        caretVisible = false;
        caretOpacity.x = 1;
        caretOpacity.target = 1;
        caret.style.opacity = '1';
        // 焦点进来要立刻有一根光标，等一帧会看到"先没有、再出现"
        refresh();
    }
    /** 焦点真的走了：光标、选区块、焦点环**一起**在同一帧收掉。 */
    function onBlur() {
        hasFocus = false;
        root.removeAttribute('data-focus');
        if (!active)
            return;
        window.clearTimeout(blinkTimer);
        caret.classList.remove('is-blinking');
        // 关键：caretVisible 必须一起置假。旧写法只把 opacity 弹簧推回 0，
        // caretVisible 仍是 true —— 下一次 refresh 就会认为「光标本来就该在」，
        // 于是 restartBlink() 把它重新点亮，闪个不停。
        caretVisible = false;
        caretOpacity.target = 0;
        ensureLoop();
        hideSelectionBoxes();
    }
    /** 窗口整个失焦（切到别的应用/标签页）时，浏览器会收起原生光标，这里跟着收。 */
    const onWindowBlur = () => { if (focused())
        hideCaret(); };
    const onWindowFocus = () => { if (focused())
        refresh(); };
    /** 记录「这次焦点是拿鼠标点的还是按 Tab 进去的」，只用于决定要不要画焦点环。 */
    const onPointerIntent = () => { lastPointerAt = Date.now(); };
    const onKeyIntent = (event) => { if (event.key === 'Tab')
        lastKeyAt = Date.now(); };
    const onSelectionChange = () => { if (document.activeElement === input)
        scheduleRefresh(); };
    const onViewportChange = () => { chromeDirty = true; scheduleRefresh(); };
    /** 主题翻转会换字体/行高：镜面的排版属性必须重算一次。 */
    const onThemeChange = () => { chromeDirty = true; scheduleRefresh(); };
    const listeners = [
        [input, 'input', scheduleRefresh],
        [input, 'keyup', scheduleRefresh],
        [input, 'mouseup', scheduleRefresh],
        [input, 'scroll', onScroll],
        [input, 'focus', onFocus],
        [input, 'blur', onBlur],
        [input, 'compositionstart', scheduleRefresh],
        [input, 'compositionend', scheduleRefresh],
        [document, 'selectionchange', onSelectionChange],
        [window, 'resize', onViewportChange],
        [window, 'blur', onWindowBlur],
        [window, 'focus', onWindowFocus],
    ];
    /**
     * 焦点归属的监听**与动效无关**：reduced-motion 下自绘光标不接管，
     * 但键盘用户仍然需要一个看得见的焦点提示（data-focus → 焦点环）。
     */
    const focusListeners = [
        [input, 'focus', onFocus],
        [input, 'blur', onBlur],
        [document, 'pointerdown', onPointerIntent],
        [document, 'keydown', onKeyIntent],
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
    /** 主题属性一变，镜面的字体/行高就可能变（深浅色用的是两套字重与字号）。 */
    const themeObserver = typeof MutationObserver === 'function' && typeof document.documentElement !== 'undefined'
        ? new MutationObserver(() => onThemeChange())
        : null;
    /**
     * 浮窗拖边改宽走的是 pointermove 直接改 style，不会触发 window.resize ——
     * 没有这个观察者，镜面宽度会停在旧值，光标和选区继续按旧换行点画。
     *
     * 2026-11-07：改成「先标脏、等尺寸稳定再量一次」。拖动过程中每帧都量一次，
     * 等于把浏览器自己的重排乘上 3（实测拖一下 p95 116ms）。
     */
    const sizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            if (dead || !active)
                return;
            chromeDirty = true;
            whenResizeSettled(scheduleRefresh);
        })
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
        hideSelectionBoxes();
        if (rafId)
            cancelAnimationFrame(rafId);
        rafId = 0;
    };
    focusListeners.forEach(([target, name, fn]) => target.addEventListener(name, fn, true));
    // 挂载时焦点可能已经在里面了（宿主要求打开即聚焦的路径）：补一次状态。
    if (typeof document !== 'undefined' && document.activeElement === input)
        onFocus();
    if (active) {
        listeners.forEach(([target, name, fn]) => target.addEventListener(name, fn, true));
        observer?.observe(document.body, { childList: true, subtree: true });
        themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] });
        sizeObserver?.observe(input);
        motionQuery?.addEventListener?.('change', onMotionChange);
        root.setAttribute('data-smooth', 'on');
        try {
            refresh();
        }
        catch {
            // 量取失败就整体退回原生：宁可没有动效，也不能出现一根不动的假光标
            active = false;
            root.removeAttribute('data-smooth');
        }
        // 字体晚到时换行点会变，量一次
        try {
            document.fonts?.ready?.then(() => { if (!dead && active) {
                chromeDirty = true;
                refresh();
            } });
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
            if (refreshRaf)
                cancelAnimationFrame(refreshRaf);
            if (settleRaf)
                cancelAnimationFrame(settleRaf);
            rafId = 0;
            refreshRaf = 0;
            settleRaf = 0;
            listeners.forEach(([target, name, fn]) => target.removeEventListener(name, fn, true));
            focusListeners.forEach(([target, name, fn]) => target.removeEventListener(name, fn, true));
            root.removeAttribute('data-focus');
            observer?.disconnect();
            themeObserver?.disconnect();
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
