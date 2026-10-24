/**
 * 把「哪几条被选中了」画到**主对话的那张卡片上**。
 *
 * 为什么这件事必须由客户端做、而且必须用属性而不是插入节点：
 * - 用户原话「选择后怎么表示选择上了该内容」——上一版主对话里**一个像素都没变**，
 *   只能回浮窗里那行小字找线索；
 * - 主对话是宿主的 React 渲染结果，往里面插可交互节点会干扰它（契约也禁止「打扰主 agent」）；
 *   只加一个 data 属性既不改结构、也不改事件，React 重绘时也不会被当成自己的 props 抹掉
 *   （实测：加完属性再滚动、再改窗口尺寸，属性仍在原节点上）。
 */
const MARK = 'data-ea-picked';
const INDEX = 'data-ea-pick-index';
const ANCHOR = 'data-ea-pick';
/**
 * 退场摘属性的时刻，必须**晚于** styles.css 里那段淡出（160ms）。
 *
 * 取消选择时**不能**立刻摘掉属性：CSS 过渡只存在于「带属性」的那一侧，
 * 属性一没，元素立刻回到基态，用户看到的就是「啪」一下消失 ——
 * 这正是上一轮页面切换被批评的那种「随意」。所以先挂一个 leaving 值（它保留过渡），
 * 等淡出播完再摘。数值刻意比 160 多留 40ms：与动画同值时，定时器会和最后一帧赛跑。
 */
const PICK_OUT_MS = 200;
/** 正在退场的节点：key 是元素本身，值是它的定时器。 */
const leavingNodes = new WeakMap();
/**
 * 按「属性名 + 精确值」找节点。
 *
 * 刻意不用 `[attr="value"]` 选择器：测试夹具的假 DOM 只认 `[attr]` 这种形式，
 * 用值选择器会让这条路径在测试里**永远找不到节点**，于是一个真缺陷（高亮画不上去）
 * 在单测里完全看不出来。这里退成「先按属性名捞，再比一次值」。
 */
function findByAttr(doc, name, value) {
    return Array.from(doc.querySelectorAll('[' + name + ']')).filter(node => node.getAttribute(name) === value);
}
/**
 * 找回那张卡片。
 *
 * 首选锚点（选中时写上去的 data-ea-pick）；宿主重绘换掉节点时锚点会跟着旧节点一起消失，
 * 这时退一步按会话键找回来 —— 但**只有键在整个文档里唯一**时才这么做：
 * 实测真实 DOM 里有重复键（82 个带键节点只有 76 个不同值），
 * 随便挑一个会把高亮画到另一条内容上。
 */
function findNode(doc, anchor, item) {
    const direct = findByAttr(doc, ANCHOR, anchor)[0];
    if (direct)
        return direct;
    const key = typeof item.id === 'string' && item.id && item.id !== anchor ? item.id : '';
    if (!key)
        return null;
    const byKey = findByAttr(doc, 'data-chat-node-key', key);
    return byKey.length === 1 ? byKey[0] : null;
}
function mark(node, anchor, index) {
    const pending = leavingNodes.get(node);
    if (pending) {
        clearTimeout(pending.timer);
        leavingNodes.delete(node);
    }
    if (node.getAttribute(ANCHOR) !== anchor)
        node.setAttribute(ANCHOR, anchor);
    if (node.getAttribute(MARK) !== anchor)
        node.setAttribute(MARK, anchor);
    const text = String(index + 1);
    if (node.getAttribute(INDEX) !== text)
        node.setAttribute(INDEX, text);
}
function unmark(node) {
    // 已经在退场了：不重复挂。
    if (node.getAttribute(MARK) === 'leaving' || leavingNodes.has(node))
        return;
    node.setAttribute(MARK, 'leaving');
    const timer = setTimeout(() => {
        leavingNodes.delete(node);
        if (node.getAttribute(MARK) !== 'leaving')
            return;
        node.removeAttribute(MARK);
        node.removeAttribute(INDEX);
    }, PICK_OUT_MS);
    leavingNodes.set(node, { timer });
}
/**
 * 让卡片上的标记与当前选择一致。可以随便重复调用（每一帧重画都会调）。
 *
 * 两个刻意的选择：
 * 1. 只动**值真的变了**的属性 —— setAttribute 即使写同一个值也会产生一次 mutation，
 *    主对话在流式输出时每帧都在重绘，无谓的 mutation 会拖慢它；
 * 2. 浮窗自己内部的节点一律不碰（选择页/对话页里也有 [data-ea-pick] 的可能性）。
 */
export function syncPickMarks(doc, evidence) {
    const items = Array.isArray(evidence) ? evidence : [];
    const alive = new Set();
    items.forEach((item, index) => {
        const anchor = typeof item?.pickId === 'string' ? item.pickId : '';
        if (!anchor)
            return;
        const node = findNode(doc, anchor, item);
        if (!node)
            return;
        if (node.closest('.dsh-explain-assistant-overlay, [data-shell-overlay]'))
            return;
        alive.add(anchor);
        mark(node, anchor, index);
    });
    for (const node of Array.from(doc.querySelectorAll('[' + MARK + ']'))) {
        const value = node.getAttribute(MARK) || '';
        if (value === 'leaving' || alive.has(value))
            continue;
        unmark(node);
    }
}
