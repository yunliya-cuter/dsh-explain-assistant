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
// 新版把模型选择搬到**独立的选择页**：对话页上不再常驻任何模型列表，
// 入口是标题栏那个 .ea-model-trigger，点开才切到 data-view=model。
test('模型列表按提供方分组，并且整块是可折叠的', () => withDom(async dom => {
  const { plugin } = pluginSpy();
  const root = overlay.renderOverlay(state({
    catalog: { groups: [
      { provider: 'kimi-coding', displayName: 'Kimi', models: [{ provider: 'kimi-coding', id: 'k3', name: 'Kimi K3' }, { provider: 'kimi-coding', id: 'k3-256k', name: 'Kimi K3 256K' }] },
      { provider: 'workbuddy', displayName: 'WorkBuddy', models: [{ provider: 'workbuddy', id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] },
    ], failures: [] },
  }), plugin);

  // ── 对话页上不该常驻模型列表（这就是「可折叠」在新版里的等价形态，且更强）──
  assert.equal(root.getAttribute('data-view'), 'chat', '默认必须是对话页');
  assert.equal(root.querySelectorAll('.ea-model-option').length, 0,
    '对话页上不得常驻模型选项（33 个平铺把浮窗吃掉正是上一版的病）');
  // 找不到入口 = 用户仍不知道该去哪选，所以入口本身必须醒目且可读。
  const trigger = root.querySelectorAll('.ea-model-trigger')[0];
  assert.ok(trigger, '首屏必须有模型入口 .ea-model-trigger');
  assert.equal(trigger.getAttribute('data-unselected'), 'true', '未选模型时入口要标记成待选状态');
  assert.ok(/选择模型/.test(trigger.textContent), '未选模型时入口必须写明「选择模型」');
  // 醒目 = 实心主色；这条同时钉住「待选状态真的被样式接住了」，不只是加了个属性。
  assert.match(css, /\.ea-model-trigger\[data-unselected=true\]\{[^}]*background/, '待选状态的入口必须醒目（有 background）');

  // ── 点开：切到选择页，且真的按 provider 分组、每个模型一个可点按钮 ──
  trigger.click();
  assert.equal(root.getAttribute('data-view'), 'model', '点入口必须切到模型选择页');
  const groups = root.querySelectorAll('.ea-model-group');
  assert.equal(groups.length, 2, '必须按 provider 分组，而不是平铺成一条流');
  assert.equal(root.querySelectorAll('.ea-model-option').length, 3, '每个模型一个可点按钮');
  // 关掉要整棵摘掉：不是用 CSS 藏起来（藏起来会让别的页读到不属于它的文案）。
  const back = root.querySelectorAll('.ea-model-panel-back')[0];
  assert.ok(back, '选择页必须有「← 返回」');
  back.click();
  assert.equal(root.getAttribute('data-view'), 'chat', '返回后必须回到对话页');
  assert.equal(root.querySelectorAll('.ea-model-option').length, 0, '关掉后选择页必须整棵从 DOM 摘掉');
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
//
// 本轮改版后标题栏多了一个模型按钮，宽度策略随之变了，判据也要跟着改准：
//   · 操作区**整体**变成 flex:0 1 auto（可缩，但 priority 低于状态文字）—— 不再是 0 0 auto；
//   · 真正保证「按钮不被压扁」的是**每一条**非模型按钮 flex:0 0 auto 的规则：
//     只有模型按钮允许缩（它的标签是模型 id，可能很长，靠省略号收尾）。
// 旧断言 flex:0 0 auto 若只是删掉，「按钮不被压扁」就没人守了 —— 所以这里换成
// 「整体可缩 + 其余按钮不可缩」这一对，强度不降反升（旧版根本没覆盖「谁可以缩」）。
test('标题栏有独立操作区，关闭按钮不再贴边', () => {
  const actions = css.match(/\.ea-header-actions\{[^}]*\}/);
  assert.ok(actions, '必须有标题栏操作区样式 .ea-header-actions');
  assert.match(actions[0], /flex:\s*0 1 auto/, '操作区整体必须可缩（flex:0 1 auto），否则模型按钮的长文本会把标题栏撑爆');
  assert.match(actions[0], /min-width:\s*0/, '操作区必须有 min-width:0，否则 flex 子项不会真正收缩');
  // 关键一条：除模型按钮外的每个按钮 + 关闭按钮都必须不可缩 —— 这才是「不被压扁」的实现处。
  //
  // 注意选择器是**逗号并列**的一条规则（不是两条）：
  //   .ea-header-actions > .ea-btn:not(.ea-model-trigger),
  //   .ea-header-actions > .dsh-explain-assistant-close{flex:0 0 auto}
  // 所以正则里用 [^{]* 吃掉逗号与换行，不能要求选择器后面紧跟 "{" ——
  // 那样会对着一份**正确的** CSS 报红（我第一版就这么红了一次）。
  assert.match(css, /\.ea-header-actions\s*>\s*\.ea-btn:not\(\.ea-model-trigger\)[^{]*\{[^}]*flex:\s*0 0 auto/,
    '除模型按钮外的按钮必须 flex:0 0 auto（不得被压扁）');
  assert.match(css, /\.ea-header-actions\s*>\s*\.dsh-explain-assistant-close[^{]*\{[^}]*flex:\s*0 0 auto/,
    '关闭按钮必须 flex:0 0 auto（不得被压扁、不得贴边）');
  // 反向钉子：模型按钮**不得**被写进「不可缩」那一组，否则长模型名会把标题栏顶开。
  assert.ok(!/\.ea-btn:not\(\.ea-model-trigger\)[^{]*\.ea-model-trigger[^{]*\{/.test(css),
    '模型按钮不得出现在「不可缩」选择器里');
  // 模型按钮自己只在标签上省略，不参与「不可缩」那一组 —— 否则长模型名会把标题栏顶开。
  assert.match(css, /\.ea-model-trigger-label\{[^}]*text-overflow:ellipsis/,
    '模型按钮的标签必须自己省略（它是唯一允许被压缩的那一个）');
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
