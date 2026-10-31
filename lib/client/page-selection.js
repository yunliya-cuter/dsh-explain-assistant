/**
 * 正文选区的动画高亮（移植自 More 设置向导 2026-10-25 版 page-selection.js）。
 *
 * 浏览器原生的 ::selection 只能"啪"地出现、啪地换形，没有任何过渡可言。
 * 这里在浮窗上叠一层高亮块：位置与宽度由弹簧驱动（键盘 0.2s / 拖选 0.1s /
 * 淡入 0.12s，与输入框里那套同源），跨行、跨段的选区会被平滑地重塑。
 *
 * 三条硬约束：
 *  1. 只画在**文字下方**：高亮层 z-index:-1，浮窗是层叠上下文，
 *     于是它排在浮窗背景之上、所有内容之下 —— 字形一个像素都不会被染色/变粗。
 *  2. 只量文字：整段 Range 直接取矩形会把图标、按钮也量成方块，
 *     所以按文本节点切开，各取各的矩形，再按几何去重（嵌套矩形会叠出深色）。
 *  3. 不拦操作：整层 pointer-events:none，拖选、双击选词、Ctrl+A、复制都不受影响。
 *
 * ── 本轮修正（2026-10-31 审计）─────────────────────────────────
 * · **画不了就交还原生**。自绘高亮有三个画不了的场景，以前都是"硬画一半"，
 *   而原生选中色又被关掉了，结果就是"选中了却什么都看不见"：
 *     a) 选区里有不透明底色（模型页/教程页/提问气泡/引导卡/错误卡）——
 *        高亮垫在 z-index:-1，被那些底色整个盖住；
 *     b) 选区超过 MAX_BLOCKS 个矩形 —— 以前只画前 24 个，
 *        实测 37 行的选区只有 20 行有蓝色，剩下 17 行看着像没选中；
 *     c) 选区落在浮窗里但量不出任何文字矩形（例如在输入框里）。
 *   这三种情况现在统一把 data-page-selection 摘掉，让浏览器原生选中色回来：
 *   宁可没有动画，也不能让"选中"这件事看不出来。
 * · **跨出浮窗边界的选区**：以前只要 range 的公共祖先跑出浮窗（拖到浮窗外），
 *   整段 range 直接被丢弃，浮窗内那一段高亮整体消失。现在按"是否与浮窗相交"判断，
 *   只画落在浮窗里的那部分。
 * · **减少动态效果可以在运行中切换**：监听 media query 的 change，
 *   两个方向都要切回对应的那一套（否则 CSS 把自绘层 display:none 了，原生又是透明的）。
 *
 * 输入框里的选区不在这里画 —— 那是 text-field.ts 的活，两边各管一段，不会叠成两份。
 */
import { createSpring, stepSpring, DEFAULT_CONFIG } from './text-field.js';
const PAD_X = 1.5;
const PAD_Y = 1.5;
const SNAP_EPS = 0.05;
/**
 * 一屏最多画多少个高亮块。每个块两个弹簧，成本可以忽略；
 * 但一次 Ctrl+A 就能产生几百个矩形，所以要有上限 —— 超过就交还原生选区。
 * 64 是"长回答整段全选"的实测上界（约 30 行、含行内代码碎片）。
 */
