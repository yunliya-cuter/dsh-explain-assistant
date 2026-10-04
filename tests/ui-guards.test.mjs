import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const overlaySource = readFileSync(join(root, 'src/client/overlay.tsx'), 'utf8');
const cssSource = readFileSync(join(root, 'src/client/styles.css'), 'utf8');

// A11 §9.2：必须是圆环（SVG），不是一行文字。
test('存在 SVG 圆环实现，用 stroke-dasharray 表达百分比', () => {
  assert.match(overlaySource, /createElementNS/, '必须用 createElementNS 创建 SVG');
  assert.match(overlaySource, /'svg'|\"svg\"/, '必须创建 svg 元素');
  assert.match(overlaySource, /stroke-dasharray/, '必须用 stroke-dasharray 表示占用比例');
  assert.match(cssSource, /dsh-explain-assistant-ring/, '圆环必须有样式');
});

// A11 §9.2：推算值要标「估算」。
test('推算出来的占用要标「估算」', () => {
  assert.match(overlaySource, /估算/, '必须有「估算」标识');
  assert.match(cssSource, /ring-estimated/, '估算态必须有样式');
});

// A3 §4：首次打开要有中文快捷问题。
test('首次打开提供中文快捷问题，且点过就不再自动展示', () => {
  assert.match(overlaySource, /它现在在干什么/, '必须包含文档举例的快捷问题');
  const quoted = overlaySource.match(/QUICK_QUESTIONS = \[([^\]]*)\]/);
  assert.ok(quoted, '必须有快捷问题清单常量');
  assert.ok((quoted[1].match(/'/g) || []).length >= 4, '至少两个快捷问题');
  assert.match(overlaySource, /quickQuestionsDismissed/, '必须有「点过不再展示」的标记');
});

// A10 §7/§11.8：模型可单独选择，未选时要提示。
test('模型列表可点选并调用 selectModel；未选时给出中文提示', () => {
  assert.match(overlaySource, /selectModel/, '必须能调用 selectModel');
  assert.match(overlaySource, /还没有选择模型/, '未选模型时必须提示用户去选');
  assert.match(overlaySource, /模型列表|aria-label.*模型/, '模型列表要有无障碍标签');
});

// FakeElement 的 parentElement 会形成循环引用，不能用 JSON.stringify 取文本。
function textOf(node) {
  if (!node) return '';
  let text = typeof node.textContent === 'string' ? node.textContent : '';
  const attrs = node.attributes instanceof Map ? [...node.attributes.values()].join(' ') : '';
  const children = Array.isArray(node.children) ? node.children.map(textOf).join('') : '';
  return [text, attrs, children].join(' ');
}

// 真实行为：直接把 renderOverlay 跑起来，检查圆环在两种状态下渲染出什么。
let overlayModule;
async function render(state) {
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  const module = overlayModule ?? (overlayModule = await moduleFromSource('src/client/overlay.tsx'));
  const updates = [];
  const plugin = {
    registry: { update: (id, patch) => updates.push({ id, patch }), close: () => {}, get: () => state },
    api: { selectModel: async () => ({}), models: async () => ({ payload: {} }) },
    submit: async () => {},
  };
  const node = module.renderOverlay(state, plugin);
  return { node, dom, updates };
}

function baseState(extra) {
  return Object.assign({
    sessionId: 's1', open: true, phase: 'idle', draft: '', reasoning: '', text: '', tools: [], records: [],
    hasEarlier: false, loadingEarlier: false, evidence: [], unread: false, occupancyKnown: false,
    quickQuestionsDismissed: false, catalog: { groups: [], failures: [] },
  }, extra || {});
}

test('占用未知时渲染的是「占用未知」，绝不出现编造的百分比', async () => {
  const { node, dom } = await render(baseState({ occupancyKnown: false }));
  try {
    const ring = node.querySelectorAll('.dsh-explain-assistant-ring');
    assert.equal(ring.length, 1, '右下角必须有且只有一个占用圆环');
    const text = textOf(ring[0]);
    assert.ok(text.includes('占用未知'), '未知时必须显示中文「占用未知」');
    assert.equal(/\d+%/.test(text), false, '未知时不得渲染任何百分比数字');
    assert.equal(ring[0].getAttribute('data-unknown'), 'true');
  } finally { dom.restore(); }
});

test('占用已知时渲染百分比，且估算态打上估算标记', async () => {
  const { node, dom } = await render(baseState({ occupancyKnown: true, occupancy: 42, occupancyEstimated: true }));
  try {
    const ring = node.querySelectorAll('.dsh-explain-assistant-ring');
    const text = textOf(ring[0]);
    assert.ok(text.includes('42%'), '已知时必须渲染出百分比');
    assert.ok(text.includes('估算'), '估算态必须标注');
    assert.equal(ring[0].getAttribute('data-estimated'), 'true');
  } finally { dom.restore(); }
});

/* ---------------- 0.2：悬停显示「这份上下文由哪两块构成」 ---------------- */

test('0.2: 有构成数据时，圆环悬停提示同时给出两块的数量与占比', async () => {
  const { node, dom } = await render(baseState({
    occupancyKnown: true, occupancy: 42, occupancyEstimated: true,
    occupancyParts: { mainAgentTokens: 1200, mainAgentChars: 4800, ownTokens: 3400, ownChars: 13600, mainAgentEvents: 6 },
  }));
  try {
    const ring = node.querySelectorAll('.dsh-explain-assistant-ring')[0];
    const title = ring.getAttribute('title');
    assert.ok(title, '必须设置悬停提示（此前这个圆环完全没有 title，鼠标放上去什么都不显示）');
    assert.match(title, /主 agent 转移 1\.2k/, '必须给出主 agent 转移的量');
    assert.match(title, /小助手对话 3\.4k/, '必须给出小助手对话的量');
    assert.match(title, /约 26% \/ 74%/, '必须给出两部分占比，且加起来是 100%');
    // 无障碍标签必须与悬停提示同源：读屏用户拿不到 title。
    const aria = ring.getAttribute('aria-label');
    assert.match(aria, /主 agent 转移 1\.2k/, 'aria-label 必须带上同一份构成');
  } finally { dom.restore(); }
});

test('0.2 反例: 没有构成数据时不得设置悬停提示（宁可不显示，也不编造）', async () => {
  const { node, dom } = await render(baseState({ occupancyKnown: true, occupancy: 42 }));
  try {
    const ring = node.querySelectorAll('.dsh-explain-assistant-ring')[0];
    assert.equal(ring.getAttribute('title'), null, '拿不到构成时不得编造一个悬停提示');
    assert.equal(/主 agent 转移/.test(ring.getAttribute('aria-label') || ''), false, 'aria-label 也不得编造构成');
  } finally { dom.restore(); }
});

test('0.2 反例: 两块都是 0 时不显示构成（0/0 的比例没有意义）', async () => {
  const { node, dom } = await render(baseState({
    occupancyKnown: true, occupancy: 0,
    occupancyParts: { mainAgentTokens: 0, mainAgentChars: 0, ownTokens: 0, ownChars: 0 },
  }));
  try {
    const ring = node.querySelectorAll('.dsh-explain-assistant-ring')[0];
    assert.equal(ring.getAttribute('title'), null, '总量为 0 时不该给出 0%/100% 这种假比例');
  } finally { dom.restore(); }
});

test('0.2: 主 agent 段被截断时，悬停提示要如实说明', async () => {
  const { node, dom } = await render(baseState({
    occupancyKnown: true, occupancy: 60, occupancyEstimated: true,
    occupancyParts: { mainAgentTokens: 15000, mainAgentChars: 60000, ownTokens: 500, ownChars: 2000, mainlineTruncated: true },
  }));
  try {
    const ring = node.querySelectorAll('.dsh-explain-assistant-ring')[0];
    assert.match(ring.getAttribute('title'), /已截断/, '截断过就必须说，不能让用户以为看到的是全部');
  } finally { dom.restore(); }
});

test('首个打开渲染快捷问题按钮；标记已点过后不再渲染', async () => {
  const first = await render(baseState({ quickQuestionsDismissed: false }));
  try {
    assert.equal(first.node.querySelectorAll('.dsh-explain-assistant-quick').length, 1, '首次打开要有快捷问题区');
  } finally { first.dom.restore(); }
  const later = await render(baseState({ quickQuestionsDismissed: true }));
  try {
    assert.equal(later.node.querySelectorAll('.dsh-explain-assistant-quick').length, 0, '点过之后不再自动展示');
  } finally { later.dom.restore(); }
});

test('空模型目录时给出中文提示，而不是空白', async () => {
  const { node, dom } = await render(baseState({ catalog: { groups: [], failures: [] } }));
  try {
    // 空目录时列表没有内容，展开后必须给出中文提示而不是空白。
    node.querySelectorAll('button').find(b => /点这里选择模型|换一个模型/.test(b.textContent || ''))?.click();
    const text = textOf(node.querySelectorAll('.dsh-explain-assistant-model')[0]);
    assert.ok(text.includes('暂时没有可用的模型'), '空目录必须有中文提示');
  } finally { dom.restore(); }
});
