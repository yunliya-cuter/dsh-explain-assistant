import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

const selection = await moduleFromSource('src/client/selection.ts');

// §5.2：点击主对话中的步骤卡片即可选定解释对象，且不得触发原卡片操作。
test('左键点击步骤卡片即选中，并阻止原卡片操作', () => {
  const dom = fakeDom();
  try {
    const root = dom.document;
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const card = new FakeElement('div'); card.setAttribute('data-tool', 'bash');
    card.textContent = '运行了一条命令';
    chat.appendChild(card); root.appendChild(chat);
    const picked = [];
    const controller = selection.attachSelection(root, 'session-a', item => picked.push(item));
    card.focus();
    const event = root.emit('click', { target: card, button: 0, clientX: 10, clientY: 10 });
    assert.equal(picked.length, 1, '左键点击必须选中');
    assert.equal(event.defaultPrevented, true, '必须阻止原卡片的默认操作');
    assert.equal(picked[0].title, 'bash');
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
    const picked = [];
    const controller = selection.attachSelection(root, 'session-a', item => picked.push(item));
    root.emit('contextmenu', { target: card, button: 2 });
    assert.equal(picked.length, 1);
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
    const picked = [];
    const controller = selection.attachSelection(root, 'session-a', item => picked.push(item));
    root.emit('click', { target: card, button: 0, clientX: 1, clientY: 1 });
    assert.equal(picked.length, 0, '浮窗内点击不应触发选中');
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
    const picked = [];
    const controller = selection.attachSelection(root, 'session-a', item => picked.push(item));
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
      root.emit('click', { target: card, button: 0, clientX: 1, clientY: 1, [modifier]: true });
    }
    assert.equal(picked.length, 0, '带修饰键的点击不得被拦截');
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
    const picked = [];
    const controller = selection.attachSelection(root, 'session-a', item => picked.push(item));
    root.emit('mousedown', { target: card, button: 0, clientX: 10, clientY: 10 });
    root.emit('click', { target: card, button: 0, clientX: 90, clientY: 60 });
    assert.equal(picked.length, 0, '位移过大说明在选字，不应误判为选中');
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
    const picked = [];
    const controller = selection.attachSelection(root, 'session-a', item => picked.push(item));
    root.emit('click', { target: plain, button: 0, clientX: 1, clientY: 1 });
    assert.equal(picked.length, 0);
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
    const picked = [];
    const controller = selection.attachSelection(root, 'session-a', item => picked.push(item));
    card.focus();
    root.emit('keydown', { key: 'Enter', shiftKey: true, target: card });
    assert.equal(picked.length, 1);
    assert.equal(picked[0].id, 'node-7');
    controller.dispose();
  } finally { dom.restore(); }
});
