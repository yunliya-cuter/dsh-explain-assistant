import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fakeDom, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * /compact 的压缩报告（用户 2026-10：「按 /compact 后的页面设计进行仔细优化」「让摘要内容折叠起来」）。
 *
 * 这组测试刻意盯四件"做错了也照样能跑"的事：
 * 1. 摘要**默认必须折起来**（不然一份上千字的摘要会把整段历史顶到下面）；
 * 2. 展开/收起必须能跨重画保留（浮窗每次状态变化都会重画这一块）；
 * 3. 压缩中那段流式正文**不得**被当成回答渲染进对话区；
 * 4. 四种状态各自有明确的徽章与动作，不是共用一句"已完成"。
 */

const base = {
  sessionId: 's', open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
  tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [],
  occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: true, stateReady: true,
};

async function render(state) {
  const submitted = [];
  const plugin = { registry: { update() {}, get: () => state, close() {} }, api: {}, cancel() {}, loadEarlier() {}, submit: q => { submitted.push(q); return Promise.resolve() } };
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const root = overlay.renderOverlay({ ...state, open: true }, plugin);
  return { root, submitted, overlay, plugin };
}

const summaryText = '这是压缩后的摘要正文。'.repeat(20);

function compactCard(root) {
  return root.querySelector('.ea-compact');
}
function byClass(root, cls) {
  return root.querySelector('.' + cls);
}

test('默认折叠：有预览、有折叠按钮，正文容器不展开', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render({ ...base, compactState: { status: 'complete', summary: summaryText, updatedAt: new Date().toISOString() } });
    const card = compactCard(root);
    assert.ok(card, '必须渲染压缩卡片');
    assert.ok(byClass(root, 'ea-compact-preview'), '折叠态必须有一份文字预览（折起来 ≠ 看不见）');
    const box = byClass(root, 'ea-compact-summary-box');
    assert.equal(box.getAttribute('data-open'), 'false', '摘要默认必须是折叠的（用户明确要求）');
    const toggle = byClass(root, 'ea-compact-toggle');
    assert.match(toggle.textContent, /展开摘要/, '按钮要写清"展开"而不是含糊的"更多"');
    assert.match(toggle.textContent, /约 \d+ 字/, '按钮要给出摘要篇幅，用户才能判断值不值得展开');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  } finally { dom.restore(); }
});

test('展开后：data-open 翻成 true，按钮变「收起摘要」', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render({ ...base, compactState: { status: 'complete', summary: summaryText, updatedAt: new Date().toISOString() } });
    const toggle = byClass(root, 'ea-compact-toggle');
    toggle.emit('click');
    assert.equal(byClass(root, 'ea-compact-summary-box').getAttribute('data-open'), 'true', '点一下必须真的展开');
    assert.equal(toggle.textContent, '收起摘要');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    toggle.emit('click');
    assert.equal(byClass(root, 'ea-compact-summary-box').getAttribute('data-open'), 'false', '再点一下必须收回去');
  } finally { dom.restore(); }
});

test('展开状态必须跨重画保留（否则用户点开之后一个状态变化又收起来）', async () => {
  const dom = fakeDom();
  try {
    const state = { ...base, compactState: { status: 'complete', summary: summaryText, updatedAt: '2026-10-25T00:00:00.000Z' } };
    const { root, overlay, plugin } = await render(state);
    byClass(root, 'ea-compact-toggle').emit('click');
    // 模拟一次普通重画（例如占用刷新、历史追加）
    overlay.updateOverlay(root, state, plugin);
    assert.equal(byClass(root, 'ea-compact-summary-box').getAttribute('data-open'), 'true', '重画之后必须仍然是展开的');
  } finally { dom.restore(); }
});

test('四种状态各有自己的徽章与动作', async () => {
  const dom = fakeDom();
  try {
    const cases = [
      [{ status: 'running' }, /压缩中/, null],
      [{ status: 'complete', summary: summaryText, updatedAt: '2026-10-25T00:00:00.000Z' }, /已压缩/, /重新压缩/],
      [{ status: 'error', error: '宿主超时' }, /压缩失败/, /重试压缩/],
      [{ status: 'interrupted', error: '用户中断' }, /已中断/, /继续压缩/],
    ];
    for (const [compactState, badge, action] of cases) {
      const { root } = await render({ ...base, compactState });
      const node = byClass(root, 'ea-compact-badge');
      assert.match(node.textContent, badge, '徽章文案：' + JSON.stringify(compactState));
      if (action) {
        const texts = root.querySelectorAll('button').map(b => b.textContent);
        assert.ok(texts.some(t => action.test(t)), '必须有「' + action.source + '」这颗动作按钮，实际：' + texts.join('/'));
      }
    }
  } finally { dom.restore(); }
});

test('压缩中：流式正文不得当成回答渲染进对话区', async () => {
  const dom = fakeDom();
  try {
    const state = { ...base, phase: 'running', text: '摘要正在一段段推过来', compactState: { status: 'running' } };
    const { root } = await render(state);
    const live = byClass(root, 'ea-conv-live');
    assert.ok(live, '骨架里应当有"当前这一问"这块');
    assert.equal(live.hidden, true, '压缩中不得在对话区显示"空问句 + 摘要"，那会让它看起来像回答');
    assert.match(compactCard(root).textContent, /正在整理小助手自己的上下文/, '进度要写在压缩卡片里');
    assert.match(compactCard(root).textContent, /已收到 \d+ 字/, '已收到的字数就是真实进度，要显示出来');
  } finally { dom.restore(); }
});

test('占用变化：有前后两个数才写「A% → B%」，只有一个数时不编造箭头', async () => {
  const dom = fakeDom();
  try {
    const withBoth = await render({ ...base, occupancyKnown: true, occupancy: 38, compactState: { status: 'complete', summary: summaryText, updatedAt: '2026-10-25T00:00:00.000Z', beforeOccupancy: 62 } });
    assert.match(byClass(withBoth.root, 'ea-compact-meta').textContent, /62% → 38%/, '必须给出压缩前后的对比');
    const onlyBefore = await render({ ...base, occupancyKnown: false, compactState: { status: 'complete', summary: summaryText, updatedAt: '2026-10-25T00:00:00.000Z', beforeOccupancy: 62 } });
    assert.equal(/→/.test(byClass(onlyBefore.root, 'ea-compact-meta').textContent), false, '拿不到"现在"的时候不得画箭头');
  } finally { dom.restore(); }
});

test('失败态：原因 + 上一份摘要仍可用 + 重试，三者齐全', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render({ ...base, compactState: { status: 'error', error: '宿主超时', summary: summaryText, updatedAt: '2026-10-24T00:00:00.000Z' } });
    const card = compactCard(root);
    assert.match(card.textContent, /压缩失败：宿主超时/);
    assert.match(card.textContent, /仍然可用/, '失败时必须说清上一份摘要还在（§9.1）');
    assert.ok(byClass(root, 'ea-compact-summary-box'), '上一份摘要也要能展开看');
  } finally { dom.restore(); }
});

test('样式契约：折叠靠 grid-template-rows 0fr→1fr，不是靠量高度', async () => {
  const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.ea-compact-summary-inner\{display:grid;grid-template-rows:0fr/, '折叠必须用 grid 0fr，避免"量到 0 → 跳一下"');
  assert.match(css, /\[data-open=true\] \.ea-compact-summary-inner\{grid-template-rows:1fr\}/, '展开态必须切到 1fr');
  assert.match(css, /-webkit-line-clamp:3/, '折叠态的预览必须真的截成三行');
});
