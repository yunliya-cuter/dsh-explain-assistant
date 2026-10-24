import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

const selection = await moduleFromSource('src/client/selection.ts');

/**
 * 选择控制器现在有两个出口：select（选中一条）与 deselect（取消一条，按锚点）。
 * 控制器**只挂一次**（整棵浮窗生命周期），模式只是它内部的一个开关 ——
 * 因为「点已选中的卡片 = 取消」必须在模式外也有效。
 */
function recorder() {
  const picked = [];
  const removed = [];
  return { picked, removed, handlers: { select: item => picked.push(item), deselect: id => removed.push(id) } };
}

// §5.2：点击主对话中的步骤卡片即可选定解释对象，且不得触发原卡片操作。
test('左键点击步骤卡片即选中，并阻止原卡片操作', () => {
  const dom = fakeDom();
  try {
    const root = dom.document;
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const card = new FakeElement('div'); card.setAttribute('data-tool', 'bash');
    card.textContent = '运行了一条命令';
    chat.appendChild(card); root.appendChild(chat);
    const rec = recorder();
    const controller = selection.attachSelection(root, 'session-a', rec.handlers);
    controller.enter();
    card.focus();
    const event = root.emit('click', { target: card, button: 0, clientX: 10, clientY: 10 });
    assert.equal(rec.picked.length, 1, '左键点击必须选中');
    assert.equal(event.defaultPrevented, true, '必须阻止原卡片的默认操作');
    assert.equal(rec.picked[0].title, 'bash');
    controller.dispose();
  } finally { dom.restore(); }
});

// 模式外点普通卡片不抢事件 —— 否则主对话自己的折叠/展开全被吞掉。
test('反例：没进选择模式时点普通卡片，不选中也不拦事件', () => {
  const dom = fakeDom();
  try {
    const root = dom.document;
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const card = new FakeElement('div'); card.setAttribute('data-tool', 'bash');
    card.textContent = '运行了一条命令';
    chat.appendChild(card); root.appendChild(chat);
    const rec = recorder();
    const controller = selection.attachSelection(root, 'session-a', rec.handlers);
    const event = root.emit('click', { target: card, button: 0, clientX: 10, clientY: 10 });
    assert.equal(rec.picked.length, 0);
    assert.equal(event.defaultPrevented, false, '模式外不得拦截点击');
    controller.dispose();
  } finally { dom.restore(); }
});

// 用户要求第二条：取消要方便直观 —— 点一下那张已经高亮的卡片就取消，不必重新进模式。
test('取消：点已选中的卡片即取消，且不触发原卡片操作', () => {
  const dom = fakeDom();
  try {
    const root = dom.document;
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const card = new FakeElement('div'); card.setAttribute('data-tool', 'bash');
    card.setAttribute('data-ea-pick', 'p7');
    card.setAttribute('data-ea-picked', 'p7');
    card.textContent = '运行了一条命令';
    chat.appendChild(card); root.appendChild(chat);
    const rec = recorder();
    const controller = selection.attachSelection(root, 'session-a', rec.handlers);
    const event = root.emit('click', { target: card, button: 0, clientX: 10, clientY: 10 });
    assert.deepEqual(rec.removed, ['p7'], '点已选中的卡片必须按锚点取消');
    assert.equal(rec.picked.length, 0, '取消不得又被当成一次选中');
    assert.equal(event.defaultPrevented, true, '取消也要吞掉这次点击，别让原卡片跟着展开');
    controller.dispose();
  } finally { dom.restore(); }
});

test('右键仍然可以选中（兼容保留）', () => {
  const dom = fakeDom();
  try {
    const root = dom.document;
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const card = new FakeElement('div'); card.setAttribute('data-tool', 'fs');
    chat.appendChild(card); root.appendChild(chat);
    const rec = recorder();
    const controller = selection.attachSelection(root, 'session-a', rec.handlers);
    controller.enter();
    root.emit('contextmenu', { target: card, button: 2 });
    assert.equal(rec.picked.length, 1);
    controller.dispose();
  } finally { dom.restore(); }
});

test('反例：浮窗内部的点击不得被当成选中', () => {
  const dom = fakeDom();
  try {
    const root = dom.document;
    const overlay = new FakeElement('div'); overlay.setAttribute('data-shell-overlay', 'x');
    const card = new FakeElement('div'); card.setAttribute('data-tool', 'bash');
    overlay.appendChild(card); root.appendChild(overlay);
    const rec = recorder();
    const controller = selection.attachSelection(root, 'session-a', rec.handlers);
    controller.enter();
    root.emit('click', { target: card, button: 0, clientX: 1, clientY: 1 });
    assert.equal(rec.picked.length, 0, '浮窗内点击不应触发选中');
    controller.dispose();
  } finally { dom.restore(); }
});

