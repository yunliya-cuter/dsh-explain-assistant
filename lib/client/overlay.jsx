import { clampGeometry, attachWindowInteractions } from './window.js';
// 回答正文的 Markdown 渲染。用户要求「解析记号」与「保证性能」同时成立，
// 增量机制（块级冻结 + 代码块只追加 + 只换尾部）都在这个模块里，见其头部说明。
import { mountMarkdown, cachedMarkdownNodes } from './markdown.js';
// §10/D1：记录为什么没完成的中文文案与宿主**共用同一份**（src/shared/）。刻意不复制第二份。
import { recordReasonText, RECORD_REASON_PREFIX, RECORD_INCOMPLETE_TEXT } from '../shared/record-reason.js';
// §9.1：压缩日志不是一轮对话 —— 判定只此一处，宿主与客户端共用（见 shared/record-kind.ts）。
import { isAskRecord } from '../shared/record-kind.js';
// 历史区的分页窗口（纯函数，可单测）：默认只挂最近几条，往上补，同时挂载量有上限。
import { HISTORY_BATCH, resolveHistoryWindow } from './history-window.js';
import { mountTextField } from './text-field.js';
import { mountPageSelection } from './page-selection.js';
/**
 * 目录级失败的码：表示「整份目录没读到」，与「读到了但某个 provider 有问题」相对。
 *
 * 声明刻意放在两个用到它的函数**之前**：它们体内会引用这个常量，
 * 放后面虽然因为「函数是延后调用」而不构成真 TDZ，但那是**靠调用时机巧合**成立的，
 * 一旦有人把调用时机前移就会变成运行期崩溃。顺序显式写对，不依赖巧合。
 */
const CATALOG_UNAVAILABLE_CODE = 'MODEL_CATALOG_UNAVAILABLE';
/**
 * 是否已经有**来自宿主/用户的真实内容**。
 *
 * 判据刻意只认这些「不可能凭空出现」的字段：它们要么来自一次成功的 /state，
 * 要么来自用户自己的动作（选模型、提问）。**不**把 records.length===0、catalog 缺失
 * 这类「空」算作内容 —— 那正是我们不让界面当成结论的东西。
 */
function hasLoadedContent(state) {
    return Boolean(state.records.length ||
        state.text ||
        state.tools.length ||
        state.evidence.length ||
        state.model ||
        state.historyDetail ||
        state.compactState?.summary ||
        // 目录：有模型组才算内容；失败条目里**只有非目录级**的（例如 MODEL_CATALOG_PARTIAL）
        // 才算「读到了但有 provider 出问题」。
        // 目录级失败（MODEL_CATALOG_UNAVAILABLE）不是内容，而是「这次没读到目录」——
        // 把它算成内容会让界面判为 ready，从而把「没读到」渲染成一批「真的没有」的结论
        // （t6 评审的 F2）。
        (state.catalog && ((state.catalog.groups?.length ?? 0) > 0
            || (state.catalog.failures || []).some(failure => failure?.code !== CATALOG_UNAVAILABLE_CODE))));
}
/**
 * 「这次没读到」的原因（t6 评审的 F2）。
 *
 * 两种来源，界面上是同一件事：**数据没到位**，而不是**数据是空的**。
 *   1. /state 整体失败 → state.stateError（t2 已有的路径）；
 *   2. /state 成功、但随它下发的模型目录是「读取失败」的形状
 *      （空 groups + 一条 MODEL_CATALOG_UNAVAILABLE）。
 *
 * 为什么第 2 条必须在这里认出来：宿主修好之前，目录读取失败被 catch 成
 * `{groups: [], failures: []}` —— 与「目录真的是空的」形状完全相同，
 * 客户端无从分辨。宿主改成如实填 failures 之后，这里就能**区分**
 * 「没读到」（有目录级失败）与「真的没有」（failures 为空）。
 */
function readFailure(state) {
    if (typeof state.stateError === 'string' && state.stateError) {
        return { title: '没有读到小助手的当前状态', message: state.stateError };
    }
    const catalog = state.catalog;
    // 只有在「一个模型组都没有」时才算整份目录没读到；有组的目录是**读到了**的。
    if (!catalog || (catalog.groups?.length ?? 0) > 0)
        return undefined;
    const failure = (catalog.failures || []).find(item => item?.code === CATALOG_UNAVAILABLE_CODE && item.message);
    if (!failure)
        return undefined;
    return { title: '没有读到模型目录', message: String(failure.message) };
}
/**
 * 决定这次渲染走哪一档。
 *
 * 关于 `state.stateReady === false` 这个写法的说明（**不是**把 undefined 当成已就绪的偷懒）：
 * stateReady 的唯一来源是 store 的 initial()（恒为 false）与 index.ts 里 /state 的两种结局。
 * 凡是从 registry 取出来的状态这个字段**一定是布尔值**，所以真实用户路径上
 * 「未就绪」永远命中 `=== false` 这一支。写成显式比较是为了让**手工构造的状态对象**
 * （几十条既有单测直接传字面量）保持原行为，不被这次改动连带影响。
 * 新增的单测走的是真实 registry（见 tests/state-readiness.test.mjs），
 * 那里断言的是 initial() 的初值与两种结局，不受这个兼容写法影响。
 */
/**
 * 这个档位下「提交」是否合法（t8 的 F-B）。
 *
 * 加载页与失败页上都**不允许**提交：这两档下数据还没到位/没读到，
 * 而按下去却会真的发出 /api/explain-assistant/ask ——
 * 实测（t8 在真实页面上）：加载页打字后点发送，请求确实发出去了（命中 t1 清单 L15）。
 *
 * 抽成纯函数是为了让「真的不许发出去」这条判据能被逐条断言，
 * 而不是只测到「按钮变灰」—— 后者在 submit 路径没被拦住时照样会绿。
 */
export function canSubmit(state) {
    return surfaceGate(state) === 'ready' && !isBusy(state);
}
/**
 * 发送按钮的文案。
 *
 * 不能提交的档位必须**看得出**不可提交，而不是仍然写着「发送」并只靠灰化表达 ——
 * 灰化在浅色主题下很弱，用户仍会以为按得动（t8 的 F-B 现象就是这个）。
 */
export function sendLabel(state, gate) {
    if (gate === 'loading')
        return '读取中…';
    if (gate === 'failed')
        return '暂时不可用';
    /**
     * 忙的时候这颗按钮变成「停止」（用户 2026-10-31 的决定：
     * 「U6我认为点击按钮即可停止的设计不错」）。
     *
     * 为什么不再显示「处理中」：那是**状态描述**，不是**可执行动作**。
     * 用户在等一条跑飞的回答时，唯一想做的就是让它停下；把唯一一颗他手已经放上去的按钮
     * 写成「处理中」并置灰，等于把出口藏起来。同一颗按钮原地换成动作，最符合直觉。
     */
    return isBusy(state) ? '停止' : '发送';
}
function surfaceGate(state) {
    if (state.stateReady === false)
        return 'loading';
    // 「没读到」且**没有任何已经正确的旧内容**时，整块内容区交给明确的中文说明 + 重试。
    // 这里用 readFailure 而不是只看 stateError：目录读取失败同样是「没读到」，
    // 旧写法（只看 stateError）会让它落到 ready，于是渲染出一批「真的没有」的结论（F2）。
    if (readFailure(state) && !hasLoadedContent(state))
        return 'failed';
    return 'ready';
}
/** 明确的加载页。第一眼必须被读成「正在加载」，而不是「没有数据」「插件坏了」。 */
function loadingNodes() {
    return [el('section', { class: 'ea-loading', 'aria-label': '正在加载' }, el('div', { class: 'ea-loading-row', role: 'status', 'aria-live': 'polite' }, el('span', { class: 'ea-spinner', 'aria-hidden': 'true' }), el('span', { class: 'ea-loading-text', text: '正在读取小助手的当前状态…' })), el('p', { class: 'ea-loading-hint', text: '模型列表、历史记录与上下文占用会在数据到位后一次性显示出来。这里现在什么都没有显示，是因为还没读到，不是因为你没有数据。' }), 
        // 第一次打开确实比后面慢：要读主 agent 这一段的过程、算占用、拉一次模型目录。
        // 写出来，用户才知道"等"是正常的、不是卡死（读一次之后有缓存，再打开就是秒开）。
        el('p', { class: 'ea-loading-hint ea-loading-slow', text: '第一次打开可能要几秒：需要先把主 agent 最近这一段的过程读一遍、再算上下文占用。读到之后会缓存，之后再打开就是秒开。' }))];
}
/**
 * /state 失败（或超时）且没有旧内容时的明确中文错误 + 重试。
 *
 * 这段文案刻意**明说「不是你没有数据」**：失败路径最容易犯的错就是让界面看起来
 * 和「真的没有内容」一模一样 —— 那等于又制造一次错值窗口（契约判据 3 直接禁止）。
 */
function stateErrorNodes(state, plugin, failure) {
    // 标题与原因都取自 readFailure：这样「/state 整体失败」与「/state 成功但目录没读到」
    // 各自说自己那句实话，而不是笼统地都说「没读到当前状态」（F2 里后者根本不是状态的问题）。
    const info = failure || readFailure(state) || { title: '没有读到小助手的当前状态', message: state.stateError };
    return [el('section', { class: 'ea-state-error ea-card', 'aria-label': '状态读取失败' }, el('h3', { class: 'ea-card-title', text: info.title }), el('p', { class: 'ea-state-error-reason ea-error', role: 'alert', text: info.message }), el('p', { class: 'ea-state-error-hint', text: '注意：这不是「没有内容」。模型列表、历史记录与上下文占用这次都没有取到，所以下面不显示空的列表或「还没有历史」这类结论 —— 那会把「没读到」说成「真的没有」。' }), button('重试', '重新读取小助手状态', () => {
            if (!plugin.retryState)
                return;
            /**
             * 先让界面**立刻**回到「正在重新读取」，再发请求。
             *
             * 旧写法只发请求、什么都不改 —— 接下来最长 15 秒里界面一动不动，
             * 用户看到的就是「重试按了没反应」（3081 上就是这么报的）。
             * 置 stateReady=false 会切到加载页；无论成功还是再次失败，都会有明确结局。
             */
            plugin.registry.update(state.sessionId, { stateReady: false, stateError: undefined });
            void plugin.retryState(state.sessionId);
        }, { class: 'ea-btn ea-btn-primary ea-state-retry' }))];
}
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
        'aria-expanded': options.expanded === undefined ? undefined : String(options.expanded),
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
function heroNodes(state, ctx) {
    if (state.text || state.records.length || state.error || isBusy(state))
        return [];
    return [el('section', { class: 'ea-hero', 'aria-label': '使用说明' }, el('p', { class: 'ea-hero-title', text: '小助手在旁边看着主 agent，随时把「它正在干什么」讲成白话。' }), el('ul', { class: 'ea-hero-list' }, el('li', { text: '点右上角「选择主对话内容」，再点主对话里的一条内容，就能针对它提问；再点同一张卡片可以取消。' }), el('li', { text: '也可以直接在下面输入问题，或者点上面的快捷问题。' }), el('li', { text: '小助手只读：不改主 agent、不执行命令、不碰主对话的输入框。' })), 
        // 第一次打开的人不知道标题栏那排按钮能点 —— 教程入口必须出现在这里，而不只在标题栏。
        button('第一次用？看 30 秒教程 →', '打开使用教程', () => openTutorial(ctx), { class: 'ea-btn ea-btn-soft ea-hero-tutorial' }))];
}
/**
 * §7 / §11.8 模型选择：标题栏里的一个按钮 + 点开后的选择页。
 *
 * ── 这一版为什么搬家 ────────────────────────────────────────────────
 * 旧版把「模型」做成正文里的一张卡片：标题 + 「刷新模型」+ 一行「本对话已选 · provider / model」
 * + 一个折叠按钮 + 展开后的一大片模型按钮。模型是一年改不了几次的**设置**，
 * 却长期占着正文最显眼的位置：每次打开浮窗，第一眼看到的是「共 8 个可选」，
 * 真正要看的小助手回答被挤到下面去了。
 * 现在标题栏里只留一个按钮，**始终显示现在用的是哪个模型**，点开才进入模型选择页。
 *
 * ── 一条不能破的规矩：三档界面（判据见 surfaceGate）──────────────────
 *   loading（/state 还没回来）→ 标题栏按钮**不出现**，选择页也进不去；
 *   failed（没读到且没有旧内容）→ 同样不出现。
 * 于是「共 0 个可选」「暂时没有可用的模型」「还没有选择模型」这些**结论**
 * 没有机会出现在错值窗口里 —— 这是已经修过的缺陷，不能因为一次改版退回去。
 * 目录整份没读到、但页面还能用（有旧内容）时：按钮说「模型目录未读到」，
 * 选择页**不报数**（见 catalogUnavailable）。
 */
/** 目录整份没读到时的失败条目。判据与 readFailure 一致：只要有组就算读到了。 */
function catalogUnavailable(state) {
    if ((state.catalog?.groups?.length ?? 0) > 0)
        return undefined;
    return (state.catalog?.failures || []).find(item => item?.code === CATALOG_UNAVAILABLE_CODE && item?.message);
}
function catalogEntries(state) {
    const entries = [];
    for (const group of state.catalog?.groups || []) {
        for (const entry of group.models || []) {
            const provider = String(entry.provider || group.provider || '');
            const id = String(entry.id || '');
            if (!provider || !id)
                continue;
            entries.push({ provider, id, name: String(entry.name || id), group: String(group.displayName || group.provider || '未命名提供方') });
        }
    }
    return entries;
}
function isSelectedModel(state, entry) {
    return Boolean(state.model && state.model.provider === entry.provider && state.model.model === entry.id);
}
/**
 * 标题栏按钮上显示什么。
 * 不做手工截断（截断交给 CSS，见 .ea-model-trigger-label）：手工截断会把模型名截成
 * 「deepseek-v4.1-…」这种既不能读也不能搜的半截字，而 CSS 的省略号至少看起来是「被截断」。
 */
function modelTriggerLabel(state) {
    if (catalogUnavailable(state))
        return '模型目录未读到';
    if (!state.model)
        return '选择模型';
    // 优先显示目录里的**显示名**（「DeepSeek V4.1 Flash」），拿不到才退回 id
    //（「cn:deepseek-v4.1-flash」）：标题栏这一格只有 2~3 个字的地方，
    // 显示名更容易被认出来，id 仍完整留在 aria-label 与选择页里。
    const entry = catalogEntries(state).find(item => isSelectedModel(state, item));
    return entry?.name || state.model.model;
}
const MODEL_PANEL_ID = 'ea-model-panel';
/**
 * 标题栏按钮。**只建一次**：它挂在标题栏里，重建会打断拖动与焦点。
 * 每次状态变化只改它的标签与 aria（见 syncModelTrigger）。
 */
function buildModelTrigger(getCtx) {
    const prefix = el('span', { class: 'ea-model-trigger-prefix', 'aria-hidden': 'true', text: '模型' });
    const label = el('span', { class: 'ea-model-trigger-label' });
    const warn = el('span', { class: 'ea-model-trigger-warn', 'aria-hidden': 'true', text: '⚠' });
    const caret = el('span', { class: 'ea-model-trigger-caret', 'aria-hidden': 'true', text: '▾' });
    const root = el('button', {
        type: 'button',
        class: 'ea-btn ea-btn-soft ea-model-trigger',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'aria-controls': MODEL_PANEL_ID,
        // 未就绪/没读到之前不出现：见文件里「三档界面」的说明。
        hidden: true,
        onClick: () => {
            const ctx = getCtx();
            if (!ctx)
                return;
            if (ctx.modelOpen)
                closeModelPanel(ctx);
            else
                openModelPanel(ctx);
        },
    }, prefix, label, warn, caret);
    return { root, prefix, label, warn, caret };
}
/**
 * 未就绪/没读到：按钮整个退成空壳。
 *
 * 不只是隐藏 —— 连标签文本一起清掉。hidden 只作用于**显示**，文本仍留在 DOM 里，
 * 于是一张「B 会话还没读到状态」的加载页上会冒出一个「模型」二字（那是 A 会话的内容），
 * 读屏的「读整页」与基于 DOM 文本的界面断言都会读到它。
 */
function resetModelTrigger(ctx) {
    const trigger = ctx.modelTrigger;
    trigger.root.hidden = true;
    trigger.label.textContent = '';
    trigger.warn.textContent = '';
    trigger.prefix.textContent = '';
    trigger.caret.textContent = '';
    trigger.prefix.hidden = true;
    trigger.root.removeAttribute('data-unselected');
    trigger.root.removeAttribute('data-warn');
    trigger.root.setAttribute('aria-expanded', 'false');
    trigger.root.setAttribute('aria-label', '模型选择（数据读取中不可用）');
    trigger.root.setAttribute('title', '模型选择（数据读取中不可用）');
}
/** 把标题栏按钮同步成当前状态。三种形态：已选 / 还没选 / 目录没读到。 */
function syncModelTrigger(ctx) {
    const state = ctx.state;
    const trigger = ctx.modelTrigger;
    const unavailable = catalogUnavailable(state);
    const failures = (state.catalog?.failures || []).filter(failure => failure?.message);
    const warn = Boolean(failures.length) || Boolean(unavailable);
    trigger.label.textContent = modelTriggerLabel(state);
    // 「模型」二字只在**已经选了模型**时出现：没选的时候按钮本身就是一句行动号召
    //（「选择模型」），再挂一个前缀会读成「模型 选择模型」。
    trigger.prefix.hidden = !state.model || Boolean(unavailable);
    trigger.prefix.textContent = '模型';
    trigger.caret.textContent = '▾';
    trigger.warn.hidden = !warn;
    trigger.warn.textContent = warn ? '⚠' : '';
    trigger.root.setAttribute('data-unselected', state.model ? 'false' : 'true');
    trigger.root.setAttribute('data-warn', warn ? 'true' : 'false');
    trigger.root.setAttribute('aria-expanded', ctx.modelOpen ? 'true' : 'false');
    // 面板没打开时，失败信息也得**看得见**：靠这个 ⚠ 与 aria-label/title。
    const detail = unavailable
        ? '没有读到模型目录，点开查看'
        : (state.model ? '已选 ' + state.model.provider + ' / ' + state.model.model + '，点开换一个' : '还没有选择模型，点这里选一个');
    const others = unavailable ? failures.length - 1 : failures.length;
    const extra = others > 0 ? '；另有 ' + others + ' 条提供方读取失败' : '';
    trigger.root.setAttribute('aria-label', '模型：' + detail + extra);
    trigger.root.setAttribute('title', '模型：' + detail + extra);
}
/**
 * 模型选择页。同样**只建一次**：里面的筛选框是有状态的（用户可能正打着字），
 * 而流式回答期间 updateOverlay 一次回答要跑几十上百次 —— 每次都重建筛选框，
 * 用户打的字和光标就会被打断。
 */
