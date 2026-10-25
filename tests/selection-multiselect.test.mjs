import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fakeDom, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 选择模式这一版的契约（用户 2026-10 的两条要求）：
 *   1. 进入选择模式后，解释小助手**暂时不显示**，方便在主对话里选；
 *   2. Ctrl+左键可以选择多条。
 *
 * 这两条合起来带来一个新风险：浮窗让开之后"退出选择模式"那颗按钮也看不见了，
 * 而多选又取消了"选一条就自动退出"的兜底。所以这组测试的重点不是"能进模式"，
 * 而是**三条出口都真的通**（完成 / Esc / 卸载兜底），以及浮动条上的计数是活的。
 */

const baseState = {
  sessionId: 's', open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
  tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [],
  occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: true, stateReady: true,
};

function fixture(state, calls = []) {
  const plugin = {
    registry: { update() {}, get: () => state, close() {} },
    api: {}, cancel: () => {}, loadEarlier: () => {}, submit: q => { calls.push(q); return Promise.resolve() },
  };
  return moduleFromSource('src/client/overlay.tsx')
    .then(overlay => ({ overlay, root: overlay.renderOverlay({ ...state, open: true }, plugin), plugin }));
}

function selectButton(root) {
  return Array.from(root.querySelectorAll('button')).find(b => /选择主对话内容|退出选择模式/.test(b.textContent || ''));
}

function barOf(document) {
  return (document.body?.children || []).find(node => node.className === 'ea-select-bar');
}

/** 按类名找浮动条里的元件：按文字找会被那句提示语骗（"…· Esc 完成"里也有"完成"）。 */
function barButton(bar, className) {
  return bar.children.find(node => (node.className || '') === className);
}

async function withOverlay(run) {
  const dom = fakeDom();
  try { await run({ dom, document: dom.document }); }
  finally { await new Promise(r => setTimeout(r, 0)); dom.restore(); }
}

test('进入选择模式：浮窗让开（标记 + 页面标记），并把浮动条挂到 body 上', async () => {
  await withOverlay(async ({ dom, document }) => {
    const { root } = await fixture(baseState);
    selectButton(root).emit('click');
    assert.equal(root.hasAttribute('data-selection-mode'), true, '浮窗必须进入"让开"状态');
    assert.equal(document.documentElement.getAttribute('data-ea-selecting'), 'true', '主对话卡片要靠这个标记才出现虚线/十字光标');
    const bar = barOf(document);
    assert.ok(bar, '浮动条必须真的挂到 body 上（挂在浮窗里会被 overflow 裁掉、还会跟着让开）');
    assert.match(bar.textContent, /已选 0 条/, '浮动条必须显示已选条数');
    assert.ok(bar.children.some(node => /完成/.test(node.textContent || '')), '浮动条必须有「完成」这颗出口按钮');
  });
});

test('「完成」必须能退出：清掉模式标记、页面标记，并摘掉浮动条', async () => {
  await withOverlay(async ({ document }) => {
    const { root } = await fixture(baseState);
    selectButton(root).emit('click');
    const bar = barOf(document);
    const done = barButton(bar, 'ea-btn ea-select-bar-done');
    assert.ok(done, '浮动条上必须有「完成」按钮');
    done.emit('click');
    assert.equal(root.hasAttribute('data-selection-mode'), false);
    assert.equal(document.documentElement.hasAttribute('data-ea-selecting'), false, '退出后页面上的 selecting 标记必须一起清（否则主对话一直是十字光标）');
    assert.equal(barOf(document), undefined, '退出后浮动条必须摘掉');
    assert.equal(root.querySelector('button').textContent.includes('退出选择模式'), false);
  });
});

