import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

const overlay = await moduleFromSource('src/client/overlay.tsx');
const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8');

function state(extra) {
  return Object.assign({
    sessionId: 's1', open: true, phase: 'idle', draft: '', reasoning: '', text: '', tools: [], records: [],
    hasEarlier: false, loadingEarlier: false, evidence: [], unread: false, occupancyKnown: false,
    quickQuestionsDismissed: false, catalog: { groups: [], failures: [] },
  }, extra || {});
}
function pluginSpy() {
  const updates = [];
  return {
    updates,
    plugin: {
      registry: { update: (id, patch) => updates.push({ id, patch }), close() {}, get: () => undefined },
      api: { selectModel: async () => ({}), models: async () => ({ payload: {} }) },
      submit: async () => {}, loadEarlier: async () => {}, cancel() {},
    },
  };
}
function withDom(run) {
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  return run(dom).finally(async () => { await new Promise(r => setTimeout(r, 20)); dom.restore(); });
}
function textOf(node) {
  let out = typeof node.textContent === 'string' ? node.textContent : '';
  for (const child of node.children || []) out += ' ' + textOf(child);
  return out;
}

/* ---------------- 上一版「不可用」的几条直接原因，逐条钉住 ---------------- */

// 上一版：33 个模型平铺成一个换行流，把浮窗整个吃掉，用户要滚很久才看得到输入框。
test('模型列表按提供方分组，并且整块是可折叠的', () => withDom(async dom => {
  const { plugin } = pluginSpy();
  const root = overlay.renderOverlay(state({
    catalog: { groups: [
      { provider: 'kimi-coding', displayName: 'Kimi', models: [{ provider: 'kimi-coding', id: 'k3', name: 'Kimi K3' }, { provider: 'kimi-coding', id: 'k3-256k', name: 'Kimi K3 256K' }] },
      { provider: 'workbuddy', displayName: 'WorkBuddy', models: [{ provider: 'workbuddy', id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] },
    ], failures: [] },
  }), plugin);
  const details = root.querySelectorAll('.ea-model-details');
  assert.equal(details.length, 1, '模型列表必须包在可折叠块里');
  // 默认必须是折叠的：一开就摊开 33 个模型会把「使用说明 + 快捷问题」顶出可视区，
  // 用户第一眼看到的是模型墙而不是「这窗口是干什么的」。
  assert.notEqual(details[0].getAttribute('data-open'), 'true', '模型列表必须默认折叠');
  // 但未选模型时摘要行必须是醒目的行动点，否则用户找不到去哪选（§7/§11.8）。
  assert.equal(details[0].getAttribute('data-unselected'), 'true', '未选模型时摘要行要标记成待选状态');
  const toggle = details[0].querySelectorAll('button')[0];
  assert.ok(/选择模型/.test(toggle.textContent), '未选模型时摘要行必须写明「选择模型」');
  assert.match(css, /\.ea-model-details\[data-unselected=true\] \.ea-model-summary\{[^}]*background/, '待选状态的摘要行必须醒目');
  // 点得开：原生 <details> 在真实浏览器里点不开，这里必须是自控按钮。
  toggle.click();
  const groups = root.querySelectorAll('.ea-model-group');
  assert.equal(groups.length, 2, '必须按 provider 分组，而不是平铺成一条流');
  assert.equal(root.querySelectorAll('.ea-model-option').length, 3, '每个模型一个可点按钮');
}));

// 上一版：占用圆环绝对定位在右下角，和「发送」按钮重叠。
test('占用圆环不再绝对定位压在输入区上，而是输入区里的一个普通格子', () => {
  const ringRule = css.match(/\.dsh-explain-assistant-ring\{[^}]*\}/);
  assert.ok(ringRule, '必须有占用圆环样式');
  assert.equal(/position\s*:\s*absolute/.test(ringRule[0]), false, '占用圆环不得再绝对定位，否则会和发送按钮重叠');
  assert.match(css, /\.ea-ring-slot\{[^}]*display:flex/, '圆环要有自己的格子');
  const composer = css.match(/\.dsh-explain-assistant-form\{[^}]*\}/);
  assert.ok(composer && /flex:0 0 auto/.test(composer[0]), '输入区必须固定，不随正文滚动');
});

