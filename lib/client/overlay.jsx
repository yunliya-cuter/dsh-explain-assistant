import { clampGeometry, attachWindowInteractions } from './window.js';
// 回答正文的 Markdown 渲染。用户要求「解析记号」与「保证性能」同时成立，
// 增量机制（块级冻结 + 代码块只追加 + 只换尾部）都在这个模块里，见其头部说明。
import { mountMarkdown, cachedMarkdownNodes } from './markdown.js';
// §10/D1：记录为什么没完成的中文文案与宿主**共用同一份**（src/shared/）。刻意不复制第二份。
import { recordReasonText, RECORD_REASON_PREFIX, RECORD_INCOMPLETE_TEXT } from '../shared/record-reason.js';
let previouslyFocused = null;
function appendChildren(node, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false)
            continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
}
/** 用一批 Child 替换容器内容；先滤掉 null/undefined/false，满足 replaceChildren 的类型要求。 */
function fill(node, children) {
    node.replaceChildren(...children.filter((child) => child !== null && child !== undefined && child !== false));
}
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false)
            continue;
        if (key === 'class')
            node.className = String(value);
        else if (key === 'text')
            node.textContent = String(value);
        else if (key === 'style')
            Object.assign(node.style, value);
        else if (key === 'dataset')
            Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function')
            node.addEventListener(key.slice(2).toLowerCase(), value);
        else
            node.setAttribute(key, value === true ? '' : String(value));
    }
    appendChildren(node, children);
    return node;
}
function button(label, aria, handler, options = {}) {
    return el('button', {
        type: 'button',
        class: options.class || 'ea-btn',
        'aria-label': aria,
        title: options.title,
        disabled: options.disabled,
        'aria-pressed': options.pressed === undefined ? undefined : String(options.pressed),
        onClick: handler,
    }, label);
}
function isBusy(state) { return state.phase === 'running' || state.phase === 'connecting'; }
function phaseLabel(state) {
    if (state.phase === 'connecting')
        return '正在连接';
    if (state.phase === 'running')
        return '正在解释';
    if (state.phase === 'complete')
        return '已完成';
    if (state.phase === 'error')
        return '出错';
    if (state.phase === 'interrupted')
        return '已停止';
    return '';
}
function timeText(value) {
    if (typeof value !== 'string' || !value)
        return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
/* ------------------------------------------------------------------ *
 * 各区块渲染
 * ------------------------------------------------------------------ */
/**
 * 「正在解释…」的提示条。
 *
 * 为什么和正文分成两个函数：正文现在走**增量渲染**（mountMarkdown），它必须一直
 * 待在自己的容器里原地更新 —— 冻结的块一旦被摘下来再挂回去，浏览器的滚动锚点就丢了，
 * 用户看到的是跳变。所以正文独占一个槽位，这个提示条自己一个槽位，互不牵连。
 */
function currentStatusNodes(state, plugin) {
    if (!isBusy(state) || state.text)
        return [];
    return [el('div', { class: 'ea-running', role: 'status' }, el('span', { class: 'ea-spinner', 'aria-hidden': 'true' }), el('span', { text: state.phase === 'connecting' ? '正在连接模型…' : '正在解释…' }), button('停止', '停止本次解释', () => plugin.cancel?.(), { class: 'ea-btn ea-btn-quiet' }))];
}
/** 当前这次提问的推理过程与工具过程（正文由 answerSlot 单独负责）。 */
function currentDetailNodes(state) {
    const nodes = [];
    if (state.reasoning) {
        nodes.push(el('details', { class: 'dsh-explain-assistant-reasoning ea-disclosure' }, el('summary', {}, '推理过程（原始内容，默认折叠）'), 
        // 推理过程同样是模型写出来的文字，会带 Markdown 记号；走缓存渲染，避免每次重画重解析。
        // 键里带上推理正文的指纹：换一次提问、推理内容一变就自然失效，
        // 免得两次提问拿到同一份旧节点。
        el('div', { class: 'ea-disclosure-body ea-md-scope' }, ...cachedMarkdownNodes('live-reasoning#' + contentKey(state.reasoning), state.reasoning))));
    }
    if (state.tools.length) {
        const rows = state.tools.map(tool => el('details', { class: 'dsh-explain-assistant-tool ea-tool' }, el('summary', {}, (tool.label || tool.name) + ' · ' + (tool.status === 'running' ? '进行中' : tool.status === 'error' ? '失败' : '完成')), el('div', { class: 'ea-tool-body' }, tool.detail ? el('p', { class: 'ea-tool-detail', text: tool.detail }) : null, tool.result !== undefined ? el('pre', { class: 'ea-pre', text: typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2) }) : null)));
        nodes.push(el('section', { class: 'ea-tools dsh-explain-assistant-tools', 'aria-label': '工具过程' }, el('h3', { class: 'ea-card-title', text: '工具过程' }), ...rows));
    }
    return nodes;
}
/**
 * §7 / §10：模型不可用时的**降级层**。
 *
 * 文档明写「不让联网大模型成为基本功能的强依赖：模型不可用时仍能查看既有记录、真实依据和基本说明」。
 * 旧实现只有一条错误文案，用户的感受是「整个功能坏了」——既看不到已经拿到的依据，
 * 也得不到任何基本说明，只能干等模型恢复。
 *
 * 这里补齐三件事（都在本地算，不需要模型）：
 * 1. 已经拿到的真实依据照常显示（不去依赖模型）；
 * 2. 给一段**基于既有记录的基本说明**：有几个步骤、分别是什么状态、有没有失败；
 * 3. 明确写清「这一段是本地整理，不是模型对问题的解释」，不冒充完整智能回答（§7 最后一条）。
 */
