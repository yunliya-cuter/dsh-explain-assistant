import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDom, FakeElement, moduleFromSource, settle } from './fixtures/runtime.mjs';

const overlay = await moduleFromSource('src/client/overlay.tsx');
const marks = await moduleFromSource('src/client/pick-marks.ts');
const client = await moduleFromSource('src/client/index.ts');

/**
 * 选择主对话内容的三个用户问题（本轮原话）：
 *   1. 选中后怎么表示「这条被选中了」；
 *   2. 怎么取消，更直观；
 *   3. 每次问完一个问题后自动重置。
 *
 * 这里钉的是**界面与数据链**上的可验证事实，不是「代码里写了什么」：
 * 标签的中文类型、× 只取消那一条、退场不是瞬间消失、主对话卡片上的锚点、
 * 以及回答落地后自动清空（失败不clear）。
 */

function state(extra) {
  return Object.assign({
    sessionId: 's1', open: true, phase: 'idle', draft: '', reasoning: '', text: '', tools: [], records: [],
    hasEarlier: false, loadingEarlier: false, evidence: [], unread: false, occupancyKnown: false,
    quickQuestionsDismissed: false, catalog: { groups: [], failures: [] }, stateReady: true,
  }, extra || {});
}

/** 一个真的会改状态的 registry：update 支持「传函数」这种写法（生产代码就用它）。 */
function pluginWith(current) {
  const updates = [];
  return {
    updates,
    plugin: {
      registry: {
        update: (id, patch) => { updates.push({ id, patch }); if (typeof patch === 'function') patch(current); else Object.assign(current, patch); },
        get: () => current,
        close() {},
      },
      api: { selectModel: async () => ({}), models: async () => ({ payload: {} }) },
      submit: async () => {}, loadEarlier: async () => {}, cancel() {},
    },
  };
}

function withDom(run) {
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  return run(dom).finally(async () => { await settle(20); dom.restore(); });
}

const picked = { id: 'k1', pickId: 'p1', title: 'assistant-step', summary: '做完了：把页面写好了，单文件，无外链。', evidenceState: 'reported_only' };
const pickedTool = { id: 'k2', pickId: 'p2', title: 'bash', summary: 'npm run build 通过', evidenceState: 'observed' };

/* ---------------- 1. 选中怎么表示 ---------------- */

test('输入框上方每条一个标签：中文类型 + 摘要 + 编号，不露宿主英文标识', () => withDom(async dom => {
  const current = state({ evidence: [picked, pickedTool] });
  const { plugin } = pluginWith(current);
  const root = overlay.renderOverlay(state({ evidence: [picked, pickedTool] }), plugin);
  const chips = root.querySelectorAll('.ea-pick-chip');
  assert.equal(chips.length, 2, '两条选择 = 两个标签');
  const text = chips.map(chip => chip.textContent).join(' | ');
  assert.ok(/助手汇报/.test(text), 'assistant-step 必须翻成「助手汇报」');
  assert.equal(/assistant-step/.test(root.querySelector('.ea-target-bar').textContent), false, '界面上不得出现宿主英文标识');
  assert.ok(/工具 · bash/.test(text), '工具卡片要写明是哪件工具');
  assert.ok(/做完了/.test(text), '标签里要带摘要，用户才认得出是哪条');
  assert.equal(chips[0].getAttribute('data-tier'), 'reported', '分级要在标签上分得出来（§6.3）');
  assert.equal(root.querySelector('.ea-target-bar').getAttribute('data-has-target'), 'true');
}));

test('明细默认收起：不再用 4000 字原文把答案顶出可视区', () => withDom(async dom => {
  const current = state({ evidence: [picked] });
  const { plugin } = pluginWith(current);
  const root = overlay.renderOverlay(state({ evidence: [picked] }), plugin);
  const fold = root.querySelectorAll('.ea-evidence-details')[0];
  assert.ok(fold, '明细仍在（分级与原文要查得到）');
  assert.equal(fold.hasAttribute('open'), false, '默认必须是收起的');
}));

test('没有选择时不留空条', () => withDom(async dom => {
  const current = state();
  const { plugin } = pluginWith(current);
  const root = overlay.renderOverlay(state(), plugin);
  assert.equal(root.querySelectorAll('.ea-pick-chip').length, 0);
  assert.notEqual(root.querySelector('.ea-target-bar').getAttribute('data-has-target'), 'true');
}));

