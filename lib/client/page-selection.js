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
    /** 几何脏了没有：只有它为真时 tick 才真的重量一次 */
    let dirty = true;
    /** 上一次量出来的矩形（视口坐标），tick 每帧只拿它推进弹簧 */
    let rectsCache = null;
    /** 下一次 tick 要不要"瞬时落位"（滚动/缩放触发时为 true） */
    let pendingSnap = false;
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
            ty: 0,
        };
    }
    function ensureBlocks(count) {
        while (blocks.length < count && blocks.length < MAX_BLOCKS)
            blocks.push(createBlock());
    }
    /**
     * 最近一个「真的会滚」的祖先的客户区，再与视口求交。
     *
     * 为什么补这一刀：高亮层只被浮窗本身 overflow:hidden 裁，正文滚出滚动区之后
     * 那几行会画到浮窗自己的标题栏上（2026-11-01 复现：26 个块里 7 个落在正文区上边界
     * 之上，最上面一个 y=-39）。只认「内容确实超出」的祖先，避免被圆角 overflow:hidden
     * 的装饰层误裁。
     */
    function clipRectOf(node) {
        let left = 0;
        let top = 0;
        let right = window.innerWidth || document.documentElement.clientWidth || 0;
        let bottom = window.innerHeight || document.documentElement.clientHeight || 0;
        let el = node.nodeType === 1 ? node : node.parentElement;
        let guard = 0;
        while (el && el !== document.body && el !== document.documentElement && guard++ < 40) {
            const cs = getComputedStyle(el);
            const oy = cs.overflowY;
            const ox = cs.overflowX;
            const clips = (oy && oy !== 'visible') || (ox && ox !== 'visible');
            if (clips && el.clientHeight > 2 && el.clientWidth > 2
                && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
                const r = el.getBoundingClientRect();
                left = Math.max(left, r.left + el.clientLeft);
                top = Math.max(top, r.top + el.clientTop);
                right = Math.min(right, r.left + el.clientLeft + el.clientWidth);
                bottom = Math.min(bottom, r.top + el.clientTop + el.clientHeight);
                break;
            }
            el = el.parentElement;
        }
        if (right - left < 2 || bottom - top < 2)
            return null;
        return { left, top, right, bottom };
    }
    /**
     * 只收集落在可见区里的文本节点。
     *
     * 旧实现把浮窗里**所有**文本节点先走一遍再逐个 intersectsNode ——
     * 而 tick 每帧都会调它：4,000 节点实测单帧 3.8ms，内容越长越慢。
     * 现在先按子树矩形剪枝，屏幕外的整棵子树一步不进去。
     */
    /**
     * 「这个矩形能不能拿来判断在不在视口里」。
     *
     * 空矩形**不等于**在视口外：DSH 里到处是 display:contents 的包裹层，
     * 它们的 getBoundingClientRect() 恒为 0×0×0×0。当成"在视口上方"剪掉，
     * 整棵树会被剪空 —— 3082 真机实测：选区明明在屏上，一个文本节点都收不到。
     * 所以空矩形一律放行，只有真有面积的元素才按矩形剪。
     */
    function rectUsable(r) { return !!r && (r.width > 0 || r.height > 0); }
    /** 自己没面积就往下钻第一个有面积的子元素（display:contents 包裹层用它代表自己）。 */
    function probeRect(el) {
        let r = null;
        try {
            r = el.getBoundingClientRect();
        }
        catch {
            r = null;
        }
        if (rectUsable(r))
            return r;
        let node = el;
        let depth = 0;
        while (depth++ < 6) {
            const child = node.firstElementChild;
            if (!child)
                return r;
            try {
                r = child.getBoundingClientRect();
            }
            catch {
                return r;
            }
            if (rectUsable(r))
                return r;
            node = child;
        }
        return r;
    }
    function outsideClip(r, clip) {
        if (!rectUsable(r))
            return false;
        return r.bottom < clip.top - 1 || r.top > clip.bottom + 1
            || r.right < clip.left - 1 || r.left > clip.right + 1;
    }
    /** 兄弟节点竖排时二分找第一条落在可见区里的；前提不满足就退回线性扫描。 */
    function visibleStartIndex(kids, clip) {
        const n = kids.length;
        if (n <= 24)
            return 0;
        const probe = (i) => {
            const el = kids[i];
            if (!el || el.nodeType !== 1)
                return null;
            return probeRect(el);
        };
        const first = probe(0);
        const last = probe(n - 1);
        if (!rectUsable(first) || !rectUsable(last))
            return 0;
        if (first.top > last.top)
            return 0;
        let lo = 0;
        let hi = n - 1;
        let guard = 0;
        while (lo < hi && guard++ < 40) {
            const mid = (lo + hi) >> 1;
            const r = probe(mid);
            if (!rectUsable(r))
                return 0;
            if (r.bottom < clip.top)
                lo = mid + 1;
            else
                hi = mid;
        }
        return Math.max(0, lo - 1);
    }
    function collectVisibleText(el, clip, out, budget, range) {
        const kids = el.childNodes;
        const start = visibleStartIndex(kids, clip);
        for (let i = start; i < kids.length; i++) {
            const node = kids[i];
            if (node.nodeType === 3) {
                if (!node.nodeValue)
                    continue;
                /* 同屏 ≠ 在选区里：剪枝之后每个容器只剩几十个节点，这一步很便宜。 */
                let hit = true;
                try {
                    hit = range.intersectsNode(node);
                }
                catch {
                    hit = false;
                }
                if (!hit)
                    continue;
                out.push(node);
                if (out.length > budget)
                    return;
                continue;
            }
            if (node.nodeType !== 1)
                continue;
            const elNode = node;
            if (elNode.classList && elNode.classList.contains('ea-page-sel-layer'))
                continue;
            const r = probeRect(elNode);
            if (outsideClip(r, clip)) {
                if (rectUsable(r) && r.top > clip.bottom + 1 && kids.length > 8) {
                    let back = false;
                    for (let j = i + 1; j < kids.length && j <= i + 3; j++) {
                        if (kids[j].nodeType !== 1)
                            continue;
                        try {
                            const rj = probeRect(kids[j]);
                            if (rectUsable(rj) && rj.top <= clip.bottom + 1) {
                                back = true;
                                break;
                            }
                        }
                        catch { /* 忽略 */ }
                    }
                    if (!back)
                        return;
                }
                continue;
            }
            collectVisibleText(elNode, clip, out, budget, range);
            if (out.length > budget)
                return;
        }
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
        const budget = MAX_BLOCKS * 6;
        for (const range of ranges) {
            const clip = clipRectOf(range.startContainer);
            if (!clip)
                continue;
            const scope = range.commonAncestorContainer;
            const scopeEl = scope.nodeType === 1 ? scope : scope.parentElement;
            if (!scopeEl)
                continue;
            const nodes = [];
            collectVisibleText(scopeEl, clip, nodes, budget, range);
            for (const text of nodes) {
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
                    const left = Math.max(r.left - PAD_X, clip.left);
                    const top = Math.max(r.top - PAD_Y, clip.top);
                    const right = Math.min(r.right + PAD_X, clip.right);
                    const bottom = Math.min(r.bottom + PAD_Y, clip.bottom);
                    if (right - left <= 0.5 || bottom - top <= 0.5)
                        continue;
                    if (coveredBy(out, { left, top, right, bottom }))
                        continue;
                    out.push({ left, width: right - left, top, height: bottom - top });
                }
                if (out.length >= MAX_BLOCKS) {
                    overflowed = true;
                    return null;
                }
            }
        }
        return out.length ? out : null;
    }
    function frameBlock(block, dt, rect, origin, snap) {
        let moving = false;
        if (rect) {
            block.alive = true;
            /* 视口刚动过（滚动/缩放）：直接落位，不做弹簧。
               可见区的矩形集合每滚一步整体换一批，按索引匹配的块会拿到"另一行"的目标值，
               弹簧一过渡就成了"橙框自己会动"（台架实测：滚动中 16 个块全部偏离、17 行没人盖）。 */
            if (snap) {
                block.left.x = rect.left;
                block.left.v = 0;
                block.width.x = rect.width;
                block.width.v = 0;
            }
            else if (block.opacity.x < SNAP_EPS) {
                block.left.x = rect.left;
                block.left.v = 0;
                block.width.x = rect.width;
                block.width.v = 0;
            }
            block.left.target = rect.left;
            block.width.target = rect.width;
            block.ty = round(rect.top - origin.top);
            block.node.style.height = round(rect.height) + 'px';
            if (stepSpring(block.left, dt, cfg.substep))
                moving = true;
            if (stepSpring(block.width, dt, cfg.substep))
                moving = true;
            /* 位置走 transform，不走 left/top：left/top 是布局属性，每帧改一次就是一次
               布局；块多的时候（上限 64）这一项就能吃掉好几毫秒。 */
            block.node.style.transform = 'translate3d(' + round(block.left.x - origin.left) + 'px,' + block.ty + 'px,0)';
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
    /**
     * 量一次几何。只在 dirty 时由 tick 调用 —— 以前是**每帧**调用，
     * 拖选时等于每帧把整个浮窗的文本节点走一遍（4,000 节点 3.8ms/帧）。
     * 现在只有"选区变了 / 滚动了 / 尺寸变了"才重量，弹簧照样逐帧推进。
     */
    function measure() {
        const ranges = selectionScope();
        if (!ranges) {
            setNative(false);
            active = false;
            rectsCache = null;
            return;
        }
        const rects = collectRects(ranges);
        const covered = ranges.some(range => coveredByPaint(range));
        // 真的画不了才交还原生：有底色挡住 / 超过块数上限
        if (overflowed || covered) {
            setNative(true);
            active = false;
            rectsCache = null;
            return;
        }
        /* 选区还在，只是这一帧跟可见区没有交集（滚出屏外了）：继续抑制原生色，
           只把块淡出。以前这里一并 setNative(true)，于是"滚出去再滚回来"会变成
           一段系统蓝，而且 active=false 之后 onScroll 也不再重画，就永远停在蓝色上。 */
        setNative(false);
        active = true;
        rectsCache = rects && rects.length ? rects : null;
    }
    function tick(now) {
        if (dead)
            return;
        const dt = clamp((now - lastTime) / 1000, 0, cfg.maxDt);
        lastTime = now;
        let snapNow = false;
        if (dirty) {
            dirty = false;
            measure();
            snapNow = pendingSnap;
            pendingSnap = false;
        }
        const rects = rectsCache;
        if (rects)
            ensureBlocks(rects.length);
        const origin = layer.getBoundingClientRect();
        let moving = false;
        for (let i = 0; i < blocks.length; i++) {
            const rect = rects && i < rects.length ? rects[i] : null;
            if (frameBlock(blocks[i], dt, rect, origin, snapNow))
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
    /** snap = 这次重算是"视口动了"引起的，块必须瞬时落位，不能过渡。 */
    function refresh(snap = false) {
        if (dead || !enabled)
            return;
        dirty = true;
        if (snap)
            pendingSnap = true;
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
    const onScroll = () => { refresh(true); };
    const onViewportChange = () => { refresh(true); };
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
