import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 「浮窗真的用上了 Markdown 渲染」这条接线闸。
 *
 * 为什么渲染器自己有 13 条测试还不够：那些测的是 markdown.ts **单独**跑得对不对。
 * 而用户看到的是浮窗 —— 完全可能出现「渲染器没问题、但浮窗还在用 textContent 显示原文」
 * 这种状态，而且所有测试都绿。所以这里断言的是**浮窗这一层**的行为。
 *
 * 第二个重点是**冻结前缀在浮窗里也没被摘下来**。这是「保证性能」在界面上的落点：
 * 若 updateOverlay 每次把全部节点 replaceChildren 一遍，元素虽然还是同一个对象，
 * 但浏览器会因此丢掉滚动锚点 —— 用户看到的就是跳变。
 */

const overlay = await moduleFromSource('src/client/overlay.tsx');
const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8');

function state(extra) {
  return Object.assign({
    sessionId: 's1', open: true, phase: 'idle', draft: '', reasoning: '', text: '', tools: [], records: [],
    hasEarlier: false, loadingEarlier: false, evidence: [], unread: false, occupancyKnown: false,
    quickQuestionsDismissed: true, catalog: { groups: [], failures: [] },
  }, extra || {});
}

function pluginSpy() {
  return {
    registry: { update() {}, close() {}, get: () => undefined },
    api: { selectModel: async () => ({}), models: async () => ({ payload: {} }) },
    submit: async () => {}, loadEarlier: async () => {}, cancel() {},
  };
}

function withDom(run) {
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  return run(dom).finally(async () => { await new Promise(r => setTimeout(r, 20)); dom.restore(); });
}

const ANSWER = '.dsh-explain-assistant-answer';

test('浮窗正文把 Markdown 记号渲染成格式，不再原样露出', () => withDom(async () => {
  const { plugin } = pluginSpy();
  const source = '## 小标题\n\n这句话有 **重点** 和 \`代码\`。\n\n- 甲\n- 乙\n';
  const root = overlay.renderOverlay(state({ text: source, phase: 'complete' }), plugin);

  const answer = root.querySelector(ANSWER);
  assert.ok(answer, '必须有回答正文容器');
  const text = answer.textContent || '';

  // 格式出来了（这一条是「只删记号不出格式」的判别点）。
  assert.ok(answer.querySelectorAll('h2').length === 1, '标题应渲染成 <h2>，实际标签：' + tagsOf(answer).join(','));
  assert.ok(answer.querySelectorAll('strong').length === 1, '粗体应渲染成 <strong>');
  assert.ok(answer.querySelectorAll('code').length === 1, '行内代码应渲染成 <code>');
  assert.equal(answer.querySelectorAll('li').length, 2, '两条列表项应渲染成两个 <li>');

  // 记号本身不再露出。
  assert.ok(!text.includes('##'), '正文里还露着 ## ：' + text);
  assert.ok(!text.includes('**'), '正文里还露着 ** ：' + text);
  assert.ok(!text.includes('\`'), '正文里还露着反引号：' + text);
  assert.ok(!/- 甲/.test(text), '正文里还露着列表记号：' + text);
  assert.ok(text.includes('小标题') && text.includes('重点') && text.includes('甲'), '内容不能丢：' + text);
}));

test('浮窗历史记录的回答也按 Markdown 渲染', () => withDom(async () => {
  const { plugin } = pluginSpy();
  const root = overlay.renderOverlay(state({
    records: [{ id: 'r1', question: '问', answer: '答案是 **这个**，见 \`a.ts\`。', status: 'complete', createdAt: new Date().toISOString() }],
  }), plugin);
  const record = root.querySelector('.ea-record-answer');
  assert.ok(record, '必须有历史正文');
  assert.equal(record.querySelectorAll('strong').length, 1, '历史正文里的粗体也要变成 <strong>');
  assert.equal(record.querySelectorAll('code').length, 1, '历史正文里的行内代码也要变成 <code>');
  assert.ok(!(record.textContent || '').includes('**'), '历史正文里还露着 ** ：' + record.textContent);
}));