/* ---------------- 2. 怎么取消 ---------------- */

test('点标签上的 × 只取消这一条，其他选择留着', () => withDom(async dom => {
  const current = state({ evidence: [picked, pickedTool] });
  const { plugin } = pluginWith(current);
  const root = overlay.renderOverlay(state({ evidence: [picked, pickedTool] }), plugin);
  const remove = root.querySelectorAll('.ea-pick-chip')[0].querySelectorAll('.ea-pick-remove')[0];
  assert.ok(remove, '每个标签上必须有一个 ×');
  remove.click();
  assert.equal(current.evidence.length, 1, '只应移除一条');
  assert.equal(current.evidence[0].pickId, 'p2', '留下的必须是另一条（按锚点删，不按 id）');
}));

test('取消后标签先淡出再摘，不是瞬间消失', () => withDom(async dom => {
  const current = state({ evidence: [picked] });
  const { plugin } = pluginWith(current);
  const root = overlay.renderOverlay(state({ evidence: [picked] }), plugin);
  const row = root.querySelector('.ea-target-bar');
  // 模拟「回答落地后自动清空」
  current.evidence = [];
  overlay.updateOverlay(root, state({ evidence: [] }), plugin);
  const chip = row.querySelectorAll('.ea-pick-chip')[0];
  assert.ok(chip, '退场动画期间节点必须还在（上一轮的教训：摘早了就是啪一下）');
  assert.equal(chip.getAttribute('data-leaving'), 'true', '退场要先挂标记，让 CSS 播完');
  assert.equal(row.getAttribute('data-has-target'), 'true', '还有标签在退场时，整行不能先收起来');
  await settle(260);
  assert.equal(row.querySelectorAll('.ea-pick-chip').length, 0, '播完必须真的摘掉');
  assert.equal(row.getAttribute('data-has-target'), 'false', '最后一条走了，整行收起');
}));

/* ---------------- 主对话卡片上的标记 ---------------- */

function chatWithCard(key) {
  const doc = new FakeElement('div');
  const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
  const card = new FakeElement('div'); card.setAttribute('data-chat-node-key', key); card.textContent = '一段内容';
  chat.appendChild(card); doc.appendChild(chat);
  return { doc, card };
}

test('选中后主对话那张卡片本身带上锚点与编号', () => {
  const { doc, card } = chatWithCard('k1');
  marks.syncPickMarks(doc, [{ id: 'k1', pickId: 'p1' }]);
  assert.equal(card.getAttribute('data-ea-picked'), 'p1', '卡片必须被标出来（上一版这里一个像素都不变）');
  assert.equal(card.getAttribute('data-ea-pick-index'), '1', '编号要和输入框上方标签对得上');
  assert.equal(card.getAttribute('data-ea-pick'), 'p1', '锚点写回卡片，后续重绘才找得到');
});

test('取消时先挂 leaving 再摘，主对话的高亮是淡出的', async () => {
  const { doc, card } = chatWithCard('k1');
  marks.syncPickMarks(doc, [{ id: 'k1', pickId: 'p1' }]);
  marks.syncPickMarks(doc, []);
  assert.equal(card.getAttribute('data-ea-picked'), 'leaving', '不能立刻摘：CSS 过渡只存在于带属性的一侧');
  await settle(280);
  assert.equal(card.hasAttribute('data-ea-picked'), false, '播完必须摘干净，不能留一个假高亮');
  assert.equal(card.hasAttribute('data-ea-pick-index'), false);
});

test('宿主重绘换了节点：按会话键找回来，但键不唯一时宁可不画', () => {
  // 唯一键 → 找回来
  const one = chatWithCard('k9');
  marks.syncPickMarks(one.doc, [{ id: 'k9', pickId: 'p9' }]);
  const replacement = new FakeElement('div'); replacement.setAttribute('data-chat-node-key', 'k9');
  one.doc.querySelectorAll('[data-conversation-scroll]')[0].replaceChildren(replacement);
  marks.syncPickMarks(one.doc, [{ id: 'k9', pickId: 'p9' }]);
  assert.equal(replacement.getAttribute('data-ea-picked'), 'p9', '锚点随旧节点消失后，唯一键要能找回来');
  // 重复键 → 一个都不画（实测真实 DOM 里有重复键）
  const dup = chatWithCard('k9');
  const second = new FakeElement('div'); second.setAttribute('data-chat-node-key', 'k9');
  dup.doc.querySelectorAll('[data-conversation-scroll]')[0].appendChild(second);
  marks.syncPickMarks(dup.doc, [{ id: 'k9', pickId: 'p9' }]);
  assert.equal(dup.card.hasAttribute('data-ea-picked'), false, '键不唯一时不能瞎挑一个画上去');
  assert.equal(second.hasAttribute('data-ea-picked'), false);
});