function buildModelPanel(getCtx) {
    const count = el('span', { class: 'ea-count ea-model-panel-count' });
    const current = el('p', { class: 'ea-model-panel-current' });
    const search = el('input', {
        type: 'search',
        class: 'ea-model-search',
        placeholder: '按名称筛选，例如 flash',
        'aria-label': '按名称筛选模型',
        autocomplete: 'off',
    });
    const list = el('div', { class: 'ea-model-list ea-model-panel-list', role: 'group', 'aria-label': '可选模型列表' });
    const failures = el('div', { class: 'ea-model-panel-failures' });
    const refresh = button('刷新', '重新读取可用模型列表（绕开缓存）', () => {
        const ctx = getCtx();
        if (!ctx || !ctx.plugin.api?.models)
            return;
        refresh.disabled = true;
        /**
         * 「刷新」是用户亲手点的一下：失败、挂起都必须有结局。
         * 没有超时的话，一次卡住的请求会让这颗按钮**永远灰着** —— 看起来像"刷新坏了"。
         */
        const timeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('读取模型目录超时（等了 10 秒没有回应）。可以再点一次刷新。')), 10_000);
        });
        void Promise.race([ctx.plugin.api.models(), timeout]).then(result => {
            const payload = (result.payload || {});
            ctx.plugin.registry.update(ctx.state.sessionId, { catalog: payload });
        }).catch(error => ctx.plugin.registry.update(ctx.state.sessionId, {
            error: error instanceof Error ? error.message : String(error),
        })).finally(() => { refresh.disabled = false; });
    }, { class: 'ea-btn ea-btn-soft ea-model-panel-refresh' });
    const back = button('← 返回', '关闭模型选择，回到对话', () => {
        const ctx = getCtx();
        if (ctx)
            closeModelPanel(ctx);
    }, { class: 'ea-btn ea-btn-quiet ea-model-panel-back' });
    const root = el('section', {
        class: 'ea-model-panel',
        id: MODEL_PANEL_ID,
        role: 'dialog',
        'aria-modal': 'false',
        'aria-labelledby': 'ea-model-panel-title',
    }, el('div', { class: 'ea-model-panel-head' }, back, el('h3', { class: 'ea-model-panel-title', id: 'ea-model-panel-title', text: '选择模型' }), count, refresh), current, el('div', { class: 'ea-model-panel-filter' }, search), list, failures);
    search.addEventListener('input', () => {
        const ctx = getCtx();
        if (!ctx)
            return;
        ctx.modelQuery = search.value;
        renderModelList(ctx);
    });
    return { root, count, current, search, list, failures, refresh };
}
/**
 * 选择页按需创建。
 *
 * 为什么不是「随浮窗一起建、用 CSS 藏起来」：藏起来只是**显示**层面，它里面的标题
 *（「选择模型」）、按钮文字仍在 DOM 里，于是「未就绪的加载页」或「别的会话」上
 * 会读到一份不属于当前页面的模型文案。关掉就摘掉，DOM 里就没有它。
 */
function ensureModelPanel(ctx) {
    if (!ctx.modelPanel) {
        ctx.modelPanel = buildModelPanel(() => ctx);
        ctx.modelPanelSlot.appendChild(ctx.modelPanel.root);
    }
    return ctx.modelPanel;
}
/**
 * 出场动画时长。刻意**大于** styles.css 的 --ea-page-out-dur（160ms）：
 * 退场是两页同时动（模型页往右退 160ms、对话页从左侧 220ms 回来），
 * 若在 160ms 就把节点摘掉，遇到低帧率会出现「两页都不在」的一帧 —— 闪一下白。
 * 留到 220ms 摘，等于等两页都就位再收摊。
 */