test('展开的「完整内容」面板里，回答也按 Markdown 渲染', () => withDom(async () => {
  const { plugin } = pluginSpy();
  const root = overlay.renderOverlay(state({
    historyDetail: {
      recordId: 'r1', status: 'ready', hasEarlier: false, loadingMore: false,
      record: { question: '问', answerText: '细节是 **这样** 的。' },
      counts: { evidence: 0, tools: 0, images: 0 },
    },
  }), plugin);
  const detail = root.querySelector('.ea-detail-answer');
  assert.ok(detail, '必须有详情正文');
  assert.equal(detail.querySelectorAll('strong').length, 1, '详情正文里的粗体也要变成 <strong>');
  assert.ok(!(detail.textContent || '').includes('**'), '详情正文里还露着 ** ：' + detail.textContent);
}));

test('流式更新时，已冻结的正文节点在浮窗里原地不动（不重建、不摘挂）', () => withDom(async () => {
  const { plugin } = pluginSpy();
  // 先渲染出两个已终结的块 + 一个正在长的块。
  let text = '## 第一节\n\n第一段 **内容**。\n\n第二节正在写';
  const root = overlay.renderOverlay(state({ text, phase: 'running' }), plugin);
  const answer = root.querySelector(ANSWER);
  const heading = answer.querySelector('h2');
  const paragraph = answer.querySelector('p');
  assert.ok(heading && paragraph, '首屏应已渲染出标题与段落');
  const headingDetaches = heading.detachments;
  const paragraphDetaches = paragraph.detachments;

  // 模拟流式：不断追加。
  for (let i = 0; i < 30; i++) {
    text += '，继续第' + i + '句';
    overlay.updateOverlay(root, state({ text, phase: 'running' }), plugin);
  }

  // 冻结的节点必须是**同一个对象**。
  assert.equal(answer.querySelector('h2'), heading, '标题节点被重建了 —— 冻结失效');
  assert.equal(answer.querySelector('p'), paragraph, '段落节点被重建了 —— 冻结失效');
  // 而且**一次都没有被摘下来过**。
  //
  // 这是本条测试真正的判别点。只断言「对象还是同一个」是不够的：
  // 把「只换尾部」改成整棵 replaceChildren，节点对象依然是同一批（渲染器复用了它们），
  // 但它们每次都被摘下来再挂回去 —— 真实浏览器会因此丢掉滚动锚点，用户看到跳变。
  // 假 DOM 如实记录摘除次数后，这种改法才会变红（已证伪）。
  assert.equal(heading.detachments, headingDetaches,
    '冻结的标题被摘下来过 ' + (heading.detachments - headingDetaches) + ' 次 —— 浏览器会丢滚动锚点，用户看到跳变');
  assert.equal(paragraph.detachments, paragraphDetaches,
    '冻结的段落被摘下来过 ' + (paragraph.detachments - paragraphDetaches) + ' 次 —— 浏览器会丢滚动锚点，用户看到跳变');
  assert.ok((answer.textContent || '').includes('继续第29句'), '流式内容必须完整跟到底');
}));

test('正文为空时不占位置（隐藏），有内容时才显示', () => withDom(async () => {
  const { plugin } = pluginSpy();
  const root = overlay.renderOverlay(state({ text: '' }), plugin);
  const answer = root.querySelector(ANSWER);
  assert.ok(answer, '正文容器应始终存在（增量渲染器挂在它上面）');
  assert.equal(answer.hidden, true, '没有正文时应隐藏，不留一块空白框');
  overlay.updateOverlay(root, state({ text: '有内容了' }), plugin);
  assert.equal(answer.hidden, false, '有正文时应显示');
  assert.ok((answer.textContent || '').includes('有内容了'));
}));