function offlineFallbackNodes(state) {
    const available = state.phase === 'error' || state.phase === 'interrupted';
    if (!available)
        return [];
    const nodes = [];
    const evidence = state.evidence.filter(item => item?.summary || item?.title);
    const tools = state.tools;
    // 1) 已有依据：即使模型不可用，这些是用户自己点出来的真实记录，必须照常可见。
    if (evidence.length) {
        nodes.push(el('section', { class: 'ea-offline ea-card', 'aria-label': '仍可查看的依据' }, el('h3', { class: 'ea-card-title', text: '这些依据仍然可以查看' }), el('ul', { class: 'ea-offline-list' }, ...evidence.map(item => el('li', {
            class: 'ea-offline-evidence',
            text: (item.title || '未命名步骤') + '：' + String(item.summary || '').slice(0, 120),
        })))));
    }
    // 2) 基本说明：只用本地已知信息，不编造。
    const steps = tools.length;
    const failed = tools.filter(tool => tool.status === 'error').length;
    const running = tools.filter(tool => tool.status === 'running').length;
    const lines = [];
    if (steps) {
        lines.push('上一次解释过程中记录到 ' + steps + ' 个步骤。');
        if (failed)
            lines.push('其中 ' + failed + ' 个是失败的。');
        if (running)
            lines.push('其中 ' + running + ' 个当时还在进行中。');
        if (!failed && !running)
            lines.push('它们当时都已完成。');
    }
    if (evidence.length)
        lines.push('你选中了 ' + evidence.length + ' 条依据，内容见上面。');
    if (state.records.length)
        lines.push('你的历史问答记录仍然完整保留，可以在下面的「历史」里翻看，一条都没有丢。');
    if (!lines.length)
        lines.push('这个小助手还没有拿到任何具体步骤。你可以先在主对话里点一条步骤卡片，再回来提问。');
    nodes.push(el('section', { class: 'ea-offline ea-card', 'aria-label': '基本说明' }, el('h3', { class: 'ea-card-title', text: '现在能告诉你的基本说明' }), ...lines.map(line => el('p', { class: 'ea-offline-line', text: line })), 
    // §7 最后一条：基本说明不能冒充完整智能回答。
    el('p', { class: 'ea-offline-note', text: '这一小段是小助手在没有模型的情况下，根据已记录的内容直接整理的，不是模型对你想问的问题给出的解释。模型恢复后重新提问，就能拿到完整回答。' })));
    return nodes;
}
/** §4 第一次打开时的快捷问题。点一下就直接问，用户不必自己想怎么措辞。 */
const QUICK_QUESTIONS = ['它现在在干什么', '这一步为什么这么做', '这步实际产出了什么', '哪里可以调整'];
function quickNodes(state, plugin) {
    if (state.quickQuestionsDismissed || state.records.length || isBusy(state))
        return [];
    return [el('section', { class: 'dsh-explain-assistant-quick ea-quick', 'aria-label': '快捷问题' }, el('h3', { class: 'ea-card-title', text: '你可以直接点一个问：' }), el('div', { class: 'dsh-explain-assistant-quick-row ea-quick-row' }, ...QUICK_QUESTIONS.map(question => button(question, '快捷提问：' + question, () => {
            plugin.registry.update(state.sessionId, { quickQuestionsDismissed: true });
            void plugin.submit(question);
        }, { class: 'ea-btn ea-chip' }))))];
}
/** 没有任何内容时的引导。用户第一次打开应该一眼知道这里能干什么。 */
function heroNodes(state) {
    if (state.text || state.records.length || state.error || isBusy(state))
        return [];
    return [el('section', { class: 'ea-hero', 'aria-label': '使用说明' }, el('p', { class: 'ea-hero-title', text: '小助手在旁边看着主 agent，随时把「它正在干什么」讲成白话。' }), el('ul', { class: 'ea-hero-list' }, el('li', { text: '点右上角「选择主对话内容」，再点主对话里的一条步骤卡片，就能针对那一步提问。' }), el('li', { text: '也可以直接在下面输入问题，或者点上面的快捷问题。' }), el('li', { text: '小助手只读：不改主 agent、不执行命令、不碰主对话的输入框。' })))];
}
/**
 * §7 / §11.8 模型选择。
 *
 * 33 个模型平铺会把整个浮窗吃掉，所以按 provider 分组并默认折叠：
 * 未选模型时展开（必须让用户先选），已选之后折叠成一行摘要，需要换再展开。
 */
function modelNodes(state, plugin, open, onToggle) {
    const groups = state.catalog?.groups || [];
    const failures = state.catalog?.failures || [];
    let total = 0;
    groups.forEach(group => { total += (group.models || []).length; });
    // §7/§11.8：未选模型时必须明确提示去选，不能让用户以为已经在用某个模型。
    const current = el('span', { class: 'dsh-explain-assistant-model-current ea-model-current' });
    current.textContent = state.model ? '本对话已选 · ' + state.model.provider + ' / ' + state.model.model : '还没有选择模型：请先选一个，小助手不会自动替你挑';
    const list = el('div', { class: 'dsh-explain-assistant-model-list ea-model-list', role: 'group', 'aria-label': '可选模型列表' });
    let rendered = 0;
    groups.forEach(group => {
        const options = [];
        (group.models || []).forEach(entry => {
            const provider = String(entry.provider || group.provider || '');
            const model = String(entry.id || '');
            if (!provider || !model)
                return;
            rendered++;
            const selected = Boolean(state.model && state.model.provider === provider && state.model.model === model);
            options.push(button((selected ? '✓ ' : '') + (entry.name || model), '选择模型 ' + provider + '/' + model, () => {
                if (!plugin.api?.selectModel)
                    return;
                // 先乐观更新界面（按钮看起来立刻有反应），但失败必须**回滚**：
                // 曾经只回写 error、不回滚 model，于是选择其实被宿主拒绝了，界面却一直显示「本对话已选」。
                const previous = plugin.registry.get(state.sessionId)?.model;
                plugin.registry.update(state.sessionId, { model: { provider, model, source: 'explicit' }, error: undefined });
                void plugin.api.selectModel(state.sessionId, { provider, model }).catch(error => plugin.registry.update(state.sessionId, {
                    model: previous,
                    error: '选择模型失败：' + (error instanceof Error ? error.message : String(error)),
                }));
            }, { class: 'dsh-explain-assistant-model-option ea-btn ea-model-option', pressed: selected }));
        });
        if (!options.length)
            return;
        list.appendChild(el('div', { class: 'ea-model-group' }, el('div', { class: 'ea-model-group-name' }, el('span', { text: String(group.displayName || group.provider || '未命名提供方') }), el('span', { class: 'ea-count', text: String(options.length) })), el('div', { class: 'ea-model-options' }, ...options)));
    });
    if (!rendered)
        list.appendChild(el('p', { class: 'dsh-explain-assistant-empty ea-empty', text: '暂时没有可用的模型，请先检查模型配置' }));
    const refresh = button('刷新模型', '刷新可用模型', (event) => {
        if (!plugin.api?.models)
            return;
        const target = event.currentTarget;
        target.disabled = true;
        void plugin.api.models().then(result => {
            const payload = (result.payload || {});
            plugin.registry.update(state.sessionId, { catalog: payload });
        }).catch(error => plugin.registry.update(state.sessionId, { error: error instanceof Error ? error.message : String(error) })).finally(() => { target.disabled = false; });
    }, { class: 'ea-btn ea-btn-quiet' });
    // 不用原生 <details>/<summary>：真实浏览器里 UIA 把它暴露成 expand 动作，合成点击点不开
    // （3082 实测连点三次都停在折叠态，用户也就永远看不到模型列表）。
    // 这里改成自己控制的按钮 + 展开状态：点得动，也能被测试断言。
    const toggle = button(open ? '收起模型列表' : (state.model ? '换一个模型（共 ' + total + ' 个）' : '点这里选择模型（共 ' + total + ' 个可选）'), open ? '收起模型列表' : '展开可选模型列表', () => onToggle?.(!open), { class: 'ea-model-summary', pressed: open });
    const details = el('div', { class: 'ea-model-details', 'data-unselected': state.model ? undefined : 'true', 'data-open': open ? 'true' : undefined }, toggle, open ? list : null);
    const failureNodes = failures.filter(failure => failure?.message).map(failure => el('small', { class: 'dsh-explain-assistant-model-failure ea-model-failure', text: failure.message }));
    return [el('section', { class: 'dsh-explain-assistant-model ea-card', 'aria-labelledby': 'dsh-explain-assistant-model-title' }, el('div', { class: 'ea-card-head' }, el('h3', { class: 'ea-card-title', id: 'dsh-explain-assistant-model-title', text: '模型' }), refresh), current, details, ...failureNodes)];
}
/**
 * §9.1 /compact 的结果。
 *
 * 这一段此前完全不存在：压缩摘要只落库、不进任何 UI 状态，用户按了 /compact
 * 界面没有任何变化，成功失败都看不见，等于功能不存在。现在四种状态都给中文反馈：
 * 压缩中 / 已完成（带摘要正文）/ 已中断 / 失败（并说明保留上一份可用摘要）。
 */
