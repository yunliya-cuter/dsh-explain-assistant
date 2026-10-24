import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

const overlay = await moduleFromSource('src/client/overlay.tsx');

/**
 * 历史记录的表现方式（本轮用户原话）：
 * 「我不喜欢现在的卡片方式，更喜欢像 deepseek harness 这样的对话式」
 * 「注意配色、位置关系、动画的设计」
 * 「每次仅渲染部分上下文以避免性能问题（处理方式请参考 dsh 的处理方式）」
 *
 * 所以这里断言的正是那三件事在界面上的落点：
 *   1. 结构：问句是右对齐气泡、回答是左对齐正文、没有卡片边框；
 *   2. 位置：时间在气泡正下方、动作行在回答下方；
 *   3. 窗口：一次只挂 6 条、往上补、有上限、能回到最近、往上翻时新回答不抢位置。
 */

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

const longAnswer = '答'.repeat(500);

/** 只数「历史里」的轮次：当前这一问也带 .ea-turn（同一套样式），不能算进来。 */
function historyTurns(root) {
  const history = root.querySelector('.dsh-explain-assistant-history');
  assert.ok(history, '历史区必须存在');
  return history.querySelectorAll('.ea-turn');
}

function records(n, extra) {
  return Array.from({ length: n }, (_, i) => Object.assign({
    id: 'r' + i,
    question: '第 ' + (i + 1) + ' 个问题',
    answerText: '第 ' + (i + 1) + ' 个回答',
    status: 'complete',
    createdAt: new Date(2026, 0, 1, 10, i).toISOString(),
  }, extra ? extra(i) : {}));
}

test('历史是对话：问句右气泡、回答左正文、没有卡片边框', () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ records: records(2) }), plugin);
  const turns = historyTurns(root);
  assert.equal(turns.length, 2, '两条记录就该是两轮');
  const first = turns[0];
  const bubble = first.querySelector('.ea-turn-q');
  assert.ok(bubble, '问句必须有自己的气泡节点');
  assert.match(bubble.textContent, /第 1 个问题/);
  const answer = first.querySelector('.ea-turn-a');
  assert.ok(answer, '回答必须是自己的正文节点');
  assert.match(answer.textContent, /第 1 个回答/);
  // 位置关系：气泡 → 时间 → 回答 → 动作行，这个顺序就是阅读顺序
  const classes = first.children.map(child => child.className);
  assert.deepEqual(classes.slice(0, 3).map(name => String(name).split(' ')[0]), ['ea-turn-q', 'ea-turn-meta', 'ea-turn-a'], '顺序错了就是位置关系错了：' + classes.join(' / '));
  assert.ok(first.querySelector('.ea-turn-foot'), '回答下面要有动作行（查看完整内容）');
  // 不再是卡片：历史区自己不能带 ea-card，轮与轮之间也不能有横线卡片感
  const history = root.querySelector('.dsh-explain-assistant-history');
  assert.ok(history, '历史区必须还在');
  assert.equal((history.className || '').includes('ea-card'), false, '历史区不得再是卡片');
}));

test('窗口：20 条只挂 6 条，顶上给「更早的 14 条」', () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ records: records(20) }), plugin);
  assert.equal(historyTurns(root).length, 6, '一次只挂最近 6 条');
  assert.match(root.textContent, /更早的 14 条/, '上面要有可以往前翻的入口');
  // 最新一条必须在
  const turns = historyTurns(root);
  assert.match(turns.at(-1).textContent, /第 20 个问题/);
}));

test('往上翻一次补 6 条；再翻，挂载量封顶（不是无限堆）', () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ records: records(20) }), plugin);
  const older = () => {
    const btn = root.querySelector('.ea-conv-older-btn');
    assert.ok(btn, '必须有「更早」按钮');
    btn.click();
  };
  older();
  assert.equal(historyTurns(root).length, 12, '补一次后 12 条');
  older();
  assert.equal(historyTurns(root).length, 12, '再往上翻必须保持在 12 条以内（多的从下面摘掉）');
  // 最上面那条变成了更早的记录 —— 说明窗口真的往上滑了
  assert.match(historyTurns(root)[0].textContent, /第 3 个问题/);
}));