// 上一版：没有正文滚动区和固定输入区的分层，滚动时按钮跟着跑。
test('正文可滚动、输入区固定，滚动位置在重画后保留', () => withDom(async dom => {
  const { plugin } = pluginSpy();
  const root = overlay.renderOverlay(state({ text: '第一段回答', records: [{ id: 'r1', question: 'q', answer: 'a', status: 'complete', createdAt: new Date().toISOString() }] }), plugin);
  const body = root.querySelectorAll('.dsh-explain-assistant-content')[0];
  assert.ok(body, '必须有正文滚动区');
  assert.match(css, /\.dsh-explain-assistant-content\{[^}]*overflow-y:auto/, '正文区必须自己滚动');
  body.scrollTop = 120;
  overlay.updateOverlay(root, state({ text: '第一段回答', records: [{ id: 'r1', question: 'q', answer: 'a', status: 'complete', createdAt: new Date().toISOString() }], phase: 'complete' }), plugin);
  assert.equal(body.scrollTop, 120, '重画不得把滚动位置重置回顶部');
}));

// 上一版：每个状态变化都整棵重建 DOM，打字时光标被顶到末尾、草稿被顶掉。
test('打字时输入框节点不重建，草稿不会被顶掉', () => withDom(async dom => {
  const { plugin, updates } = pluginSpy();
  const initial = state({ draft: '' });
  const root = overlay.renderOverlay(initial, plugin);
  const input = root.querySelectorAll('textarea')[0];
  assert.ok(input, '必须有输入框');
  // 模拟用户输入「它现在在干什么」
  input.value = '它现在在干什么';
  input.emit('input');
  assert.ok(updates.some(u => u.patch && u.patch.draft === '它现在在干什么'), '输入必须写回 registry.draft');
  // 状态随之更新（draft 变了），原地重画一次
  overlay.updateOverlay(root, state({ draft: '它现在在干什么' }), plugin);
  const sameInput = root.querySelectorAll('textarea')[0];
  assert.equal(sameInput, input, '重画必须复用同一个输入框节点，否则光标会被顶到末尾');
  assert.equal(sameInput.value, '它现在在干什么', '草稿不得被重画冲掉');
}));

// 上一版：标题栏把三个按钮和标题挤在一行，文字被压、按钮贴边。
test('标题栏有独立操作区，关闭按钮不再贴边', () => {
  assert.match(css, /\.ea-header-actions\{[^}]*flex:0 0 auto/, '标题栏操作区不得被压缩');
  assert.match(css, /\.dsh-explain-assistant-status\{[^}]*text-overflow:ellipsis/, '状态文字过长要省略，而不是把按钮挤出去');
});

// 上一版：没有运行中的可见反馈——点了发送只看到按钮变成「处理中」。
test('运行中显示进度提示，并提供「停止」', () => withDom(async dom => {
  const { plugin } = pluginSpy();
  const root = overlay.renderOverlay(state({ phase: 'running' }), plugin);
  const text = textOf(root);
  assert.ok(text.includes('正在解释'), '运行中必须有中文进度提示');
  const labels = root.querySelectorAll('button').map(b => b.getAttribute('aria-label'));
  assert.ok(labels.includes('停止本次解释'), '运行中必须能停');
}));

// 第一次打开必须一眼知道这里能干什么。
test('首次打开给出中文引导，说明怎么选内容和能问什么', () => withDom(async dom => {
  const { plugin } = pluginSpy();
  const root = overlay.renderOverlay(state({}), plugin);
  const text = textOf(root);
  assert.ok(text.includes('小助手在旁边看着主 agent'), '首开必须有用途说明');
  assert.ok(text.includes('选择主对话内容'), '首开必须点明选择入口');
}));