function compactNodes(state) {
    const compact = state.compactState;
    if (!compact || compact.status === 'idle')
        return [];
    // 防线：宿主落库的 compactState 是**落库结构**，没有 status 字段（§9.1 只有成功才落库）。
    // 若某条路径把它整份带进来，status 会是 undefined，按下面的分支就会把「成功」显示成「已中断」。
    // 有摘要就按成功渲染，没摘要才按失败渲染。
    const status = compact.status ?? (compact.summary ? 'complete' : 'error');
    const rows = [];
    if (status === 'running') {
        rows.push(el('p', { class: 'ea-compact-status', role: 'status', text: '正在整理小助手自己的上下文…' }));
    }
    else if (status === 'complete') {
        rows.push(el('p', { class: 'ea-compact-status', role: 'status', text: '已压缩：后续回答参考下面这份摘要。完整问答记录仍然保留在历史里，没有被删除。' }));
        // 摘要也是**模型写出来的正文**，同样会带 Markdown 记号 —— 原先直接塞 text，记号会原样露出。
        // 用户抱怨「没有对 md 的符号进行解析」，指的是所有看到模型文字的地方，不只是回答正文。
        if (compact.summary)
            rows.push(el('div', { class: 'dsh-explain-assistant-compact-summary ea-compact-summary ea-md-scope' }, ...cachedMarkdownNodes('compact-' + (compact.updatedAt || contentKey(String(compact.summary))), String(compact.summary))));
        if (compact.updatedAt)
            rows.push(el('small', { class: 'ea-meta', text: '压缩时间 ' + timeText(compact.updatedAt) }));
    }
    else {
        // §9.1：失败必须清楚提示，并且明确「上一份可用摘要还在」。
        const failed = status === 'error';
        rows.push(el('p', { class: failed ? 'ea-compact-status ea-compact-error' : 'ea-compact-status', role: 'alert', text: (failed ? '压缩失败：' : '压缩已中断：') + (compact.error || '没有拿到可用的摘要') }));
        if (compact.summary) {
            rows.push(el('div', { class: 'dsh-explain-assistant-compact-summary ea-compact-summary ea-md-scope' }, ...cachedMarkdownNodes('compact-prev-' + compact.updatedAt, String(compact.summary))));
            rows.push(el('small', { class: 'ea-meta', text: '上面这份是上一次成功压缩的摘要，仍然可用。' }));
        }
    }
    return [el('section', { class: 'dsh-explain-assistant-compact ea-card', 'aria-label': '小助手上下文压缩' }, el('div', { class: 'ea-card-head' }, el('h3', { class: 'ea-card-title', text: '小助手上下文' })), ...rows)];
}
/**
 * §6.3 依据分级在界面上的呈现。
 *
 * 三级用词与提示词侧（prompts.ts 的 EVIDENCE_TIERS）保持一致，
 * 免得「同一件事在两处叫两个名字」。hint 是给用户的一句话解释，不出现术语。
 */
function evidenceTierOf(item) {
    if (item.evidenceState === 'observed') {
        return { key: 'observed', label: '已观察到', hint: '这是实际跑出来的结果或输出，有记录可查。' };
    }
    if (item.evidenceState === 'reported_only') {
        return { key: 'reported', label: '仅据汇报', hint: '这只是主 agent 自己说它做了什么，还没有看到实际结果。' };
    }
    if (item.evidenceState === 'unavailable') {
        return { key: 'unavailable', label: '无从得知', hint: '这条当时还没结束，或者拿不到可读内容，不能当作已验证。' };
    }
    return { key: 'unknown', label: '未分级', hint: '这条依据没有带分级信息。' };
}
/** §5.2 已选择的依据。列出用户点过的卡片，可逐条移除。 */
function evidenceNodes(state, plugin) {
    if (!state.evidence.length)
        return [];
    const rows = state.evidence.map((item) => {
        // §6.3/§11.7：**必须把三级的差异显示给用户看**。
        // 此前分级只做进了数据层与提示词，界面上一个字都不显示 ——
        // 用户根本分不清自己看到的这条是「工具真的跑出来的结果」，
        // 还是「主 agent 嘴里说的一句话」。这恰好是文档点名要求区分的那件事。
        const tier = evidenceTierOf(item);
        return el('article', { class: 'dsh-explain-assistant-evidence-row ea-evidence-row' }, el('div', { class: 'ea-row-head' }, el('strong', { class: 'ea-evidence-title', text: item.title || item.id }), el('span', { class: 'ea-evidence-tier ea-tier-' + tier.key, text: tier.label, title: tier.hint }), button('移除', '移除这条依据', () => plugin.registry.update(state.sessionId, current => { current.evidence = current.evidence.filter(existing => existing.id !== item.id); }), { class: 'ea-btn ea-btn-quiet' })), el('small', { class: 'ea-meta', text: [item.source, item.capturedAt ? new Date(item.capturedAt).toLocaleTimeString('zh-CN') : ''].filter(Boolean).join(' · ') }), el('p', { class: 'ea-evidence-summary', text: item.summary || '没有可见摘要' }), el('small', { class: 'ea-evidence-tier-hint', text: tier.hint }));
    });
    return [el('section', { class: 'dsh-explain-assistant-evidence ea-card', 'aria-labelledby': 'dsh-explain-assistant-evidence-title' }, el('div', { class: 'ea-card-head' }, el('h3', { class: 'ea-card-title', id: 'dsh-explain-assistant-evidence-title', text: '已选择依据' }), el('span', { class: 'ea-count ea-count-inline', text: String(state.evidence.length) })), ...rows)];
}
/**
 * 一段文本的短指纹（FNV-1a）。
 *
 * 用途：当历史记录**没有 id** 时给渲染缓存算一个**稳定的**键。
 * 为什么不能用位置索引当键：分页会把同一条记录挪到不同位置，
 * 于是「第 3 条」这个键会指向**另一条记录**——缓存命中后会把别人的正文显示出来。
 * 内容指纹只取决于内容本身，与位置无关，因此分页、插入都不会让它错位。
 *
 * 不需要密码学强度：它的唯一作用是「同一段文本得到同一个键」，碰撞了最多是多解析一次。
 */