const MAX_BLOCKS = 64;
function round(n) {
    return Math.round(n * 100) / 100;
}
function clamp(n, min, max) {
    return Math.min(Math.max(n, min), max);
}
function reducedMotion() {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    catch {
        return false;
    }
}
/** 从 computed backgroundColor 里取 alpha；解析不了就当作"不挡"（继续自绘）。 */
function backgroundAlpha(color) {
    const match = /^rgba?\(([^)]+)\)$/.exec(String(color || '').trim());
    if (!match)
        return 0;
    const parts = match[1].split(/[,/]/).map(part => parseFloat(part));
    if (parts.length < 4)
        return 1;
    return Number.isFinite(parts[3]) ? parts[3] : 1;
}
function unavailable() {
    return { layer: document.createElement('div'), refresh() { }, destroy() { } };
}
export function mountPageSelection(root, overrides = {}) {
    // 环境不具备（测试用的假 DOM、极老的浏览器）就整体不接管，退回浏览器原生选中色
    if (typeof root.insertBefore !== 'function'
        || typeof document.createTreeWalker !== 'function'
        || typeof NodeFilter === 'undefined'
        || typeof requestAnimationFrame !== 'function') {
        return unavailable();
    }
    const cfg = { ...DEFAULT_CONFIG, ...overrides };
    const layer = document.createElement('div');
    layer.className = 'ea-page-sel-layer';
    layer.setAttribute('aria-hidden', 'true');
    root.insertBefore(layer, root.firstChild);
    const blocks = [];
    let rafId = 0;
    let lastTime = 0;
    let active = false;
    let dead = false;
    /** 量不出/画不了 → 交还原生选中色 */
    let native = false;
    /** 这一趟扫描是不是撞上了 MAX_BLOCKS */
    let overflowed = false;
    const engineOk = typeof document.createRange === 'function';
    let enabled = engineOk && !reducedMotion();
    function createBlock() {
        const node = document.createElement('div');
        node.className = 'ea-page-sel';
        node.setAttribute('aria-hidden', 'true');
        layer.appendChild(node);
        return {
            node,
            left: createSpring(0, cfg.selectionResponse, 1),
            width: createSpring(0, cfg.selectionResponse, 1),
            opacity: createSpring(0, cfg.selectionFade, 1),
            alive: false,
        };
    }
    function ensureBlocks(count) {
        while (blocks.length < count && blocks.length < MAX_BLOCKS)
            blocks.push(createBlock());
    }
    /** 该不该用原生选中色：自绘画不了的时候必须让位。 */
    function syncNativeAttribute() {
        if (!enabled || native)
            root.removeAttribute('data-page-selection');
        else
            root.setAttribute('data-page-selection', 'on');
    }
    function setNative(on) {
        if (on === native)
            return;
        native = on;
        syncNativeAttribute();
    }
    /** 选区是否落在本浮窗里（**相交即算**，不再要求整段都在里面）。 */
    function selectionScope() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0)
            return null;
        const ranges = [];
        for (let i = 0; i < selection.rangeCount; i++) {
            const range = selection.getRangeAt(i);
            if (range.collapsed)
                continue;
            // 输入框里的选区交给 text-field.ts，这里不重复画
            const node = range.commonAncestorContainer;
            const elNode = node.nodeType === 1 ? node : node.parentElement;
            if (elNode?.closest?.('.ea-field'))
                continue;
            // 相交即算：从浮窗里拖到浮窗外，浮窗里那一段仍然要高亮
            let intersects = false;
            try {
                intersects = range.intersectsNode(root);
            }
            catch {
                intersects = false;
            }
            if (!intersects)
                continue;
            ranges.push(range);
        }
        return ranges.length ? ranges : null;
    }
    /** 选区所在的祖先里有没有不透明底色 —— 有的话自绘层会被压在它下面，只能退回原生。 */
    function coveredByPaint(range) {
        // 只沿着**落在浮窗里面**的那一端往上找。跨出浮窗的选区，commonAncestor 会是 body，
        // 而 body 一定有自己的底色 —— 拿它判断会把「有内到外拖选」整段判成被遮挡，结果浮窗里那一段又不画了。
        const inside = (node) => Boolean(node && (node === root || root.contains(node)));
        const anchor = inside(range.startContainer) ? range.startContainer
            : inside(range.endContainer) ? range.endContainer : null;
        if (!anchor)
            return false;
        let element = anchor.nodeType === 1 ? anchor : anchor.parentElement;
        let guard = 0;
        while (element && element !== root && guard < 64) {
            guard++;
            let color = '';
            try {
                color = getComputedStyle(element).backgroundColor;
            }
            catch {
                color = '';
            }
            if (backgroundAlpha(color) >= 0.5)
                return true;
            element = element.parentElement;
        }
        return false;
    }
    function coveredBy(list, r) {
        for (const c of list) {
            const cLeft = c.left + PAD_X;
            const cTop = c.top + PAD_Y;
            const cRight = cLeft + c.width - PAD_X * 2;
            const cBottom = cTop + c.height - PAD_Y * 2;
            if (r.left >= cLeft - 2 && r.top >= cTop - 2 && r.right <= cRight + 2 && r.bottom <= cBottom + 2)
                return true;
        }
        return false;
    }
    function collectRects(ranges) {
        overflowed = false;
        const out = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        const nodes = [];
        let node = walker.nextNode();
        while (node) {
            nodes.push(node);
            node = walker.nextNode();
        }
        for (const range of ranges) {
            for (const text of nodes) {
                if (!range.intersectsNode(text))
                    continue;
                const parent = text.parentElement;
                if (parent?.closest?.('.ea-field, .ea-page-sel-layer, .ea-model-search'))
                    continue;
                const part = document.createRange();
                part.setStart(text, text === range.startContainer ? range.startOffset : 0);
                part.setEnd(text, text === range.endContainer ? range.endOffset : text.length);
                if (part.collapsed)
                    continue;
                const list = part.getClientRects();
                for (const r of Array.from(list)) {
                    if (r.width <= 0 || r.height <= 0)
                        continue;
                    if (coveredBy(out, r))
                        continue;
                    out.push({ left: r.left - PAD_X, width: r.width + PAD_X * 2, top: r.top - PAD_Y, height: r.height + PAD_Y * 2 });
                }
                if (out.length >= MAX_BLOCKS) {
                    overflowed = true;
                    return null;
                }
            }
        }
        return out.length ? out : null;
    }
    function frameBlock(block, dt, rect) {
        let moving = false;
        if (rect) {
            block.alive = true;
            if (block.opacity.x < SNAP_EPS) {
                block.left.x = rect.left;
                block.left.v = 0;
                block.width.x = rect.width;
                block.width.v = 0;
            }
            block.left.target = rect.left;
            block.width.target = rect.width;
            block.node.style.top = round(rect.top) + 'px';
            block.node.style.height = round(rect.height) + 'px';
            if (stepSpring(block.left, dt, cfg.substep))
                moving = true;
            if (stepSpring(block.width, dt, cfg.substep))
                moving = true;
            block.node.style.left = round(block.left.x) + 'px';
            block.node.style.width = round(Math.max(block.width.x, 0)) + 'px';
            block.opacity.target = 1;
        }
        else {
            block.opacity.target = 0;
        }
        if (stepSpring(block.opacity, dt, cfg.substep))
            moving = true;
        block.node.style.opacity = String(round(clamp(block.opacity.x, 0, 1) * 1000) / 1000);
        if (!rect && block.opacity.x <= 0.001 && Math.abs(block.opacity.v) < 0.01)
            block.alive = false;
        return moving;
    }
    function tick(now) {
        if (dead)
            return;
        const dt = clamp((now - lastTime) / 1000, 0, cfg.maxDt);
        lastTime = now;
        const ranges = native ? null : selectionScope();
        const rects = ranges ? collectRects(ranges) : null;
        // 拖选过程中矩形数可能越过上限（或反向回到上限内），这里跟着切
        if (overflowed)
            setNative(true);
        if (!ranges)
            active = false;
        if (rects)
            ensureBlocks(rects.length);
        const origin = layer.getBoundingClientRect();
        let moving = false;
        for (let i = 0; i < blocks.length; i++) {
            const rect = rects && i < rects.length
                ? { left: rects[i].left - origin.left, width: rects[i].width, top: rects[i].top - origin.top, height: rects[i].height }
                : null;
            if (frameBlock(blocks[i], dt, rect))
                moving = true;
        }
        rafId = moving ? requestAnimationFrame(tick) : 0;
    }
    function start() {
        if (dead || rafId || !enabled)
            return;
        lastTime = performance.now();
        rafId = requestAnimationFrame(tick);
    }
    function refresh() {
        if (dead || !enabled)
            return;
        const ranges = selectionScope();
        if (!ranges) {
            setNative(false);
            active = false;
            start();
            return;
        }
        const rects = collectRects(ranges);
        const covered = ranges.some(range => coveredByPaint(range));
        // 画不了就交还原生：有底色挡住 / 超过块数上限 / 一个矩形都量不出来
        if (overflowed || covered || !rects || rects.length === 0) {
            setNative(true);
            active = false;
            start();
            return;
        }
        setNative(false);
        active = true;
        start();
    }
    /**
     * 拖选过程中浏览器会持续派发 selectionchange —— 高亮必须在**拖的当下**就跟着走，
     * 不能等松手。每帧 tick 里还会重新取一次矩形，
     * 所以即使指针停住、弹簧已经收敛，选区一变也能立刻接上。
     */
    const onSelectionChange = () => refresh();
    const onPointerDown = () => { if (active)
        start(); };
    const onPointerUp = () => refresh();
    const onScroll = () => { if (active)
        start(); };
    const onViewportChange = () => refresh();
    const listeners = [
        [document, 'selectionchange', onSelectionChange, false],
        [document, 'pointerdown', onPointerDown, true],
        [window, 'pointerup', onPointerUp, true],
        [window, 'resize', onViewportChange, false],
        [root, 'scroll', onScroll, true],
        [window, 'scroll', onScroll, true],
    ];
    if (enabled) {
        listeners.forEach(([target, name, fn, capture]) => target.addEventListener(name, fn, capture));
        syncNativeAttribute();
    }
    /** 「减少动态效果」可以在运行中打开：那一刻必须把原生选中色还回去。 */
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
        if (next === enabled)
            return;
        enabled = next;
        if (!enabled) {
            setNative(true);
            active = false;
            blocks.forEach(block => { block.node.style.opacity = '0'; });
            if (rafId)
                cancelAnimationFrame(rafId);
            rafId = 0;
            syncNativeAttribute();
            return;
        }
        setNative(false);
        syncNativeAttribute();
        refresh();
    };
    motionQuery?.addEventListener?.('change', onMotionChange);
    const observer = typeof MutationObserver === 'function'
        ? new MutationObserver(() => { if (!root.isConnected)
            handle.destroy(); })
        : null;
    observer?.observe(document.body, { childList: true, subtree: true });
    const handle = {
        layer,
        refresh,
        destroy() {
            if (dead)
                return;
            dead = true;
            if (rafId)
                cancelAnimationFrame(rafId);
            rafId = 0;
            listeners.forEach(([target, name, fn, capture]) => target.removeEventListener(name, fn, capture));
            motionQuery?.removeEventListener?.('change', onMotionChange);
            observer?.disconnect();
            root.removeAttribute('data-page-selection');
            layer.remove();
        },
    };
    return handle;
}