test('往上翻之后出现「回到最近」，点一下回到最新 6 条', () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ records: records(20) }), plugin);
  assert.equal(root.querySelectorAll('.ea-conv-jump-btn').length, 0, '还在底部时不该出现「回到最近」');
  root.querySelector('.ea-conv-older-btn').click();
  root.querySelector('.ea-conv-older-btn').click();
  const jump = root.querySelector('.ea-conv-jump-btn');
  assert.ok(jump, '往上翻过之后必须给一条回到最近的路');
  jump.click();
  const turns = historyTurns(root);
  assert.equal(turns.length, 6);
  assert.match(turns.at(-1).textContent, /第 20 个问题/, '点完必须回到最新一条');
}));

test('折叠：除最新一轮外，长回答默认收起；点「展开全文」就展开', () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({
    records: records(2, i => ({ answerText: longAnswer })),
  }), plugin);
  const turns = historyTurns(root);
  const olderAnswer = turns[0].querySelector('.ea-turn-a');
  assert.equal(olderAnswer.getAttribute('data-folded'), 'true', '旧的长回答默认收起');
  const newestAnswer = turns[1].querySelector('.ea-turn-a');
  assert.equal(newestAnswer.getAttribute('data-folded'), 'false', '最新一轮要完整展开');
  const more = turns[0].querySelector('.ea-turn-more');
  assert.ok(more, '收起时必须给「展开全文」');
  more.click();
  assert.equal(historyTurns(root)[0].querySelector('.ea-turn-a').getAttribute('data-folded'), 'false', '点过之后必须真的展开');
}));

test('短回答不折叠（不制造一个点了没反应的按钮）', () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ records: records(3) }), plugin);
  for (const turn of historyTurns(root)) {
    assert.equal(turn.querySelector('.ea-turn-a').getAttribute('data-folded'), 'false');
    assert.equal(turn.querySelector('.ea-turn-more'), null, '短回答不该出现「展开全文」');
  }
}));

test('当前这一问：显示问句气泡；落地后让位给历史，同一条回答不出现两次', () => withDom(async () => {
  const plugin = pluginSpy();
  const live = {
    sessionId: 's1', open: true, phase: 'running', draft: '', reasoning: '', text: '正在写的回答', tools: [], records: [],
    hasEarlier: false, loadingEarlier: false, evidence: [], unread: false, occupancyKnown: false,
    quickQuestionsDismissed: true, catalog: { groups: [], failures: [] },
    question: '它现在在干什么',
  };
  const root = overlay.renderOverlay(live, plugin);
  const liveTurn = root.querySelector('.ea-conv-live');
  assert.ok(liveTurn, '必须有「当前这一问」这一块');
  assert.equal(liveTurn.hasAttribute('hidden'), false, '正在回答时它是可见的');
  assert.match(root.querySelector('.ea-live-q').textContent, /它现在在干什么/, '正在回答的这一段上面必须有问句');

  // 落地：记录进了历史，当前这一问收起
  overlay.updateOverlay(root, {
    ...live,
    phase: 'complete',
    liveRecordId: 'rec-live',
    records: [{ id: 'rec-live', question: '它现在在干什么', answerText: '正在写的回答', status: 'complete', createdAt: new Date().toISOString() }],
  }, plugin);
  assert.equal(root.querySelector('.ea-conv-live').hasAttribute('hidden'), true, '落地后当前这一块必须收起');
  const history = root.querySelector('.dsh-explain-assistant-history');
  assert.match(history.textContent, /正在写的回答/, '回答必须出现在历史里');
}));

test('性能：无关状态变化不得重挂历史（节点对象保持同一个）', () => withDom(async () => {
  const plugin = pluginSpy();
  const base = state({ records: records(20) });
  const root = overlay.renderOverlay(base, plugin);
  const before = root.querySelector('.ea-turn');
  const firstTurnText = before.textContent;
  // 流式期间每一个分片都会调一次 updateOverlay；这里是同一种调用，只是改了一个与历史无关的字段
  overlay.updateOverlay(root, { ...base, text: '正在写的回答' }, plugin);
  const after = root.querySelector('.ea-turn');
  assert.equal(after, before, '历史区被重建了：同一个 DOM 对象必须还在（重建会丢滚动锚点、也白费性能）');
  assert.equal(after.textContent, firstTurnText);
}));