function contentKey(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}
/** §8 历史问答。关闭再打开能继续查看与追问。 */
function historyNodes(state, plugin) {
    const children = [el('div', { class: 'ea-card-head' }, el('h3', { class: 'ea-card-title', text: '历史' }), state.records.length ? el('span', { class: 'ea-count ea-count-inline', text: String(state.records.length) }) : null, state.hasEarlier ? button(state.loadingEarlier ? '正在加载…' : '查看更早历史', '加载更早历史', () => { if (!state.loadingEarlier)
            void plugin.loadEarlier(); }, { class: 'ea-btn ea-btn-quiet', disabled: state.loadingEarlier }) : null)];
    if (!state.records.length) {
        children.push(el('p', { class: 'dsh-explain-assistant-empty ea-empty', text: '还没有小助手历史' }));
    }
    else {
        // 记录有两个来源、两套字段名，必须都认：
        // - 宿主落库（routes.ts 写的）：answerText / reasoningText / startedAt / updatedAt；
        // - 客户端本地刚追加的：answer / createdAt。
        // 旧代码只读 record.answer，而真实路径下记录来自宿主 —— 于是重开浮窗后
        // 历史里只剩问题、看不到回答，用户以为那次问答丢了（§8「关闭再打开能查看」）。
        state.records.forEach(record => {
            const recordId = typeof record.id === 'string' && record.id ? record.id : '';
            const answer = (typeof record.answerText === 'string' && record.answerText) ? record.answerText : record.answer;
            const at = record.startedAt ?? record.createdAt;
            const reasoning = typeof record.reasoningText === 'string' && record.reasoningText ? record.reasoningText : record.reasoning;
            children.push(el('article', { class: 'dsh-explain-assistant-record ea-record' }, el('div', { class: 'ea-row-head' }, el('strong', { class: 'ea-record-question', text: record.question }), el('small', { class: 'ea-meta', text: timeText(at) })), 
            // 历史正文同样是 Markdown：用户看到的「记号没解析」在这一处也存在。
            // 走 cachedMarkdownNodes 而不是直接渲染 —— updateOverlay 在流式期间每个分片都跑一次，
            // 没有缓存的话，每来一个字就要把**所有历史记录**重新解析一遍，记录越多越卡。
            // 缓存键必须**稳定**：有 id 用 id；没有 id 时用正文指纹，**不能**用位置索引
            // （位置索引会随分页变化指向另一条记录，缓存命中后会把别人的正文顶上来）。
            // 同样带上 ea-md-scope：它是「这里面的文字是模型写的」的**约定标记类**，
            // **不是**「已解析」的判据 —— 判据是子节点来自渲染器。已部署产物里
            // class="ea-record-answer" 没有这个类却解析正常，证明它既不必要也不充分。
            //
            // ⚠️ 这里**确实带来用户可见的变化**，不是「观感不变」（原先那句注释是错的，已更正）：
            // 元素一旦带上 ea-md-scope，styles.css:127+ 那组规则就生效，
            // 于是 **粗体** 与 ~~删除线~~ 从「有节点、无样式」变为可见呈现 ——
            // .ea-record-answer 只有 code/codeblock/h/link/list/p/pre/quote 的规则，缺 strong/del。
            // 方向上是修复（渲染器一直产出这些节点，只是从没有规则给它们样式），
            // 但观感必须由页面复验确认，不能靠推断 —— 见 docs/evidence/ 的页面普查。
            answer ? el('div', { class: 'ea-record-answer ea-md-scope' }, ...cachedMarkdownNodes(recordId || 'rec#' + contentKey(String(record.question || '') + '\u0000' + String(answer)), String(answer))) : null, 
            // 推理同样是**模型写出的 Markdown**，必须走渲染器。
            // 这里原本是唯一一处裸文本渲染（el('div', {..., text: reasoning})），
            // 页面实测：历史列表里 6 个 ea-disclosure-body 全部没有 ea-md-scope，
            // 成段的 `- 条目` 记号原样露出（同一份 reasoning 在详情面板 512 行却能解析）。
            // 缓存键必须**稳定**：有 id 用 id；没有 id 用正文指纹 —— 不能用位置索引
            // （见 441-443 行：位置索引会随分页漂移到别的记录，命中后把别人的正文顶上来）。
            reasoning ? el('details', { class: 'ea-disclosure' }, el('summary', {}, '这次回答的推理过程'), el('div', { class: 'ea-disclosure-body ea-md-scope' }, ...cachedMarkdownNodes(recordId || 'rec-reasoning#' + contentKey(String(reasoning)), String(reasoning)))) : null, 
            // 同样两套字段名：客户端本地写 incomplete，宿主写 status/complete。
            // 只看 incomplete 的话，来自宿主的未完成记录永远不会显示警告（§6.3「不得把没验证的说成已验证」）。
            //
            // §10/D1：记录会**留在磁盘上** —— 整页重载后只有「未完成」不足以让用户明白为什么停的。
            // 若记录带了原因（routes.ts 落库时写入），就把对应的中文提示一并显示。
            // 文案从 src/shared 取，与宿主 SSE 事件用的是**同一份常量**（本项目吃过两处不一致的亏）。
            // 老记录没有 reason 字段 → recordReasonText 返回 undefined → 退回原来的「此记录未完成或未验证」，行为不变。
            ((record.incomplete === true) || record.status === 'interrupted' || record.status === 'error' || record.complete === false)
                ? el('small', { class: 'ea-warn', text: (() => {
                        const reasonText = recordReasonText(record.reason);
                        return reasonText ? RECORD_REASON_PREFIX + reasonText : RECORD_INCOMPLETE_TEXT;
                    })() }) : null, 
            // §5.1/§11.6：历史里只显示摘要，用户要能点开某一条看它的**完整依据**。
            // 此前没有任何入口，api.historyResult 是死代码，被截断的工具结果与依据在界面上永远看不到。
            recordId ? button(state.historyDetail?.recordId === recordId ? '正在查看完整内容' : '查看完整内容', '查看这条记录的完整内容', () => { void plugin.openHistoryDetail?.(recordId); }, { class: 'ea-btn ea-btn-quiet ea-record-detail', pressed: state.historyDetail?.recordId === recordId }) : null));
        });
    }
    return [el('section', { class: 'dsh-explain-assistant-history ea-card' }, ...children)];
}
/**
 * §5.1/§8/§11.6：某条历史记录的「完整内容」面板。
 *
 * 记录里多出来的东西正是用户核查时最需要的原始材料：
 * - 依据（evidence）：这一条当时到底读到了什么，来源、时间、原文；
 * - 工具过程（tools）：跑过哪些只读工具、命令/参数、真实输出、失败原因；
 * - 图片快照（images）：截了什么图、放在哪、有多大。
 * 面板只给**原文**，不做二次解释；取不到就说取不到（§6.3 不得把没验证的说成已验证）。
 *
 * 宿主按页给（一页三组各若干条），所以底部有「继续加载」。分页与首页共用同一个游标。
 */