const MODEL_EXIT_MS = 220;
function prefersReducedMotion() {
    // 假 DOM 里没有 matchMedia：当作「可以播动画」，这样测试跑的是带过渡的真实路径。
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function openModelPanel(ctx) {
    // 两个整页面板互斥：教程页开着时点「模型」，先把教程收掉。
    // 否则两层 z-index:3 的面板会同时挂在 DOM 上，关掉上面那个还会留下 modelOpen=true 的幽灵状态。
    if (ctx.tutorialOpen)
        closeTutorial(ctx, { focus: false });
    // 上一次关闭的「延迟摘除」还没执行就又打开了：取消它，复用同一个节点。
    ctx.modelCloseToken++;
    const panel = ensureModelPanel(ctx);
    if (panel.root.hasAttribute('data-closing')) {
        panel.root.removeAttribute('data-closing');
        panel.root.removeAttribute('aria-hidden');
    }
    ctx.modelQuery = '';
    if (panel.search.value)
        panel.search.value = '';
    ctx.modelOpen = true;
    // 回到对话页时挂的 data-returning 必须摘掉，否则它会一直把对话页按在「刚回来」的那一帧。
    ctx.root.removeAttribute('data-returning');
    ctx.root.setAttribute('data-view', 'model');
    ctx.modelTrigger.root.setAttribute('aria-expanded', 'true');
    renderModelPanel(ctx);
    // 打开就把焦点放到筛选框：键盘用户不必再 Tab 一圈才到得了列表。
    queueMicrotask(() => { try {
        panel.search.focus({ preventScroll: true });
    }
    catch { /* 老浏览器没有参数 */ } });
}
/**
 * 关掉选择页回到对话。
 *
 * @param options.focus 是否把焦点还给标题栏按钮。宿主把界面切到加载/失败档时用 false ——
 *   那一刻按钮本身是隐藏的，把焦点塞进一个看不见的按钮只会让键盘用户丢失位置。
 */
function closeModelPanel(ctx, options = {}) {
    const wasOpen = ctx.modelOpen;
    const panel = ctx.modelPanel;
    ctx.modelOpen = false;
    ctx.modelTrigger.root.setAttribute('aria-expanded', 'false');
    // data-view 立刻切回来：这一帧开始「对话页回来」的动画，而模型页还在上面播退场。
    // 教程页还开着就回到教程页，不能无条件写 chat（那会让 tutorialOpen 与 data-view 打架）。
    ctx.root.setAttribute('data-view', ctx.tutorialOpen ? 'tutorial' : 'chat');
    const animate = options.animate !== false && Boolean(panel) && wasOpen && !prefersReducedMotion();
    if (animate && panel) {
        // 退场：先挂 data-closing 让 CSS 播 160ms，**播完再摘**。摘早了你只会看到它凭空消失。
        panel.root.setAttribute('data-closing', 'true');
        panel.root.setAttribute('aria-hidden', 'true');
        const token = ++ctx.modelCloseToken;
        setTimeout(() => {
            // 期间又点开了：这个 token 已经过期，别把新面板删掉。
            if (ctx.modelCloseToken !== token || ctx.modelPanel !== panel)
                return;
            fill(ctx.modelPanelSlot, []);
            ctx.modelPanel = undefined;
        }, MODEL_EXIT_MS);
    }
    else {
        fill(ctx.modelPanelSlot, []);
        ctx.modelPanel = undefined;
    }
    if (wasOpen) {
        // 对话页「回来」的入场动画：只在真的从模型页退回来时播，不在每次打开浮窗时播。
        //
        // 标记刻意**不用定时器清除**：动画用了 fill:both，播完停在「自然状态」，
        // 留着它什么也不会多做；而定时器清除会有个真问题 —— 动画被浏览器节流时
        // （后台标签页）JS 计时器照走，会在动画播到一半时把标记摘掉，画面直接跳一下。
        // 它由下一次 openModelPanel 负责清掉（那时正好也是该重播的时机）。
        ctx.root.setAttribute('data-returning', 'true');
    }
    if (wasOpen && options.focus !== false)
        ctx.modelTrigger.root.focus?.({ preventScroll: true });
}
/**
 * 选中一个模型。
 *
 * 先乐观更新界面（按钮看起来立刻有反应），失败必须**回滚**：
 * 曾经只回写 error、不回滚 model，于是选择其实被宿主拒绝了，界面却一直显示「已选」。
 * 选完直接回到对话 —— 用户点模型是为了继续问问题，不是为了继续看模型列表。
 */
function selectModelFromPanel(ctx, provider, id) {
    if (!ctx.plugin.api?.selectModel)
        return;
    const previous = ctx.plugin.registry.get(ctx.state.sessionId)?.model;
    ctx.plugin.registry.update(ctx.state.sessionId, { model: { provider, model: id, source: 'explicit' }, error: undefined });
    closeModelPanel(ctx);
    void ctx.plugin.api.selectModel(ctx.state.sessionId, { provider, model: id }).catch(error => ctx.plugin.registry.update(ctx.state.sessionId, {
        model: previous,
        error: '选择模型失败：' + (error instanceof Error ? error.message : String(error)),
    }));
}
/**
 * 目录里有提供方读失败时的提示条。
 *
 * 为什么这条必须留在正文、不能只放进选择页：那几句是**宿主明确告诉我们**的事实
 * （「模型提供方「x」暂时没有可用模型」）。只放进一个要用户主动点开才看得见的页面，
 * 等于把「宿主说的」降级成「藏起来的」——用户会以为模型列表是空的、或自己选错了。
 * 它只在真的有失败时出现，不占常驻位置。
 */
function catalogNoticeNodes(ctx) {
    // H-7：记录文件损坏被隔离时，必须明说一句。
    // 不说的后果：/state 返回 records=[]，界面显示「还没有小助手历史」，用户以为记录从来没存在过，
    // 而磁盘上其实还躺着 .corrupt.<时间戳> 的备份。
    const recovered = ctx.state.recoveredCorrupt === true
        ? [el('div', { class: 'ea-catalog-note', role: 'status' }, el('span', { class: 'ea-catalog-note-icon', 'aria-hidden': 'true', text: '⚠' }), el('div', { class: 'ea-catalog-note-text' }, el('small', { class: 'ea-model-failure', text: '这条对话的小助手记录文件损坏了：已把它改名备份到同目录（.corrupt.*），并从这里重新开始记录。备份文件还在，可以找回来。' })))]
        : [];
    const failures = (ctx.state.catalog?.failures || []).filter(failure => failure?.message);
    if (!failures.length)
        return recovered;
    return [...recovered, el('div', { class: 'ea-catalog-note', role: 'status' }, el('span', { class: 'ea-catalog-note-icon', 'aria-hidden': 'true', text: '⚠' }), el('div', { class: 'ea-catalog-note-text' }, ...failures.map(failure => el('small', { class: 'ea-model-failure', text: String(failure.message) }))), button('查看', '打开模型选择页，查看各提供方的状态', () => openModelPanel(ctx), { class: 'ea-btn ea-btn-quiet ea-catalog-note-open' }))];
}
function renderModelPanel(ctx) {
    const state = ctx.state;
    const panel = ensureModelPanel(ctx);
    const failures = (state.catalog?.failures || []).filter(failure => failure?.message);
    panel.current.textContent = state.model
        ? '本对话已选 · ' + state.model.provider + ' / ' + state.model.model
        : '还没有选择模型：请先选一个，小助手不会自动替你挑';
    panel.current.setAttribute('data-unselected', state.model ? 'false' : 'true');
    fill(panel.failures, failures.map(failure => el('small', { class: 'ea-model-failure', text: String(failure.message) })));
    panel.failures.hidden = failures.length === 0;
    renderModelList(ctx);
}
/** 重画模型列表（按 provider 分组 + 按筛选词过滤）。只动列表，不动筛选框。 */
function renderModelList(ctx) {
    const state = ctx.state;
    const panel = ensureModelPanel(ctx);
    const entries = catalogEntries(state);
    const keyword = ctx.modelQuery.trim().toLowerCase();
    const matched = keyword
        ? entries.filter(entry => entry.name.toLowerCase().includes(keyword)
            || entry.id.toLowerCase().includes(keyword)
            || entry.provider.toLowerCase().includes(keyword))
        : entries;
    const groups = new Map();
    for (const entry of matched) {
        const bucket = groups.get(entry.group);
        if (bucket)
            bucket.push(entry);
        else
            groups.set(entry.group, [entry]);
    }
    const nodes = [];
    for (const [name, bucket] of groups) {
        nodes.push(el('div', { class: 'ea-model-group' }, el('div', { class: 'ea-model-group-name' }, el('span', { text: name }), el('span', { class: 'ea-count', text: String(bucket.length) })), el('div', { class: 'ea-model-options' }, ...bucket.map(entry => {
            const selected = isSelectedModel(state, entry);
            return el('button', {
                type: 'button',
                class: 'ea-btn ea-model-option',
                'aria-pressed': String(selected),
                'aria-label': (selected ? '当前已选：' : '选择模型 ') + entry.provider + '/' + entry.id,
                title: entry.provider + ' / ' + entry.id,
                onClick: () => selectModelFromPanel(ctx, entry.provider, entry.id),
            }, el('span', { class: 'ea-model-option-name', text: entry.name }), el('span', { class: 'ea-model-option-id', text: entry.id }), el('span', { class: 'ea-model-option-check', 'aria-hidden': 'true', text: selected ? '✓' : '' }));
        }))));
    }
    // 空态只在「目录确实读到了、确实是空的」时才出现。目录整份没读到时不画它 ——
    // 那句「暂时没有可用的模型」会被读成结论，而真实情况是「没读到」。
    if (!entries.length && !catalogUnavailable(state)) {
        nodes.push(el('p', { class: 'ea-empty ea-model-empty', text: '暂时没有可用的模型，请先检查模型配置' }));
    }
    else if (!matched.length) {
        nodes.push(el('p', { class: 'ea-empty ea-model-empty', text: '没有匹配「' + ctx.modelQuery.trim() + '」的模型。换个关键词，或清空筛选框。' }));
    }
    fill(panel.list, nodes);
    const unavailable = catalogUnavailable(state);
    const total = entries.length;
    if (unavailable) {
        // 不自报数量：把自己数出来的 0 说成「共 0 个可选」，就是拿没读到的数据当结论。
        panel.count.textContent = '没有读到模型目录';
    }
    else if (keyword) {
        panel.count.textContent = '筛选出 ' + matched.length + ' / ' + total + ' 个';
    }
    else {
        panel.count.textContent = '共 ' + total + ' 个';
    }
}
/**
 * compactState 的**唯一**状态判定处。
 *
 * 宿主的 compactState 是落库结构：**没有 status 字段**（§9.1 只有压缩成功才落库）。
 * 在这里补回语义：有摘要即成功，没摘要就是失败。渲染层与"这一行插在哪"都走这一个判定，
 * 免得同一件事两处各写一遍、又漂成两套结论（历史上就出现过：摘要明明在，
 * 界面把"压缩成功"渲染成"压缩已中断"）。
 */
function compactStatusOf(compact) {
    const status = compact.status ?? (compact.summary ? 'complete' : 'error');
    return status;
}
/**
 * §9.1 /compact 的结果。
 *
 * 这一段此前完全不存在：压缩摘要只落库、不进任何 UI 状态，用户按了 /compact
 * 界面没有任何变化，成功失败都看不见，等于功能不存在。现在四种状态都给中文反馈：
 * 压缩中 / 已完成（带摘要正文）/ 已中断 / 失败（并说明保留上一份可用摘要）。
 */
/**
 * §9.1 /compact 的结果 —— 小助手上下文的一次「压缩事件」。
 *
 * ── 这一版为什么不是卡片 ───────────────────────────────────────
 * 用户原话：「我不希望上下文压缩是这样的卡片的形式，因为用户这样子看不见（在上下文最上方）」
 * 「参考一下 deepseek harness 是怎么处理摘要的显示的」。
 *
 * 宿主的做法（@deepseek-ai/dsh-client-ui-chat 的 compactionRow）是一行**很安静的条**，
 * 长在对话流里、就在压缩发生的位置，样式是：
 *   [图标] 上下文已压缩 · 摘要首行……（单行省略）
 *   hover 时图标变成展开箭头；点开就在同一位置往下长出正文（缩进 22px、次要色），
 *   展开时头部还会 sticky 在滚动区顶部。
 * 它不给"报告卡片"，也不占正文最上面 —— 因为那两样都会让人看不见或以为界面没反应。
 * 这里照同一套来：一行、跟着对话走、点开看全文。
 */
function compactNodes(state, ctx) {
    const compact = state.compactState;
    if (!compact)
        return [];
    // 防线：宿主落库的 compactState 是**落库结构**，没有 status 字段（§9.1 只有成功才落库）。
    const status = compactStatusOf(compact);
    if (status === 'idle')
        return [];
    const running = status === 'running';
    const failed = status === 'error';
    const summary = typeof compact.summary === 'string' ? compact.summary : '';
    const open = ctx.compactOpen === true && !running;
    const title = running ? '正在压缩上下文'
        : status === 'complete' ? '上下文已压缩'
            : failed ? '上下文压缩失败' : '上下文压缩已中断';
    const line = running
        ? '正在整理小助手自己的上下文…' + (state.text ? '（已收到 ' + state.text.length + ' 字）' : '')
        : status === 'complete'
            ? (firstLineOf(summary) || '点击查看压缩摘要')
            : (compact.error || '没有拿到可用的摘要');
    const row = el('section', {
        class: 'ea-compact-row',
        'data-status': running ? 'running' : status === 'complete' ? 'complete' : failed ? 'error' : 'interrupted',
        'data-open': open ? 'true' : 'false',
        'aria-label': '小助手上下文压缩',
    });
    const head = el('button', {
        type: 'button', class: 'ea-compact-head', 'aria-expanded': open ? 'true' : 'false',
    });
    head.append(el('span', { class: 'ea-compact-chevron', 'aria-hidden': 'true', text: '▸' }), el('span', { class: 'ea-compact-title', text: title }), el('span', { class: 'ea-compact-sep', 'aria-hidden': 'true' }), el('span', { class: 'ea-compact-line', text: line }));
    if (running)
        head.setAttribute('disabled', '');
    else
        head.addEventListener('click', () => {
            const next = !(ctx.compactOpen === true);
            ctx.compactOpen = next;
            row.setAttribute('data-open', next ? 'true' : 'false');
            head.setAttribute('aria-expanded', next ? 'true' : 'false');
            /**
             * 展开时把这一行的头部顶到滚动区上方。
             *
             * 它可能贴着滚动区底部（刚压完、就是最后一条之后的那个位置），也可能在对话中间
             * （压缩之后又问了几轮，它就夹在那几轮上面）。不管在哪，正文都是往下长的：
             * 不把头部顶上去，多出来的那一截就在视口外 —— 用户看到的是"点了没反应，只多出一条线"。
             */
            if (next && typeof row.getBoundingClientRect === 'function') {
                const r = row.getBoundingClientRect();
                const b = ctx.body.getBoundingClientRect();
                if (r.height > 0 && b.height > 0)
                    ctx.body.scrollTop += (r.top - b.top) - 6;
            }
        });
    row.appendChild(head);
    // 正文：只在展开时才有内容（宿主的 compactionBody 也是这么按需出现的）。
    const metaBits = [];
    if (compact.updatedAt)
        metaBits.push('压缩时间 ' + timeText(compact.updatedAt));
    const before = typeof compact.beforeOccupancy === 'number' ? compact.beforeOccupancy : undefined;
    // 0% → 0% 这种"什么都没变"的数字不写：那不是信息，是噪音。
    const after = state.occupancyKnown && typeof state.occupancy === 'number' ? state.occupancy : undefined;
    // 四舍五入之后的数才算数：0.4% → 0.3% 显示成「0% → 0%」是噪音，不是信息。
    const beforeRounded = before !== undefined ? Math.round(before) : undefined;
    const afterRounded = after !== undefined ? Math.round(after) : undefined;
    if (beforeRounded !== undefined && afterRounded !== undefined && (beforeRounded > 0 || afterRounded > 0)) {
        metaBits.push('占用 ' + beforeRounded + '% → ' + afterRounded + '%');
    }
    else if (beforeRounded !== undefined && beforeRounded > 0) {
        metaBits.push('压缩前占用 ' + beforeRounded + '%');
    }
    const body = [];
    if (metaBits.length)
        body.push(el('small', { class: 'ea-meta ea-compact-meta', text: metaBits.join(' · ') }));
    // 失败/中断的**原因**要在展开后的正文里写清（头部那一行只有一句省略，长错误看不全）。
    if (!running && status !== 'complete') {
        body.push(el('p', {
            class: 'ea-compact-error',
            role: 'alert',
            text: (failed ? '压缩失败：' : '压缩已中断：') + (compact.error || '没有拿到可用的摘要'),
        }));
        if (summary)
            body.push(el('small', { class: 'ea-meta', text: '下面是上一次成功压缩的摘要，仍然可用。' }));
    }
    if (summary)
        body.push(el('div', { class: 'ea-compact-summary ea-md-scope' }, ...cachedMarkdownNodes('compact-' + (compact.updatedAt || contentKey(summary)), summary)));
    else if (!running)
        body.push(el('p', { class: 'ea-compact-hint', text: failed || status === 'interrupted' ? '这次没有拿到可用的摘要。' : '没有可用的摘要正文。' }));
    if (status === 'complete')
        body.push(el('div', { class: 'ea-compact-actions' }, compactAction('重新压缩', '再压缩一次小助手上下文', ctx), compactCopyAction(summary)));
    else if (!running)
        body.push(el('div', { class: 'ea-compact-actions' }, compactAction(failed ? '重试压缩' : '继续压缩', '再尝试压缩一次小助手上下文', ctx)));
    row.appendChild(el('div', { class: 'ea-compact-body' }, ...body));
    return [row];
}
/** 一条记录是什么时候开始的：宿主落库写 startedAt，客户端本地刚追加的写 createdAt。 */
function recordStartedAt(input) {
    const record = (input || {});
    const at = record.startedAt ?? record.createdAt;
    return typeof at === 'string' ? at : '';
}
/**
 * 「上下文已压缩」这一行该插在对话里的第几条记录之前。返回 -1 表示现在没有可画的压缩事件。
 *
 * ── 为什么需要这个函数 ─────────────────────────────────────────────
 * 这一行原来固定在 `historySlot` 之后（body 的末尾），于是**永远**躺在对话最下面：
 * 压缩完再问两轮，它就跑到那两轮下面去了，看起来像"刚刚才压缩过"，而实际压缩发生在
 * 更早的位置。用户原话：「上下文压缩的提示总是在上下文最下方，而非在它本应在的位置」。
 *
 * ── 判据与宿主同源 ────────────────────────────────────────────────
 * 宿主 host/occupancy.ts 的 carriedRecords 就是按同一条规则算「哪些记录还在上下文里」：
 *     record.startedAt > compactState.createdAt
 * 也就是说：压缩**之前开始的**记录已被摘要取代（在它上面），压缩**之后开始的**才是新对话
 *（在它下面）。界面照同一条线插，两边不会各说各话。
 *
 * 拿不到压缩时间（老数据、或只有摘要正文）时不猜：退回末尾，按「最后发生」排。
 */
function compactBoundaryIndex(state, items) {
    const compact = state.compactState;
    if (!compact)
        return -1;
    const status = compactStatusOf(compact);
    if (status === 'idle')
        return -1;
    // 正在压缩：这件事正在发生，此刻下面就还没有「压缩之后」的记录。
    if (status === 'running')
        return items.length;
    const createdAt = typeof compact.createdAt === 'string' ? compact.createdAt : '';
    if (!createdAt)
        return items.length;
    const index = items.findIndex(item => {
        const at = recordStartedAt(item);
        // 两个时间都是 new Date().toISOString()，定长同格式，字符串比较即时间比较。
        return Boolean(at) && at > createdAt;
    });
    return index < 0 ? items.length : index;
}
/** 摘要的第一行，去掉 markdown 记号，用在这一行条上做省略显示（宿主的 compactionSummary 就是单行省略）。 */
function firstLineOf(text) {
    const plain = text.replace(/[#>*_`-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return plain.length > 80 ? plain.slice(0, 80) : plain;
}
/** 「重新压缩 / 重试」按钮：与标题栏那颗走同一条路（submit('/compact')），不另开一条。 */
function compactAction(label, aria, ctx) {
    return button(label, aria, () => {
        // 按钮禁用只是视觉挡板：直接调用也能绕过去，闸门必须在这里再判一次。
        if (!canSubmit(ctx.state))
            return;
        void ctx.plugin.submit('/compact');
    }, { class: 'ea-btn ea-btn-soft ea-compact-action' });
}
/** 复制摘要：只有真的有摘要时才出现；没有剪贴板 API 时如实说没复制成，不假装成功。 */
function compactCopyAction(summary) {
    const node = button('复制摘要', '把这份摘要复制到剪贴板', () => {
        const clipboard = (typeof navigator === 'object' ? navigator : undefined)?.clipboard;
        const say = (text) => { node.textContent = text; setTimeout(() => { node.textContent = '复制摘要'; }, 1600); };
        if (!clipboard?.writeText) {
            say('无法复制');
            return;
        }
        clipboard.writeText(summary).then(() => say('已复制'), () => say('复制失败'));
    }, { class: 'ea-btn ea-btn-soft ea-compact-action' });
    return node;
}
/**
 * §6.3 依据分级在界面上的呈现。
 *
 * 三级用词与提示词侧（prompts.ts 的 EVIDENCE_TIERS）保持一致，
 * 免得「同一件事在两处叫两个名字」。hint 是给用户的一句话解释，不出现术语。
 */
/**
 * 使用教程页。
 *
 * 用户这一轮的要求：「增加一个使用教程页面，内容编排精心设计」。
 * 入口两个（都做了，因为两边都有人走）：标题栏那颗「?」图标（随时可查），
 * 以及首次打开时正文里的那条引导（第一次用的人根本不知道标题栏那排按钮能点）。
 *
 * 编排原则（不是把功能列表抄一遍）：
 * 1. **先说它不做什么**（只读 / 不独立干活 / 不猜），因为这是用户最担心的三件事；
 * 2. 再给三步上手：选 → 问 → 看，每步都带上真正要按的那个键或那颗按钮；
 * 3. 「依据分级」单独一节 —— 它是这个插件最容易被误解的机制，也是最值钱的那一点；
 * 4. 按钮表与键盘表：可查，不解释；
 * 5. 常见问答每条都带「问它一句」，把"读文档"直接变成"问它"。
 */
function tutorialNodes(ctx) {
    const rows = [];
    rows.push(el('header', { class: 'ea-tut-head' }, el('h2', { class: 'ea-tut-title', text: '解释小助手 · 使用教程' }), el('p', { class: 'ea-tut-lead', text: '它就站在主对话旁边：读主 agent 的记录，把「它正在干什么、为什么错、下一步建议」讲成人话。' })));
    rows.push(el('section', { class: 'ea-tut-sec' }, el('h3', { class: 'ea-tut-h', text: '先说三条边界' }), el('ul', { class: 'ea-tut-list' }, el('li', { text: '只读：不改主对话、不替你发消息、不执行任何命令。' }), el('li', { text: '不独立干活：它不会自己去查主机或跑测试，讲的是主对话里已经发生的事。' }), el('li', { text: '拿不准就说「信息不足」，不猜、不编。' }))));
    rows.push(el('section', { class: 'ea-tut-sec' }, el('h3', { class: 'ea-tut-h', text: '三步上手' }), el('ol', { class: 'ea-tut-steps' }, el('li', { class: 'ea-tut-step' }, el('strong', { text: '选一段内容（可选）' }), el('p', { text: '点右上角「选择主对话内容」，浮窗会让开；再点主对话里的步骤或工具卡片即可。想选多条就按住 Ctrl（Mac 是 ⌘）再点。Esc 或「完成」结束选择。' })), el('li', { class: 'ea-tut-step' }, el('strong', { text: '提问' }), el('p', { text: '在下面的输入框里问，或者点快捷问题。Enter 发送，Shift+Enter 换行。' })), el('li', { class: 'ea-tut-step' }, el('strong', { text: '看回答里的依据' }), el('p', { text: '每条结论后面都标着它凭什么这么说 —— 见下一节。' })))));
    rows.push(el('section', { class: 'ea-tut-sec' }, el('h3', { class: 'ea-tut-h', text: '「依据分级」是什么' }), el('ul', { class: 'ea-tut-tiers' }, el('li', {}, el('span', { class: 'ea-evidence-tier ea-tier-observed', text: '已观察到' }), el('span', { text: '真的跑出来的结果（工具输出、命令返回），有记录可查。' })), el('li', {}, el('span', { class: 'ea-evidence-tier ea-tier-reported', text: '仅据汇报' }), el('span', { text: '只是主 agent 自己说它做了什么，还没看到实际结果。' })), el('li', {}, el('span', { class: 'ea-evidence-tier ea-tier-unavailable', text: '信息不足' }), el('span', { text: '记录里没有能判定的内容 —— 这时它会直说，而不是编一个。' }))), el('p', { class: 'ea-tut-note', text: '为什么必须分三级：主 agent 说「已完成」和「真的跑完了」是两件事。前者只是它的话。' })));
    rows.push(el('section', { class: 'ea-tut-sec' }, el('h3', { class: 'ea-tut-h', text: '标题栏那几颗按钮' }), el('dl', { class: 'ea-tut-keys' }, el('dt', { text: '模型' }), el('dd', { text: '现在是哪个模型，点开可以换一个（只影响小助手自己）。' }), el('dt', { text: '选择主对话内容' }), el('dd', { text: '进出选择模式；选中的内容会钉在输入框上方，问完自动清掉。' }), el('dt', { text: '/compact' }), el('dd', { text: '把「小助手自己的上下文」压成一份摘要，省上下文；不影响主对话，摘要默认折叠。' }), el('dt', { text: '?' }), el('dd', { text: '就是这一页。' }), el('dt', { text: '×' }), el('dd', { text: '关闭（Esc）。关掉不丢记录，下次打开还在。' }))));
    rows.push(el('section', { class: 'ea-tut-sec' }, el('h3', { class: 'ea-tut-h', text: '键盘' }), el('dl', { class: 'ea-tut-keys' }, el('dt', {}, el('kbd', { text: 'Enter' })), el('dd', { text: '发送' }), el('dt', {}, el('kbd', { text: 'Shift' }), el('span', { text: ' + ' }), el('kbd', { text: 'Enter' })), el('dd', { text: '换行' }), el('dt', {}, el('kbd', { text: 'Esc' })), el('dd', { text: '退出选择模式 / 关闭浮窗' }), el('dt', {}, el('kbd', { text: 'Ctrl' }), el('span', { text: ' / ' }), el('kbd', { text: '⌘' }), el('span', { text: ' + 点击' })), el('dd', { text: '多选内容' }), el('dt', { text: '方向键' }), el('dd', { text: '标题栏获得焦点时移动窗口' }), el('dt', { text: '拖边 / 拖角' }), el('dd', { text: '像普通窗口一样改大小' }))));
    rows.push(el('section', { class: 'ea-tut-sec' }, el('h3', { class: 'ea-tut-h', text: '上下文与占用' }), el('div', { class: 'ea-tut-two' }, el('div', {}, el('strong', { text: '会被算进上下文的' }), el('ul', { class: 'ea-tut-list' }, el('li', { text: '主 agent 最近这一段的过程（超长会被截断）' }), el('li', { text: '你和小助手的问答' }), el('li', { text: '你选中的那几条内容' }))), el('div', {}, el('strong', { text: '不进上下文的' }), el('ul', { class: 'ea-tut-list' }, el('li', { text: '主对话的全部历史' }), el('li', { text: '小助手的旧记录（除非你自己翻出来问）' }), el('li', { text: '它读不到的文件' })))), el('p', { class: 'ea-tut-note', text: '输入框左边那个圆环是当前占用；标着「估算」表示是推算值。鼠标移上去可以看到两块各占多少。' })));
    const faq = [
        ['它说「信息不足」是什么意思？', '记录里没有能判定这件事的内容。这时它不会猜 —— 你可以先选中相关的那一步，再问一次。'],
        ['会不会动我的文件或命令？', '不会。它只读主对话的记录；工具和命令都是主 agent 在跑。'],
        ['会不会花我很多 token？', '每一问都会带上一段上下文，圆环显示当前占用。觉得太高就按 /compact 压成一份摘要。'],
        ['关掉浮窗后记录还在吗？', '在。记录按会话保存，重新打开还是那些内容；会话归档后会被清掉。'],
    ];
    rows.push(el('section', { class: 'ea-tut-sec' }, el('h3', { class: 'ea-tut-h', text: '常见问题' }), el('div', { class: 'ea-tut-faq' }, ...faq.map(([question, answer]) => el('details', { class: 'ea-tut-q' }, el('summary', { text: question }), el('p', { class: 'ea-tut-a', text: answer }), button('问它一句', '把这个问题发给小助手', () => {
        if (!canSubmit(ctx.state))
            return;
        closeTutorial(ctx, { focus: false });
        void ctx.plugin.submit(question);
    }, { class: 'ea-btn ea-btn-soft ea-tut-ask' }))))));
    rows.push(el('footer', { class: 'ea-tut-foot' }, el('small', { class: 'ea-meta', text: '解释小助手 v0.3.0 · 只读 · 记录留在本机' }), button('回到对话', '关闭教程，回到对话', () => closeTutorial(ctx), { class: 'ea-btn ea-btn-soft' })));
    return rows;
}
function buildTutorialPanel(getCtx) {
    const body = el('div', { class: 'ea-tut-body' });
    const back = button('返回对话', '关闭使用教程', () => { const ctx = getCtx(); if (ctx)
        closeTutorial(ctx); }, { class: 'ea-btn ea-btn-soft ea-tut-back' });
    const root = el('section', { class: 'ea-page ea-tutorial-panel', 'aria-label': '使用教程', tabindex: '-1' }, el('header', { class: 'ea-tut-bar' }, el('span', { class: 'ea-tut-bar-title', text: '使用教程' }), back), body);
    return { root, body, back };
}
function ensureTutorialPanel(ctx) {
    if (!ctx.tutorialPanel) {
        ctx.tutorialPanel = buildTutorialPanel(() => ctx);
        ctx.tutorialSlot.appendChild(ctx.tutorialPanel.root);
    }
    return ctx.tutorialPanel;
}
function renderTutorial(ctx) {
    const panel = ensureTutorialPanel(ctx);
    fill(panel.body, tutorialNodes(ctx));
}
function openTutorial(ctx) {
    // 与 openModelPanel 对称：模型页开着时点教程，先把模型页收掉。
    if (ctx.modelOpen)
        closeModelPanel(ctx, { focus: false, animate: false });
    ctx.tutorialCloseToken++;
    const panel = ensureTutorialPanel(ctx);
    if (panel.root.hasAttribute('data-closing')) {
        panel.root.removeAttribute('data-closing');
        panel.root.removeAttribute('aria-hidden');
    }
    ctx.tutorialOpen = true;
    ctx.tutorialBtn.setAttribute('aria-expanded', 'true');
    // 与模型页同一套"翻页"语义：data-view 一改，CSS 负责两页互相推拉。
    ctx.root.removeAttribute('data-returning');
    ctx.root.setAttribute('data-view', 'tutorial');
    renderTutorial(ctx);
    queueMicrotask(() => { try {
        panel.back.focus({ preventScroll: true });
    }
    catch { /* 老浏览器没有参数 */ } });
}
function closeTutorial(ctx, options = {}) {
    const wasOpen = ctx.tutorialOpen;
    ctx.tutorialOpen = false;
    ctx.tutorialBtn.setAttribute('aria-expanded', 'false');
    ctx.root.setAttribute('data-view', ctx.modelOpen ? 'model' : 'chat');
    const panel = ctx.tutorialPanel;
    if (wasOpen && panel && !prefersReducedMotion()) {
        panel.root.setAttribute('data-closing', 'true');
        panel.root.setAttribute('aria-hidden', 'true');
        const token = ++ctx.tutorialCloseToken;
        setTimeout(() => {
            if (ctx.tutorialCloseToken !== token || ctx.tutorialPanel !== panel)
                return;
            fill(ctx.tutorialSlot, []);
            ctx.tutorialPanel = undefined;
        }, MODEL_EXIT_MS);
    }
    else {
        fill(ctx.tutorialSlot, []);
        ctx.tutorialPanel = undefined;
    }
    if (wasOpen)
        ctx.root.setAttribute('data-returning', 'true');
    if (wasOpen && options.focus !== false) {
        try {
            ctx.tutorialBtn.focus({ preventScroll: true });
        }
        catch { /* 老浏览器没有参数 */ }
    }
}
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
/**
 * 中文类型名。
 *
 * 宿主给的是英文标识：助手汇报是 `assistant-step`，工具卡片给的是工具名（bash / read / write…）。
 * 上一版把这些原样印在「正在围绕这条内容提问：」后面 —— 用户看到的是 `assistant-step`，
 * 既不是内容、也不是人话。这里做一次翻译，翻不出来的才退回原名。
 */
function evidenceLabel(item) {
    const title = (item.title || '').trim();
    if (!title)
        return '正文片段';
    if (title === 'assistant-step')
        return '助手汇报';
    if (title === 'turn-tail')
        return '本轮汇报';
    if (title === 'turn-process')
        return '处理过程';
    if (title === 'tool-call')
        return '工具调用';
    if (title === 'user' || title === 'input-message' || title === 'request-prompt')
        return '你的提问';
    return '工具 · ' + title;
}
/** 一行摘录：压掉换行与多余空白，截到能塞进标签的长度。 */
function evidenceSnippet(item, max = 28) {
    const text = String(item.summary || '').replace(/\s+/g, ' ').trim();
    if (!text)
        return '（没有可见摘要）';
    return text.length > max ? text.slice(0, max) + '…' : text;
}
/** 选择的身份按**锚点**算（pickId），没有锚点才退回 id —— 与 selection.ts 的 ensurePickId 同源。 */
function pickKeyOf(item) { return String(item.pickId || item.id || ''); }
function pickChipsOf(state) {
    return state.evidence
        .filter(item => item && (item.title || item.summary))
        .map(item => ({ key: pickKeyOf(item), item, label: evidenceLabel(item), snippet: evidenceSnippet(item), tier: evidenceTierOf(item) }));
}
/**
 * 从选择里移除一条。按锚点删，不按 id：工具卡片没有会话键，id 会退化成工具名。
 */
function removePick(ctx, item) {
    const key = pickKeyOf(item);
    ctx.plugin.registry.update(ctx.state.sessionId, current => {
        current.evidence = current.evidence.filter(existing => pickKeyOf(existing) !== key);
    });
}
/**
 * 输入框上方那一行：每条选择一个可拆掉的标签。没有选择时整行收起。
 *
 * 退场摘节点的时刻必须**晚于** CSS 的 --ea-pick-out-dur（140ms）。取同一个数值时，
 * 定时器和动画的最后一帧在赛跑：慢放实测过，节点会在淡出只播到一半时被摘掉，
 * 用户看到的是「闪一下没了」。留 40ms 余量，等它真的淡完再收。
 */
const PICK_CHIP_EXIT_MS = 180;
const chipEntries = new WeakMap();
/**
 * 重画「这一问围绕哪几条」。
 *
 * 为什么不是每次重建节点：取消一条、回答落地后自动清空都会让某条消失，
 * 直接换掉 DOM 就是「啪」一下没了 —— 上一轮页面切换被批评的正是这种瞬间消失。
 * 所以这里按锚点复用节点：新来的建节点（播入场动画），要走掉的先挂 data-leaving
 * 播 140ms 再摘，留下来的原地更新文案、不重播动画。
 */
/**
 * 选择模式浮动条上的「已选 N 条」。
 *
 * 只改文字，不换节点：进模式时键盘焦点就落在「完成」这颗按钮上，
 * 每次状态变化都重建整条浮动条，等于把用户的焦点一次次弄丢。
 */
function syncSelectBar(ctx, state) {
    const text = '已选 ' + state.evidence.length + ' 条';
    if (ctx.selectBarCount.textContent !== text)
        ctx.selectBarCount.textContent = text;
    // 「完成」永远可点：它是唯一一个「不管现在选中了什么都能退出」的出口，
    // 一条都没选时也必须在（禁用等于把用户关在模式里）。
}
function renderPickRow(ctx) {
    const row = ctx.targetBar;
    const chips = pickChipsOf(ctx.state);
    let live = chipEntries.get(row);
    if (!live) {
        live = new Map();
        chipEntries.set(row, live);
    }
    const map = live;
    const wanted = new Set(chips.map(chip => chip.key));
    for (const [key, entry] of Array.from(map)) {
        if (wanted.has(key) || entry.timer)
            continue;
        if (prefersReducedMotion()) {
            entry.node.remove();
            map.delete(key);
            continue;
        }
        entry.node.setAttribute('data-leaving', 'true');
        entry.timer = setTimeout(() => {
            entry.node.remove();
            map.delete(key);
            // 最后一条也走完了：把这一行（含「这一问围绕」的引子）整体收掉。
            if (!map.size) {
                row.replaceChildren();
                row.setAttribute('data-has-target', 'false');
            }
        }, PICK_CHIP_EXIT_MS);
    }
    // 引子只建一次，且只在这一行真有内容时存在：空行里留一句「这一问围绕」会在
    // 收起前的一瞬被读到（也污染「没有选择时不留空条」那条断言）。
    if (chips.length && !row.querySelector('.ea-pick-lead')) {
        row.appendChild(el('span', { class: 'ea-pick-lead', text: '这一问围绕' }));
    }
    chips.forEach((chip, index) => {
        let entry = map.get(chip.key);
        if (!entry) {
            const indexEl = el('span', { class: 'ea-pick-index' });
            const labelEl = el('span', { class: 'ea-pick-label' });
            const snippetEl = el('span', { class: 'ea-pick-snippet' });
            const node = el('span', { class: 'ea-pick-chip' }, indexEl, labelEl, snippetEl, button('×', '取消这条选择', () => removePick(ctx, chip.item), { class: 'ea-pick-remove' }));
            entry = { node, index: indexEl, label: labelEl, snippet: snippetEl };
            map.set(chip.key, entry);
            row.appendChild(node);
        }
        else if (entry.timer) {
            // 一边退场一边又被选回来：取消摘除，直接复用它。
            clearTimeout(entry.timer);
            entry.timer = undefined;
            entry.node.removeAttribute('data-leaving');
        }
        entry.node.setAttribute('data-tier', chip.tier.key);
        entry.node.setAttribute('title', chip.label + '：' + chip.snippet + '\n' + chip.tier.label + ' · ' + chip.tier.hint);
        entry.index.textContent = String(index + 1);
        entry.label.textContent = chip.label;
        entry.snippet.textContent = chip.snippet;
    });
    // 顺序不做「每次重排」的写法：新标签永远追加在末尾，删除不改动别人的相对次序，
    // 于是顺序天然就是状态的顺序。反过来，每帧都 appendChild 一遍在真实 DOM 里会
    // 打断正在播的动画（节点被移动 = 动画重启），在假 DOM 里则会直接复制出一串重复节点。
    const leaving = Array.from(map.values()).some(entry => entry.timer);
    row.setAttribute('data-has-target', chips.length || leaving ? 'true' : 'false');
    if (!chips.length && !leaving) {
        row.replaceChildren();
        map.clear();
    }
}
/** 切到加载页/失败页时把这一行整体收掉：那是换会话级别的重置，不播逐条退场。 */
function resetPickRow(ctx) {
    const map = chipEntries.get(ctx.targetBar);
    if (map) {
        for (const entry of map.values())
            if (entry.timer)
                clearTimeout(entry.timer);
        map.clear();
    }
    ctx.targetBar.replaceChildren();
    ctx.targetBar.removeAttribute('data-has-target');
}
/**
 * §5.2 已选择的依据（明细）。
 *
 * 上一版这是一张**常驻大卡**：4000 字原文、来源、时间全铺在正文里，把答案顶出可视区。
 * 现在默认收起 —— 输入框上方那排标签已经回答了「选了哪几条」，想核对原文再展开。
 * 分级（§6.3）仍然逐条显示，只是不再抢正文的位置。
 */
function evidenceNodes(state, plugin) {
    if (!state.evidence.length)
        return [];
    const rows = state.evidence.map((item) => {
        const tier = evidenceTierOf(item);
        return el('article', { class: 'dsh-explain-assistant-evidence-row ea-evidence-row' }, el('div', { class: 'ea-row-head' }, el('strong', { class: 'ea-evidence-title', text: evidenceLabel(item) }), el('span', { class: 'ea-evidence-tier ea-tier-' + tier.key, text: tier.label, title: tier.hint }), button('移除', '移除这条依据', () => plugin.registry.update(state.sessionId, current => { current.evidence = current.evidence.filter(existing => existing.id !== item.id); }), { class: 'ea-btn ea-btn-quiet' })), el('small', { class: 'ea-meta', text: [item.source, item.capturedAt ? new Date(item.capturedAt).toLocaleTimeString('zh-CN') : ''].filter(Boolean).join(' · ') }), el('p', { class: 'ea-evidence-summary', text: item.summary || '没有可见摘要' }), el('small', { class: 'ea-evidence-tier-hint', text: tier.hint }));
    });
    return [el('details', { class: 'dsh-explain-assistant-evidence ea-card ea-evidence-details' }, el('summary', { class: 'ea-evidence-fold' }, el('span', { class: 'ea-card-title', text: '已选依据' }), el('span', { class: 'ea-count ea-count-inline', text: String(state.evidence.length) }), el('small', { class: 'ea-evidence-fold-hint', text: '展开看原文与分级' })), ...rows)];
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
/**
 * 历史回答超过这个字数就折叠。
 *
 * 为什么是 420：13px 正文在默认 420 宽的浮窗里一行大约 34～36 个汉字，
 * 10 行就是 340～360 字。取 420 是为了「折叠的一定真的超过一屏」——
 * 早先按 240 字折叠，实测被折的那条只有 156px 高（7 行），
 * 「展开全文」点下去什么都没变，等于一个假按钮。
 */
const TURN_FOLD_CHARS = 420;
function recordAnswerText(record) {
    const value = record;
    const text = typeof value?.answerText === 'string' && value.answerText ? value.answerText : value?.answer;
    return typeof text === 'string' ? text : '';
}
function recordReasoningText(record) {
    const value = record;
    const text = typeof value?.reasoningText === 'string' && value.reasoningText ? value.reasoningText : value?.reasoning;
    return typeof text === 'string' ? text : '';
}
function recordIdOf(record) {
    const value = record?.id;
    return typeof value === 'string' ? value : '';
}
/** 一条历史记录画成对话里的一轮：问句在右（气泡），回答在左（正文）。 */
function historyTurnNodes(input, ctx, newestId) {
    // 记录有两个来源、两套字段名，必须都认：
    //   · 宿主落库（routes.ts 写的）：answerText / reasoningText / startedAt；
    //   · 客户端本地刚追加的：answer / createdAt。
    const record = (input || {});
    const id = recordIdOf(record);
    const question = String(record.question || '');
    const answer = recordAnswerText(record);
    const reasoning = recordReasoningText(record);
    const at = record.startedAt ?? record.createdAt;
    const status = String(record.status || '');
    const incomplete = record.incomplete === true || status === 'interrupted' || status === 'error' || record.complete === false;
    const reasonText = recordReasonText(record.reason);
    const warnText = incomplete ? (reasonText ? RECORD_REASON_PREFIX + reasonText : RECORD_INCOMPLETE_TEXT) : '';
    const expanded = ctx.expandedIds.has(id);
    const longEnough = answer.length > TURN_FOLD_CHARS;
    // 最新一轮永远完整展开：那是用户刚问的那一条，不该还要再点一下才看全。
    const folded = Boolean(answer) && longEnough && !expanded && id !== newestId;
    const nodes = [];
    if (question)
        nodes.push(el('div', { class: 'ea-turn-q', text: question }));
    const time = timeText(at);
    if (time)
        nodes.push(el('div', { class: 'ea-turn-meta', text: time }));
    if (answer) {
        // 正文渲染走缓存：updateOverlay 会反复重画，没有缓存就等于每次把所有历史重新解析一遍。
        // 缓存键必须稳定：有 id 用 id，没有 id 用正文指纹（不能用位置索引 —— 分页会漂移）。
        const key = id || 'turn#' + contentKey(question + '\u0000' + answer);
        nodes.push(el('div', {
            class: 'ea-turn-a ea-md-scope',
            'data-folded': folded ? 'true' : 'false',
        }, ...cachedMarkdownNodes(key, answer)));
    }
    if (reasoning) {
        nodes.push(el('details', { class: 'ea-turn-reason ea-disclosure' }, el('summary', {}, '推理过程'), el('div', { class: 'ea-disclosure-body ea-md-scope' }, ...cachedMarkdownNodes(id || 'turn-reasoning#' + contentKey(reasoning), reasoning))));
    }
    /**
     * 工具过程必须**持久显示**（用户 2026-10-31：「工具调用要持久显示，不删去」）。
     *
     * 旧行为：工具只在"当前这一问"的活体块里画（currentDetailNodes）。回答一落地，
     * 活体块收起、历史这一轮只画问答正文 —— 那几轮工具调用就凭空消失了，
     * 用户看到的是「生成完后工具步骤被删掉，内容突然上移一截」。
     *
     * 现在按记录里落库的 tools 原样补进历史：默认折叠成一行，不占版面，也不丢。
     */
    const tools = Array.isArray(record.tools) ? record.tools : [];
    if (tools.length) {
        const failedCount = tools.filter(tool => tool?.status === 'error').length;
        nodes.push(el('details', { class: 'ea-turn-tools ea-disclosure' }, el('summary', {}, '工具过程 · ' + tools.length + ' 步' + (failedCount ? '（' + failedCount + ' 个失败）' : '')), el('div', { class: 'ea-disclosure-body ea-tool-list' }, ...tools.map(tool => {
            const status = tool?.status === 'running' ? '进行中' : tool?.status === 'error' ? '失败' : '完成';
            const name = String(tool?.label || tool?.name || '工具');
            const detail = typeof tool?.detail === 'string' ? tool.detail : '';
            return el('div', { class: 'ea-tool-row', 'data-status': tool?.status === 'error' ? 'error' : 'ok' }, el('span', { class: 'ea-tool-row-name', text: name }), el('span', { class: 'ea-tool-row-status', text: status }), detail ? el('p', { class: 'ea-tool-detail', text: detail }) : null);
        }))));
    }
    const foot = [];
    /*
     * 「展开全文 / 收起」：**就地**切换 + 补间，不重画整段历史。
     *
     * 为什么不重画：重画会把这一轮的节点整块换掉（顺带重排其它轮、重挂 Markdown 克隆），
     * 实测点击到画出第一帧要 100ms 以上 —— 动画还没开始，用户先看到一次卡顿；
     * 而且节点一换，浏览器就没法给同一个元素补间了，只能一帧跳到终态。
     * 就地切换之后：同一个元素、同一帧开始、滚动锚点也不丢。
     * 补不了间的情况（测试里的假 DOM / 不支持 WAAPI / 用户要减少动效）退回重画，落到终态。
     */
    const toggleFold = () => {
        const turn = findHistoryTurn(ctx, id);
        const answer = turn ? turn.querySelector('.ea-turn-a') : null;
        const toggle = turn ? turn.querySelector('.ea-turn-more') : null;
        // 方向以**画面上那一轮**为准，不看闭包里的旧值：就地切换之后按钮不重建，
        // 写死 true/false 会让「收起」继续走展开分支（点第二下没反应）。
        const expand = Boolean(answer && answer.getAttribute('data-folded') === 'true');
        if (expand)
            ctx.expandedIds.add(id);
        else
            ctx.expandedIds.delete(id);
        if (!answer || !toggle || typeof answer.animate !== 'function' || prefersReducedMotion()) {
            ctx.rerender();
            return;
        }
        // 就地切换不会重画历史：把缓存签名同步成「切换后」的样子，
        // 否则下一次流式更新会重挂整段历史、把动画打断（见 historySignature 的说明）。
        if (ctx.lastWin)
            ctx.historySig = historySignature(ctx, ctx.state, ctx.lastWin);
        animateFold(answer, toggle, expand, () => { scheduleFoldCheck(ctx); });
    };
    // aria-expanded：读屏用户也要知道这一块现在是收起还是展开（键盘/读屏下没有「看到高度变了」这回事）。
    if (folded)
        foot.push(button('展开全文', '展开这条回答的全文', () => { toggleFold(); }, { class: 'ea-turn-more', expanded: false }));
    else if (expanded && longEnough)
        foot.push(button('收起', '收起这条回答', () => { toggleFold(); }, { class: 'ea-turn-more', expanded: true }));
    // 只有确实还有材料可看时才给入口；面板已经开着时更不再重复挂一个（内容就在下面）。
    const hasMaterial = recordMaterialCount(record) > 0;
    if (id && hasMaterial && ctx.state.historyDetail?.recordId !== id) {
        foot.push(button('查看完整内容', '查看这条记录的依据与工具过程', () => { void ctx.plugin.openHistoryDetail?.(id); }, { class: 'ea-turn-detail' }));
    }
    if (warnText)
        foot.push(el('span', { class: 'ea-warn ea-turn-warn', text: warnText }));
    if (foot.length)
        nodes.push(el('div', { class: 'ea-turn-foot' }, ...foot));
    return nodes;
}
/**
 * 把「完整内容」面板摆进视野 —— 面板就挂在被点的那一行下面，所以**不是**把正文滚回顶部。
 *
 * 用户 2026-10-25 的原话：「完整内容并没有按直觉在红框下方展示剩余完整内容，
 * 而是弹到了上下文的最上方」。位置已经改到那一轮下面（见 historyNodes），
 * 这里只负责「刚好能看见」，不做多余跳动：
 *   · 已经整块看得见 → 一个字节都不动；
 *   · 只差底部 → 往下补到刚好露出底边，但别把按钮行顶出视野；
 *   · 面板比正文区还高 → 把按钮行对齐到正文区顶部（视野里就是「按钮行 + 它下面这块记录」）。
 *
 * 返回 false 表示量不到布局（测试里的假 DOM）：调用方自己决定兜底动作。
 */
function placeDetailPanel(ctx) {
    const body = ctx.body;
    const turn = ctx.root.querySelector('.ea-turn[data-detail-open="true"]');
    const row = (turn && turn.querySelector('.ea-turn-foot')) || turn;
    const panel = (turn && turn.querySelector('.dsh-explain-assistant-detail')) || ctx.detailSlot.querySelector('.dsh-explain-assistant-detail');
    if (typeof body.getBoundingClientRect !== 'function' || !row || typeof row.getBoundingClientRect !== 'function' || !panel || typeof panel.getBoundingClientRect !== 'function')
        return false;
    const view = body.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const rect = panel.getBoundingClientRect();
    const margin = 14;
    const top = view.top + margin;
    const bottom = view.bottom - margin;
    // 已经整块在视野里（常见：最后一条、面板又短）：不动。
    if (rect.top >= top && rect.bottom <= bottom)
        return true;
    let delta;
    if (rect.height <= bottom - top) {
        delta = rect.bottom > bottom ? rect.bottom - bottom : rect.top - top;
        // 往下补的时候别把按钮行顶出视野（否则用户看不见自己点的是哪一条）。
        if (rowRect.top - delta < top)
            delta = rowRect.top - top;
    }
    else {
        delta = rowRect.top - top;
    }
    if (Math.abs(delta) >= 1)
        body.scrollTop += delta;
    return true;
}
/** 打开面板的那一刻就要定位；量不到布局时退回老行为（滚到顶部），至少保证面板在视野里。 */
function scrollDetailIntoView(ctx) {
    if (!placeDetailPanel(ctx))
        ctx.body.scrollTop = 0;
}
/** 顶部那颗「更早的 N 条」：补齐的方向只有一个 —— 往上。 */
function historyOlderNode(state, plugin, ctx, win) {
    const known = win.start; // 已经载入、但没挂在页面上的条数
    const askHost = known === 0 && state.hasEarlier;
    if (known === 0 && !askHost)
        return null;
    const loading = state.loadingEarlier === true;
    const label = loading ? '正在加载…' : known > 0 ? '更早的 ' + known + ' 条' : '加载更早的记录';
    return el('div', { class: 'ea-conv-older' }, button(label, '往前翻更早的历史', () => {
        if (loading)
            return;
        // 记住「第一条还看得见的那一轮」：补上去的内容会把阅读位置往下推，补完按它的位移还回来。
        const remember = () => {
            const body = ctx.body;
            if (typeof body.getBoundingClientRect !== 'function')
                return;
            const bodyTop = body.getBoundingClientRect().top;
            const turns = Array.from(ctx.historySlot.querySelectorAll('.ea-turn'));
            const first = turns.find(turn => {
                const rect = turn.getBoundingClientRect();
                return rect.bottom > bodyTop + 4;
            }) || turns[0];
            // 记 id 而不是元素：这次重画会把整段历史的节点换掉，旧元素已经不在文档里了
            //（按元素记的话，量不到位置，等于没锚定 —— 实测锚点从 y=725 掉到 y=4944）。
            const id = first?.getAttribute('data-record-id') || '';
            if (id)
                ctx.anchor = { id, top: first.getBoundingClientRect().top };
        };
        if (askHost) {
            // 本地已经没有更早的了：向宿主再要一页，拿到之后再补挂。
            void Promise.resolve(plugin.loadEarlier?.()).then(() => {
                ctx.pendingOlder = HISTORY_BATCH;
                remember();
                ctx.rerender();
            }).catch(() => undefined); // 取不到就更早的：保持现状，绝不把失败变成未处理拒绝
        }
        else {
            ctx.pendingOlder = HISTORY_BATCH;
            remember();
            ctx.rerender();
        }
    }, { class: 'ea-conv-older-btn', disabled: loading }));
}
/** 往上翻过之后，右下角出现「回到最近」——和 dsh 的回到最新是同一个东西。 */
function historyJumpNode(ctx) {
    // 按钮自己就是 sticky 元素（不要包一层 height:0 的壳：壳没有高度，sticky 不生效，
    // 实测按钮虽然存在却贴在内容末尾、滚出视野，用户根本看不到）。
    return button('↓', '回到最近的历史', () => {
        ctx.historyWindow = undefined;
        ctx.scrollToTail = true;
        ctx.rerender();
    }, { class: 'ea-conv-jump-btn', title: '回到最近' });
}
/**
 * §8 历史问答：对话式（问句右气泡 / 回答左正文），并且**一次只挂一小段**。
 *
 * 旧实现是「一叠卡片、全量挂载」：20 条实测 12,917px 高、552 个节点，
 * 每来一个流式分片都要整块重挂一次。现在按 dsh 的做法 —— 尾部窗口 + 顶部补页 + 上限。
 */
function historyNodes(state, plugin, ctx, win) {
    /**
     * 压缩那一行插在**它真正发生的位置**：第一条「晚于压缩时间」的记录之前
     * （判据见 compactBoundaryIndex；与宿主 carriedRecords 同一条时间线）。
     *
     * 这个槽位是**同一个 DOM 节点**被搬来搬去（不是每帧新建一个），
     * 所以插进去之后那一行的展开态、以及它周围用户的阅读位置都不会因重画而跳。
     */
    const compactAt = compactBoundaryIndex(state, win.items);
    const compactSlot = compactAt >= 0 ? ctx.compactSlot : null;
    if (!state.records.length) {
        // 一条记录都没有时也要给它位置：刚打开就压缩、或压缩后历史又被清理过。
        return [
            compactSlot,
            el('p', { class: 'dsh-explain-assistant-empty ea-empty', text: '还没有小助手历史' }),
        ];
    }
    const hasJump = win.end < win.total;
    const children = [
        el('div', { class: 'ea-conv-head' }, el('span', { class: 'ea-conv-title', text: '历史' }), el('span', { class: 'ea-conv-count', text: win.total + ' 条' })),
        historyOlderNode(state, plugin, ctx, win),
    ];
    // 只按问答记录判「最新一轮」：压缩日志不画成一轮，指向它会让"最新一条自动展开"落空。
    const newestId = recordIdOf(win.items[win.items.length - 1]);
    for (let index = 0; index < win.items.length; index++) {
        // 落在这一轮之前：压缩之后问的第一条，就排在压缩那一行的下面。
        if (index === compactAt)
            children.push(ctx.compactSlot);
        const record = win.items[index];
        const id = recordIdOf(record);
        const nodes = historyTurnNodes(record, ctx, newestId);
        /*
         * 「查看完整内容」就挂在这一轮**下面**（用户 2026-10-25 的原话：
         * 「完整内容并没有按直觉在红框下方展示剩余完整内容，而是弹到了上下文的最上方」）。
         * 旧实现把面板放在正文最前面（当时的理由是「放在下面用户会以为按钮没反应」），
         * 但那是「看不见」，不是「位置不对」——现在面板就长在按钮行下方，点完马上多出一块，
         * 并且打开时会把它滚进视野（见 scrollDetailIntoView），两个问题一起解决。
         */
        const detailOpen = Boolean(id) && state.historyDetail?.recordId === id;
        if (detailOpen) {
            ctx.detailInline = true;
            nodes.push(...historyDetailNodes(state, plugin, { inlineOfTurn: true }));
        }
        children.push(el('article', {
            class: 'ea-turn',
            'data-record-id': id || undefined,
            'data-detail-open': detailOpen ? 'true' : undefined,
            // 只有「刚落地的那一条」进场时动一下；后续重画不重播（由 ctx.enteredTurnId 控制）。
            'data-enter': ctx.pendingEnterId && ctx.pendingEnterId === id ? 'true' : undefined,
        }, ...nodes));
    }
    // 压缩之后还没有新记录（刚压完），或者时间戳缺失、退回「最后发生」：落在末尾。
    if (compactSlot && compactAt >= win.items.length)
        children.push(ctx.compactSlot);
    if (hasJump)
        children.push(historyJumpNode(ctx));
    return [el('section', { class: 'dsh-explain-assistant-history ea-conv' + (hasJump ? ' has-jump' : ''), 'aria-label': '历史问答' }, ...children)];
}
/**
 * 这条记录里有没有「对话区看不到的东西」：依据 / 工具过程 / 图片快照。
 *
 * 用户 2026-10-25 的原话：「明明已经显示完整内容的还有展开完整内容这个选项」
 * 「这个选项明显在大部分情况下用不着」。确实如此：记录本来就只有一段回答时，
 * 点开也只是把上面那段回答再抄一遍（实测那个会话 3 条记录的依据/工具/图片全是 0）。
 * 所以入口只在**确实还有材料可看**的时候才出现；纯问答记录上不再挂这个按钮。
 */
function recordMaterialCount(record) {
    const value = (record || {});
    const size = (item) => (Array.isArray(item) ? item.length : 0);
    return size(value.evidence) + size(value.tools) + size(value.images);
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
function historyDetailNodes(state, plugin, options = {}) {
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
    /**
     * 卡片 = 固定的标题行 + 自己滚的正文。
     *
     * 为什么要拆成两层：记录能很长（整段回答 + 依据 + 工具过程），旧实现整块按内容长，
     * 在不高的窗口里会一路长到输入框上沿、被那条边切断 —— 没有下边框、最后一行字贴着输入框，
     * 看起来就是界面坏了（用户 2026-10-25 的截图）。
     * 现在标题行（含「收起」）不随记录滚走，正文在卡片内部滚，卡片有一条完整的圆角下边框。
     */
    const detailCard = (all) => el('section', { class: 'dsh-explain-assistant-detail ea-card ea-detail' }, all[0], el('div', { class: 'ea-detail-scroll' }, ...all.slice(1)));
    if (detail.status === 'loading' && !evidence.length && !tools.length && !images.length) {
        rows.push(el('p', { class: 'ea-detail-status', role: 'status', text: '正在读取这条记录的完整内容…' }));
        return [detailCard(rows)];
    }
    if (detail.status === 'error') {
        // §10：失败要给明确中文原因，不能显示成「这条记录没有内容」。
        rows.push(el('p', { class: 'ea-detail-error ea-error', role: 'alert', text: detail.error || '这条记录的完整内容没有取到。' }));
        return [detailCard(rows)];
    }
    // 面板挂在那一轮下面时，问题与回答就在它上面几厘米处：再抄一遍就是用户说的「重复」，所以跳过。
    // （只有那一轮不在挂载窗口里、面板落到正文顶部时，才把问答带上当上下文。）
    if (record.question && !options.inlineOfTurn)
        rows.push(el('p', { class: 'ea-detail-question', text: '问题：' + String(record.question) }));
    const answer = typeof record.answerText === 'string' && record.answerText ? record.answerText : record.answer;
    // 同历史区：没有 recordId 时用正文指纹当键，避免两条不同记录撞同一键而互相顶掉正文。
    if (answer && !options.inlineOfTurn)
        rows.push(el('article', { class: 'ea-detail-answer ea-md-scope' }, ...cachedMarkdownNodes('detail-' + (detail.recordId || 'rec#' + contentKey(String(answer))), String(answer))));
    const reasoning = typeof record.reasoningText === 'string' && record.reasoningText ? record.reasoningText : record.reasoning;
    if (reasoning && !options.inlineOfTurn)
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
    if (!evidence.length && !tools.length && !images.length && (!answer || options.inlineOfTurn)) {
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
    return [detailCard(rows)];
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
/**
 * @param initialGeometry 重建前那个浮窗**实际显示在屏幕上的**几何。
 *
 *   为什么需要它（t8 的 F-A）：切会话时 entry.ts 会重建整棵浮窗 DOM，而新会话此刻
 *   还没有几何（它的 /state 还没回来）。不传这个值时 renderOverlay 只能退回
 *   window.ts 的默认值，用户就会看到浮窗**先跳回默认位置/大小、过一会再跳到该会话
 *   真实几何** —— 位置和大小都变。
 *
 *   传进来之后：加载页首帧几何 == 重建前的实际几何，从「浮窗可见」到「数据到位」
 *   全程零几何变化；只有目标会话的 /state 带回**不同的**存储几何时，才会在
 *   「内容到位那一刻」一次性归位（这是允许的，且不是「先跳默认值再跳回来」）。
 *
 *   没有已知位置时（第一次打开某个会话、且从未有过浮窗）不传 → 仍落默认值，
 *   这正是默认值唯一该服务的场景。
 */
export function renderOverlay(state, plugin, initialGeometry) {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : previouslyFocused;
    const like = plugin;
    const root = el('section', {
        class: 'dsh-explain-assistant-overlay ea-overlay',
        role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'dsh-explain-assistant-title',
    });
    root.tabIndex = -1;
    /**
     * 正文选区的动画高亮（见 page-selection.ts）。
     * 必须**先建**：它要插在 root 的第一个子节点上，靠 z-index:-1 待在内容之下。
     */
    mountPageSelection(root);
    const titlebar = el('header', { class: 'dsh-explain-assistant-titlebar ea-header', 'data-drag-handle': 'true', tabindex: '0', 'aria-label': '拖动解释小助手窗口；使用方向键移动' });
    const phase = el('span', { class: 'dsh-explain-assistant-status ea-phase', 'aria-live': 'polite' });
    const close = button('×', '关闭解释小助手', () => {
        // 优先走 plugin.close()：它除了关窗，还会把「已读」补落到宿主（见 createClientPlugin 的说明）。
        // 没有这个方法时（旧宿主 / 测试替身）退回单纯关窗，行为不退化。
        const current = contexts.get(root);
        if (current?.plugin.close)
            current.plugin.close();
        else
            current?.plugin.registry.close(state.sessionId);
        previouslyFocused?.focus();
        previouslyFocused = null;
    }, { class: 'dsh-explain-assistant-close ea-close', title: '关闭（Esc）' });
    // §5.2 / §11.4：选择模式必须能**退出**。
    // 旧实现只在进入时置 data-selection-mode，全库没有任何清除代码 →
    // 用户点过一次「选择主对话内容」之后，主对话里所有点击会被持续吞掉，再也点不动原卡片。
    // 现在：再点一次这个按钮就退出；选中一条依据后自动退出（见下方 evidence-selected 监听）。
    /**
     * 进出选择模式。
     *
     * 两件事必须同时发生，缺一件就是「看着像进了模式，其实没进」：
     * 1. 浮窗自己：data-selection-mode（浮窗让开）+ 按钮文案 + 顶部浮动条；
     * 2. 页面：documentElement 上的 data-ea-selecting —— 主对话里的卡片在悬停时
     *    才会出现虚线框与十字光标（用户得先知道「这里能点」），控制器也据此决定
     *    「这一下点击是选，还是只是普通点击」。
     *
     * ── 为什么这一版要「让开」──────────────────────────────────────
     * 用户原话：「进入选择模式后，解释小助手暂时不显示，方便用户选择」。
     * 旧版浮窗原地不动，而它常常正好压住用户要选的那一块：420×620 的一层玻璃盖在对话区上，
     * 要选的东西有一半在它后面 —— 只能先拖窗、再选、再把窗拖回来。
     * 现在进模式就让浮窗退到一边：不是 display:none（那会把焦点和 Esc 一起弄丢），
     * 而是透明度 + 缩放到不可见、并且 visibility:hidden 把它从 Tab 序列里摘出去。
     *
     * ── 退出比进来更重要 ─────────────────────────────────────────
     * 浮窗一让开，「退出选择模式」那颗按钮也就看不见了。所以出口有三条，且都必须真的通：
     *   · 顶部浮动条上的「完成」；
     *   · Esc —— 挂在 document 上，因为浮窗让开之后焦点多半在主对话里，root 上的监听收不到；
     *   · 关掉浮窗（含切会话 / 插件卸载）：dispose 时必须把模式一起清干净。
     * 任何一条漏掉，用户就掉进「所有点击都被吞掉、没有出路」的状态 —— 那是修过一次的老缺陷。
     */
    const leaveSelectionMode = () => {
        if (!root.hasAttribute('data-selection-mode'))
            return;
        root.removeAttribute('data-selection-mode');
        select.setAttribute('aria-pressed', 'false');
        select.textContent = '选择主对话内容';
        selectionStatus.textContent = '';
        document.removeEventListener('keydown', escapeWhileSelecting, true);
        document.documentElement?.removeAttribute('data-ea-selecting');
        selectBar.remove();
        // 焦点还回标题栏那颗按钮：此刻它又可见了。
        queueMicrotask(() => { try {
            select.focus({ preventScroll: true });
        }
        catch { /* 老浏览器没有参数 */ } });
        document.dispatchEvent(new CustomEvent('dsh-explain-assistant:select-exit', { detail: { sessionId: state.sessionId } }));
    };
    /** 选择模式下的 Esc：浮窗已经让开、焦点多半在主对话里，所以这条监听只能挂在 document 上。 */
    const escapeWhileSelecting = (event) => {
        if (event.key !== 'Escape' || !root.hasAttribute('data-selection-mode'))
            return;
        event.preventDefault();
        // 拦在这里：外层（浮窗自己的 Esc → 关窗）不得顺手把整扇窗关掉 —— 用户想退的是模式。
        event.stopPropagation();
        leaveSelectionMode();
    };
    const enterSelectionMode = () => {
        root.setAttribute('data-selection-mode', 'true');
        select.setAttribute('aria-pressed', 'true');
        select.textContent = '退出选择模式';
        selectionStatus.textContent = '';
        document.documentElement?.setAttribute('data-ea-selecting', 'true');
        document.addEventListener('keydown', escapeWhileSelecting, true);
        // 浮动条挂在 body 上：浮窗有 backdrop-filter（它会让浮窗成为 fixed 定位的包含块）
        // 且 overflow:hidden，挂在浮窗里面会被裁掉、还会跟着浮窗一起让开 —— 正好是要避免的。
        document.body?.appendChild(selectBar);
        // 浮窗让开之后焦点不能还留在里面的输入框上：那样用户在主对话里敲键盘是敲给空气的。
        const active = document.activeElement;
        if (active && typeof root.contains === 'function' && root.contains(active)) {
            try {
                active.blur();
            }
            catch { /* 没实现就算了 */ }
        }
        queueMicrotask(() => { try {
            selectBarDone.focus({ preventScroll: true });
        }
        catch { /* 同上 */ } });
        document.dispatchEvent(new CustomEvent('dsh-explain-assistant:select', { detail: { sessionId: state.sessionId } }));
    };
    const select = button('选择主对话内容', '选择主对话中的步骤或工具卡片', () => {
        if (root.hasAttribute('data-selection-mode'))
            leaveSelectionMode();
        else
            enterSelectionMode();
    }, { class: 'ea-btn ea-btn-soft', pressed: false });
    // Esc 的第二条路径：焦点恰好在浮窗里时（刚点过标题栏按钮就会这样），事件落在 root 上。
    root.addEventListener('keydown', event => { if (event.key === 'Escape' && root.hasAttribute('data-selection-mode'))
        leaveSelectionMode(); }, true);
    // 注意：这里**没有**「选中一条就自动退出」了。
    //
    // 旧版有这条，理由正当：选完就该回到提问，别继续吞点击。但用户这一轮要的是
    // 「Ctrl+左键可选择多个内容」—— 自动退出会让多选根本没法发生（第二条没机会被点）。
    // 代价是「卡在模式里」的风险变大，所以出口做成三条（完成 / Esc / dispose 兜底），
    // 并且三条都有测试钉着（tests/selection-multiselect.test.mjs）。
    /**
     * 教程入口做成一颗**图标**而不是文字按钮：标题栏这一行已经挤着
     * 「模型 / 选择主对话内容 / /compact / ×」，再加一个四字按钮，窗口一窄就开始压缩标题。
     * 图标只占 24px，而且「?」在软件里就是"帮助"的通用记号。
     */
    const tutorialBtn = button('?', '使用教程', () => {
        const current = contexts.get(root);
        if (!current)
            return;
        if (current.tutorialOpen)
            closeTutorial(current);
        else
            openTutorial(current);
    }, { class: 'ea-btn ea-btn-soft ea-tutorial-trigger', expanded: false });
    const compactBtn = button('/compact', '压缩小助手上下文', () => {
        const current = contexts.get(root);
        if (current && !isBusy(current.state))
            void current.plugin.submit('/compact');
    }, { class: 'ea-btn ea-btn-soft', title: '整理小助手自己的上下文；不影响主对话' });
    // 模型按钮放在标题栏按钮组的**最前面**（紧挨着「选择主对话内容」）：
    // 它原来占着正文最显眼的位置，现在只是这一行里的一个按钮，点开才进入选择页。
    const modelTrigger = buildModelTrigger(() => contexts.get(root));
    titlebar.append(el('strong', { id: 'dsh-explain-assistant-title', class: 'ea-title', text: '解释小助手' }), phase, el('div', { class: 'ea-header-actions' }, modelTrigger.root, select, compactBtn, tutorialBtn, close));
    const selectionStatus = el('span', { class: 'dsh-explain-assistant-selection-status ea-selection-status', role: 'status' });
    /**
     * 选择模式期间浮窗让开，但「现在在选、选了几条、怎么退出」必须一直看得见。
     *
     * 这条细浮动条就是那个出口，也是这一版唯一新增的可见元件：
     *   · 左边一个呼吸的点 = 模式还开着（静止的界面里，一个不动的小圆点很难被读成「正在等待你操作」）；
     *   · 中间写清「已选 N 条」与键盘/鼠标两种加法；
     *   · 右边「清空」和「完成」——「完成」是主按钮，因为它是用户 90% 会点的那个。
     * 它挂在 body 上（见 enterSelectionMode），所以既不会被浮窗的 overflow 裁掉，也不会跟着浮窗一起让开。
     */
    const selectBarCount = el('strong', { class: 'ea-select-bar-count', role: 'status', 'aria-live': 'polite', text: '已选 0 条' });
    const selectBarDone = button('完成', '结束选择，回到解释小助手', () => leaveSelectionMode(), { class: 'ea-btn ea-select-bar-done' });
    const selectBarClear = button('清空', '清空已选内容，继续选择', () => {
        const current = contexts.get(root);
        if (!current)
            return;
        current.plugin.registry.update(current.state.sessionId, state => { state.evidence = []; });
    }, { class: 'ea-btn ea-select-bar-clear' });
    const selectBar = el('div', { class: 'ea-select-bar', role: 'group', 'aria-label': '选择主对话内容' }, el('span', { class: 'ea-select-bar-dot', 'aria-hidden': 'true' }), selectBarCount, el('span', { class: 'ea-select-bar-hint', text: 'Ctrl+点击 可加选 · Esc 完成' }), selectBarClear, selectBarDone);
    const body = el('div', { class: 'dsh-explain-assistant-content ea-body' });
    /**
     * 用户自己滚动时更新「跟随」开关（见 OverlayContext.followPaused）。
     *
     * 只在**滚动事件**里判：程序自己把 scrollTop 设到底，落点永远满足"贴底"，
     * 所以这条监听不会把自动跟随自己关掉。24px 是容差 —— 缩放/高分屏下一两像素的
     * 误差不该被读成"用户滚上去了"。
     */
    body.addEventListener('scroll', () => {
        const current = contexts.get(root);
        if (!current)
            return;
        const node = current.body;
        const max = (node.scrollHeight ?? 0) - (node.clientHeight ?? 0);
        if (!(max > 0))
            return;
        // 程序自己写的 scrollTop 不算"用户滚动"：缓动跟随每帧都会触发一次 scroll 事件，
        // 不排除的话，跟随的第一帧就会把自己判成"用户往上滚了"，然后立刻停手（实测就是这个症状）。
        // 判据是**位置**不是时间窗：跟随循环每帧都写 scrollTop，时间窗永远不空，
        // 用户的上滚会被整段吞掉、followPaused 永远置不上（实机症状：上滚一帧后又被拽回底部）。
        if (current.programmaticTop !== undefined && Math.abs((node.scrollTop ?? 0) - current.programmaticTop) <= 2)
            return;
        // 用户自己动了滚动条：内部浮点位置作废，下次重新对齐到真实位置。
        current.followPos = undefined;
        if ((node.scrollTop ?? 0) >= max - FOLLOW_NEAR_BOTTOM) {
            current.followPaused = false;
            return;
        }
        // 只有"正在流式输出"时才把它当成"用户想看上面"：其它时候的滚动与跟随无关。
        if (isBusy(current.state) && current.state.text)
            current.followPaused = true;
    });
    const errorSlot = el('div', { class: 'ea-slot' });
    /**
     * 贴在这一问下面的错误条（与顶部的 errorSlot 分工）。
     *
     * 为什么需要第二个位置：正文顺序是「错误 → 引导 → 历史 → 当前这一问 → 依据」，
     * 而用户提问时眼睛在**底部**。一次提问失败，真正的原因（请求失败/超时）原先只出现在
     * 顶部那条里 —— 长历史时它在几十屏之上，用户看到的是底部一句笼统的「这一条没有跑完」。
     * 所以：**属于当前这一问**的错误走这个槽位（就在那一问下面），其余的仍走顶部。
     */
    const errorTailSlot = el('div', { class: 'ea-slot ea-error-tail-slot' });
    const currentSlot = el('div', { class: 'ea-slot' });
    // 正文的容器用 <article>：它是「小助手回答」这一块，读屏需要这个语义标签。
    // 增量渲染器只在这个容器**内部**增删尾部节点，容器本身不重建。
    const answerSlot = el('article', { class: 'dsh-explain-assistant-answer ea-answer', 'aria-label': '小助手回答' });
    const answerView = mountMarkdown(answerSlot);
    const heroSlot = el('div', { class: 'ea-slot' });
    const quickSlot = el('div', { class: 'ea-slot' });
    // 模型选择页：正文以外的「另一页」。它有一个常驻骨架（筛选框是有状态的），
    // 只在这里建一次，之后按需填列表（见 renderModelPanel）。
    const catalogNoteSlot = el('div', { class: 'ea-slot ea-catalog-note-slot' });
    const modelPanelSlot = el('div', { class: 'ea-slot ea-model-panel-slot' });
    /** 教程页的槽位：与模型页同一套「另一页」机制（见 data-view）。 */
    const tutorialSlot = el('div', { class: 'ea-slot ea-tutorial-panel-slot' });
    const evidenceSlot = el('div', { class: 'ea-slot' });
    /**
     * 压缩那一行的槽位。它**不挂在 body 上**：历史区渲染时把这个槽位**本身**插进对话流
     * 里「压缩发生的位置」（见 historyNodes）。槽位常驻（而不是每次重建一行）有两个理由：
     *   · 展开态与「用户正读到哪」在两次重画之间不必重新计算；
     *   · 历史区重画时只搬这个槽位，槽位里的那一行不会被连根拔掉。
     */
    const compactSlot = el('div', { class: 'ea-slot ea-compact-slot' });
    const historySlot = el('div', { class: 'ea-slot ea-conv-slot' });
    /**
     * 当前这一问：和历史是同一套对话样式（问句右气泡、回答左正文），位置在最下面、贴着输入框。
     *
     * 为什么它必须显示问句：旧界面上「正在回答的这一段」上面没有问句，
     * 用户滚下去之后分不清这段回答对应哪一个问题。
     *
     * 为什么它会被整体隐藏：回答落地后 appendRecord 会写 liveRecordId，
     * 同一条回答已经出现在历史里；若这块还留着，同一条内容就会在页面上出现两次。
     */
    const liveQuestion = el('div', { class: 'ea-turn-q ea-live-q' });
    const liveTurn = el('section', { class: 'ea-conv-live', 'aria-label': '当前这一问' });
    liveTurn.append(el('article', { class: 'ea-turn ea-turn-live' }, liveQuestion, currentSlot, answerSlot));
    // 展开面板放在最前面：用户点的是「查看完整内容」，结果必须在打开的那一刻就被看见，
    // 否则在长长的历史列表里点完之后什么都不会变化（内容其实在下面，用户以为按钮坏了）。
    const detailSlot = el('div', { class: 'ea-slot' });
    // 加载页与「状态没读到」的错误页各占一个槽位，且**排在所有内容区块之前**：
    // 未就绪/失败时它们是唯一有内容的东西，用户第一眼看到的就是它（不是空态列表）。
    const loadingSlot = el('div', { class: 'ea-slot ea-loading-slot' });
    const stateErrorSlot = el('div', { class: 'ea-slot ea-state-error-slot' });
    // 顺序即阅读顺序：错误 → 引导 → 历史 → 当前这一问 → 依据（贴着输入框）。
    //
    // **压缩那一行不在这个列表里**：它跟着对话走，由历史区插到它真正发生的位置
    //（见 historyNodes / compactBoundaryIndex）。早先把它钉在 historySlot 之后，
    // 结果是「不论压缩发生在哪一刻，它都躺在对话最下方」——用户原话：
    //「上下文压缩的提示总是在上下文最下方，而非在它本应在的位置」。
    body.append(stateErrorSlot, loadingSlot, catalogNoteSlot, detailSlot, errorSlot, heroSlot, quickSlot, historySlot, liveTurn, errorTailSlot, evidenceSlot, selectionStatus);
    const input = el('textarea', { class: 'ea-input', placeholder: '问小助手主 agent 正在做什么…', 'aria-label': '向解释小助手提问', rows: '2' });
    /**
     * 平滑光标 + 蓝色选区（移植自 More 设置向导 2026-10-25 版，见 text-field.ts）。
     * 只包一层 .ea-field「白底板」，输入框本身、上面的所有监听器、表单提交路径一概不动。
     * reduced-motion 下 mountTextField 自己会退回原生光标与选区。
     */
    const field = mountTextField(input);
    /**
     * 发送 / 停止是**同一颗按钮**（用户 2026-10-31 的决定：「点击按钮即可停止的设计不错」）。
     *
     * 忙的时候它不再是"描述状态"的标签（旧文案「处理中」），而是唯一能中止这次回答的出口：
     * 用户的手本来就停在这颗按钮上，原地换词比让他再去别处找一个「停止」更快。
     * 发送的闸门仍在 form 的 submit 监听里（加载 / 失败 / 忙 一律不许发），这里只负责分发。
     */
    const send = button(sendLabel(state, 'ready'), isBusy(state) ? '停止本次解释' : '发送问题', () => {
        const current = contexts.get(root);
        if (current && isBusy(current.state)) {
            current.plugin.cancel?.();
            return;
        }
        form.requestSubmit();
    }, { class: 'ea-btn ea-btn-primary ea-send' });
    send.setAttribute('data-stop', isBusy(state) ? 'true' : 'false');
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
    form.append(targetBar, field.root, el('div', { class: 'ea-composer-actions' }, ringSlot, send));
    /**
     * 改大小的入口：**像普通窗口一样拖边、拖角**。
     *
     * 用户对上一版（只有一个角落字符 ◢）的定性原话是
     * 「不是，意思是这个设计不符合操作直觉，不是说它看不到用不了」——
     * 他嫌的不是字号或颜色，而是「要去角落找一个符号」这件事不合他平时用窗口的经验。
     * 所以这里在四周各铺一条边、四个角各铺一个热区，方向与鼠标指针一致。
     * 角落那个 ◢ 符号后来按用户要求删掉了（2026-10-24：「这个元素现在已经没用了」）：
     * 角上已经是 24×24 的热区，指针形状本身就是告示，再画一个符号反而多余。
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
    // 首帧几何的优先级：本会话已知几何（/state 已回来）> 重建前的实际几何 > 默认值。
    // 中间那一档是本轮加的：它让「切会话」不再经过默认值。
    const geometry = clampGeometry(state.geometry ?? initialGeometry, window.innerWidth, window.innerHeight);
    root.style.left = geometry.x + 'px';
    root.style.top = geometry.y + 'px';
    root.style.width = geometry.width + 'px';
    root.style.height = geometry.height + 'px';
    // 中间层：正文 + 输入区 + 模型页槽。模型页绝对定位盖满它，
    // 于是「打开时输入区隐藏」造成的重排发生在遮挡物后面（看不见）。
    const main = el('div', { class: 'ea-main' });
    main.append(body, form, modelPanelSlot, tutorialSlot);
    root.append(titlebar, main, ...resizeZones.map(zone => zone.element));
    /**
     * 「查看完整内容」面板的高度上限要用「正文区有多高」来算（见 styles.css 的 .dsh-explain-assistant-detail）。
     *
     * 为什么不能在样式里直接写百分比：面板的父级是 .ea-slot，它的高度是 auto，
     * 百分比 max-height 落在 auto 高度上按 none 处理 —— 实测写 max-height:100% 一点都没生效，
     * 面板照样按内容长到 800 多像素，照样被输入框那条边切断。
     * 所以这里量一次正文区高度写进 --ea-body-h；窗口被拖动改大小、切会话都由 ResizeObserver 重算。
     */
    /**
     * 正文区高度 → CSS 变量（只给"完整内容"面板的 max-height 用）。
     *
     * 加一道"变化超过 4px 才写"的守卫：ResizeObserver 在流式期间会跟着内容高度频繁触发，
     * 每次都 setProperty 会让整棵浮窗做一次样式重算 —— 那也是"跟随不丝滑"的一部分来源。
     */
    let lastBodyHeight = 0;
    const measureBodyHeight = () => {
        const height = body.clientHeight;
        if (height > 0 && Math.abs(height - lastBodyHeight) > 4) {
            lastBodyHeight = height;
            root.style.setProperty('--ea-body-h', height + 'px');
        }
    };
    measureBodyHeight();
    // 测试环境的假 DOM 里没有 ResizeObserver（也不需要）：没有就只保留首帧量到的那一次。
    const bodyObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measureBodyHeight()) : undefined;
    bodyObserver?.observe(body);
    const ctx = {
        state, plugin: like, body, phase, selectionStatus, controller: undefined, appliedGeometry: undefined,
        // 见 updateOverlay：用来判断「后面来的几何值是不是新值」。
        // 不这样做的话，每次重画都会把用户刚拖好的位置按旧值拽回去。
        errorSlot, errorTailSlot, currentSlot, answerSlot, answerView, heroSlot, quickSlot, evidenceSlot, compactSlot, historySlot, detailSlot, ringSlot, targetBar, catalogNoteSlot, modelPanelSlot, modelTrigger,
        selectBar, selectBarCount, selectBarDone, compactBtn, tutorialBtn, tutorialSlot, tutorialOpen: false, tutorialCloseToken: 0,
        liveTurn, liveQuestion, expandedIds: new Set(), sessionId: state.sessionId,
        loadingSlot, stateErrorSlot, root,
        // 默认折叠模型列表：一开就摊开 33 个模型会把「使用说明 + 快捷问题」顶出可视区。
        // 未选模型时由摘要行 + 醒目的提示承担「先选一个」的引导（§7/§11.8）。
        form, input, field, send, modelOpen: false, modelQuery: '', modelCloseToken: 0,
        rerender: () => updateOverlay(root, ctx.state, ctx.plugin),
    };
    contexts.set(root, ctx);
    // 默认是对话页；选择页由 openModelPanel 切过去（见 data-view 的样式）。
    root.setAttribute('data-view', 'chat');
    input.value = state.draft;
    input.addEventListener('input', () => { const current = contexts.get(root); if (current)
        current.plugin.registry.update(current.state.sessionId, { draft: input.value }); });
    form.addEventListener('submit', event => {
        event.preventDefault();
        const current = contexts.get(root);
        if (!current)
            return;
        /*
         * 闸门必须是 canSubmit（= ready 且不忙），**不是** !isBusy。
         *
         * 旧写法只判 !isBusy，于是加载页上「不忙」→ 放行 → 真的发出 /ask（t8 的 F-B）。
         * 按钮 disabled 只是**视觉**上的挡板：requestSubmit() 与回车都能绕过它，
         * 所以拦截必须落在这一层。两条一起才对：按钮挡鼠标，这里挡一切。
         */
        if (!canSubmit(current.state))
            return;
        const question = input.value.trim();
        if (question)
            void current.plugin.submit(question);
    });
    /**
     * 输入框的回车语义：Enter 发送、Shift+Enter 换行。
     *
     * 为什么必须自己接管：输入框是 textarea，浏览器给的默认行为就是换行，
     * 而"发送"只挂在按钮上 —— 用户敲完一句话按回车，得到的是多一个空行，
     * 然后必须抬手去点那颗按钮。这是对话式界面里最不该缺的一条。
     *
     * 四条不能破的边界（少一条都会被当成"坏了"）：
     * 1. **输入法**：用拼音/五笔选词时那一下回车是"确认候选词"，发出去就是半句话。
     *    两个判据一起用 —— event.isComposing（Chrome/Safari/Firefox 都有）
     *    与 compositionstart/end 记下的状态（部分浏览器在 compositionend 之后才派发 keydown，
     *    那一帧 isComposing 已经是 false，只靠它仍会误发），再加 keyCode 229 兜旧内核。
     * 2. **发不出去时不拦**：读取中/处理中/加载失败时，回车应当照常换行。
     *    拦下来又发不出去，等于"按了没反应，而且还不让我换行"。
     * 3. **带修饰键不接管**：Shift 是换行；Ctrl/⌘/Alt+Enter 留给浏览器（有宿主用它做别的）。
     * 4. **走同一道闸**：不直接调 plugin.submit，而是 form.requestSubmit()，
     *    于是 loading/failed/busy 的拦截逻辑与点按钮完全同一条（见上面的注释）。
     */
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    // 焦点切走时清掉：compositionend 在某些浏览器里不会到达，
    // 留着 true 会让此后所有回车都变成换行（看起来像"回车发送坏了"，很难查）。
    input.addEventListener('blur', () => { composing = false; });
    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter')
            return;
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
            return;
        const legacyIme = event.keyCode === 229;
        if (composing || event.isComposing || legacyIme)
            return;
        const current = contexts.get(root);
        if (!current || !canSubmit(current.state) || !input.value.trim())
            return;
        event.preventDefault();
        form.requestSubmit();
    });
    updateOverlay(root, state, like);
    const focusable = () => {
        const inPanel = (element) => Boolean(element.closest('.ea-model-panel-slot'));
        const inTutorial = (element) => Boolean(element.closest('.ea-tutorial-panel-slot'));
        const live = contexts.get(root);
        const panelOpen = Boolean(live?.modelOpen);
        const tutorialOpen = Boolean(live?.tutorialOpen);
        return Array.from(root.querySelectorAll('button, textarea, input, select, summary, [tabindex]:not([tabindex="-1"])'))
            .filter(element => !element.hasAttribute('disabled') && element.tabIndex >= 0 && !element.hidden)
            // 选择页与对话页互斥显示，但 querySelectorAll 仍然取得到被 CSS 藏起来的那一半。
            // 不按当前页过滤，Tab 就会跳到看不见的按钮上。
            .filter(element => panelOpen ? inPanel(element) : !inPanel(element))
            // 教程页与对话页也是互斥的：不按当前页过滤，Tab 会跳到被 CSS 藏起来的那一半。
            .filter(element => tutorialOpen ? inTutorial(element) : !inTutorial(element));
    };
    const keydown = (event) => {
        if (event.key === 'Escape') {
            // 中文输入法组字时那一下 Esc 是「取消候选词」，不是「关窗」。
            // 输入区的 Enter 分支早就判了 isComposing，Esc 这里漏了同样的判据。
            const legacyIme = event.keyCode === 229;
            if (composing || event.isComposing || legacyIme)
                return;
            event.preventDefault();
            // 选择页开着时 Esc 先关选择页（用户想退出的是这一页），再按一次才关窗。
            const current = contexts.get(root);
            if (current?.tutorialOpen) {
                closeTutorial(current);
                return;
            }
            if (current?.modelOpen) {
                closeModelPanel(current);
                return;
            }
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
    root.addEventListener('dsh-explain-assistant:dispose', () => {
        // 关窗/卸载时把跟随循环停掉：它每帧都在读已脱离文档的节点，不停就是一条永久的 rAF 泄漏。
        stopFollowLoop(ctx);
        controller.dispose();
        answerView.dispose();
        bodyObserver?.disconnect();
        // 选择模式的三样残留必须一起清：少一样就是「关掉浮窗之后主对话里所有点击还是被吞」。
        document.removeEventListener('keydown', escapeWhileSelecting, true);
        document.documentElement?.removeAttribute('data-ea-selecting');
        selectBar.remove();
    }, { once: true });
    // preventScroll：默认的 focus() 会把浏览器滚动到输入框，于是首屏直接停在模型列表上、
    // 「使用说明 + 快捷问题」被顶到可视区外面——第一眼就看不到这窗口是干什么的。
    queueMicrotask(() => { (input || root).focus({ preventScroll: true }); body.scrollTop = 0; });
    return root;
}
/**
 * 折叠的兜底：字数判据说该折叠、但实际排版没被裁掉时，把「展开全文」收掉。
 *
 * 为什么要兜底：字数与行数不是一回事（浮窗宽度可拖、长英文单词会换行）。
 * 实测有一条 500 多字、排出来只有 204px 高（不到折叠线），
 * 按钮点下去什么都不会变 —— 那是个假按钮。
 *
 * 为什么放到下一帧：刚填进 DOM 的节点还没排版，量到的 clientHeight/scrollHeight 都是 0，
 * 当场判断会把所有折叠都误判成「没裁掉」。
 */
function scheduleFoldCheck(ctx) {
    const run = () => {
        const slot = ctx.historySlot;
        if (typeof slot.querySelectorAll !== 'function')
            return;
        const nodes = Array.from(slot.querySelectorAll('.ea-turn-a'));
        for (const node of nodes) {
            if (node.getAttribute('data-folded') !== 'true')
                continue;
            const client = node.clientHeight;
            const scroll = node.scrollHeight;
            if (typeof client !== 'number' || typeof scroll !== 'number' || !client)
                continue;
            if (scroll <= client + 2) {
                node.setAttribute('data-folded', 'false');
                const turn = node.closest?.('.ea-turn');
                const more = turn?.querySelector?.('.ea-turn-more');
                if (more)
                    more.hidden = true;
            }
        }
    };
    if (typeof requestAnimationFrame === 'function')
        requestAnimationFrame(run);
    else
        setTimeout(run, 0);
}
/**
 * 历史区的渲染编排：算窗口 → 没变化就跳过 → 重画 → 只有「刚落地的一条」播进场。
 *
 * 跳过重画的理由不只是省事：updateOverlay 在流式期间每个分片都跑一次，
 * 而历史区可能挂着十几轮 Markdown。签名里只放**会改变画面**的东西（窗口、条数、展开态、
 * 每条的状态与长度），这样流式回答时历史区一次都不会被重挂，
 * 顺带也避免了「每次重画都重播进场动画」。
 */
/**
 * 「完整内容」面板的签名。
 *
 * 面板现在挂在历史的那一轮下面，就跟着 renderHistory 的缓存走；如果签名里只有 recordId，
 * 正文取回来时（同一个 recordId，只是 status 从 loading 变 ready）签名不变 → 不重画 →
 * 面板会永远停在「正在读取这条记录的完整内容…」（实测踩到：等 10 秒也不变）。
 * 所以把状态、分页、以及每组已取到的条数与正文长度都算进来。
 */
function historyDetailSignature(detail) {
    if (!detail)
        return '';
    const record = (detail.record || {});
    const size = (value) => (Array.isArray(value) ? value.length : 0);
    const text = (value) => (typeof value === 'string' ? value.length : 0);
    const counts = (detail.counts || {});
    return [
        detail.recordId || '', detail.status || '', detail.hasEarlier ? 1 : 0, detail.loadingMore ? 1 : 0, detail.error || '',
        size(record.evidence), size(record.tools), size(record.images),
        text(record.answerText ?? record.answer), text(record.reasoningText ?? record.reasoning),
        Number(counts.evidence || 0), Number(counts.tools || 0), Number(counts.images || 0),
    ].join(':');
}
/** 折叠态的高度（与 styles.css 的 --ea-fold-height 同源；量不到就用这个兜底）。 */
const FOLD_HEIGHT_FALLBACK = 220;
/*
 * 两条曲线是一对：
 *   · 展开用 emphasized-decelerate —— 起步快、尾巴长，正文是「铺开」而不是「弹开」；
 *   · 收起用 emphasized-accelerate —— 先慢慢起步再利落收住，读起来像把纸折回去。
 * 都不带回弹：正文块回弹会在末尾几帧把字挤在一起，看着抖。
 */
const FOLD_EASE_EXPAND = 'cubic-bezier(.16,1,.3,1)';
const FOLD_EASE_COLLAPSE = 'cubic-bezier(.4,0,.2,1)';
/**
 * 时长按「要挪多远」算：短回答 220ms 收住、不拖沓；长回答最多 640ms，不会一闪而过。
 * 实测 220→571px 是 328ms，正是「眼睛跟得上、手指不觉得等」的区间。
 */
function foldDuration(distance) {
    return Math.round(Math.min(640, Math.max(220, 150 + distance * 0.42)));
}
/** 按 recordId 取回这一轮的节点：分页/重画之后节点会换，不按元素缓存。 */
function findHistoryTurn(ctx, id) {
    const slot = ctx.historySlot;
    if (typeof slot.querySelectorAll !== 'function')
        return null;
    const turns = Array.from(slot.querySelectorAll('.ea-turn'));
    return turns.find(turn => turn.getAttribute('data-record-id') === id) || null;
}
/** 折叠高度从样式里读，避免 JS 里再写死一个 220 和 CSS 打架。 */
function foldHeightOf(node) {
    if (typeof getComputedStyle !== 'function')
        return FOLD_HEIGHT_FALLBACK;
    const parsed = Number.parseFloat(getComputedStyle(node).getPropertyValue('--ea-fold-height'));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : FOLD_HEIGHT_FALLBACK;
}
/**
 * 「展开全文 / 收起」的高度补间（就地执行，不重画）。
 *
 * 一次动画由三层叠出来，缺一层都会露出「状态被硬切」的痕迹：
 *   1. 高度：from → to（曲线与时长见 FOLD_EASE_* / foldDuration）；
 *   2. 遮罩：展开时把底部 34px 的渐隐化到 0，收起时再长回来 —— 文字是「化开/收拢」，不是被刀切；
 *   3. 按钮：第 70ms 起淡入 2px，替换掉「展开全文 / 收起」那一下文字突变。
 *
 * 结束时把内联的过渡与变量全部撤掉，交还给 CSS —— 下一次折叠仍由样式说了算，不留脏状态。
 */
function animateFold(answer, toggle, expand, onDone) {
    const measured = typeof answer.getBoundingClientRect === 'function' ? answer.getBoundingClientRect().height : 0;
    const from = measured > 0 ? measured : answer.clientHeight;
    // 先切状态：展开要拿掉 max-height 才量得到整段高度；收起则靠 data-fold-anim 把上限放开。
    answer.setAttribute('data-folded', expand ? 'false' : 'true');
    answer.setAttribute('data-fold-anim', expand ? 'expand' : 'collapse');
    const to = expand ? answer.scrollHeight : foldHeightOf(answer);
    const finish = () => {
        answer.removeAttribute('data-fold-anim');
        answer.style.removeProperty('--ea-fold-fade');
        answer.style.removeProperty('transition');
        onDone?.();
    };
    if (!from || !to || Math.abs(to - from) < 2) {
        finish();
        return;
    }
    const distance = Math.abs(to - from);
    const duration = foldDuration(distance);
    // 展开时渐隐先退（占 60% 时长），收起时渐隐后长（占 85%）—— 收起的最后一段正需要它压住边角。
    const fadeDuration = Math.round(expand ? duration * 0.6 : duration * 0.85);
    answer.style.setProperty('--ea-fold-fade', expand ? '34px' : '0px');
    answer.style.transition = '--ea-fold-fade ' + fadeDuration + 'ms cubic-bezier(.4,0,.2,1)';
    // 下一帧再写终值：同一帧里写两次等于直接跳到终值，过渡不会发生。
    const settleFade = () => answer.style.setProperty('--ea-fold-fade', expand ? '0px' : '34px');
    if (typeof requestAnimationFrame === 'function')
        requestAnimationFrame(settleFade);
    else
        setTimeout(settleFade, 0);
    // 按钮先换词，再让它淡入：换词与高度的第一帧同时发生，读起来是「同一个动作」。
    toggle.textContent = expand ? '收起' : '展开全文';
    toggle.setAttribute('aria-label', expand ? '收起这条回答' : '展开这条回答的全文');
    toggle.setAttribute('aria-expanded', expand ? 'true' : 'false');
    if (typeof toggle.animate === 'function') {
        toggle.animate([{ opacity: 0, transform: 'translateY(-2px)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay: 70, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
    const animation = answer.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration, easing: expand ? FOLD_EASE_EXPAND : FOLD_EASE_COLLAPSE, fill: 'none' });
    const done = animation && animation.finished;
    if (done && typeof done.then === 'function')
        done.then(finish, finish);
    else
        finish();
}
/**
 * 压缩那一行在历史签名里的那一份。
 *
 * 只放**会改变它位置或形态**的东西：状态（压缩中 → 完成/失败要换位置也换文案）、
 * 压缩时间（决定它插在哪两条之间）、以及算出来的插入下标。
 * 压缩过程中流式推过来的字数**刻意不算**——那是每个分片都变的量，
 * 算进来就会让整段历史（十几轮 Markdown）跟着逐字重挂一遍。
 */
function compactSignatureOf(state, win) {
    const compact = state.compactState;
    if (!compact)
        return '-';
    const status = compactStatusOf(compact);
    if (status === 'idle')
        return '-';
    return [status, compact.createdAt || '', compact.updatedAt || '', String(compactBoundaryIndex(state, win.items))].join(':');
}
/**
 * 历史区的签名：只放**会改变画面**的东西（窗口、条数、展开态、每条的状态与长度）。
 * 抽成函数是为了「就地展开/收起」之后能把缓存签名同步过去（见 toggleFold）：
 * 不同步的话，下一次任意重画都会认为展开态变了、把整段历史重挂一遍 ——
 * 正在播的折叠动画会被硬生生换掉，看起来就是「展开到一半突然跳到底」。
 */
function historySignature(ctx, state, win) {
    return [
        win.start, win.end, win.total,
        state.hasEarlier ? 1 : 0,
        state.loadingEarlier ? 1 : 0,
        compactSignatureOf(state, win),
        historyDetailSignature(state.historyDetail),
        [...ctx.expandedIds].sort().join('+'),
        // 只算问答记录：压缩日志不进历史（见 renderHistory 的说明），它的变化不该触发整段重挂。
        state.records.filter(isAskRecord).map(record => recordIdOf(record) + ':' + String(record?.status || '') + ':' + recordAnswerText(record).length).join(','),
    ].join('|');
}
function renderHistory(ctx, state) {
    const expand = ctx.pendingOlder || 0;
    ctx.pendingOlder = 0;
    /**
     * 只把**问答**记录画进对话流（见 shared/record-kind.ts）。
     *
     * 压缩日志（kind:'compact'，question 为空、answerText 是整份摘要）已经由
     * 「上下文已压缩」那一行表达过了；再画一遍 = 同一份摘要在对话里出现两次，
     * 而且是一条**没有问句的回答**（用户 3081 真实数据里就有 3 条这样的记录）。
     * 计数与窗口都按同一份列表算，否则「历史 N 条」与实际能看到的对不上。
     */
    const records = state.records.filter(isAskRecord);
    const win = resolveHistoryWindow(records, ctx.historyWindow, expand);
    if (win.total) {
        const firstId = recordIdOf(win.items[0]);
        ctx.historyWindow = { ...(firstId ? { firstId } : {}), count: Math.max(1, win.end - win.start), atTail: win.atTail };
    }
    else {
        ctx.historyWindow = undefined;
    }
    const newestId = recordIdOf(records[records.length - 1]);
    /**
     * 刚落地的这一条**不播进场动画**（用户 2026-10-31：「内容生成完后会闪一下」）。
     *
     * 它上一帧还以"当前这一问"的形态完整显示在屏幕上；再播一次 180ms 的
     * "淡入 + 上移 6px"，中间会出现一帧透明 —— 看起来就是闪一下。
     * 只有那些**不是从活体块变来的**记录（刷新后出现、别的会话切过来）才需要进场动画。
     */
    const justLanded = Boolean(state.liveRecordId) && state.liveRecordId === newestId;
    if (!justLanded && newestId && ctx.enteredTurnId !== undefined && newestId !== ctx.enteredTurnId)
        ctx.pendingEnterId = newestId;
    ctx.enteredTurnId = newestId || undefined;
    ctx.lastWin = win;
    const sig = historySignature(ctx, state, win);
    if (sig === ctx.historySig)
        return;
    ctx.historySig = sig;
    fill(ctx.historySlot, historyNodes(state, ctx.plugin, ctx, win));
    ctx.pendingEnterId = undefined;
    scheduleFoldCheck(ctx);
}
/** 第一次就绪时停在最新一轮（对话的习惯是打开就看见最后一条，而不是最顶上那条）。 */
function scrollToNewestOnOpen(ctx, state) {
    if (ctx.autoScrolled)
        return;
    /**
     * 这一开就是空的（新会话）：没有「最新一轮」可停，当场把这件事记下来。
     *
     * 不这么做的话，第一条回答**落地的那一刻** records 才第一次变成非空，这段"首开定位"
     * 会在那时执行 —— 表现就是用户报的「内容生成完后，会自动跳转到最下面」。
     */
    if (!state.records.length) {
        ctx.autoScrolled = true;
        return;
    }
    // 教程页/模型页开着时正文被整页盖住：这时候滚，用户看不见，回到对话只表现为「跳了一下」。
    if (ctx.tutorialOpen || ctx.modelOpen)
        return;
    const body = ctx.body;
    const hist = ctx.historySlot;
    if (typeof body.getBoundingClientRect !== 'function' || typeof hist.getBoundingClientRect !== 'function')
        return;
    const bodyRect = body.getBoundingClientRect();
    const histRect = hist.getBoundingClientRect();
    // 还没挂到页面上（首次 renderOverlay 是在插进 DOM 之前调用的）时两者的矩形都是 0：
    // 这时**不能**把「已自动滚动过」记下来，否则等真正有了布局就再也不会滚了
    //（实测：首开停在最上面，最新一轮在 2000px 之外）。
    if (!bodyRect.height || !histRect.height) {
        /**
         * 还没挂进文档（renderOverlay 是在插进 DOM **之前**调用的）→ 下一帧再试，最多 3 次。
         *
         * 不重试的后果实测过：首开永远停在最上面那一轮，最新一轮在十几屏之外。
         * 上限 3 次是为了「浮窗被隐藏/量不到」时不至于一直排帧。
         */
        const tries = (ctx.autoScrollTries || 0) + 1;
        ctx.autoScrollTries = tries;
        if (tries > 3)
            return;
        const retry = () => { if (!ctx.autoScrolled)
            scrollToNewestOnOpen(ctx, ctx.state); };
        if (typeof requestAnimationFrame === 'function')
            requestAnimationFrame(retry);
        else
            setTimeout(retry, 16);
        return;
    }
    ctx.autoScrollTries = 0;
    ctx.autoScrolled = true;
    // 为什么延后一帧：这次 updateOverlay 里刚把历史填进去，同一帧内设置 scrollTop
    // 会被浏览器钳回 0（实测：设 2196 后读回来是 0，滚动事件里记到的也是 0）。
    // 放到下一个宏任务时布局已经稳定，再设就生效。
    setTimeout(() => {
        const b = ctx.body;
        const h = ctx.historySlot;
        if (typeof b.getBoundingClientRect !== 'function' || typeof h.getBoundingClientRect !== 'function')
            return;
        const br = b.getBoundingClientRect();
        const hr = h.getBoundingClientRect();
        const delta = hr.bottom - br.bottom + 14;
        if (Number.isFinite(delta) && delta > 0)
            b.scrollTop += delta;
    }, 0);
}
/**
 * 流式回答的自动跟随（用户 2026-10-31 的判据）。
 *
 *   ① **只有原本贴着底**（或这一问刚开始）时才跟 —— 用户滚上去之后还把他拽回来，
 *      是最招人烦的一种"聪明"；
 *   ② 用户自己往上滚 → 立刻停（由 body 的 scroll 监听置 followPaused）；
 *   ③ 用户这一问的**气泡顶到正文区顶端** → 停。用户原话：「当用户发出的消息到达顶端时
 *      停止自动跟随，避免模型输出太快导致用户读不完」。也就是说：一条回答超过一屏之后，
 *      再跟着走就只有"字在飞"、没有人能读；从这一刻起把滚动权交还给他。
 */
function followStreaming(ctx, state, wasAtBottom) {
    const body = ctx.body;
    if (!(isBusy(state) && state.text)) {
        // 一次回答结束（或还没开始吐字）：下一次提问从头开始跟随。
        ctx.followPaused = false;
        ctx.followTurnKey = undefined;
        stopFollowLoop(ctx);
        return;
    }
    const key = state.question || state.liveRecordId || '';
    if (ctx.followTurnKey !== key) {
        // 换了一问：先把这一问带进视野（否则问完看不到自己刚问的那句话），再从"贴底"开始跟。
        ctx.followTurnKey = key;
        ctx.followPaused = false;
        wasAtBottom = true;
    }
    if (ctx.followPaused)
        return;
    const question = ctx.liveQuestion;
    if (typeof question.getBoundingClientRect === 'function' && typeof body.getBoundingClientRect === 'function') {
        const qr = question.getBoundingClientRect();
        const br = body.getBoundingClientRect();
        // 问句整块滑到正文区顶端之上（或刚好贴住）→ 停止跟随，把阅读速度交给用户。
        if (qr.height > 0 && br.height > 0 && qr.top <= br.top + 4) {
            ctx.followPaused = true;
            return;
        }
    }
    if (!wasAtBottom)
        return;
    /**
     * 跟随要**丝滑**（用户原话：「自动跟随应更加丝滑」）。
     *
     * 旧写法每个分片直接 `scrollTop = scrollHeight` —— 一帧跳几十到几百像素，
     * 看起来就是"画面一段段往上顶"。改成缓动：每帧只走剩余距离的一部分，
     * 新分片来了就重新定目标，于是画面是连续地滑到底，而不是一跳一跳。
     */
    startFollowLoop(ctx);
}
/** 「接近最下面」的容差：约三行文字。用户只要在这个范围内，就认为他想跟着看。 */
const FOLLOW_NEAR_BOTTOM = 120;
/**
 * 缓动跟随：每帧把剩余距离吃掉一部分，直到贴底。
 *
 * 为什么用 rAF 而不是 CSS scroll-behavior:smooth：
 * smooth 是"一次滚到底"的动画，流式内容每几十毫秒就变长一次，会把动画不断打断、变成抖动。
 * 这里的循环是**持续追一个会移动的目标**：delta 每帧重算，内容长了就继续追，停了就自然停下。
 */
function stopFollowLoop(ctx) {
    if (ctx.followRaf !== undefined && typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(ctx.followRaf);
    ctx.followRaf = undefined;
    ctx.followPos = undefined;
}
function startFollowLoop(ctx) {
    const bodyForFallback = ctx.body;
    if (typeof requestAnimationFrame !== 'function') {
        // 没有 rAF 的环境（测试里的假 DOM）：退化成"一次性贴底"。
        // 真实浏览器永远走下面的缓动路径；这里只是让同一条判据在单测里可断言。
        const height = (bodyForFallback.scrollHeight ?? 0) - (bodyForFallback.clientHeight ?? 0);
        if (Number.isFinite(height) && height >= 0)
            bodyForFallback.scrollTop = height;
        return;
    }
    if (ctx.followRaf !== undefined)
        return;
    /**
     * 跟随循环**一直跑**，直到「不流式了」或「用户接管」为止（用户 2026-10-31：「还是不丝滑」）。
     *
     * 上一版是"每来一个分片才跑一小段、追平就退出"。问题在于：分片之间的间隔并不均匀
     *（有时几十毫秒、有时一帧来好几个），于是画面是"停一下、蹭一下"——
     * 每一段都是一次新的启动，看起来就是一顿一顿的。
     *
     * 现在改成**常驻**：只要还在流式，就每帧往底部挪一点；内容没变就原地不动（不写 scrollTop），
     * 内容长了自己就跟上。每帧位移有上限（42px ≈ 2500px/s），
     * 所以一次灌进来一大块（比如整段代码块）也不会"一帧跨过去半屏"。
     */
    /**
     * 每帧只做一件事：把 scrollTop 朝「内容底部」推进一小段。
     *
     * 这一版按用户实机反馈（「A. 一顿一顿」）重写了三处，都是**量化台阶**的来源：
     *
     * 1. **不再有整数下限**。上一版写的是 Math.max(2, delta * 0.5) ——
     *    剩余量小于 2px 时也硬走 2px，于是产生 2/2/2 的规律小跳（正是"一顿一顿"）。
     *    现在小剩余量走亚像素步长，肉眼是连续滑动。
     * 2. **用 dt 做时间积分**，不用"每帧固定比例"。帧率掉到 30fps 时步长自动变大、
     *    60fps 时变小 —— 否则一卡帧，画面就会"停两帧再补一大步"。
     * 3. **自己记一个浮点位置**（ctx.followPos）。浏览器把 scrollTop 读回来可能是整数，
     *    只靠读回的整数累加，小数部分每帧丢失 → 又变成台阶。写出去用浮点，下一帧从浮点继续。
     */
    let lastTs = 0;
    const step = (ts) => {
        ctx.followRaf = undefined;
        const streaming = isBusy(ctx.state) && Boolean(ctx.state.text);
        if (!streaming || ctx.followPaused) {
            ctx.followPos = undefined;
            return;
        }
        const body = ctx.body;
        const now = typeof ts === 'number' ? ts : (typeof performance === 'object' && performance && typeof performance.now === 'function' ? performance.now() : Date.now());
        const dt = lastTs ? Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000)) : 0.016;
        lastTs = now;
        // 目标是**最大可滚动位置**，不是内容总高：写 scrollHeight 会被浏览器钳到底部，
        // 而我们的浮点位置却记住了那个越界值 —— 下一帧 delta 变负数，就再也追不动了。
        const target = (body.scrollHeight ?? 0) - (body.clientHeight ?? 0);
        if (!Number.isFinite(target) || target < 0) {
            ctx.followRaf = requestAnimationFrame(step);
            return;
        }
        if (ctx.followPos === undefined)
            ctx.followPos = body.scrollTop ?? 0;
        const delta = target - ctx.followPos;
        if (delta > 0.05) {
            // 指数趋近：时间常数 100ms（与帧率无关）；再按最大速度 3200px/s 截断。
            // +0.05 只是保证极小的剩余量也能推进，不会"永远差几像素"。
            const alpha = 1 - Math.exp(-dt / 0.10);
            const move = Math.min(delta, Math.min(delta * alpha + 0.05, 3200 * dt));
            ctx.followPos += move;
            ctx.programmaticTop = ctx.followPos;
            body.scrollTop = ctx.followPos;
        }
        else if (delta < -1) {
            // 内容变短（例如折叠）：把内部位置拉回真实值，别把"超出底部"的状态一路带着。
            ctx.followPos = target;
        }
        // 无条件续帧：追平了也继续等，下一块内容长出来时同一帧就跟上。
        ctx.followRaf = requestAnimationFrame(step);
    };
    ctx.followRaf = requestAnimationFrame(step);
}
/** 状态变化时原地重画各区块。骨架、输入框、滚动位置都不动。 */
export function updateOverlay(root, state, plugin) {
    const ctx = contexts.get(root);
    if (!ctx)
        return;
    ctx.state = state;
    ctx.plugin = plugin;
    /**
     * 「这一帧之前」是不是贴着底 —— 必须在**改任何 DOM 之前**量。
     * 内容一改，scrollHeight 就变了，这个判断再也回不到原样。
     */
    const bodyForScroll = ctx.body;
    const bodyMax = (bodyForScroll.scrollHeight ?? 0) - (bodyForScroll.clientHeight ?? 0);
    // 「接近最下面」也算贴底（用户 2026-10-31：只有在最下面或接近最下面时才自动跟随）。
    const wasAtBottom = bodyMax > 0 && (bodyForScroll.scrollTop ?? 0) >= bodyMax - FOLLOW_NEAR_BOTTOM;
    /**
     * 「回答落地」这一帧的位置保护（用户 2026-10-31 报的真缺陷：
     * 「当内容生成完后，会自动跳转到最下面」）。
     *
     * 完成的那一刻 DOM 会换一次形态：当前这一问的活体块（liveTurn）被隐藏，同一条回答
     * 作为一条历史记录重新挂进历史区。两个块一换，浏览器重新计算滚动位置 ——
     * 只要新内容比原先矮一点，scrollTop 就被钳到新的底部，用户看到的就是"一生成完就跳到最后"。
     *
     * 所以：**用户没在贴底**时，改动前先记下这一轮在屏幕上的位置，改完按位移把它补回去。
     * 按元素记、不按 scrollHeight 差值算：浏览器自己也可能已经锚定过一次，差值法会双倍偏移
     *（与 historyOlderNode 的 ctx.anchor 同一套理由，见那里的注释）。
     */
    const handoffAnchor = (() => {
        if (wasAtBottom)
            return undefined;
        const id = state.liveRecordId;
        if (!id)
            return undefined;
        const live = ctx.liveTurn;
        if (!live || live.hidden)
            return undefined;
        if (typeof live.getBoundingClientRect !== 'function')
            return undefined;
        const rect = live.getBoundingClientRect();
        return rect && rect.height > 0 ? { id, top: rect.top } : undefined;
    })();
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
    // 切会话：窗口、展开态、进场标记全部换一份 —— 否则上一个会话「往上翻过」的窗口会带过来。
    if (ctx.sessionId !== state.sessionId) {
        ctx.sessionId = state.sessionId;
        ctx.historyWindow = undefined;
        ctx.historySig = undefined;
        ctx.expandedIds = new Set();
        ctx.enteredTurnId = undefined;
        ctx.pendingEnterId = undefined;
        ctx.pendingOlder = 0;
        ctx.anchor = undefined;
        ctx.scrollToTail = false;
        ctx.autoScrolled = false;
        ctx.autoScrollTries = 0;
        // 换了会话就是「第一次看到」：新会话若已有压缩记录，不该把视野拽到那一行。
        ctx.compactSig = undefined;
        // 跟随状态属于上一个会话的某一问，不能带过来（循环也要停：它读的是上一个会话的 DOM）。
        ctx.followPaused = false;
        ctx.followTurnKey = undefined;
        stopFollowLoop(ctx);
    }
    ctx.phase.textContent = phaseLabel(state);
    // ── 三档界面在这里分叉（判据与理由见 surfaceGate 的说明）────────────────────
    // 未就绪：只画加载页，下面那些区块**一个都不画**。
    // 这是「错值窗口」的根治点：空态文案（「暂时没有可用的模型」「还没有小助手历史」
    // 「占用未知」）在数据到位之前**根本没有机会**出现在界面上。
    const gate = surfaceGate(state);
    ctx.root.setAttribute('data-surface', gate);
    if (gate === 'loading') {
        // 正文/当前请求等槽位一律清空：加载期不许残留任何会被当成结论的内容。
        ctx.errorSlot.replaceChildren();
        ctx.errorTailSlot.replaceChildren();
        ctx.currentSlot.replaceChildren();
        ctx.answerSlot.hidden = true;
        ctx.answerView.update('', false);
        resetModelTrigger(ctx);
        closeModelPanel(ctx, { focus: false, animate: false });
        fill(ctx.catalogNoteSlot, []);
        fill(ctx.evidenceSlot, []);
        fill(ctx.compactSlot, []);
        fill(ctx.historySlot, []);
        ctx.historySig = undefined;
        ctx.pendingOlder = 0;
        ctx.liveTurn.hidden = true;
        ctx.liveQuestion.textContent = '';
        fill(ctx.detailSlot, []);
        ctx.ringSlot.replaceChildren();
        // A4（F1 的前置条件）：使用说明与快捷问题也必须清掉。
        //
        // 现在它们是「切会话时整棵 DOM 重建」顺带消失的，所以 t6 那条 F1 判为不可达。
        // 但那是**靠重建**成立的：一旦以后改成「同一棵 DOM 从 ready 原地切到 loading」，
        // 上一会话的 hero 三句与 4 个快捷问题就会原样留在加载页上。
        // 显式清掉之后，这条路径不论怎么切换都成立，不再依赖「恰好重建过」。
        fill(ctx.heroSlot, []);
        fill(ctx.quickSlot, []);
        // A3：加载期不许提交。按钮挡鼠标 + disabled 让读屏也知道不可用；
        // 真正的拦截在 form 的 submit 监听里（见 canSubmit）。
        ctx.send.textContent = sendLabel(state, 'loading');
        ctx.send.disabled = true;
        ctx.send.setAttribute('data-stop', 'false');
        ctx.send.setAttribute('aria-label', '发送问题');
        ctx.compactBtn.disabled = true;
        fill(ctx.loadingSlot, loadingNodes());
        // 选择痕迹一并收掉：加载页上不该出现上一档的任何「已选」标签。
        resetPickRow(ctx);
        return;
    }
    fill(ctx.loadingSlot, []);
    ctx.errorSlot.replaceChildren();
    ctx.errorTailSlot.replaceChildren();
    // 失败但有旧内容时：错误原因显示在顶部，旧内容照常留在下面（契约允许的另一条出路）。
    //
    // 例外：**这一次提问失败**（phase=error/interrupted）时原因要贴到当前这一问下面。
    // 用户提问时眼睛在底部，而顶部那条在长历史里是几十屏之外 —— 他看到的只是"进度条没了"。
    /**
     * 错误条的进场动画只播一次（用户 2026-10-31：「点击停止后…突然闪出」）。
     *
     * 判据是"这句话和上一帧不一样"：同一句错误在后续每次重画里都不再重播，
     * 否则流式期间每来一个分片就重画一次，错误条会一直闪。
     */
    const currentErrorText = state.stateError && gate === 'ready' ? state.stateError : (state.error || '');
    const errorEntering = Boolean(currentErrorText) && ctx.lastErrorText !== currentErrorText;
    const errorClass = 'dsh-explain-assistant-error ea-error' + (errorEntering ? ' ea-error-enter' : '');
    ctx.lastErrorText = currentErrorText || undefined;
    const turnError = state.error && (state.phase === 'error' || state.phase === 'interrupted')
        ? el('div', { class: errorClass, role: 'alert', text: state.error })
        : null;
    if (state.stateError && gate === 'ready')
        ctx.errorSlot.appendChild(el('div', { class: errorClass, role: 'alert', text: state.stateError }));
    else if (state.error && !turnError)
        ctx.errorSlot.appendChild(el('div', { class: errorClass, role: 'alert', text: state.error }));
    if (turnError)
        ctx.errorTailSlot.appendChild(turnError);
    // 失败且没有任何旧内容：整块内容区交给明确的中文错误 + 重试，
    // **不再**渲染模型/历史/占用那些区块 —— 否则它们会显示空态文案，用户读成「真的没有」。
    if (gate === 'failed') {
        ctx.currentSlot.replaceChildren();
        ctx.answerSlot.hidden = true;
        ctx.answerView.update('', false);
        resetModelTrigger(ctx);
        closeModelPanel(ctx, { focus: false, animate: false });
        fill(ctx.catalogNoteSlot, []);
        fill(ctx.evidenceSlot, []);
        fill(ctx.compactSlot, []);
        fill(ctx.historySlot, []);
        ctx.historySig = undefined;
        ctx.pendingOlder = 0;
        ctx.liveTurn.hidden = true;
        ctx.liveQuestion.textContent = '';
        fill(ctx.detailSlot, []);
        ctx.ringSlot.replaceChildren();
        // A4 同理：失败页也不许残留上一会话的使用说明与快捷问题。
        fill(ctx.heroSlot, []);
        fill(ctx.quickSlot, []);
        // A3：失败页同样不许提交（数据没读到，提问没有可用上下文）。
        ctx.send.textContent = sendLabel(state, 'failed');
        ctx.send.disabled = true;
        ctx.send.setAttribute('data-stop', 'false');
        ctx.send.setAttribute('aria-label', '发送问题');
        ctx.compactBtn.disabled = true;
        fill(ctx.stateErrorSlot, stateErrorNodes(state, ctx.plugin, readFailure(state)));
        resetPickRow(ctx);
        return;
    }
    fill(ctx.stateErrorSlot, []);
    // 「落地」：这一问的回答已经作为记录进了历史 → 当前这一块收起来，避免同一条回答出现两次。
    // 失败/中断没有落地（没有记录或记录未完成）时照常显示，用户得看到自己问过什么、为什么失败。
    const landed = Boolean(state.liveRecordId) && state.records.some(record => recordIdOf(record) === state.liveRecordId);
    /**
     * 压缩中**不**进对话流：那段流式正文是"摘要"，不是"回答"。
     * 旧版把它按回答渲染，屏幕上会出现一个空问句气泡 + 自己滚出来的摘要 ——
     * 用户看到的是"我问了什么？它怎么自己答起来了？"。进度改在压缩卡片里给。
     */
    const compacting = state.compactState?.status === 'running';
    const showLive = !compacting && !landed && Boolean(state.question || state.text || isBusy(state));
    ctx.liveTurn.hidden = !showLive;
    ctx.liveQuestion.textContent = showLive ? (state.question || '') : '';
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
    fill(ctx.heroSlot, heroNodes(state, ctx));
    fill(ctx.quickSlot, quickNodes(state, ctx.plugin));
    // 模型：标题栏按钮恒显示「现在用哪个」，选择页开着就跟着刷新（目录可能刚被「刷新」换掉）。
    ctx.modelTrigger.root.hidden = false;
    syncModelTrigger(ctx);
    fill(ctx.catalogNoteSlot, catalogNoticeNodes(ctx));
    if (ctx.modelOpen)
        renderModelPanel(ctx);
    fill(ctx.evidenceSlot, evidenceNodes(state, ctx.plugin));
    // 压缩那一行的**内容**先填；**位置**由历史区决定（historyNodes 把这个槽位本身插进对话流）。
    // 这两句的顺序不能颠倒：renderHistory 要搬的正是这个已经填好的槽位。
    /**
     * 压缩那一行**不要每个分片都重建**（用户 2026-10-31：「跟随还是不丝滑」）。
     *
     * 这段代码每次 updateOverlay 都会跑，流式期间一秒能跑几十次；展开状态下里面是整份摘要的
     * Markdown（几十个节点），每帧重建一次就是白送卡顿。只有真正会改变它的东西变了才重画。
     */
    const compactRenderSig = [
        compactStatusOf(state.compactState || { status: 'idle' }),
        ctx.compactOpen === true ? 1 : 0,
        state.compactState?.updatedAt || '',
        state.compactState?.error || '',
        typeof state.occupancy === 'number' ? Math.round(state.occupancy) : '',
        state.compactState?.status === 'running' ? Math.floor(state.text.length / 40) : '',
    ].join('|');
    if (compactRenderSig !== ctx.compactRenderSig) {
        ctx.compactRenderSig = compactRenderSig;
        fill(ctx.compactSlot, compactNodes(state, ctx));
    }
    ctx.detailInline = false;
    renderHistory(ctx, state);
    // 落地后把这一轮按"屏幕上原来的位置"摆回去（见 handoffAnchor）。
    if (handoffAnchor) {
        const turns = Array.from(ctx.historySlot.querySelectorAll('.ea-turn'));
        const node = turns.find(turn => turn.getAttribute('data-record-id') === handoffAnchor.id);
        if (node && typeof node.getBoundingClientRect === 'function') {
            const delta = node.getBoundingClientRect().top - handoffAnchor.top;
            if (Number.isFinite(delta) && Math.abs(delta) > 1)
                ctx.body.scrollTop += delta;
        }
    }
    /*
     * 压缩状态一变就把那一行带进视野。
     *
     * 为什么必须做：/compact 是用户主动按的，按完那一刻他正看着面板底部；
     * 若这一行在他看不到的位置，界面就等于「没有任何反应」。
     * 只在**状态真的变了**时滚一次 —— 每次重画都滚会把正在读的历史顶走。
     *
     * 必须排在 renderHistory **之后**：那一行现在长在对话流里（见 historyNodes），
     * 重画之前它可能还没被挂进文档，量到的矩形是 0，滚了等于没滚。
     */
    const compactSig = [state.compactState?.status, state.compactState?.updatedAt, state.compactState?.error].join('|');
    /**
     * 第一次看到这份压缩状态（刚打开浮窗、刚切会话）**不滚**。
     *
     * 为什么：这一行现在长在对话流里它真正发生的位置（见 historyNodes），
     * 而它往往在最新那一轮的**上面几十屏**。首帧就把它「带进视野」，等于
     * 打开浮窗的第一眼停在压缩那一行上，而不是最新一轮 —— 用户原话：
     * 「点开？后会自动弹到上下文压缩的地方，不符合直觉」。
     * 只有**这一次真的发生了状态变化**（按了 /compact、压缩刚跑完/失败）才滚。
     *
     * 另外：教程页/模型页开着时正文被整页盖住，这时候滚只会在回到对话时
     * 表现为「莫名其妙跳了一下」，所以也跳过。
     */
    const compactFirstSight = ctx.compactSig === undefined;
    if (ctx.compactSig !== compactSig) {
        ctx.compactSig = compactSig;
        const shouldScrollToRow = !compactFirstSight && !ctx.tutorialOpen && !ctx.modelOpen;
        const rowAt = () => ctx.compactSlot.querySelector?.('.ea-compact-row');
        // 自己算滚动量，不用 scrollIntoView：
        // 浮窗外层是 overflow:hidden，scrollIntoView 在真实页面上会把祖先链一起卷，
        // 实测这里 scrollTop 仍是 0（那一行留在视口下面，等于没滚）。按两个矩形差补 scrollTop 最确定。
        const scrollToRow = () => {
            const row = rowAt();
            if (!row || typeof row.getBoundingClientRect !== 'function')
                return;
            const r = row.getBoundingClientRect();
            const b = ctx.body.getBoundingClientRect();
            if (!(r.height > 0 && b.height > 0))
                return;
            if (r.bottom > b.bottom)
                ctx.body.scrollTop += (r.bottom - b.bottom) + 10;
            else if (r.top < b.top)
                ctx.body.scrollTop -= (b.top - r.top) + 10;
        };
        // 排在下一帧、并再补一次 150ms：
        // 压缩刚完成时这一行是"边渲染边被撑开"的（上面还有历史/元信息在变），
        // 当场量出来的位置很快就会过时 —— 实测只量一次时 scrollTop 差 400 多像素。
        // 每次都现取那一行（不提前抓元素）：一次重画里历史区可能刚被整块换掉，
        // 抓着旧元素量到的是已经脱离文档的节点，矩形恒为 0。
        if (shouldScrollToRow) {
            if (typeof requestAnimationFrame === 'function')
                requestAnimationFrame(() => scrollToRow());
            else
                scrollToRow();
            setTimeout(scrollToRow, 150);
        }
    }
    // 面板平时挂在那一轮下面（见 historyNodes）；只有那一轮不在当前挂载窗口里时，
    // 才会掉到正文顶部的这个槽位——否则用户点了按钮什么都看不到。
    fill(ctx.detailSlot, ctx.detailInline ? [] : historyDetailNodes(state, ctx.plugin));
    // 换了一条记录来展开时把面板滚到可见处；同一记录的续读/重画不动滚动位置。
    const detailId = state.historyDetail?.recordId;
    if (detailId && detailId !== ctx.detailRecordId) {
        ctx.detailRecordId = detailId;
        ctx.detailFit = true;
        scrollDetailIntoView(ctx);
    }
    else if (!detailId) {
        ctx.detailRecordId = undefined;
        ctx.detailFit = false;
    }
    // 内容回来时面板会从「正在读取」的几十像素长成整块记录：那一刻再摆一次，之后不再碰滚动位置。
    else if (ctx.detailFit && state.historyDetail?.status !== 'loading') {
        ctx.detailFit = false;
        placeDetailPanel(ctx);
    }
    ctx.ringSlot.replaceChildren(ringNode(state));
    // §5.2：常驻显示「这一问围绕哪几条」。每条一个可拆掉的标签；没有选择时整行收起。
    renderPickRow(ctx);
    syncSelectBar(ctx, state);
    // 只在草稿真的被外部改写（例如提交后清空）时回写输入框，避免打字时被顶掉光标。
    if (ctx.input.value !== state.draft) {
        ctx.input.value = state.draft;
        // 程序改 value 不会派发 input 事件，镜面还停在旧文本上 —— 光标会停在旧位置（发送清空、恢复草稿都走这条）。
        ctx.field?.refresh();
    }
    // 走到这里必然是 ready 档：文案与可用性都由 canSubmit 统一决定 ——
    // 这样「加载/失败时禁用、回到 ready 后恢复」只有一处真相，不会两边漂移。
    /**
     * 忙 → 这颗按钮是「停止」，而且**必须可点**：它现在是用户唯一的出口。
     * 不忙 → 回到「发送」，可用性照旧由 canSubmit 决定（加载 / 失败两档在更早的分支里已经返回）。
     */
    const stopping = isBusy(state);
    ctx.send.textContent = sendLabel(state, 'ready');
    ctx.send.disabled = stopping ? false : !canSubmit(state);
    ctx.send.setAttribute('data-stop', stopping ? 'true' : 'false');
    ctx.send.setAttribute('aria-label', stopping ? '停止本次解释' : '发送问题');
    // /compact 同理：忙碌时再点只是静默返回，按钮看起来可点却毫无反应（旧版的真问题）。
    ctx.compactBtn.disabled = !canSubmit(state);
    ctx.compactBtn.setAttribute('title', canSubmit(state) ? '整理小助手自己的上下文；不影响主对话' : '正在处理中，等这一次结束再压缩');
    // 往上补历史之后把阅读位置还回去：量一下参照的那一轮现在跑到哪，把差值补进 scrollTop。
    // 这是闭环的 —— 浏览器如果已经自己锚定过，这里量到的差值就是 0，不会双倍偏移。
    if (ctx.anchor) {
        const anchor = ctx.anchor;
        ctx.anchor = undefined;
        const turns = Array.from(ctx.historySlot.querySelectorAll('.ea-turn'));
        const node = turns.find(turn => turn.getAttribute('data-record-id') === anchor.id);
        if (node) {
            const now = node.getBoundingClientRect().top;
            const delta = now - anchor.top;
            if (Number.isFinite(delta) && Math.abs(delta) > 1)
                ctx.body.scrollTop += delta;
        }
    }
    if (ctx.scrollToTail) {
        ctx.scrollToTail = false;
        const height = ctx.body.scrollHeight;
        if (typeof height === 'number' && Number.isFinite(height))
            ctx.body.scrollTop = height;
    }
    scrollToNewestOnOpen(ctx, state);
    // 流式跟随排在最后：它读的是这一帧重画后的真实高度，并自己决定要不要动滚动。
    followStreaming(ctx, state, wasAtBottom);
    // 注意：这里**不再回写 scrollTop**。见函数开头说明。
}
