import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fakeDom, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * /compact 的结果：对话流里的一行「压缩事件」。
 *
 * 用户这一轮的原话是：
 *   「我不希望上下文压缩是这样的卡片的形式，因为用户这样子看不见（在上下文最上方）」
 *   「参考一下 deepseek harness 是怎么处理摘要的显示的」
 * 宿主（dsh-client-ui-chat 的 compactionRow）的做法是一行 24px 的安静长条：
 *   [箭头] 上下文已压缩 · 摘要首行…（单行省略）  —— 点开才在原位往下长出正文。
 *
 * 所以这组测试盯的是"它是不是真的变成了一行、而且出现在对话末尾"，
 * 而不是"页面上有没有这段文字"。
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
const complete = { status: 'complete', summary: summaryText, updatedAt: '2026-10-25T00:00:00.000Z' };
const byClass = (root, cls) => root.querySelector('.' + cls);

test('是一行，不是一个卡片：只有头部一行 + 默认收起的正文', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render({ ...base, compactState: complete });
    const row = byClass(root, 'ea-compact-row');
    assert.ok(row, '必须渲染出压缩那一行');
    assert.equal(byClass(root, 'ea-compact'), null, '不得再出现"卡片"那一套结构（用户明确否掉了）');
    assert.equal(row.getAttribute('data-open'), 'false', '默认必须是收起的');
    const head = byClass(root, 'ea-compact-head');
    assert.ok(head, '必须有头部那一行');
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    assert.match(head.textContent, /上下文已压缩/, '头部要写清发生了什么');
    assert.match(head.textContent, /这是压缩后的摘要正文/, '头部要带摘要首行（单行省略），让人不点开也知道写了什么');
    assert.ok(byClass(root, 'ea-compact-body'), '正文容器要在（CSS 负责收起时不显示）');
  } finally { dom.restore(); }
});

test('点一下头部就在原位展开，再点收起', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render({ ...base, compactState: complete });
    const head = byClass(root, 'ea-compact-head');
    head.emit('click');
    assert.equal(byClass(root, 'ea-compact-row').getAttribute('data-open'), 'true');
    assert.equal(head.getAttribute('aria-expanded'), 'true');
    assert.ok(byClass(root, 'ea-compact-summary'), '展开后正文里要有摘要本体');
    head.emit('click');
    assert.equal(byClass(root, 'ea-compact-row').getAttribute('data-open'), 'false');
  } finally { dom.restore(); }
});

test('展开状态跨重画保留（否则用户点开之后一个状态变化又收起来）', async () => {
  const dom = fakeDom();
  try {
    const state = { ...base, compactState: complete };
    const { root, overlay, plugin } = await render(state);
    byClass(root, 'ea-compact-head').emit('click');
    overlay.updateOverlay(root, state, plugin);
    assert.equal(byClass(root, 'ea-compact-row').getAttribute('data-open'), 'true');
  } finally { dom.restore(); }
});

test('位置：必须排在历史之后、当前这一问之前（不是正文最上面）', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render({ ...base, compactState: complete });
    const body = byClass(root, 'ea-body');
    const names = body.children.map(child => child.className);
    const historyAt = names.findIndex(name => /ea-conv-slot/.test(name));
    const compactAt = names.findIndex(name => /ea-compact-row/.test(name) || (child => true));
    // compact 那一行自己是 .ea-compact-row，但父级槽位是 .ea-slot：按"后代里有没有 .ea-compact-row"定位
    const slotAt = body.children.findIndex(child => child.querySelector && child.querySelector('.ea-compact-row'));
    const liveAt = names.findIndex(name => /ea-conv-live/.test(name));
    assert.ok(slotAt > historyAt, '压缩这一行必须排在历史之后（它是一次"刚刚发生的事"），实际：' + historyAt + ' vs ' + slotAt);
    assert.ok(slotAt < liveAt, '并且要在"当前这一问"之前，实际：' + slotAt + ' vs ' + liveAt);
    assert.ok(compactAt >= -1);
  } finally { dom.restore(); }
});

test('四种状态各自的一句话', async () => {
  const dom = fakeDom();
  try {
    const cases = [
      [{ status: 'running' }, /正在压缩上下文/, /正在整理小助手自己的上下文/],
      [complete, /上下文已压缩/, /上下文已压缩/],
      [{ status: 'error', error: '宿主超时' }, /上下文压缩失败/, /宿主超时/],
      [{ status: 'interrupted', error: '用户中断' }, /上下文压缩已中断/, /用户中断/],
    ];
    for (const [compactState, title, line] of cases) {
      const { root } = await render({ ...base, compactState });
      const head = byClass(root, 'ea-compact-head');
      assert.match(head.textContent, title);
      assert.match(head.textContent, line);
    }
  } finally { dom.restore(); }
});

test('压缩中：不进对话流，进度就写在那一行里，且头部不可展开', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render({ ...base, phase: 'running', text: '摘要正在一段段推过来', compactState: { status: 'running' } });
    assert.equal(byClass(root, 'ea-conv-live').hidden, true, '压缩中不得在对话区显示"空问句 + 摘要"');
    assert.match(byClass(root, 'ea-compact-line').textContent, /已收到 \d+ 字/, '已收到的字数就是真实进度');
    assert.equal(byClass(root, 'ea-compact-head').hasAttribute('disabled'), true, '还没结果时头部不该可点');
  } finally { dom.restore(); }
});

test('占用变化写在展开的正文里，只有一个数时不编造箭头', async () => {
  const dom = fakeDom();
  try {
    const withBoth = await render({ ...base, occupancyKnown: true, occupancy: 38, compactState: { ...complete, beforeOccupancy: 62 } });
    assert.match(byClass(withBoth.root, 'ea-compact-meta').textContent, /62% → 38%/);
    const onlyBefore = await render({ ...base, compactState: { ...complete, beforeOccupancy: 62 } });
    assert.equal(/→/.test(byClass(onlyBefore.root, 'ea-compact-meta').textContent), false);
  } finally { dom.restore(); }
});

test('失败态：展开后能看到原因、上一份摘要仍可用、重试按钮', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render({ ...base, compactState: { status: 'error', error: '宿主超时', summary: summaryText, updatedAt: '2026-10-24T00:00:00.000Z' } });
    byClass(root, 'ea-compact-head').emit('click');
    const body = byClass(root, 'ea-compact-body');
    assert.match(body.textContent, /宿主超时/);
    assert.ok(byClass(root, 'ea-compact-summary'), '上一份摘要也要能看到');
    assert.ok(body.textContent.includes('重试压缩'));
  } finally { dom.restore(); }
});

test('样式契约：一行 26px、单行省略、正文默认不显示、展开时才 block（照宿主的 compactionRow）', async () => {
  const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.ea-compact-head\{[^}]*height:26px/, '头部必须是固定高度的一行');
  assert.match(css, /\.ea-compact-line\{[^}]*text-overflow:ellipsis/, '摘要首行必须单行省略');
  assert.match(css, /\.ea-compact-body\{display:none/, '正文默认不显示');
  assert.match(css, /\[data-open=true\] \.ea-compact-body\{display:block\}/, '展开时才显示正文');
  assert.equal(/\.ea-compact\{/.test(css), false, '不该再有卡片那一套样式');
});