function historyDetailNodes(state, plugin) {
    const detail = state.historyDetail;
    if (!detail)
        return [];
    const record = (detail.record || {});
    const counts = detail.counts || {};
    const evidence = Array.isArray(record.evidence) ? record.evidence : [];
    const tools = Array.isArray(record.tools) ? record.tools : [];
    const images = Array.isArray(record.images) ? record.images : [];
    const total = Math.max(counts.evidence || 0, counts.tools || 0, counts.images || 0);
    const rows = [el('div', { class: 'ea-card-head' }, el('h3', { class: 'ea-card-title', text: '这条记录的完整内容' }), button('收起', '收起完整内容', () => plugin.closeHistoryDetail?.(), { class: 'ea-btn ea-btn-quiet' }))];
    if (detail.status === 'loading' && !evidence.length && !tools.length && !images.length) {
        rows.push(el('p', { class: 'ea-detail-status', role: 'status', text: '正在读取这条记录的完整内容…' }));
        return [el('section', { class: 'dsh-explain-assistant-detail ea-card ea-detail' }, ...rows)];
    }
    if (detail.status === 'error') {
        // §10：失败要给明确中文原因，不能显示成「这条记录没有内容」。
        rows.push(el('p', { class: 'ea-detail-error ea-error', role: 'alert', text: detail.error || '这条记录的完整内容没有取到。' }));
        return [el('section', { class: 'dsh-explain-assistant-detail ea-card ea-detail' }, ...rows)];
    }
    if (record.question)
        rows.push(el('p', { class: 'ea-detail-question', text: '问题：' + String(record.question) }));
    const answer = typeof record.answerText === 'string' && record.answerText ? record.answerText : record.answer;
    // 同历史区：没有 recordId 时用正文指纹当键，避免两条不同记录撞同一键而互相顶掉正文。
    if (answer)
        rows.push(el('article', { class: 'ea-detail-answer ea-md-scope' }, ...cachedMarkdownNodes('detail-' + (detail.recordId || 'rec#' + contentKey(String(answer))), String(answer))));
    const reasoning = typeof record.reasoningText === 'string' && record.reasoningText ? record.reasoningText : record.reasoning;
    if (reasoning)
        rows.push(el('details', { class: 'ea-disclosure' }, el('summary', {}, '完整推理过程'), el('div', { class: 'ea-disclosure-body ea-md-scope' }, ...cachedMarkdownNodes('detail-reasoning-' + (detail.recordId || 'rec#' + contentKey(String(reasoning))), String(reasoning)))));
    if (evidence.length) {
        rows.push(el('h4', { class: 'ea-detail-subtitle', text: '完整依据（共 ' + (counts.evidence || evidence.length) + ' 条，已显示 ' + evidence.length + ' 条）' }));
        for (const item of evidence) {
            rows.push(el('article', { class: 'ea-detail-evidence' }, el('strong', { text: String(item?.title || item?.kind || '未命名依据') }), el('small', { class: 'ea-meta', text: [item?.source, item?.evidenceState, item?.capturedAt].filter(Boolean).join(' · ') }), item?.summary ? el('p', { text: String(item.summary) }) : null, item?.command ? el('pre', { class: 'ea-pre', text: String(item.command) }) : null, item?.output !== undefined ? el('pre', { class: 'ea-pre', text: typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2) }) : null, item?.truncated ? el('small', { class: 'ea-warn', text: '原始依据仍有未取回的部分' }) : null));
        }
    }
    if (tools.length) {
        rows.push(el('h4', { class: 'ea-detail-subtitle', text: '完整工具过程（共 ' + (counts.tools || tools.length) + ' 个，已显示 ' + tools.length + ' 个）' }));
        for (const tool of tools) {
            rows.push(el('article', { class: 'ea-detail-tool' }, el('strong', { text: String(tool?.tool || '工具') + ' · ' + (tool?.status === 'error' ? '失败' : tool?.status === 'ok' ? '完成' : String(tool?.status || '')) }), tool?.arguments !== undefined ? el('pre', { class: 'ea-pre', text: JSON.stringify(tool.arguments, null, 2) }) : null, tool?.result !== undefined ? el('pre', { class: 'ea-pre', text: typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2) }) : null));
        }
    }
    if (images.length) {
        rows.push(el('h4', { class: 'ea-detail-subtitle', text: '图片快照（共 ' + (counts.images || images.length) + ' 张，已显示 ' + images.length + ' 张）' }));
        for (const image of images) {
            rows.push(el('p', { class: 'ea-detail-image', text: [image?.relativePath, image?.mediaType, image?.bytes !== undefined ? image.bytes + ' 字节' : ''].filter(Boolean).join(' · ') }));
        }
    }
    if (!evidence.length && !tools.length && !images.length && !answer) {
        rows.push(el('p', { class: 'ea-empty', text: '这条记录里没有可展开的依据或工具过程。' }));
    }
    if (detail.hasEarlier) {
        rows.push(button(detail.loadingMore ? '正在加载…' : '继续加载完整内容', '继续加载这条记录剩下的完整内容', () => { if (!detail.loadingMore)
            void plugin.loadMoreHistoryDetail?.(); }, { class: 'ea-btn ea-btn-quiet ea-detail-more', disabled: detail.loadingMore, title: total ? '共 ' + total + ' 项，还有一些没显示' : undefined }));
    }
    else if (total > 0) {
        rows.push(el('small', { class: 'ea-meta', text: '这条记录的完整内容已经全部显示。' }));
    }
    if (detail.error)
        rows.push(el('p', { class: 'ea-detail-error ea-error', role: 'alert', text: detail.error }));
    return [el('section', { class: 'dsh-explain-assistant-detail ea-card ea-detail' }, ...rows)];
}
/**
 * §9.2 右下角的占用圆环。
 *
 * 三条硬规则：
 * 1. 是圆环（SVG），不是一行文字；
 * 2. 百分比若是推算出来的，旁边要标「估算」；
 * 3. 拿不到数值就显示灰色不可用态 + 中文「占用未知」，绝不编造一个百分比。
 *
 * 位置从「绝对定位压在表单上」改成表单里的一个普通格子：绝对定位那版会和发送按钮重叠，
 * 是上一版界面最扎眼的一处「不可用」。
 */