test('正文样式不再用 pre-wrap（否则块距会翻倍）', () => {
  const rule = css.match(/\.ea-answer\{[^}]*\}/);
  assert.ok(rule, '必须有 .ea-answer 规则');
  assert.equal(/white-space\s*:\s*pre-wrap/.test(rule[0]), false,
    '正文按块渲染后不能再写 pre-wrap：源码换行会被当成可见空行，段距翻倍');
  assert.match(css, /\.ea-answer \.ea-md-pre\{[^}]*overflow-x:auto/, '代码块必须能横向滚动，不能撑破浮窗');
  assert.match(css, /\.ea-answer \.ea-md-code\{[^}]*font-family/, '行内代码必须有等宽字体');
  assert.match(css, /\.ea-answer\[hidden\]\{display:none\}/, '隐藏的正文必须真的不占位置');
});

function tagsOf(element) {
  const out = [];
  const walk = node => {
    if (node.tagName && !String(node.tagName).startsWith('#')) out.push(String(node.tagName).toLowerCase());
    for (const child of node.children || []) walk(child);
  };
  walk(element);
  return out;
}

/* ================================================================== *
 * 覆盖范围：所有「模型写出来的文字」都要按 Markdown 渲染
 *
 * 起因：用户的投诉是「没有对 md 的符号进行解析」——指的是所有看到模型文字的地方。
 * 最初只改了回答正文、历史、详情三处，漏掉了**压缩摘要**与**推理过程**：
 * 这两处同样是模型生成的正文，同样会带 ** 与 ##，原先直接塞 text，记号会原样露出。
 * ================================================================== */

test('压缩摘要按 Markdown 渲染（模型写的摘要也会带记号）', () => withDom(async () => {
  const { plugin } = pluginSpy();
  const root = overlay.renderOverlay(state({
    compactState: { status: 'complete', summary: '摘要要点：**重点一** 与 ## 小标题', updatedAt: new Date().toISOString() },
  }), plugin);
  const panel = root.querySelector('.ea-compact-summary');
  assert.ok(panel, '必须有压缩摘要面板');
  assert.ok(panel.querySelectorAll('strong').length >= 1, '摘要里的粗体应渲染成 <strong>');
  assert.equal((panel.textContent || '').includes('**'), false,
    '摘要正文里还露着 ** ：' + (panel.textContent || ''));
}));

test('推理过程按 Markdown 渲染', () => withDom(async () => {
  const { plugin } = pluginSpy();
  const root = overlay.renderOverlay(state({ reasoning: '先看 **这个** 再决定', phase: 'running' }), plugin);
  const bodies = root.querySelectorAll('.ea-disclosure-body');
  assert.ok(bodies.length >= 1, '必须有推理过程面板');
  const reasoning = bodies[0];
  assert.ok(reasoning.querySelectorAll('strong').length >= 1, '推理里的粗体应渲染成 <strong>');
  assert.equal((reasoning.textContent || '').includes('**'), false,
    '推理正文里还露着 ** ：' + (reasoning.textContent || ''));
}));

test('详情面板里的完整推理过程也按 Markdown 渲染', () => withDom(async () => {
  const { plugin } = pluginSpy();
  const root = overlay.renderOverlay(state({
    historyDetail: {
      recordId: 'r1', status: 'ready', hasEarlier: false, loadingMore: false,
      record: { question: '问', reasoningText: '想了一下 **关键点**。' },
      counts: { evidence: 0, tools: 0, images: 0 },
    },
  }), plugin);
  const bodies = root.querySelectorAll('.ea-disclosure-body');
  assert.ok(bodies.length >= 1, '必须有详情里的推理面板');
  assert.equal((bodies[0].textContent || '').includes('**'), false,
    '详情推理正文里还露着 ** ：' + (bodies[0].textContent || ''));
}));

