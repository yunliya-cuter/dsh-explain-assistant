import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 关闭浮窗的退场（用户要求「优化关闭小助手后的动画」）。
 *
 * 旧实现是**瞬间消失**：清理函数里 host.replaceChildren() 一跑节点就没了，
 * 没有任何一帧可以拿来做动画。现在真节点立刻释放，克隆体留在原地播 180ms。
 *
 * 这组测试盯三件事，且都是"做错了也看不出来"的地方：
 * 1. 真节点必须**立刻**释放（监听、增量渲染器不能因为动画多活 200ms）；
 * 2. 克隆体必须是克隆体（不是原节点被延迟摘掉）—— 否则退场期间它还能吃点击；
 * 3. 减少动态偏好 / 强制不播 / 空宿主时不得留下任何东西。
 */

const exitAnim = await moduleFromSource('src/client/exit-anim.ts');

function hostWith(child) {
  const host = new FakeElement('div');
  if (child) host.appendChild(child);
  return host;
}

test('关闭：真节点立刻释放，克隆体留在原地并带 data-leaving', () => {
  const dom = fakeDom();
  try {
    const panel = new FakeElement('section');
    panel.className = 'ea-overlay';
    const host = hostWith(panel);
    let released = 0;
    const animated = exitAnim.withExitGhost(host, () => { released++; panel.remove() });
    assert.equal(animated, true, '默认应当播退场');
    assert.equal(released, 1, '真节点必须在同一个 tick 里被释放，不能等动画');
    assert.equal(host.children.length, 1, '退场期间宿主里应当还有一份画面');
    const ghost = host.firstElementChild;
    assert.notEqual(ghost, panel, '留在场上必须是克隆体，不是原节点（原节点带监听器，留着会吃点击）');
    assert.equal(ghost.getAttribute('data-leaving'), 'true');
    assert.equal(ghost.getAttribute('aria-hidden'), 'true', '退场中的画面必须对读屏隐藏');
    assert.equal(ghost.className, 'ea-overlay', '克隆体要保留外观，否则动画是一条空框');
  } finally { dom.restore(); }
});

test('退场播完后克隆体必须被摘掉（不留幽灵节点）', async () => {
  const dom = fakeDom();
  try {
    const panel = new FakeElement('section');
    const host = hostWith(panel);
    exitAnim.withExitGhost(host, () => panel.remove());
    assert.equal(host.children.length, 1);
    await new Promise(resolve => setTimeout(resolve, exitAnim.EXIT_MS + 60));
    assert.equal(host.children.length, 0, 'EXIT_MS 之后宿主必须是空的');
  } finally { dom.restore(); }
});

test('减少动态偏好：不播动画，宿主立刻清空', () => {
  const dom = fakeDom();
  const previous = globalThis.matchMedia;
  try {
    globalThis.matchMedia = () => ({ matches: true });
    const panel = new FakeElement('section');
    const host = hostWith(panel);
    let released = 0;
    const animated = exitAnim.withExitGhost(host, () => { released++; panel.remove() });
    assert.equal(animated, false, 'prefers-reduced-motion 下不得播退场');
    assert.equal(released, 1);
    assert.equal(host.children.length, 0, '既然不播，就不能留下任何节点');
  } finally { globalThis.matchMedia = previous; dom.restore(); }
});

test('强制不播（宿主销毁/插件卸载）：与减少动态偏好同一条路', () => {
  const dom = fakeDom();
  try {
    const panel = new FakeElement('section');
    const host = hostWith(panel);
    const animated = exitAnim.withExitGhost(host, () => panel.remove(), { animate: false });
    assert.equal(animated, false);
    assert.equal(host.children.length, 0);
  } finally { dom.restore(); }
});

test('空宿主：不抛错，也不谎报"播了动画"', () => {
  const dom = fakeDom();
  try {
    const host = hostWith(null);
    let released = 0;
    const animated = exitAnim.withExitGhost(host, () => { released++ });
    assert.equal(animated, false);
    assert.equal(released, 1, '释放回调仍然必须被调用（否则真节点的资源就漏了）');
    assert.equal(host.children.length, 0);
  } finally { dom.restore(); }
});

test('克隆体上的 id 必须被剥掉（否则页面上出现两份同名 id，aria-labelledby 会指错）', () => {
  const dom = fakeDom();
  try {
    const panel = new FakeElement('section');
    const title = new FakeElement('strong');
    title.setAttribute('id', 'dsh-explain-assistant-title');
    panel.appendChild(title);
    const host = hostWith(panel);
    exitAnim.withExitGhost(host, () => panel.remove());
    const ghost = host.firstElementChild;
    assert.equal(ghost.getAttribute('id'), null, '根节点上的 id 要剥掉');
    assert.equal(ghost.querySelector('[id]'), null, '后代上的 id 也要剥掉');
  } finally { dom.restore(); }
});

/* ---------- 源码契约：入口必须真的用上这套退场 ---------- */
test('源码：entry.ts 的清理路径按 open 状态决定播不播退场（切会话不得播）', async () => {
  const entry = await readFile(new URL('../src/client/entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /withExitGhost\(/, '必须调用 withExitGhost，否则"关闭有动画"会静默退化成瞬间消失');
  assert.match(entry, /registry\.current\?\.open === false/, '必须先判断"这是关闭"再播：切会话时用户没有关窗，不该播关窗动画');
  assert.equal(/withExitGhost\(host[^)]*\)\s*;\s*host\.replaceChildren\(\)/.test(entry), false, '必须在 withExitGhost 之后不要再清一次宿主（会把克隆体一起清掉）');
});

test('源码：选择模式的多选语义确实接到了入口（替换 vs 加选）', async () => {
  const entry = await readFile(new URL('../src/client/entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /options\?\.additive === true \? before : \[\]/, '普通左键必须替换、Ctrl+左键必须加选');
  assert.match(entry, /syncPickMarks\(document, next\)/, '替换时要立刻把上一张的高亮灭掉，不能等下一轮重画');
});
