/**
 * §4/§8/§10：入口按钮（主对话右上角）的**图标**与**未读徽标**。
 *
 * ── 这一版改了什么（用户 2026-10-31：「这个图标太丑，改改，样式和动画简单精致舒适」）──
 * 旧版按钮里是一个**文字字符** `?`（未读时是 `? ·`）。丑的根因不是"问号"这个语义，
 * 而是**它是一段文字**：字形、字重、基线全部由宿主字体决定，30px 的方框里那一个字符
 * 又粗又偏，和隔壁 16px 细线图标（↗ / ⋯ / ▯）根本不是一套语言。
 *
 * 新版换成**自绘的 16×16 线性图标**：圆角对话气泡 + 内部两行短横线（上长下短）+ 左下小尾巴。
 * 为什么是它：
 * · 语义是「对选中的一段文字做解释/加注」（不是"求助"），气泡里的两行线正是"一段被讲解的文字"；
 * · 闭合轮廓在 16px 下有强剪影，比开口线稿抗糊；
 * · 全是 path，与字体、字号、baseline 彻底解耦 —— 这才是"不再丑"的结构性原因。
 *
 * ── 几何（这些数字就是"为什么 16px 下清楚"）────────────────────────
 * 墨迹外框 12×12（x/y 都在 2.0–14.0），与宿主图标同框；stroke 1、round cap/join；
 * 气泡本体 11×9、圆角 2.5；两行线在 y=5.5 / 8.5，行长 6.0 / 3.5，左端与左上圆角终点同为 x=5。
 * 净空（线到内壁、两线之间）都 ≥2，是 1px 描边在 16px 下不糊成一团的下限。
 */
/** 气泡本体：底边中段起笔拉出左下尾巴，尾巴与左边框同一条线（不留悬浮的 2px 三角）。 */
export const HEADER_GLYPH_OUTLINE = 'M5 2.5H11A2.5 2.5 0 0 1 13.5 5V9A2.5 2.5 0 0 1 11 11.5H6.5L2.5 13.5V5A2.5 2.5 0 0 1 5 2.5Z';
/** 内部两行：上长下短，差 2.5 —— 小于这个差在 100% 缩放下分不出"两行"。 */
export const HEADER_GLYPH_LINES = ['M5 5.5H11', 'M5 8.5H8.5'];
/** 三笔合一：本体 + 两行（顺序即绘制顺序）。 */
export const HEADER_GLYPH_PATHS = [HEADER_GLYPH_OUTLINE, ...HEADER_GLYPH_LINES];
/** 忙碌弧：与气泡同一个墨迹框（r=6 → 12×12），所以气泡↔弧切换时重心不移动。 */
export const HEADER_RING_RADIUS = 6;
/** 图标画布尺寸，与宿主 header 图标一致。 */
export const HEADER_ICON_SIZE = 16;
/**
 * 建出入口按钮的**内容**（不含按钮本身）—— 返回的是 **React 元素树**，不是 DOM 节点。
 *
 * ── 这里踩过一个坑，写下来免得再犯 ────────────────────────────────
 * 第一版返回的是 `document.createElement` 造出来的真 DOM 节点，然后当成 children 交给
 * React。测试里的假 React 是"给什么存什么"，所以全绿；**真实 React 不接受 DOM 节点当子节点**
 * （它会当成普通对象 → 渲染不出来）。页面上看到的现象就是：按钮还在，图标没了。
 *
 * 所以这里改成注入式：调用方把自己的 `createElement` 传进来，函数只产出"类型 + 属性 + 子节点"
 * 的普通对象。既能在真实 React 里渲染，也能在测试里用假工厂逐层断言。
 *
 * 三层常驻挂载（气泡 / 忙碌弧 / 未读点），状态切换只改按钮上的 `data-unread` / `data-busy`，
 * 由 CSS 做透明度交叉淡入 —— 状态变化时**不替换 DOM 节点**（React 按 type/key 复用），
 * 既不触发 flex 重排（30px 方框里那就是"抖一下"），也不会打断正在跑的过渡。
 */
export function createHeaderContent(h) {
    const glyph = h('svg', {
        className: 'ea-hbtn-glyph',
        width: HEADER_ICON_SIZE,
        height: HEADER_ICON_SIZE,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
    }, ...HEADER_GLYPH_PATHS.map(d => h('path', { d, key: d })));
    const ring = h('svg', {
        className: 'ea-hbtn-ring',
        width: HEADER_ICON_SIZE,
        height: HEADER_ICON_SIZE,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
    }, h('circle', {
        cx: 8,
        cy: 8,
        r: HEADER_RING_RADIUS,
        strokeDasharray: '13 24.7',
        strokeDashoffset: '10',
    }));
    const dot = h('span', { className: 'ea-hbtn-dot' });
    return h('span', { className: 'ea-hbtn' }, glyph, ring, dot);
}
/** 按钮的 title（鼠标悬停提示）。未读时明确说「有新内容」。 */
export function headerButtonTitle(unread) {
    return unread === true ? '解释小助手有新内容' : '打开解释小助手';
}
/**
 * 按钮的无障碍名。
 *
 * 图标本身 `aria-hidden`（它只是装饰），所以**未读这件事必须进 label**，
 * 否则读屏用户永远不知道"有新内容"。
 */
export function headerButtonAriaLabel(unread) {
    return unread === true ? '解释小助手（有新内容）' : '打开解释小助手';
}
/**
 * 按钮当前应该长什么样 —— 纯函数，把「数据 → 视觉状态」这一步从组件里拿出来。
 *
 * 非 true 的 unread 一律按"无未读"处理（undefined / 'true' / 0 都不显示徽标）。
 */
export function headerButtonState(unread, busy) {
    const hasUnread = unread === true;
    return {
        unread: hasUnread,
        busy: busy === true,
        title: headerButtonTitle(hasUnread),
        ariaLabel: headerButtonAriaLabel(hasUnread),
    };
}
/**
 * 订阅「**该会话自己的**」未读变化，变了才回调。
 *
 * 两个要点：
 * 1. 只在**目标会话**的 unread 真的变化时回调 —— registry 的 subscribe 是全局广播
 *    （任何会话的任何字段变化都会 emit），若不比较就会因为别的会话变动而白重渲染；
 * 2. 也因此天然满足「切换主对话后不得读到别的会话的 unread」：读的始终是传入的 sessionId。
 *
 * @returns 取消订阅函数（组件卸载时必须调用，否则泄漏）。
 */
export function watchUnread(registry, sessionId, onChange) {
    if (!sessionId)
        return () => { };
    let last = false;
    try {
        last = registry.get(sessionId)?.unread === true;
    }
    catch {
        // 读初始值失败：当作「无未读」，不因此抛给组件。
        last = false;
    }
    let disposed = false;
    let unsubscribe;
    try {
        unsubscribe = registry.subscribe(() => {
            if (disposed)
                return;
            let next = false;
            try {
                next = registry.get(sessionId)?.unread === true;
            }
            catch {
                return;
            }
            if (next === last)
                return; // 该会话未读没变（可能只是别的会话变了）→ 不触发
            last = next;
            onChange(next);
        });
    }
    catch {
        // 订阅失败不能让按钮渲染崩掉：徽标只是锦上添花，降级成「不显示徽标」。
        return () => { };
    }
    return () => {
        if (disposed)
            return;
        disposed = true;
        try {
            unsubscribe();
        }
        catch { /* 取消订阅失败不影响卸载 */ }
    };
}