test('没有锚点的依据（例如历史里回放出来的）不往主对话上画', () => {
  const { doc, card } = chatWithCard('k1');
  marks.syncPickMarks(doc, [{ id: 'k1' }]);
  assert.equal(card.hasAttribute('data-ea-picked'), false);
});

/* ---------------- 3. 问完自动重置 ---------------- */

function apiStub(overrides = {}) {
  return Object.assign({
    state: async () => ({ payload: {} }),
    ask: async (id, question, signal, evidence, emit) => {
      emit({ type: 'start', data: { requestId: 'r1' }, envelope: {} });
      emit({ type: 'text', data: { delta: '答案' }, envelope: {} });
      emit({ type: 'complete', data: {}, envelope: {} });
    },
    compact: async (id, signal, emit) => { emit({ type: 'complete', data: {}, envelope: {} }); },
    cancel: async () => ({}),
    geometry: async () => ({}),
    markRead: async () => ({}),
    history: async () => ({ payload: { records: [] } }),
    models: async () => ({ payload: {} }),
  }, overrides);
}

test('回答落地后自动清空这一问用掉的选择（用户不用手动取消）', async () => {
  const seen = [];
  const api = apiStub({ ask: async (id, question, signal, evidence, emit) => { seen.push(evidence.map(item => item.pickId)); emit({ type: 'start', data: { requestId: 'r1' }, envelope: {} }); emit({ type: 'complete', data: {}, envelope: {} }); } });
  const plugin = client.createClientPlugin({ api, session: { id: 'pick-reset' } });
  try {
    plugin.registry.update('pick-reset', { evidence: [{ id: 'k1', pickId: 'p1', title: 'assistant-step', summary: 'x' }] });
    await plugin.submit('这一步在干什么');
    assert.deepEqual(seen, [['p1']], '提问时这份选择必须真的带给宿主（先带上，再谈重置）');
    assert.equal(plugin.registry.get('pick-reset').evidence.length, 0, '回答落地后必须自动重置为空');
  } finally { plugin.dispose(); plugin.registry.remove('pick-reset'); }
});

test('反例：提问失败不清空 —— 那正是要重试的时候', async () => {
  const api = apiStub({ ask: async () => { throw new Error('网络断了'); } });
  const plugin = client.createClientPlugin({ api, session: { id: 'pick-fail' } });
  try {
    plugin.registry.update('pick-fail', { evidence: [{ id: 'k1', pickId: 'p1', title: 'assistant-step', summary: 'x' }] });
    await plugin.submit('这一步在干什么');
    assert.equal(plugin.registry.get('pick-fail').phase, 'error');
    assert.equal(plugin.registry.get('pick-fail').evidence.length, 1, '失败时保留，方便直接重试');
  } finally { plugin.dispose(); plugin.registry.remove('pick-fail'); }
});

test('回答期间新选的那一条不被顺手抹掉', async () => {
  const api = apiStub({ ask: async (id, question, signal, evidence, emit) => {
    emit({ type: 'start', data: { requestId: 'r1' }, envelope: {} });
    // 用户等待期间又选了一条
    plugin.registry.update('pick-late', current => { current.evidence = [...current.evidence, { id: 'k9', pickId: 'p9', title: 'assistant-step', summary: 'y' }]; });
    emit({ type: 'complete', data: {}, envelope: {} });
  } });
  const plugin = client.createClientPlugin({ api, session: { id: 'pick-late' } });
  try {
    plugin.registry.update('pick-late', { evidence: [{ id: 'k1', pickId: 'p1', title: 'assistant-step', summary: 'x' }] });
    await plugin.submit('问一句');
    const left = plugin.registry.get('pick-late').evidence;
    assert.equal(left.length, 1);
    assert.equal(left[0].pickId, 'p9', '只清这一问用掉的，不清用户新选的');
  } finally { plugin.dispose(); plugin.registry.remove('pick-late'); }
});
