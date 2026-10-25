import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDom, moduleFromSource, FakeElement } from './fixtures/runtime.mjs';

/**
 * 「压缩那一行」的滚动行为。
 *
 * 用户 2026-10-25 的原话：「点开？后会自动弹到上下文压缩的地方，不符合直觉」。
 *
 * 根因不在教程页：那一行改成「长在对话流里它真正发生的位置」之后，往往在最新一轮的
 * 上面几十屏，而 updateOverlay 里那段「压缩状态一变就把这一行带进视野」的逻辑在
 * **第一次看到**这份状态时也会跑 —— 于是打开浮窗（或首帧之后 150ms 的那次补滚）
 * 把视野从"最新一轮"拽到"压缩那一行"。看起来就是"点开就跳过去"。
 *
 * 判据（三条，缺一条都会复发）：
 *   ① 第一次看到压缩状态（刚打开浮窗 / 刚切会话）**不滚**；
 *   ② 这一次真的发生了状态变化（按 /compact、压缩跑完/失败）**要滚**；
 *   ③ 教程页/模型页开着时**不滚**（正文被整页盖住，滚了只会让用户回到对话时觉得跳了一下）。
 */

const base = {
  sessionId: 's', open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
  tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [],
  occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: true, stateReady: true,
};
const rec = (id, at) => ({ id, question: '问：' + id, answerText: '答：' + id, status: 'complete', startedAt: at });
const records = [rec('r1', '2026-10-24T00:00:00.000Z'), rec('r2', '2026-10-26T00:00:00.000Z')];
const compact = { version: 1, status: 'complete', createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z', summary: '摘要正文' };

/**
 * 给假 DOM 补上布局：真实浏览器里量得到矩形，这里是让三条判据可执行的最小补丁。
 * 正文区 0..400，压缩那一行 600..626（在视口下方 200px）—— 只要有人滚它，scrollTop 就会变。
 */
async function withLayout(run) {
  const original = FakeElement.prototype.getBoundingClientRect;
  FakeElement.prototype.getBoundingClientRect = function () {
    const cls = String(this.className || '');
    if (cls.includes('ea-body')) return { top: 0, bottom: 400, height: 400, left: 0, right: 900, width: 900 };
    if (cls.includes('ea-compact-row')) return { top: 600, bottom: 626, height: 26, left: 0, right: 900, width: 900 };
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
  };
  // 必须 await：run 是 async 的，不 await 的话 finally 会在测试体还没跑之前就把补丁撤掉 ——
  // 那样三条断言全部变成"没滚动所以通过"，是假绿（本轮已实际踩到）。
  try { return await run(); } finally { FakeElement.prototype.getBoundingClientRect = original; }
}

async function render(state) {
  const plugin = { registry: { update() {}, get: () => state, close() {} }, api: {}, cancel() {}, loadEarlier() {}, submit() {}, saveGeometry() {} };
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  return { root: overlay.renderOverlay({ ...state, open: true }, plugin), overlay, plugin };
}

test('第一次看到压缩状态不滚：打开浮窗不会被拽到压缩那一行', async () => {
  const dom = fakeDom();
  try {
    await withLayout(async () => {
      const { root } = await render({ ...base, records, compactState: compact });
      const body = root.querySelector('.ea-body');
      assert.equal(body.scrollTop || 0, 0, '首帧不得把视野挪到压缩那一行（用户看到的就是"点开就跳过去"）');
      // 真正的凶手是 150ms 之后那次补滚：不等到它跑完，这条断言就抓不到回归。
      await new Promise(resolve => setTimeout(resolve, 220));
      assert.equal(body.scrollTop || 0, 0, '150ms 后的补滚也不得把视野拽到压缩那一行');
    });
  } finally { dom.restore(); }
});

test('状态真的变了才滚：压缩跑完时把那一行带进视野', async () => {
  const dom = fakeDom();
  try {
    await withLayout(async () => {
      const { root, overlay, plugin } = await render({ ...base, records, compactState: { ...compact, status: 'running' } });
      const body = root.querySelector('.ea-body');
      body.scrollTop = 0;
      overlay.updateOverlay(root, { ...base, records, compactState: compact }, plugin);
      assert.ok(body.scrollTop > 0, '压缩刚跑完，这一行要进视野（否则用户以为按了没反应），实际 ' + body.scrollTop);
    });
  } finally { dom.restore(); }
});

test('教程页开着时不滚：滚了也看不见，只会让用户回到对话时觉得跳了一下', async () => {
  const dom = fakeDom();
  try {
    await withLayout(async () => {
      const { root, overlay, plugin } = await render({ ...base, records, compactState: { ...compact, status: 'running' } });
      const body = root.querySelector('.ea-body');
      root.querySelector('.ea-tutorial-trigger').emit('click');
      body.scrollTop = 0;
      overlay.updateOverlay(root, { ...base, records, compactState: compact }, plugin);
      await new Promise(resolve => setTimeout(resolve, 220));
      assert.equal(body.scrollTop || 0, 0, '教程页盖着正文时不得改正文滚动位置（补滚同理）');
    });
  } finally { dom.restore(); }
});