test('Esc 必须能退出，且只退模式、不关窗（document 级监听）', async () => {
  await withOverlay(async ({ document }) => {
    const { root } = await fixture(baseState);
    selectButton(root).emit('click');
    // 浮窗让开之后焦点在主对话里，root 上的 keydown 收不到 —— 所以这里刻意只对 document 派发。
    const event = document.emit('keydown', { key: 'Escape' });
    assert.equal(root.hasAttribute('data-selection-mode'), false, 'Esc 必须退出选择模式');
    assert.equal(event.defaultPrevented, true, 'Esc 被模式消费后必须 preventDefault');
    assert.equal(root.hasAttribute('hidden'), false, '关窗是另一件事：Esc 只退模式');
  });
});

test('浮动条上的计数随选择变化（只改文字，不重建节点 —— 焦点在上面）', async () => {
  await withOverlay(async ({ document }) => {
    const { root, overlay, plugin } = await fixture(baseState);
    selectButton(root).emit('click');
    const bar = barOf(document);
    const count = bar.children.find(node => (node.className || '') === 'ea-select-bar-count');
    assert.equal(count.textContent, '已选 0 条');
    overlay.updateOverlay(root, { ...baseState, evidence: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }] }, plugin);
    assert.equal(count.textContent, '已选 3 条', '计数必须跟着状态走');
    assert.equal(barOf(document), bar, '浮动条节点本身必须被复用（否则焦点每次都丢）');
  });
});

test('卸载兜底：dispose 后不得残留模式标记、页面标记与浮动条', async () => {
  await withOverlay(async ({ document }) => {
    const { root } = await fixture(baseState);
    selectButton(root).emit('click');
    root.emit('dsh-explain-assistant:dispose');
    assert.equal(document.documentElement.hasAttribute('data-ea-selecting'), false, '卸载后主对话不得继续处于选择态');
    assert.equal(barOf(document), undefined, '卸载后浮动条必须摘掉');
    // Esc 监听也必须摘掉：否则关掉浮窗之后按 Esc 还会走进一个已经销毁的界面。
    // 摘掉之后这次派发不应改变任何东西（也不应抛错）。
    document.emit('keydown', { key: 'Escape' });
    assert.equal(root.hasAttribute('data-selection-mode'), true, 'dispose 只做清理，不改 root 上的模式标记（节点本身已被摘掉）');
  });
});

test('「清空」清掉已选但留在模式里（多选场景下"重来一次"比"退出"更常用）', async () => {
  await withOverlay(async ({ document }) => {
    const { root, overlay, plugin } = await fixture(baseState);
    selectButton(root).emit('click');
    const bar = barOf(document);
    const clear = barButton(bar, 'ea-btn ea-select-bar-clear');
    assert.ok(clear, '浮动条必须有「清空」');
    let cleared = false;
    plugin.registry.update = (sessionId, patch) => {
      const state = { ...baseState, evidence: [{ id: 'e1' }] };
      if (typeof patch === 'function') patch(state);
      cleared = Array.isArray(state.evidence) && state.evidence.length === 0;
    };
    clear.emit('click');
    assert.equal(cleared, true, '「清空」必须把 evidence 清成空数组');
    assert.equal(root.hasAttribute('data-selection-mode'), true, '「清空」不应退出模式');
    assert.ok(overlay);
  });
});

/* ---------- 样式契约：浮窗"让开"这件事必须真的写在样式里 ---------- */
test('样式里：选择模式下浮窗是"让开"而不是"塌掉"（opacity+visibility，不是 display:none）', async () => {
  const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  const rules = (css.match(/\.ea-overlay\[data-selection-mode=true\] \.ea-main\{[^}]*\}/g) || [])
    .map(text => text.slice(text.indexOf('{') + 1, -1));
  const hiding = rules.find(text => text.includes('opacity:0'));
  assert.ok(hiding, '必须有一条"让开"的规则把 .ea-main 藏掉（不能只写注释）');
  assert.match(hiding, /visibility:hidden/, '必须从 Tab 序列里摘出去（opacity:0 的元素仍然可聚焦）');
  assert.equal(/display:none/.test(hiding), false, '不得用 display:none：display 不可过渡，焦点也会一起消失');
});
