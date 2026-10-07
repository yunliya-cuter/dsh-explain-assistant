import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fakeDom, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 「模型文本面」全量闸（task-40）。
 *
 * 背景：verify-3082 页面实测发现 src/client/overlay.tsx:446 的历史列表推理区
 * 是**唯一一处**裸文本渲染（el('div', { class: 'ea-disclosure-body', text: reasoning })），
 * 导致用户点开「这次回答的推理过程」看到成段的裸露列表记号。
 * 同一份 reasoning 在详情面板（512 行）却能正常解析。
 *
 * 为什么不是「补一条只针对 446 的用例」：那样下次谁再加一处裸文本渲染，闸不会红。
 * 所以这里把**所有承载模型写出文本的容器**列成一张表，逐项断言。
 *
 * ── 判据的更正（2026-07，Lead 复核 verify-3082 的页面证据后推翻了我最初的判据）──
 * 我最初把 **ea-md-scope** 当成「有没有走渲染器」的判据，这是**错的**：
 *   已部署产物里 ea-record-answer **没有** ea-md-scope，页面上却解析得好好的；
 *   而 compact[0] **有** ea-md-scope。所以这个类**既不必要也不充分** ——
 *   它只是**样式作用域**标记，不是「有没有解析」的判据。
 * 真正的判据是：
 *   ① **主判据**：子节点来自渲染器（出现 .ea-md-* 结构节点），且**没有纯文本子节点**；
 *   ② ea-md-scope 只是本仓库的**约定标记**，顺带断言（它让这些面可被机械枚举），
 *      但**断言它成立 ≠ 内容被解析**，所以它放在主判据之后、且措辞明确为约定。
 * 「带类 + 裸文本」必须被判为**不合格** —— 见下方负向控制那条用例。
 * 将来新增一处裸文本渲染：容器没有结构节点 / 有纯文本子节点 → 本文件红。
 */

const overlay = await moduleFromSource('src/client/overlay.tsx');
const SOURCE = await readFile(new URL('../src/client/overlay.tsx', import.meta.url), 'utf8');
const NL = String.fromCharCode(10);

const MD = [
  '# 结论标题',
  '',
  '- 第一条依据',
  '- 第二条依据',
  '',
  '正文 **加粗** 与 *斜体*。',
  '',
  '> 一段引用',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '[链接](https://example.com)',
].join(NL);

function state(extra) {
  return Object.assign({
    sessionId: 's1', open: true, phase: 'idle', draft: '', reasoning: '', text: '', tools: [], records: [],
    hasEarlier: false, loadingEarlier: false, evidence: [], unread: false, occupancyKnown: false,
    quickQuestionsDismissed: true, catalog: { groups: [], failures: [] },
  }, extra || {});
}
function plugin(st) {
  return { registry: { update() {}, get: () => st, close() {} }, api: {}, cancel() {},
    submit: async () => {}, loadEarlier: async () => {}, openHistoryDetail: async () => {}, closeHistoryDetail: () => {} };
}
/** 渲染出一个面板，返回根元素。 */
function render(st) { return overlay.renderOverlay(st, plugin(st)); }

/**
 * 按类名找第一个后代（包含自身）。
 * 不用 querySelectorAll 是因为假 DOM 只支持单一简单选择器，
 * 不支持后代组合（'.a .b'）。
 */
function byClass(root, name) {
  if (!root) return null;
  const has = el => String(el.className || '').split(/\s+/).includes(name);
  if (has(root)) return root;
  for (const child of root.children) {
    const found = byClass(child, name);
    if (found) return found;
  }
  return null;
}
/**
 * 断言：该容器里的模型文本**确实走了渲染器**。
 *
 * 判据顺序刻意如此 —— **主判据是「子节点来自渲染器」**，不是「带了某个 class」：
 *   1. 必须出现 .ea-md-* 结构节点（渲染器的产物）；
 *   2. 不得有**纯文本子节点**（裸文本渲染的特征）。
 * ea-md-scope 作为本仓库的**约定标记**顺带断言，措辞上明确它不等于「已解析」：
 * 「带类但内容是裸文本」必须被判为不合格（见负向控制用例）。
 */
function assertMarkdownized(container, label) {
  assert.ok(container, label + '：容器必须存在');
  // 假 DOM 的 matches() 只支持 .class / [attr] / 标签名，不支持 [class^=] 这类属性运算符，
  // 所以这里手动遍历（顺便也更直接地表达「子节点来自渲染器」这件事）。
  const structures = [];
  const walk = el => {
    for (const child of el.children) {
      if (/(^|\s)ea-md-/.test(String(child.className || ''))) structures.push(child);
      walk(child);
    }
  };
  walk(container);
  // ① 主判据
  assert.ok(structures.length > 0,
    label + '：模型文本必须走 Markdown 渲染器（子节点里应出现 .ea-md-* 结构节点）。'
    + '「带了 class」不算解析 —— 实际子节点 = '
    + JSON.stringify(container.children.map(c => c.className || c.tagName)));
  const textChildren = container.children.filter(c => c.tagName === '#TEXT' || (String(c.tagName || '').startsWith('#') && !String(c.className || '')));
  assert.equal(textChildren.length, 0,
    label + '：不得有纯文本子节点（这是裸文本渲染的特征，说明内容没被解析）');
  // ② 约定标记（顺带断言；它只是为了可机械枚举，不构成「已解析」的证据）
  const classes = String(container.className || '').split(/\s+/);
  assert.ok(classes.includes('ea-md-scope'),
    label + '：按本仓库约定，承载模型文本的容器应带 ea-md-scope 标记'
    + '（注意：这只是样式作用域约定，**不能**作为「已解析」的判据；实际 class="' + container.className + '"）');
}

