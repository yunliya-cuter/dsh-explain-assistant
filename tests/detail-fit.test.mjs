import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moduleFromSource, fakeDom } from './fixtures/runtime.mjs';

/**
 * 「查看完整内容」面板的高度（用户 2026-10-25 的截图）。
 *
 * 现象：点开「查看完整内容」之后，记录正文一路长到输入框上沿、被那条边切成一条直线：
 * 面板没有下边框，最后一行字直接贴着输入框，看起来像界面坏了。
 * 根因：面板按内容长（实测 813px，而正文区只有 346px），而 .ea-body 的裁剪边界
 * 正好落在输入框的分隔线上，于是「滚动区裁切」被读成了「内容被切掉」。
 *
 * 这一版的做法：面板按正文区高度封顶（--ea-body-h，overlay.tsx 量出来写在浮窗根元素上），
 * 标题行留在卡片里不动，正文在卡片内部滚 —— 卡片有一条完整的圆角下边框，
 * 下面还露出「历史 N 条」，用户看得出这是一块能滚的记录、对话还在下面。
 */
const state = {
  sessionId: 's1', open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
  tools: [], records: [], loadingEarlier: false, evidence: [], occupancyKnown: false, occupancyEstimated: false,
  quickQuestionsDismissed: true, hasEarlier: false,
  historyDetail: {
    recordId: 'rec-1', status: 'ready', hasEarlier: false, loadingMore: false,
    counts: { evidence: 0, tools: 0, images: 0 }, cursor: null,
    record: { id: 'rec-1', question: '这一步在做什么', answerText: '它在读取配置。'.repeat(60) },
  },
};

test('完整内容: 标题行不随记录滚走，正文在卡片内部滚', async () => {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const dom = fakeDom();
  const plugin = {
    registry: { update() {}, get: () => state }, api: {}, cancel() {}, submit() {}, loadEarlier() {},
    closeHistoryDetail() {}, loadMoreHistoryDetail() {},
  };
  try {
    const root = overlay.renderOverlay(state, plugin);
    const card = root.querySelector('.dsh-explain-assistant-detail');
    assert.ok(card, '必须有「这条记录的完整内容」面板');
    const scroll = card.querySelector('.ea-detail-scroll');
    assert.ok(scroll, '正文必须有一层自己的滚区（否则整块面板会一路长到输入框边上）');
    assert.equal(scroll.querySelector('.ea-card-head'), null, '标题行（含「收起」）必须留在滚区外面，滚动时不能滚走');
    assert.ok(card.querySelector('.ea-card-head'), '卡片里必须有标题行');
    assert.ok(scroll.querySelector('.ea-detail-answer'), '回答正文必须在滚区里');
    assert.match(card.textContent, /收起/, '「收起」必须还在卡片上');
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.restore();
  }
});

test('完整内容: 面板按正文区高度封顶，滚区必须能被压缩', () => {
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  const card = /.dsh-explain-assistant-detail\{[^}]*\}/.exec(css);
  assert.ok(card, '样式里必须有 .dsh-explain-assistant-detail 的规则');
  assert.match(card[0], /max-height:calc\(var\(--ea-body-h/, '面板必须按正文区高度封顶（写百分比没用：父级高度是 auto，会按 none 处理）');
  assert.match(card[0], /overflow:hidden/, '面板自己不再滚，超出的部分交给里面的滚区');
  const scroll = /\.ea-detail-scroll\{[^}]*\}/.exec(css);
  assert.ok(scroll, '样式里必须有 .ea-detail-scroll 的规则');
  assert.match(scroll[0], /overflow-y:auto/, '卡片内部必须能滚（否则长记录又会被切在输入框上沿）');
  assert.match(scroll[0], /min-height:0/, '滚区必须有 min-height:0，否则它在 flex 里不肯收缩，卡片会被内容重新撑长');
});

test('完整内容: 高度是从正文区量出来写进 --ea-body-h 的，并且随窗口变化重算', () => {
  const source = readFileSync(new URL('../src/client/overlay.tsx', import.meta.url), 'utf8');
  assert.match(source, /setProperty\('--ea-body-h'/, '必须真的把正文区高度写进 --ea-body-h（否则 max-height 只走兜底值，窗口一变就失效）');
  assert.match(source, /new ResizeObserver/, '必须随窗口/正文区尺寸变化重算，不能只在首帧量一次');
  assert.match(source, /bodyObserver\?\.disconnect\(\)/, '浮窗销毁时必须断开观察器，不能留着泄漏');
});
