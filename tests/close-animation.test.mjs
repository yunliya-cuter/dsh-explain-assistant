import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 关闭浮窗的退场。
 *
 * 用户这一轮报了两个现象：「关掉小助手时的动画卡卡的」「关掉过程中会弹至上下文最上方」。
 * 上一版的做法是"克隆一份留在原地播动画"，两个现象都由它而来：
 *   · 克隆体不继承 scrollTop → 从**对话最上面**开始播（= 弹回顶部）；
 *   · 克隆整棵面板是一次十几毫秒的长任务，正好压在动画第一帧（= 卡）。
 * 现在改成**原节点原地**播完再摘。这组测试钉的就是这两点，防止有人改回克隆。
 */

const exitAnim = await moduleFromSource('src/client/exit-anim.ts');

function hostWith(child) {
  const host = new FakeElement('div');
  if (child) host.appendChild(child);
  return host;
}

test('退场的是**原来那个节点**，不是克隆体（克隆体会丢滚动位置）', () => {
  const dom = fakeDom();
  try {
    const panel = new FakeElement('section');
    panel.className = 'ea-overlay';
    const host = hostWith(panel);
    const animated = exitAnim.beginExit(host, panel);
    assert.equal(animated, true, '默认应当播退场');
    assert.equal(host.firstElementChild, panel, '留在场上的必须还是原节点（克隆体会从对话顶部开始播）');
    assert.equal(panel.getAttribute('data-leaving'), 'true');
    assert.equal(panel.getAttribute('aria-hidden'), 'true', '退场中的画面必须对读屏隐藏');
    assert.equal(panel.style.pointerEvents, 'none', '退场期间绝不能拦住用户的下一次点击');
  } finally { dom.restore(); }
});

test('滚动位置必须原样保留（用户报的「关掉过程中弹至最上方」）', () => {
  const dom = fakeDom();
  try {
    const panel = new FakeElement('section');
    const body = new FakeElement('div');
    body.className = 'ea-body';
    body.scrollTop = 1234;
    panel.appendChild(body);
    const host = hostWith(panel);
    exitAnim.beginExit(host, panel);
    const kept = host.firstElementChild;
    assert.equal(kept.querySelector('.ea-body').scrollTop, 1234, '退场期间滚动位置不得被重置（否则就是"弹回顶部"）');
  } finally { dom.restore(); }
});

test('播完之后才摘掉节点', async () => {
  const dom = fakeDom();
  try {
    const panel = new FakeElement('section');
    const host = hostWith(panel);
    exitAnim.beginExit(host, panel);
    assert.equal(host.children.length, 1, '刚播的时候还得在');
    await new Promise(resolve => setTimeout(resolve, exitAnim.EXIT_MS + 60));
    assert.equal(host.children.length, 0, 'EXIT_MS 之后必须摘掉，不留幽灵节点');
  } finally { dom.restore(); }
});

test('减少动态偏好：不播，交给调用方立刻摘', () => {
  const dom = fakeDom();
  const previous = globalThis.matchMedia;
  try {
    globalThis.matchMedia = () => ({ matches: true });
    const panel = new FakeElement('section');
    const host = hostWith(panel);
    assert.equal(exitAnim.beginExit(host, panel), false);
    assert.equal(panel.getAttribute('data-leaving'), null, '不该挂退场标记');
  } finally { globalThis.matchMedia = previous; dom.restore(); }
});

test('强制不播 / 节点不在宿主里：都返回 false', () => {
  const dom = fakeDom();
  try {
    const panel = new FakeElement('section');
    const host = hostWith(panel);
    assert.equal(exitAnim.beginExit(host, panel, { animate: false }), false);
    const stranger = new FakeElement('section');
    assert.equal(exitAnim.beginExit(host, stranger), false, '节点不在宿主里就不是这次退场的对象');
    assert.equal(exitAnim.beginExit(host, null), false);
  } finally { dom.restore(); }
});

/* ---------- 源码契约 ---------- */
test('源码：entry.ts 用原地退场，且不再 cloneNode（防退化）', async () => {
  const entry = await readFile(new URL('../src/client/entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /beginExit\(/, '必须调用 beginExit');
  assert.match(entry, /dispose\(\{ keepElement: true \}\)/, '必须告诉 dispose 别把节点摘掉（否则动画没得播）');
  assert.match(entry, /registry\.current\?\.open === false/, '必须先判断"这是关闭"再播：切会话不该播关窗动画');
  const exitRaw = await readFile(new URL('../src/client/exit-anim.ts', import.meta.url), 'utf8');
  // 剥掉注释再查：注释里会写「曾经用 cloneNode」来说明为什么改掉，那不是实现。
  const exit = exitRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/cloneNode/.test(exit), false, '退场不得再克隆节点：克隆体会丢滚动位置，而且克隆本身就是一次掉帧');
});

test('样式：退场关键帧只动 opacity / transform，不得再有 blur 或 scale', async () => {
  const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('@keyframes ea-overlay-out'), css.indexOf('}', css.indexOf('@keyframes ea-overlay-out')) + 1);
  assert.ok(block.includes('opacity'), '必须淡出');
  assert.equal(/blur\(/.test(block), false, '不得对整块玻璃做 blur：每帧重栅格化，实测掉帧');
  assert.equal(/scale\(/.test(block), false, '不得缩放：同样迫使 backdrop 重算');
  assert.match(css, /\.ea-overlay\[data-leaving=true\]\{[^}]*will-change:opacity,transform/, '要提前提成合成层');
});