test('反例：带修饰键的点击不抢，避免破坏用户原有操作', () => {
  const dom = fakeDom();
  try {
    const root = dom.document;
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const card = new FakeElement('div'); card.setAttribute('data-tool', 'bash');
    chat.appendChild(card); root.appendChild(chat);
    const rec = recorder();
    const controller = selection.attachSelection(root, 'session-a', rec.handlers);
    controller.enter();
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
      root.emit('click', { target: card, button: 0, clientX: 1, clientY: 1, [modifier]: true });
    }
    assert.equal(rec.picked.length, 0, '带修饰键的点击不得被拦截');
    controller.dispose();
  } finally { dom.restore(); }
});

test('反例：拖动选字不误触发选中', () => {
  const dom = fakeDom();
  try {
    const root = dom.document;
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const card = new FakeElement('div'); card.setAttribute('data-tool', 'bash');
    chat.appendChild(card); root.appendChild(chat);
    const rec = recorder();
    const controller = selection.attachSelection(root, 'session-a', rec.handlers);
    controller.enter();
    root.emit('mousedown', { target: card, button: 0, clientX: 10, clientY: 10 });
    root.emit('click', { target: card, button: 0, clientX: 90, clientY: 60 });
    assert.equal(rec.picked.length, 0, '位移过大说明在选字，不应误判为选中');
    controller.dispose();
  } finally { dom.restore(); }
});

test('非目标元素点击不触发选中', () => {
  const dom = fakeDom();
  try {
    const root = dom.document;
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const plain = new FakeElement('p'); plain.textContent = '普通文字';
    chat.appendChild(plain); root.appendChild(chat);
    const rec = recorder();
    const controller = selection.attachSelection(root, 'session-a', rec.handlers);
    controller.enter();
    root.emit('click', { target: plain, button: 0, clientX: 1, clientY: 1 });
    assert.equal(rec.picked.length, 0);
    controller.dispose();
  } finally { dom.restore(); }
});

test('Shift+Enter 仍可选中聚焦的卡片', () => {
  const dom = fakeDom();
  try {
    const root = dom.document;
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const card = new FakeElement('div'); card.setAttribute('data-chat-node-key', 'node-7');
    chat.appendChild(card); root.appendChild(chat);
    const rec = recorder();
    const controller = selection.attachSelection(root, 'session-a', rec.handlers);
    controller.enter();
    card.focus();
    root.emit('keydown', { key: 'Enter', shiftKey: true, target: card });
    assert.equal(rec.picked.length, 1);
    assert.equal(rec.picked[0].id, 'node-7');
    controller.dispose();
  } finally { dom.restore(); }
});

/**
 * 锚点必须每张卡片一个。
 *
 * 真实数据里工具卡片**没有** data-chat-node-key，旧实现退回用 data-tool（工具名）当 id：
 * 两张 bash 卡片会撞成同一条，点第二张时第一张也跟着「已选」，取消一张两张一起消失。
 */
test('两张同名工具卡片各自拿到不同锚点，不再撞成一条', () => {
  const dom = fakeDom();
  try {
    const root = dom.document;
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const first = new FakeElement('div'); first.setAttribute('data-tool', 'bash'); first.textContent = '第一条命令';
    const second = new FakeElement('div'); second.setAttribute('data-tool', 'bash'); second.textContent = '第二条命令';
    chat.append(first, second); root.appendChild(chat);
    const a = selection.evidenceFromElement(first, 'session-a');
    const b = selection.evidenceFromElement(second, 'session-a');
    assert.notEqual(a.id, b.id, 'id 必须不同，否则「移除一条」会带走两条');
    assert.notEqual(a.pickId, b.pickId, '锚点必须不同');
    assert.equal(first.getAttribute('data-ea-pick'), a.pickId, '锚点要写在卡片上（主对话高亮靠它找回来）');
    // 同一张卡片再次选中：锚点必须复用，不能每次换一个新的。
    const again = selection.evidenceFromElement(first, 'session-a');
    assert.equal(again.pickId, a.pickId, '同一张卡片的锚点必须稳定');
  } finally { dom.restore(); }
});
