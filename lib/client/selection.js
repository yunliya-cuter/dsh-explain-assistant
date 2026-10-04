const TARGETS = '[data-tool], [data-chat-node-key]';
function insideChat(node) { const chat = node.closest('[data-conversation-scroll], [data-chat-root], [data-chat-flow-kind]'); return Boolean(chat && !node.closest('.dsh-explain-assistant-overlay, [data-shell-overlay]')); }
function nearest(target) { if (!(target instanceof Element))
    return undefined; const node = target.closest(TARGETS); return node && insideChat(node) ? node : undefined; }
/**
 * §6.3 依据分级：**必须区分「记录已证实」「主 agent 的说法」「信息不足」**。
 *
 * 旧实现把每一条依据都硬编码成 `observed` —— 于是三级分级在数据层根本表达不出来，
 * 实际只有一级：不管用户点的是工具的**真实输出**，还是主 agent 的**一句汇报**，
 * 界面和提示词都当成「亲眼所见」，正好踩中 §6.3 明令禁止的那一条
 * （「不得把汇报当验证事实」，§11.7 同）。
 *
 * 分级判据（基于 DSH 真实产出的 DOM 属性，不靠猜）：
 * - 工具卡片（[data-tool]）：data-state 表示这次调用的**真实结局**
 *   （done/ok → 记录已证实；failed/error → 已证实，但证实的是失败；preparing/ongoing/running → 还没定论）；
 * - 助手汇报（[data-chat-flow-kind=assistant-step] 等）：那是主 agent **说的话**，不是执行结果 → 仅据汇报；
 * - 拿不到任何可判定属性，或内容为空 → 信息不足。
 */
export function classifyEvidence(element) {
    const summary = (element.textContent || '').trim();
    // 没有正文就没有可核查的内容：宁可说信息不足，也不假装看到了（§6.3 最后一条）。
    if (!summary)
        return 'unavailable';
    const tool = element.closest('[data-tool]');
    if (tool) {
        const state = (tool.getAttribute('data-state') || '').toLowerCase();
        // 工具卡片的结局是宿主写下的真实状态，算「记录已证实」。
        // failed / error 同样属于「已证实」——证实的是「这次失败」，照样是拿到了真实结果。
        if (state === 'done' || state === 'ok' || state === 'failed' || state === 'error')
            return 'observed';
        // 还没跑完 / 还没开始：目前只有过程信息，不能当作已验证的结论。
        if (state === 'preparing' || state === 'ongoing' || state === 'running')
            return 'unavailable';
        // 有工具卡片但状态缺失：至少是真实存在的调用记录。
        return 'observed';
    }
    // 助手汇报 / 步骤说明：这是主 agent 的说法，不等于已经验证。
    const kind = element.getAttribute('data-chat-flow-kind');
    if (kind) {
        // 明确的「用户输入」不是主 agent 的说法，也不算证据。
        if (kind === 'input-message' || kind === 'request-prompt')
            return 'unavailable';
        return 'reported_only';
    }
    return 'unavailable';
}
export function evidenceFromElement(element, sessionId) { const tool = element.closest('[data-tool]'); const source = 'selected_frozen'; const state = (element.getAttribute('data-state') || '').toLowerCase(); return { id: element.getAttribute('data-chat-node-key') || element.getAttribute('data-tool') || crypto.randomUUID(), title: tool?.getAttribute('data-tool') || element.getAttribute('data-chat-flow-kind') || undefined, summary: (element.textContent || '').trim().slice(0, 4000), source, capturedAt: new Date().toISOString(), evidenceState: classifyEvidence(element), sessionId, version: element.getAttribute('data-version') || null, truncated: false, incomplete: state === 'running' || state === 'ongoing' || state === 'preparing' }; }
/** 左键按下到抬起之间允许的最大位移（像素）。超过就认为是拖动选字，不算「点击选步骤」。 */
const CLICK_SLOP_PX = 5;
export function attachSelection(root, sessionId, onSelect) {
    // §5.2 文档写的是「点击」，所以左键路径是主路径；右键与 Shift+Enter 作为兼容保留。
    // §5.2「选择只确定讲解对象，不触发原卡片的执行、链接、折叠等操作」。
    // 只 preventDefault 挡不住事件继续冒泡到 React 的委托监听，原卡片照样会响应；
    // 必须在捕获阶段就吞掉这次事件（stopPropagation + stopImmediatePropagation）。
    const swallow = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
            ;
            event.stopImmediatePropagation();
        }
    };
    const context = (event) => {
        const node = nearest(event.target);
        if (!node)
            return;
        swallow(event);
        onSelect(evidenceFromElement(node, sessionId));
    };
    let pressed;
    const click = (event) => {
        // 带修饰键的点击是用户在表达别的意图（新窗口、多选等），不抢。
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
            return;
        const node = nearest(event.target);
        if (!node)
            return;
        if (pressed && pressed.node === node) {
            const moved = Math.abs(event.clientX - pressed.x) + Math.abs(event.clientY - pressed.y);
            // 位移过大说明用户在选字，不要误判成「选了这一步」。
            if (moved > CLICK_SLOP_PX)
                return;
            const selection = typeof root.getSelection === 'function' ? root.getSelection() : null;
            if (selection && String(selection).trim().length > 0)
                return;
        }
        swallow(event);
        onSelect(evidenceFromElement(node, sessionId));
    };
    const pointerdown = (event) => {
        if (event.button !== 0)
            return;
        const node = nearest(event.target);
        pressed = node ? { x: event.clientX, y: event.clientY, node } : undefined;
    };
    const keydown = (event) => {
        if (!(event.shiftKey && event.key === 'Enter'))
            return;
        const node = nearest(document.activeElement);
        if (!node)
            return;
        swallow(event);
        onSelect(evidenceFromElement(node, sessionId));
    };
    // 捕获阶段注册：React 在 document/root 上做冒泡委托，只有在捕获阶段才能先一步拦下。
    root.addEventListener('contextmenu', context, true);
    root.addEventListener('click', click, true);
    root.addEventListener('mousedown', pointerdown, true);
    root.addEventListener('keydown', keydown, true);
    return {
        dispose() {
            root.removeEventListener('contextmenu', context, true);
            root.removeEventListener('click', click, true);
            root.removeEventListener('mousedown', pointerdown, true);
            root.removeEventListener('keydown', keydown, true);
        },
    };
}