/**
 * 0.2：把「这份上下文由哪两块构成」拼成一句人话。
 *
 * 用户要求：鼠标放到圆环上，能看出多少来自主 agent 转移、多少是小助手与用户对话产生的。
 * 格式按用户给的形状：两部分各占的比例 + 绝对量，例如
 *   「主 agent 转移 1.2k / 小助手对话 3.4k，约 26% / 74%」
 *
 * 拿不到构成时返回 undefined —— 宁可不显示提示，也不编造一个数字。
 * 两块之和为 0 时也算拿不到（没有可显示的比例）。
 */
function occupancyPartsText(parts) {
    if (!parts || typeof parts !== 'object')
        return undefined;
    const main = typeof parts.mainAgentTokens === 'number' && Number.isFinite(parts.mainAgentTokens) ? Math.max(0, parts.mainAgentTokens) : 0;
    const own = typeof parts.ownTokens === 'number' && Number.isFinite(parts.ownTokens) ? Math.max(0, parts.ownTokens) : 0;
    const total = main + own;
    if (total <= 0)
        return undefined;
    const short = (value) => value >= 1000 ? (value / 1000).toFixed(1) + 'k' : String(value);
    const mainPercent = Math.round((main / total) * 100);
    const ownPercent = 100 - mainPercent;
    const extra = parts.mainlineTruncated ? '（主 agent 部分已截断到上限）' : '';
    return '主 agent 转移 ' + short(main) + ' / 小助手对话 ' + short(own)
        + '，约 ' + mainPercent + '% / ' + ownPercent + '%' + extra;
}
function ringNode(state) {
    const box = el('div', { class: 'dsh-explain-assistant-ring ea-ring' });
    const known = Boolean(state.occupancyKnown) && typeof state.occupancy === 'number';
    const percent = known ? Math.min(100, Math.max(0, Math.round(state.occupancy))) : 0;
    // 0.2：悬停显示两块构成。此前这个圆环**只有 aria-label、没有任何鼠标悬停提示**，
    // 用户鼠标放上去什么都不显示（用户截图箭头指的就是这里）。
    const partsText = occupancyPartsText(state.occupancyParts);
    if (partsText)
        box.setAttribute('title', partsText);
    box.setAttribute('role', 'img');
    const baseLabel = known
        ? '上下文占用约 ' + percent + '%' + (state.occupancyEstimated ? '（估算值）' : '')
        : '上下文占用未知';
    // 无障碍标签必须与悬停提示**同源**：读屏用户拿不到 title，不能只给鼠标用户看构成。
    box.setAttribute('aria-label', partsText ? baseLabel + '。构成：' + partsText : baseLabel);
    if (state.occupancyEstimated && known)
        box.setAttribute('data-estimated', 'true');
    if (!known)
        box.setAttribute('data-unknown', 'true');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('width', '30');
    svg.setAttribute('height', '30');
    svg.setAttribute('class', 'dsh-explain-assistant-ring-svg');
    const RADIUS = 15.9155; // 周长恰为 100，便于用 stroke-dasharray 直接表达百分比
    const track = document.createElementNS(NS, 'circle');
    track.setAttribute('cx', '18');
    track.setAttribute('cy', '18');
    track.setAttribute('r', String(RADIUS));
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke-width', '4.2');
    track.setAttribute('class', 'dsh-explain-assistant-ring-track');
    svg.appendChild(track);
    if (known) {
        const arc = document.createElementNS(NS, 'circle');
        arc.setAttribute('cx', '18');
        arc.setAttribute('cy', '18');
        arc.setAttribute('r', String(RADIUS));
        arc.setAttribute('fill', 'none');
        arc.setAttribute('stroke-width', '4.2');
        arc.setAttribute('stroke-linecap', 'round');
        arc.setAttribute('class', 'dsh-explain-assistant-ring-arc');
        arc.setAttribute('stroke-dasharray', percent + ' ' + (100 - percent));
        arc.setAttribute('transform', 'rotate(-90 18 18)');
        svg.appendChild(arc);
    }
    box.append(svg, el('span', { class: 'dsh-explain-assistant-ring-label ea-ring-label', text: known ? percent + '%' : '占用未知' }));
    if (known && state.occupancyEstimated)
        box.appendChild(el('small', { class: 'dsh-explain-assistant-ring-estimated ea-ring-estimated', text: '估算' }));
    return box;
}
const contexts = new WeakMap();
export function renderOverlay(state, plugin) {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : previouslyFocused;
    const like = plugin;
    const root = el('section', {
        class: 'dsh-explain-assistant-overlay ea-overlay',
        role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'dsh-explain-assistant-title',
    });
    root.tabIndex = -1;
    const titlebar = el('header', { class: 'dsh-explain-assistant-titlebar ea-header', 'data-drag-handle': 'true', tabindex: '0', 'aria-label': '拖动解释小助手窗口；使用方向键移动' });
    const phase = el('span', { class: 'dsh-explain-assistant-status ea-phase', 'aria-live': 'polite' });
    const close = button('×', '关闭解释小助手', () => {
        contexts.get(root)?.plugin.registry.close(state.sessionId);
        previouslyFocused?.focus();
        previouslyFocused = null;
    }, { class: 'dsh-explain-assistant-close ea-close', title: '关闭（Esc）' });
    // §5.2 / §11.4：选择模式必须能**退出**。
    // 旧实现只在进入时置 data-selection-mode，全库没有任何清除代码 →
    // 用户点过一次「选择主对话内容」之后，主对话里所有点击会被持续吞掉，再也点不动原卡片。
    // 现在：再点一次这个按钮就退出；选中一条依据后自动退出（见下方 evidence-selected 监听）。
    const leaveSelectionMode = () => {
        root.removeAttribute('data-selection-mode');
        select.setAttribute('aria-pressed', 'false');
        select.textContent = '选择主对话内容';
        selectionStatus.textContent = '';
    };
    const enterSelectionMode = () => {
        root.setAttribute('data-selection-mode', 'true');
        select.setAttribute('aria-pressed', 'true');
        select.textContent = '退出选择模式';
        selectionStatus.textContent = '请点击主对话中的步骤卡片或助手汇报（也可以右键，或聚焦后按 Shift+Enter）。再次点本按钮可退出。';
        document.dispatchEvent(new CustomEvent('dsh-explain-assistant:select', { detail: { sessionId: state.sessionId } }));
    };
    const select = button('选择主对话内容', '选择主对话中的步骤或工具卡片', () => {
        if (root.hasAttribute('data-selection-mode'))
            leaveSelectionMode();
        else
            enterSelectionMode();
    }, { class: 'ea-btn ea-btn-soft', pressed: false });
    // 选中一条依据后自动退出选择模式：用户已经表达了要讲哪一条，不该继续吞掉后续点击。
    const onEvidenceSelected = (event) => {
        const detail = event.detail || {};
        if (detail.sessionId !== state.sessionId)
            return;
        leaveSelectionMode();
    };
    document.addEventListener('dsh-explain-assistant:evidence-selected', onEvidenceSelected);
    root.addEventListener('dsh-explain-assistant:dispose', () => document.removeEventListener('dsh-explain-assistant:evidence-selected', onEvidenceSelected), { once: true });
    // Esc 也要能退出选择模式（先退模式，再关窗由外层 keydown 处理）。
    root.addEventListener('keydown', event => { if (event.key === 'Escape' && root.hasAttribute('data-selection-mode'))
        leaveSelectionMode(); }, true);
    const compact = button('/compact', '压缩小助手上下文', () => {
        const current = contexts.get(root);
        if (current && !isBusy(current.state))
            void current.plugin.submit('/compact');
    }, { class: 'ea-btn ea-btn-soft', title: '整理小助手自己的上下文；不影响主对话' });
    titlebar.append(el('strong', { id: 'dsh-explain-assistant-title', class: 'ea-title', text: '解释小助手' }), phase, el('div', { class: 'ea-header-actions' }, select, compact, close));
    const selectionStatus = el('span', { class: 'dsh-explain-assistant-selection-status ea-selection-status', role: 'status' });
    const body = el('div', { class: 'dsh-explain-assistant-content ea-body' });
    const errorSlot = el('div', { class: 'ea-slot' });
    const currentSlot = el('div', { class: 'ea-slot' });
    // 正文的容器用 <article>：它是「小助手回答」这一块，读屏需要这个语义标签。
    // 增量渲染器只在这个容器**内部**增删尾部节点，容器本身不重建。
    const answerSlot = el('article', { class: 'dsh-explain-assistant-answer ea-answer', 'aria-label': '小助手回答' });
    const answerView = mountMarkdown(answerSlot);
    const heroSlot = el('div', { class: 'ea-slot' });
    const quickSlot = el('div', { class: 'ea-slot' });
    const modelSlot = el('div', { class: 'ea-slot' });
    const evidenceSlot = el('div', { class: 'ea-slot' });
    const compactSlot = el('div', { class: 'ea-slot' });
    const historySlot = el('div', { class: 'ea-slot' });
    // 展开面板放在最前面：用户点的是「查看完整内容」，结果必须在打开的那一刻就被看见，
    // 否则在长长的历史列表里点完之后什么都不会变化（内容其实在下面，用户以为按钮坏了）。
    const detailSlot = el('div', { class: 'ea-slot' });
    body.append(detailSlot, errorSlot, currentSlot, answerSlot, heroSlot, quickSlot, modelSlot, evidenceSlot, compactSlot, historySlot, selectionStatus);
    const input = el('textarea', { class: 'ea-input', placeholder: '问小助手主 agent 正在做什么…', 'aria-label': '向解释小助手提问', rows: '2' });
    const send = button(isBusy(state) ? '处理中' : '发送', '发送问题', () => { form.requestSubmit(); }, { class: 'ea-btn ea-btn-primary ea-send' });
    const ringSlot = el('div', { class: 'ea-ring-slot' });
    /**
     * §5.2「小助手显示正在围绕哪条内容提问」。
     *
     * 此前这条提示只写在正文末尾的状态行里（body 底部），输入框附近**没有任何固定标识**：
     * 用户滚到别处、或浮窗内容变长之后，就看不出这一问到底问的是哪一条了。
     * 现在把它固定钉在输入框正上方，随依据变化实时更新。
     */
    const targetBar = el('div', { class: 'ea-target-bar', role: 'status', 'aria-live': 'polite' });
    const form = el('form', { class: 'dsh-explain-assistant-form ea-composer' });
    form.append(targetBar, input, el('div', { class: 'ea-composer-actions' }, ringSlot, send));
    /**
     * 改大小的入口：**像普通窗口一样拖边、拖角**。
     *
     * 用户对上一版（只有一个角落字符 ◢）的定性原话是
     * 「不是，意思是这个设计不符合操作直觉，不是说它看不到用不了」——
     * 他嫌的不是字号或颜色，而是「要去角落找一个符号」这件事不合他平时用窗口的经验。
     * 所以这里在四周各铺一条边、四个角各铺一个热区，方向与鼠标指针一致；
     * 那个 ◢ 保留（有人习惯找它），但只是**其中一部分**，不再是唯一入口。
     */
    const RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    const resizeZones = RESIZE_DIRECTIONS.map(direction => ({
        direction,
        element: el('div', {
            class: 'ea-resize-edge ea-resize-' + direction,
            'data-resize-direction': direction,
            // 热区是纯装饰性拖拽面：读屏与键盘仍走标题栏的方向键（见 attachWindowInteractions）。
            'aria-hidden': 'true',
        }),
    }));
    const resize = button('◢', '调整窗口大小；使用方向键调整', undefined, { class: 'dsh-explain-assistant-resize ea-resize' });
    const geometry = clampGeometry(state.geometry, window.innerWidth, window.innerHeight);
    root.style.left = geometry.x + 'px';
    root.style.top = geometry.y + 'px';
    root.style.width = geometry.width + 'px';
    root.style.height = geometry.height + 'px';
    root.append(titlebar, body, form, ...resizeZones.map(zone => zone.element), resize);
    const ctx = {
        state, plugin: like, body, phase, selectionStatus, controller: undefined, appliedGeometry: undefined,
        // 见 updateOverlay：用来判断「后面来的几何值是不是新值」。
        // 不这样做的话，每次重画都会把用户刚拖好的位置按旧值拽回去。
        errorSlot, currentSlot, answerSlot, answerView, heroSlot, quickSlot, modelSlot, evidenceSlot, compactSlot, historySlot, detailSlot, ringSlot, targetBar,
        // 默认折叠模型列表：一开就摊开 33 个模型会把「使用说明 + 快捷问题」顶出可视区。
        // 未选模型时由摘要行 + 醒目的提示承担「先选一个」的引导（§7/§11.8）。
        form, input, send, modelOpen: false,
        rerender: () => updateOverlay(root, ctx.state, ctx.plugin),
    };
    contexts.set(root, ctx);
    input.value = state.draft;
    input.addEventListener('input', () => { const current = contexts.get(root); if (current)
        current.plugin.registry.update(current.state.sessionId, { draft: input.value }); });
    form.addEventListener('submit', event => {
        event.preventDefault();
        const current = contexts.get(root);
        if (!current)
            return;
        const question = input.value.trim();
        if (question && !isBusy(current.state))
            void current.plugin.submit(question);
    });
    updateOverlay(root, state, like);
    const focusable = () => Array.from(root.querySelectorAll('button, textarea, input, select, summary, [tabindex]:not([tabindex="-1"])')).filter(element => !element.hasAttribute('disabled') && element.tabIndex >= 0);
    const keydown = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close.click();
            return;
        }
        if (event.key !== 'Tab')
            return;
        const items = focusable();
        if (!items.length) {
            event.preventDefault();
            root.focus();
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        }
        else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };
    root.addEventListener('keydown', keydown);
    root.addEventListener('dsh-explain-assistant:dispose', () => root.removeEventListener('keydown', keydown), { once: true });
    const controller = attachWindowInteractions(root, titlebar, geometry, next => {
        const current = contexts.get(root);
        if (!current)
            return;
        // 先落到内存（本次会话内立刻生效），再让宿主记住（关掉再打开要回到原处）。
        // 此前只做了前者 —— contracts 里那个 geometry 字段从来没人写过，位置等于没存。
        current.plugin.registry.update(current.state.sessionId, { geometry: next });
        current.plugin.saveGeometry?.(current.state.sessionId, next);
    }, resizeZones);
    ctx.controller = controller;
    root.addEventListener('dsh-explain-assistant:dispose', () => { controller.dispose(); answerView.dispose(); }, { once: true });
    // preventScroll：默认的 focus() 会把浏览器滚动到输入框，于是首屏直接停在模型列表上、
    // 「使用说明 + 快捷问题」被顶到可视区外面——第一眼就看不到这窗口是干什么的。
    queueMicrotask(() => { (input || root).focus({ preventScroll: true }); body.scrollTop = 0; });
    return root;
}
/** 状态变化时原地重画各区块。骨架、输入框、滚动位置都不动。 */
export function updateOverlay(root, state, plugin) {
    const ctx = contexts.get(root);
    if (!ctx)
        return;
    ctx.state = state;
    ctx.plugin = plugin;
    // §9（用户实测：滚轮一滚就抽搐）：**这里刻意不再读 scrollTop**。
    //
    // 旧实现在这里存下 ctx.body.scrollTop，重画完再在函数末尾写回去。看起来是
    // 「保住滚动位置」，实际上是抽搐的来源：流式回答期间宿主每来一个分片就触发一次重画
    // （一次回答几十到几百次），而浏览器在内容重排时会自己做**滚动锚定**调整 scrollTop；
    // 我们把最开始读到的旧值写回去，等于把浏览器的调整**反向抹掉**——两套机制抢同一个
    // 滚动位置，用户看到的就是一滚一抽搐。
    //
    // 正文区是原地更新（各 slot 走 fill()，不重建容器），浏览器本来就会保住滚动位置；
    // 内容变短时浏览器也会自己钳低。所以「不碰」才是正确的保持方式。
    // ── 几何值「后到」时必须补应用 ──────────────────────────────────────────
    //
    // 首次打开浮窗时 `/state` 还没回来，创建那一刻只能用默认位置渲染；
    // 等几何值回来时 `updateOverlay` 只重画内容、**不重设位置** → 必须关闭重开才生效。
    // 实测（verify-3082）：硬重载后首次打开停在默认 `(600,16) 420x526`，关闭重开才 `(220,32) 620x526`。
    //
    // 两条守卫，缺一条都会造成倒退：
    //  ① 用户**正在**拖动/缩放时不覆盖 —— 否则会把用户正拖的位置拽回去；
    //  ② 与上次已套用的值相同则不动 —— 否则每次重画（流式回答期间几百次）都重设一次位置。
    if (state.geometry && ctx.controller && !ctx.controller.isInteracting()) {
        const next = clampGeometry(state.geometry, window.innerWidth, window.innerHeight);
        const prev = ctx.appliedGeometry;
        if (!prev || prev.x !== next.x || prev.y !== next.y || prev.width !== next.width || prev.height !== next.height) {
            ctx.controller.applyExternal(next);
            ctx.appliedGeometry = next;
        }
    }
    ctx.phase.textContent = phaseLabel(state);
    ctx.errorSlot.replaceChildren();
    if (state.error)
        ctx.errorSlot.appendChild(el('div', { class: 'dsh-explain-assistant-error ea-error', role: 'alert', text: state.error }));
    fill(ctx.currentSlot, [...currentStatusNodes(state, ctx.plugin), ...currentDetailNodes(state), ...offlineFallbackNodes(state)]);
    // 正文：走增量渲染。
    //
    // streaming 的判据是「还在吐字」，也就是 phase 为 connecting/running。
    // 注意**不能**只看「文本有没有变长」：一次回答结束后宿主还会再推一次同样的文本，
    // 那时若仍按流式处理，增量器会保留增量状态而不做整篇定稿渲染，
    // 未闭合的块（例如最后一段没有空行结尾）会一直停在「临时」形态。
    ctx.answerSlot.hidden = !state.text;
    if (state.text)
        ctx.answerView.update(state.text, isBusy(state));
    else
        ctx.answerView.update('', false);
    fill(ctx.heroSlot, heroNodes(state));
    fill(ctx.quickSlot, quickNodes(state, ctx.plugin));
    fill(ctx.modelSlot, modelNodes(state, ctx.plugin, ctx.modelOpen, next => { ctx.modelOpen = next; ctx.rerender(); }));
    fill(ctx.evidenceSlot, evidenceNodes(state, ctx.plugin));
    fill(ctx.compactSlot, compactNodes(state));
    fill(ctx.historySlot, historyNodes(state, ctx.plugin));
    fill(ctx.detailSlot, historyDetailNodes(state, ctx.plugin));
    // 换了一条记录来展开时把面板滚到可见处；同一记录的续读/重画不动滚动位置。
    const detailId = state.historyDetail?.recordId;
    if (detailId && detailId !== ctx.detailRecordId) {
        ctx.detailRecordId = detailId;
        ctx.body.scrollTop = 0;
    }
    else if (!detailId)
        ctx.detailRecordId = undefined;
    ctx.ringSlot.replaceChildren(ringNode(state));
    // §5.2：常驻显示「正在围绕哪条内容提问」。没有选中依据时不留空条。
    const targets = state.evidence.filter(item => item?.title || item?.summary);
    const currentId = state.evidence.length ? state.evidence[state.evidence.length - 1] : undefined;
    if (targets.length && currentId) {
        const label = currentId.title || (currentId.summary || '').slice(0, 40) || '未命名步骤';
        fill(ctx.targetBar, [
            el('span', { class: 'ea-target-label', text: '正在围绕这条内容提问：' }),
            el('strong', { class: 'ea-target-title', text: label }),
            targets.length > 1 ? el('small', { class: 'ea-target-more', text: '（另有 ' + (targets.length - 1) + ' 条依据）' }) : null,
            button('取消', '不再围绕这条内容提问', () => {
                plugin.registry.update(state.sessionId, current => { current.evidence = []; });
            }, { class: 'ea-btn ea-btn-quiet ea-target-clear' }),
        ]);
        ctx.targetBar.setAttribute('data-has-target', 'true');
    }
    else {
        ctx.targetBar.replaceChildren();
        ctx.targetBar.removeAttribute('data-has-target');
    }
    // 只在草稿真的被外部改写（例如提交后清空）时回写输入框，避免打字时被顶掉光标。
    if (ctx.input.value !== state.draft)
        ctx.input.value = state.draft;
    const busy = isBusy(state);
    ctx.send.textContent = busy ? '处理中' : '发送';
    ctx.send.disabled = busy;
    // 注意：这里**不再回写 scrollTop**。见函数开头说明。
}
