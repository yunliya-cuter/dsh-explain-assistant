import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource, fakeDom, FakeElement } from './fixtures/runtime.mjs';

const selection = await moduleFromSource('src/client/selection.ts');

/**
 * §5.2 / §11.4 B3：选择只确定讲解对象，**不触发原卡片的执行、链接、折叠等操作**。
 *
 * 修复前全库没有 stopPropagation，只有 preventDefault。preventDefault 只取消默认行为
 * （例如链接跳转），挡不住事件继续冒泡到 React 挂在容器上的委托监听——原卡片的
 * onClick（执行命令、展开折叠）照样会跑。这里直接验证事件被吞掉。
 *
 * 注意：假 DOM 不做真实冒泡，所以事件统一在 root（attachSelection 挂载的节点）上触发，
 * 并把 target 指到卡片；这与真实浏览器里事件从卡片冒泡到 root 的路径等价。
 */

/** 建一棵 root > chat > card 的树，并返回 root 与 card。 */
function tree() {
  const root = new FakeElement('div');
  const chat = new FakeElement('div');
  chat.setAttribute('data-conversation-scroll', '');
  const node = new FakeElement('div');
  node.setAttribute('data-chat-node-key', 'node-1');
  node.textContent = '步骤内容';
  chat.appendChild(node);
  root.appendChild(chat);
  return { root, node };
}

test('B3: 左键点选必须吞掉事件（stopPropagation），不能只 preventDefault', () => {
  const dom = fakeDom();
  try {
    const { root, node } = tree();
    let selected = 0;
    const controller = selection.attachSelection(root, 'session-a', () => { selected++; });
    try {
      const event = root.emit('click', { button: 0, clientX: 10, clientY: 10, target: node });
      assert.equal(selected, 1, '必须选中一次');
      assert.equal(event.defaultPrevented, true, '必须 preventDefault');
      assert.equal(event.propagationStopped, true, '必须 stopPropagation：否则原卡片仍会响应');
    } finally { controller.dispose(); }
  } finally { dom.restore(); }
});

test('B3: 原卡片自己的冒泡处理器在选中时不得被执行', () => {
  const dom = fakeDom();
  try {
    const { root, node } = tree();
    let originalHandlerRuns = 0;
    // 模拟 React 的冒泡委托：原卡片在冒泡阶段挂了 onClick。
    root.addEventListener('click', () => { originalHandlerRuns++; });
    const controller = selection.attachSelection(root, 'session-a', () => {});
    try {
      root.emit('click', { button: 0, clientX: 10, clientY: 10, target: node });
      assert.equal(originalHandlerRuns, 0, '原卡片的点击处理器绝不能被执行（§5.2）');
    } finally { controller.dispose(); }
  } finally { dom.restore(); }
});

test('B3: 右键点选同样吞掉事件', () => {
  const dom = fakeDom();
  try {
    const { root, node } = tree();
    let selected = 0;
    const controller = selection.attachSelection(root, 'session-a', () => { selected++; });
    try {
      const event = root.emit('contextmenu', { button: 2, target: node });
      assert.equal(selected, 1);
      assert.equal(event.defaultPrevented, true, '必须阻止右键菜单');
      assert.equal(event.propagationStopped, true);
    } finally { controller.dispose(); }
  } finally { dom.restore(); }
});

test('B3: Shift+Enter 选中同样吞掉事件', () => {
  const dom = fakeDom();
  try {
    // keydown 挂在 document 上，且要聚焦卡片：keydown 读的是 document.activeElement。
    const root = dom.document;
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const node = new FakeElement('div'); node.setAttribute('data-chat-node-key', 'node-k');
    chat.appendChild(node); root.appendChild(chat);
    let selected = 0;
    const controller = selection.attachSelection(root, 'session-a', () => { selected++; });
    try {
      node.focus();
      const event = root.emit('keydown', { key: 'Enter', shiftKey: true, target: node });
      assert.equal(selected, 1, 'Shift+Enter 必须选中');
      assert.equal(event.defaultPrevented, true);
      assert.equal(event.propagationStopped, true);
    } finally { controller.dispose(); }
  } finally { dom.restore(); }
});

test('B3: 监听注册在捕获阶段，才能抢在 React 冒泡委托之前', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/selection.ts', import.meta.url), 'utf8');
  for (const type of ['click', 'contextmenu', 'mousedown', 'keydown']) {
    assert.match(source, new RegExp("addEventListener\\('" + type + "',[^)]*,\\s*true\\)"), type + ' 必须以捕获阶段注册');
  }
  assert.match(source, /stopPropagation/, '必须调用 stopPropagation');
});

test('反例: 浮窗内部的点击不得被吞（不能影响小助手自己的界面）', () => {
  const dom = fakeDom();
  try {
    const root = new FakeElement('div');
    root.setAttribute('data-conversation-scroll', '');
    const inside = new FakeElement('div');
    inside.className = 'dsh-explain-assistant-overlay';
    const node = new FakeElement('div');
    node.setAttribute('data-chat-node-key', 'n');
    inside.appendChild(node);
    root.appendChild(inside);
    let selected = 0;
    const controller = selection.attachSelection(root, 'session-a', () => { selected++; });
    try {
      const event = root.emit('click', { button: 0, clientX: 1, clientY: 1, target: node });
      assert.equal(selected, 0, '浮窗内部点击不得被当成选中');
      assert.equal(event.propagationStopped, false, '也不该吞掉浮窗自己的事件');
    } finally { controller.dispose(); }
  } finally { dom.restore(); }
});

test('反例: 非目标元素点击既不选中也不吞事件', () => {
  const dom = fakeDom();
  try {
    const root = new FakeElement('div');
    root.setAttribute('data-conversation-scroll', '');
    const plain = new FakeElement('p');
    root.appendChild(plain);
    let selected = 0;
    const controller = selection.attachSelection(root, 'session-a', () => { selected++; });
    try {
      const event = root.emit('click', { button: 0, clientX: 1, clientY: 1, target: plain });
      assert.equal(selected, 0);
      assert.equal(event.propagationStopped, false, '非目标不得被吞');
    } finally { controller.dispose(); }
  } finally { dom.restore(); }
});

test('反例: 拖动选字不吞事件也不选中', () => {
  const dom = fakeDom();
  try {
    const { root, node } = tree();
    let selected = 0;
    const controller = selection.attachSelection(root, 'session-a', () => { selected++; });
    try {
      root.emit('mousedown', { button: 0, clientX: 10, clientY: 10, target: node });
      const event = root.emit('click', { button: 0, clientX: 90, clientY: 90, target: node });
      assert.equal(selected, 0, '拖动选字不得被当成选中');
      assert.equal(event.propagationStopped, false, '拖动时不得吞事件，用户还在选字');
    } finally { controller.dispose(); }
  } finally { dom.restore(); }
});
