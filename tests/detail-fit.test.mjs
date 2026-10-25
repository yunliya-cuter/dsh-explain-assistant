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

test('完整内容: 面板挂在被点的那一轮下面，而不是正文最顶上', async () => {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const dom = fakeDom();
  const detailState = Object.assign({}, state, {
    records: [
      { id: 'r0', question: '第一条问题', answerText: '第一条回答', status: 'complete', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'rec-1', question: '这一步在做什么', answerText: '它在读取配置。', status: 'complete', createdAt: '2026-01-01T00:01:00.000Z', evidence: [{ title: '依据0' }] },
    ],
    hasEarlier: false,
    historyDetail: Object.assign({}, state.historyDetail, { recordId: 'rec-1' }),
  });
  const plugin = {
    registry: { update() {}, get: () => detailState }, api: {}, cancel() {}, submit() {}, loadEarlier() {},
    closeHistoryDetail() {}, loadMoreHistoryDetail() {},
  };
  try {
    const root = overlay.renderOverlay(detailState, plugin);
    const turns = Array.from(root.querySelectorAll('.ea-turn'));
    const own = turns.find(turn => turn.getAttribute('data-record-id') === 'rec-1');
    assert.ok(own, '被点的那一轮必须还在');
    assert.equal(own.getAttribute('data-detail-open'), 'true', '被点的那一轮要打上「正在展开」的标记');
    assert.ok(own.querySelector('.dsh-explain-assistant-detail'), '面板必须在那一轮里面（用户要的是「在按钮下方展开」）');
    const children = own.children;
    const panelAt = children.findIndex(node => String(node.className).includes('dsh-explain-assistant-detail'));
    assert.equal(panelAt, children.length - 1, '面板必须挂在这一轮的最后（也就是动作行下面）');
    // 面板已经开着，内容就在眼前：不许再挂一个「查看完整内容」按钮（用户 2026-10-25 的第 1 条）。
    assert.equal(own.querySelector('.ea-turn-detail'), null, '面板开着时不得再出现「查看完整内容」入口');
    const other = turns.find(turn => turn.getAttribute('data-record-id') === 'r0');
    assert.equal(other.querySelector('.dsh-explain-assistant-detail'), null, '别的记录下面不许挂面板');
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.restore();
  }
});

test('完整内容: 正文取回来之后面板要换成正文，不能停在「正在读取」', async () => {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const dom = fakeDom();
  const records = [{ id: 'rec-1', question: '这一步在做什么', answerText: '它在读取配置。', status: 'complete', createdAt: '2026-01-01T00:00:00.000Z' }];
  const loadingState = Object.assign({}, state, {
    records,
    historyDetail: { recordId: 'rec-1', status: 'loading', hasEarlier: false, loadingMore: false, counts: {}, cursor: null, record: { id: 'rec-1' } },
  });
  const readyState = Object.assign({}, state, {
    records,
    historyDetail: {
      recordId: 'rec-1', status: 'ready', hasEarlier: false, loadingMore: false, counts: { evidence: 1, tools: 0, images: 0 }, cursor: null,
      record: { id: 'rec-1', question: '这一步在做什么', answerText: '它在读取配置。', evidence: [{ title: '依据0', summary: '第0条依据摘要', source: 'selected_frozen', evidenceState: 'observed' }] },
    },
  });
  const plugin = {
    registry: { update() {}, get: () => readyState }, api: {}, cancel() {}, submit() {}, loadEarlier() {},
    closeHistoryDetail() {}, loadMoreHistoryDetail() {},
  };
  try {
    const root = overlay.renderOverlay(loadingState, plugin);
    assert.match(root.querySelector('.dsh-explain-assistant-detail').textContent, /正在读取/, '先显示读取中');
    // 同一条记录、recordId 没变，只是内容回来了：历史区必须重画（否则面板永远停在「正在读取」）
    overlay.updateOverlay(root, readyState, plugin);
    const panel = root.querySelector('.dsh-explain-assistant-detail');
    assert.doesNotMatch(panel.textContent, /正在读取/, '内容回来之后不许还写着「正在读取」');
    assert.match(panel.textContent, /第0条依据摘要/, '取回来的依据必须显示出来');
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.restore();
  }
});