/* ================================================================== *
 * 一张表：所有承载模型写出文本的容器
 *   [标签, 渲染出的根, 定位容器的选择器]
 * ================================================================== */

function surfaces() {
  return [
    {
      label: '历史列表 · 回答正文（overlay.tsx:443）',
      root: render(state({ records: [{ id: 'r1', question: '问', answerText: MD, reasoningText: MD }] })),
      locate: r => byClass(r, 'ea-record-answer'),
    },
    {
      label: '历史列表 · 推理过程（overlay.tsx:446，本次修的缺陷）',
      root: render(state({ records: [{ id: 'r1', question: '问', answerText: MD, reasoningText: MD }] })),
      locate: r => byClass(r, 'ea-disclosure-body'),
    },
    {
      label: '实时推理（overlay.tsx:120）',
      root: render(state({ phase: 'running', reasoning: MD })),
      locate: r => byClass(r, 'ea-disclosure-body'),
    },
    {
      label: '详情面板 · 回答正文（overlay.tsx:515）',
      root: render(state({ historyDetail: { recordId: 'r1', status: 'ready', record: { question: '问', answerText: MD, reasoningText: MD }, counts: {} } })),
      locate: r => byClass(r, 'ea-detail-answer'),
    },
    {
      label: '详情面板 · 推理过程（overlay.tsx:512）',
      root: render(state({ historyDetail: { recordId: 'r1', status: 'ready', record: { question: '问', answerText: MD, reasoningText: MD }, counts: {} } })),
      locate: r => byClass(byClass(r, 'ea-detail'), 'ea-disclosure-body'),
    },
    {
      label: '压缩摘要（overlay.tsx:327）',
      root: render(state({ compactState: { summary: MD, updatedAt: '2026-01-01' } })),
      locate: r => byClass(r, 'ea-compact-summary'),
    },
  ];
}

test('[负向控制] 「带 ea-md-scope 但内容是裸文本」必须被拒绝（类不等于已解析）', () => {
  // 这条把 verify-3082 的页面更正固化成了可执行检查。
  // 已部署产物证明：ea-md-scope **既不必要也不充分** ——
  //   · ea-record-answer 没有这个类，页面上却解析得好好的（不必要）；
  //   · 所以「加了类」当然也不能证明解析过（不充分）。
  // 若哪天有人用「补个 class 就算修好」来糊弄，这条会红。
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    container.className = 'ea-disclosure-body ea-md-scope';   // ← 类齐全
    container.textContent = '- 甲' + NL + '- 乙';             // ← 但内容是裸文本
    assert.throws(() => assertMarkdownized(container, '带类的裸文本容器'),
      /必须走 Markdown 渲染器/,
      '带 ea-md-scope 但内容是裸文本的容器必须被拒绝 —— 否则说明这个闸是被 class 撑着的');
  } finally { dom.restore(); }
});

test('[负向控制] 走渲染器但**没带** ea-md-scope，主判据仍应通过（类不必要）', () => {
  // 反向：把 ea-md-scope 从渲染结果上摘掉，主判据（子节点来自渲染器）仍必须成立。
  // 这证明判据不是被 class 撑着的，而是真的看子节点结构。
  const dom = fakeDom();
  try {
    const root = render(state({ records: [{ id: 'r1', question: '问', reasoningText: MD }] }));
    const body = root.querySelector('.ea-disclosure-body');
    body.className = 'ea-disclosure-body';        // 摘掉约定标记
    const structures = [];
    const walk = el => {
      for (const child of el.children) {
        if (/(^|\s)ea-md-/.test(String(child.className || ''))) structures.push(child);
        walk(child);
      }
    };
    walk(body);
    assert.ok(structures.length > 0, '主判据只看子节点结构：摘掉 class 后仍应看出「已解析」');
  } finally { dom.restore(); }
});

test('[全量面] 所有承载模型文本的容器都必须走渲染器（子节点来自渲染器 + 无纯文本子节点）', () => {
  const dom = fakeDom();
  try {
    for (const item of surfaces()) {
      assertMarkdownized(item.locate(item.root), item.label);
    }
  } finally { dom.restore(); }
});

test('[全量面] 控制组：模型文本确实被解析成了结构节点（不是「碰巧有 class」）', () => {
  const dom = fakeDom();
  try {
    const root = render(state({ records: [{ id: 'r1', question: '问', answerText: MD, reasoningText: MD }] }));
    const body = root.querySelector('.ea-disclosure-body');
    assertMarkdownized(body, '历史列表 · 推理过程');
    // 不只是有 class —— 内容必须真的被解析：列表记号变成了 ul/li，标题变成了 h 系列。
    assert.ok(body.querySelectorAll('ul').length > 0, '列表记号必须变成 ul（裸文本时 ul=0）');
    assert.ok(body.querySelectorAll('li').length >= 2, '两个列表项必须变成两个 li');
    assert.ok(body.querySelectorAll('pre').length > 0, '代码围栏必须变成 pre');
    assert.equal(body.children.filter(c => c.tagName === '#TEXT').length, 0,
      '不得再有纯文本子节点（裸文本渲染的特征）');
  } finally { dom.restore(); }
});
