import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource } from './fixtures/runtime.mjs';

// 源码是 TS：和仓库里其它单测一样，走夹具的即时转译，不额外引入构建步骤。
const { HISTORY_WINDOW, HISTORY_WINDOW_MAX, resolveHistoryWindow, tailWindowState } = await moduleFromSource('src/client/history-window.ts');

/**
 * 历史窗口的纯计算。
 *
 * 这些数字决定「一次在页面上挂多少条」，是性能设计的落点：
 * dsh 的轨迹视图一次挂 50 个节点、主对话按页取；我们按「轮」算，
 * 默认 HISTORY_WINDOW 条、上限 HISTORY_WINDOW_MAX 条。
 */

const recs = n => Array.from({ length: n }, (_, i) => ({ id: 'r' + i, question: 'q' + i, answerText: 'a' + i }));

test('第一次渲染：只挂最后 HISTORY_WINDOW 条', () => {
  const win = resolveHistoryWindow(recs(20));
  assert.equal(win.start, 20 - HISTORY_WINDOW);
  assert.equal(win.end, 20);
  assert.equal(win.items.length, HISTORY_WINDOW);
  assert.equal(win.items.at(-1).id, 'r19', '最新一条必须在窗口里');
  assert.equal(win.atTail, true);
});

test('记录不足一窗时全挂，并且从 0 开始', () => {
  const win = resolveHistoryWindow(recs(3));
  assert.equal(win.start, 0);
  assert.equal(win.end, 3);
  assert.equal(win.items.length, 3);
});

test('空记录不产生窗口', () => {
  const win = resolveHistoryWindow([]);
  assert.deepEqual([win.start, win.end, win.total, win.items.length], [0, 0, 0, 0]);
});

test('点「更早」一次补一批，且上限是 HISTORY_WINDOW_MAX 条', () => {
  const items = recs(20);
  const first = resolveHistoryWindow(items);
  const prev = { firstId: first.items[0].id, count: 6, atTail: true };
  const second = resolveHistoryWindow(items, prev, 6);
  assert.equal(second.start, 8);
  assert.equal(second.end, 20);
  // 再补一次：窗口往上滑，但挂载量封顶
  const third = resolveHistoryWindow(items, { firstId: second.items[0].id, count: 12, atTail: true }, 6);
  assert.equal(third.end - third.start, HISTORY_WINDOW_MAX, '挂载量必须封顶，否则等于没有窗口');
  assert.equal(third.start, 2);
  assert.equal(third.end, 2 + HISTORY_WINDOW_MAX);
});

test('宿主往前插一页时，窗口还停在原来那几条上（按 id 记，不按下标）', () => {
  const older = recs(20);
  const first = resolveHistoryWindow(older);
  // 用户正看着 r14..r19；这时宿主把 20 条更早的记录插到了前面
  const withOlder = [...recs(20).map(r => ({ ...r, id: 'o' + r.id })), ...older];
  const after = resolveHistoryWindow(withOlder, { firstId: first.items[0].id, count: 6, atTail: true });
  assert.equal(after.items[0].id, 'r14', '补一页之后，用户看到的第一条必须还是原来那条');
  assert.equal(after.items.length, 6);
  assert.equal(after.start, 34);
  assert.equal(after.atTail, true, '仍然在最底部（最新一条还在窗口里）');
});

test('贴在最新处时，新回答落地后窗口跟着往前走一格', () => {
  const items = recs(20);
  const first = resolveHistoryWindow(items);
  const grown = [...items, { id: 'r20', question: 'q20', answerText: 'a20' }];
  const after = resolveHistoryWindow(grown, { firstId: first.items[0].id, count: 6, atTail: true });
  assert.equal(after.items.at(-1).id, 'r20', '新落地的那条必须能看见');
  assert.equal(after.items.length, 6);
  assert.equal(after.start, 15);
});

test('用户往上翻之后，新回答落地不得把窗口拽回底部', () => {
  const items = recs(20);
  const first = resolveHistoryWindow(items);
  const paged = resolveHistoryWindow(items, { firstId: first.items[0].id, count: 6, atTail: true }, 6);
  const grown = [...items, { id: 'r20', question: 'q20', answerText: 'a20' }];
  const after = resolveHistoryWindow(grown, { firstId: paged.items[0].id, count: 12, atTail: false });
  assert.equal(after.items[0].id, paged.items[0].id, '用户正在看的那一段不得被换掉');
  assert.equal(after.atTail, false);
});

test('tailWindowState 回到最新一窗', () => {
  const items = recs(20);
  const state = tailWindowState(items);
  const win = resolveHistoryWindow(items, state);
  assert.equal(win.start, 14);
  assert.equal(win.items.at(-1).id, 'r19');
});