test('正文以外的 Markdown 作用域有对应样式（否则渲染了但没排版）', () => {
  assert.match(css, /\.ea-md-scope \.ea-md-p\{/, '必须有 .ea-md-scope 的段落样式');
  assert.match(css, /\.ea-md-scope \.ea-md-h\{/, '必须有 .ea-md-scope 的标题样式');
  assert.match(css, /\.ea-md-scope \.ea-md-code\{/, '必须有 .ea-md-scope 的行内代码样式');
  assert.match(css, /\.ea-md-scope \.ea-md-pre\{/, '必须有 .ea-md-scope 的代码块样式');
});


/* ================================================================== *
 * 缓存交付语义：已挂载的节点批次不得再作为同一批对象交付出去
 *
 * 背景（由 impl-history 在对抗性审查中发现并修，归 Lead 复核）：
 * cachedMarkdownNodes 原先对同一 (key, text) 永远返回**同一批节点对象**。
 * 真实 DOM 的 appendChild 是**移动**语义 —— 同一批节点被挂到第二个容器时，
 * 会从第一个容器里消失，用户看到前一处正文**变空**。
 * 修法：deliverSettled —— **未挂载**时返回原批（保住「命中缓存不重解析」），
 * **已挂载**后再取同一键时返回**克隆体**。
 *
 * ⚠️ 判据为什么这样选（这一条我踩过两次坑，写下来避免以后重犯）：
 *   · 不能在假 DOM 里断言「第一条被搬空」—— 夹具的 appendChild **不模拟移动语义**
 *     （只 push，不从旧父节点移除），那种断言是**结构性假绿**，改坏了也不红（实测过）。
 *   · 也不能断言「两条正文不同的记录不撞键」—— 缓存键**本来就含正文**（key + \0 + text），
 *     所以正文不同时永远撞不上。那是我第一版测的方向，从根上测不到东西（也已实测）。
 *   · 真正可判定、且与真实浏览器一致的判据是：**同一键在已挂载之后再取，必须拿到不同的节点对象**。
 * ================================================================== */

test('已挂载的正文批次，再取同一键时必须拿到克隆体（否则真实浏览器里会互相搬空）', () => withDom(async () => {
  const dom = fakeDom();
  try {
    const md = await moduleFromSource('src/client/markdown.ts');
    md.clearSettledCache();
    const key = 'rec-key-collide';
    const text = '同一段 **正文**';
    const first = md.cachedMarkdownNodes(key, text);
    // 模拟：这批节点已经被挂到某个容器上（历史区那条记录）。
    const container = dom.document.createElement('div');
    for (const node of first) container.appendChild(node);
    // 现在第二个容器要用同一个键取同一段正文（例如两条记录正文恰好相同）。
    const second = md.cachedMarkdownNodes(key, text);
    const shared = first.filter(node => second.includes(node));
    assert.equal(shared.length, 0,
      '已挂载后再取同一键，返回了 ' + shared.length + '/' + first.length + ' 个**同一批**节点对象 —— '
      + '真实浏览器里第二个容器会把这些节点从第一个容器搬走（appendChild 是移动语义），用户看到前一处正文变空');
    assert.equal(second.length, first.length, '克隆体应当结构相同（节点数一致）');
    assert.ok((second.map(n => n.textContent || '').join('')).includes('正文'), '克隆体内容不得丢失');
    assert.equal(container.children.length, first.length, '第一个容器的节点不得被搬走');
  } finally { dom.restore(); }
}));

test('未挂载时仍返回同一批对象（保住「命中缓存不重解析」这条性能契约）', () => withDom(async () => {
  // 这一条与上一条是**两个相反方向**的约束，必须同时成立：
  //   已挂载 → 必须克隆（否则搬空）；
  //   未挂载 → 必须复用（否则每次重画都重解析，历史越多越卡）。
  // 只测其中一个方向，就会写出「把另一个方向改坏也发现不了」的测试。
  const dom = fakeDom();
  try {
    const md = await moduleFromSource('src/client/markdown.ts');
    md.clearSettledCache();
    const a = md.cachedMarkdownNodes('unmounted-key', '还没挂载的正文');
    const b = md.cachedMarkdownNodes('unmounted-key', '还没挂载的正文');
    assert.equal(b, a, '未挂载时应复用同一批节点（缓存生效），否则每次重画都会重新解析');
  } finally { dom.restore(); }
}));
