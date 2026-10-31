import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource, fakeDom, FakeElement } from './fixtures/runtime.mjs';

/**
 * 入口按钮（主对话右上角）的**图标**与**未读徽标**。
 *
 * ── 这一版为什么重写 ────────────────────────────────────────────────
 * 旧版按钮里是一个**文字字符** `?`（未读时 `? ·`）。用户 2026-10-31：
 * 「这个图标太丑，改改」。丑的根因是它是一段受宿主字体决定的文字，
 * 所以这里的断言也从「文本等于 ? ·」改成「**一棵自绘 SVG + 一个常驻未读点**」：
 * 文本断言会把这个丑的形态钉死，改成 DOM 断言才测得住新形态。
 *
 * 仍然保留的、也是本文件原本要守的东西：
 * 1. 订阅必须真的被**状态变化**触发（原缺陷：数据在、按钮不刷新）；
 * 2. 只订阅本会话（不串会话）；
 * 3. 卸载必须取消订阅（不泄漏）；
 * 4. entry.ts 必须真的接线（防止「函数写好了但没人用」）。
 *
 * 为什么本文件不是「手工构造 props 渲染一次」：那正是原缺陷的盲区 ——
 * 渲染函数看着完全正确，错的是「没人通知它重渲染」，手工渲染一次会恒过。
 */

const badge = await moduleFromSource('src/client/header-badge.ts');
const store = await moduleFromSource('src/client/store.ts');

/** 用一个真实 AssistantRegistry（不是手搓替身），这样 subscribe/emit 的语义是真的。 */
function realRegistry() {
  return new store.AssistantRegistry();
}

/**
 * 用一个最小的 createElement 工厂建出入口内容。
 *
 * 为什么把工厂注入进来、而不直接造 DOM：真实 React **不接受 DOM 节点当子节点**
 * （会当成普通对象，渲染不出来）。第一版就是 `document.createElement` 造节点再当 children，
 * 假 React 存什么是什么 → 测试全绿，真实页面上却是"按钮还在、图标没了"。
 * 注入工厂后，这条链路测的才是 React 真正拿到的东西。
 */
function fakeCreateElement(type, props, ...children) { return { type, props, children }; }
function iconTree() { return badge.createHeaderContent(fakeCreateElement); }

/* ================================================================== *
 * 1) 状态：unread / busy 决定按钮长什么样
 * ================================================================== */

test('入口图标: unread 决定 data-unread / title / aria-label（不再是文字 ?）', () => {
  assert.deepEqual(badge.headerButtonState(false, false), {
    unread: false, busy: false, title: '打开解释小助手', ariaLabel: '打开解释小助手',
  });
  const unread = badge.headerButtonState(true, false);
  assert.equal(unread.unread, true, '未读时必须显示徽标');
  assert.equal(unread.title, '解释小助手有新内容', '未读时 title 必须说明有新内容');
  assert.equal(unread.ariaLabel, '解释小助手（有新内容）', '未读必须进无障碍名：图标本身是 aria-hidden');
  // 非布尔值一律按「无未读」处理，避免把 undefined 当成有新内容
  for (const bad of [undefined, null, 0, '', 'true', {}]) {
    assert.equal(badge.headerButtonState(bad, false).unread, false, '非 true 不得显示徽标：' + JSON.stringify(bad));
  }
  assert.equal(badge.headerButtonState(false, true).busy, true, 'busy 必须能从状态里读出来（CSS 靠它切层）');
});

test('入口图标: 内容完全由注入的 createElement 产出（不碰 DOM —— 真实 React 不接受 DOM 节点）', () => {
  const calls = [];
  const h = (type, props, ...children) => { calls.push({ type, props, children }); return { type, props, children }; };
  const tree = badge.createHeaderContent(h);
  // span(根) + svg(气泡) + 3×path + svg(弧) + circle + span(点) = 8
  assert.equal(calls.length, 8, '所有节点都必须经过 createElement 工厂，实际调用 ' + calls.length + ' 次');
  assert.deepEqual(calls.map(c => c.type).sort(), ['circle', 'path', 'path', 'path', 'span', 'span', 'svg', 'svg'], '必须恰好这些元素（顺序按求值先后，不做硬约束）');
  assert.equal(tree.children.length, 3);
  // 直接交给真实 React 的东西必须有 type/props —— DOM 节点没有 type（它是 tagName）
  for (const child of tree.children) {
    assert.equal(typeof child.type, 'string');
    assert.equal(child.type, child.type.toLowerCase(), 'React 元素类型必须是小写标签名');
  }
});

test('入口图标: 内容是一棵自绘 SVG（气泡 + 两行 + 忙碌弧 + 未读点），不是字体字符', () => {
  const tree = iconTree();

  // 0) 最要紧的一条：交给 React 的必须是**元素树**，不是 DOM 节点。
  //    （第一版把 DOM 节点当 children，真实 React 直接渲染不出来 —— 页面上图标空白。）
  const assertElement = node => {
    assert.equal(typeof node, 'object', '子节点必须是元素对象');
    assert.equal(typeof node?.type, 'string', '子节点必须有 type（React 元素），实际=' + JSON.stringify(Object.keys(node || {})));
    assert.equal(typeof node?.props, 'object');
  };

  assert.equal(tree.type, 'span');
  assert.equal(tree.props.className, 'ea-hbtn');
  assert.equal(tree.children.length, 3, '气泡 / 忙碌弧 / 未读点三层必须常驻（切换时不换节点）');
  tree.children.forEach(assertElement);

  const [glyph, ring, dot] = tree.children;
  assert.equal(glyph.type, 'svg');
  assert.equal(glyph.props.className, 'ea-hbtn-glyph');
  assert.equal(glyph.props.viewBox, '0 0 16 16', '必须与宿主 header 图标同一个 16 网格');
  assert.equal(glyph.props.stroke, 'currentColor', '必须吃主题色，不能写死颜色');
  assert.equal(glyph.props.strokeWidth, 1, '与隔壁细线图标同线宽');
  assert.equal(glyph.props.fill, 'none');
  assert.equal(glyph.props.strokeLinecap, 'round');
  assert.equal(glyph.props.strokeLinejoin, 'round');
  assert.equal(glyph.props['aria-hidden'], 'true', '图标是装饰：语义靠按钮的 aria-label');

  assert.equal(glyph.children.length, 3, '气泡本体 + 两行短横线');
  for (const path of glyph.children) {
    assertElement(path);
    assert.equal(path.type, 'path');
    assert.ok(String(path.props.d).startsWith('M'), 'path 必须有真实几何，实际=' + path.props.d);
  }

  assert.equal(ring.type, 'svg');
  assert.equal(ring.props.className, 'ea-hbtn-ring');
  assert.equal(ring.props.stroke, 'currentColor', '忙碌弧必须吃主题色');
  assert.equal(ring.children.length, 1);
  const circle = ring.children[0];
  assertElement(circle);
  assert.equal(circle.type, 'circle');
  assert.equal(circle.props.r, 6, '忙碌弧必须与气泡同墨迹框（r=6 → 12×12），切换时重心不移动');

  assert.equal(dot.type, 'span');
  assert.equal(dot.props.className, 'ea-hbtn-dot', '未读点必须常驻挂载（显隐交给 CSS，不重排）');
});

/* ================================================================== *
 * 2) 最关键：订阅必须真的被「状态变化」触发
 * ================================================================== */

test('未读徽标 行为级: registry 里的 unread 变化必须触发订阅回调（这就是原缺陷）', () => {
  const registry = realRegistry();
  registry.get('s1');                       // 建立初始状态（unread=false）
  const seen = [];
  const stop = badge.watchUnread(registry, 's1', unread => { seen.push(unread); });
  try {
    assert.deepEqual(seen, [], '订阅本身不得立刻回调');

    registry.update('s1', { unread: true });
    assert.deepEqual(seen, [true], 'unread 变成 true 必须触发回调（否则按钮永远不刷新）');

    registry.update('s1', { unread: false });
    assert.deepEqual(seen, [true, false], 'unread 回到 false 也必须触发');

    registry.update('s1', { unread: false });
    assert.deepEqual(seen, [true, false], '值没变不得重复触发');
  } finally { stop(); }
});

test('未读徽标 行为级: 按钮状态随真实 unread 变化而改变（无→有→无）', () => {
  const registry = realRegistry();
  registry.get('s1');
  let view = badge.headerButtonState(registry.get('s1')?.unread, false);
  const stop = badge.watchUnread(registry, 's1', () => {
    view = badge.headerButtonState(registry.get('s1')?.unread, false);
  });
  try {
    assert.equal(view.unread, false, '初始无未读');
    registry.update('s1', { unread: true });
    assert.equal(view.unread, true, '出现未读后按钮必须挂上徽标（页面上此前恒为无徽标）');
    registry.update('s1', { unread: false });
    assert.equal(view.unread, false, '打开浮窗后必须回到无徽标');
  } finally { stop(); }
});

/* ================================================================== *
 * 3) 会话隔离：按钮反映的必须是「当前会话」的未读
 * ================================================================== */

test('未读徽标 隔离: 别的会话变未读不得影响本会话按钮', () => {
  const registry = realRegistry();
  registry.get('s1');
  registry.get('s2');
  const seen = [];
  const stop = badge.watchUnread(registry, 's1', unread => { seen.push(unread); });
  try {
    registry.update('s2', { unread: true });        // 另一个会话有新内容
    assert.deepEqual(seen, [], '别的会话的未读不得触发本会话按钮重渲染');

    registry.update('s1', { unread: true });
    assert.deepEqual(seen, [true], '本会话的未读必须触发');
  } finally { stop(); }
});

test('未读徽标 隔离: 切换会话后读到的必须是新会话的未读（不串会话）', () => {
  const registry = realRegistry();
  registry.update('s1', { unread: true });
  registry.update('s2', { unread: false });
  assert.equal(badge.headerButtonState(registry.get('s1')?.unread, false).unread, true, 's1 有未读');
  assert.equal(badge.headerButtonState(registry.get('s2')?.unread, false).unread, false, 's2 没有未读');

  const seen = [];
  const stop = badge.watchUnread(registry, 's2', unread => { seen.push(unread); });
  try {
    registry.update('s1', { unread: false });       // 只动 s1
    assert.deepEqual(seen, [], 'watch 挂在 s2 上时，s1 的变化不得触发');
  } finally { stop(); }
});

/* ================================================================== *
 * 4) 生命周期：卸载必须取消订阅
 * ================================================================== */

test('未读徽标 泄漏: 取消订阅后，后续状态变化不得再触发回调', () => {
  const registry = realRegistry();
  registry.get('s1');
  const seen = [];
  const stop = badge.watchUnread(registry, 's1', unread => { seen.push(unread); });
  registry.update('s1', { unread: true });
  assert.deepEqual(seen, [true]);

  stop();                                          // 组件卸载
  registry.update('s1', { unread: false });
  registry.update('s1', { unread: true });
  assert.deepEqual(seen, [true], '取消订阅后不得再收到回调（否则泄漏）');

  assert.doesNotThrow(() => stop(), '重复取消订阅必须安全');
});

test('未读徽标 降级: 没有 sessionId 时不订阅、不抛', () => {
  const registry = realRegistry();
  let called = 0;
  let stop;
  assert.doesNotThrow(() => { stop = badge.watchUnread(registry, '', () => { called++; }); });
  assert.equal(typeof stop, 'function', '必须返回可调用的取消函数');
  registry.update('s1', { unread: true });
  assert.equal(called, 0, '空 sessionId 不得订阅任何东西');
  stop();
});

test('未读徽标 降级: registry.subscribe 抛异常时不影响调用方', () => {
  const registry = { subscribe() { throw new Error('registry down'); }, get: () => ({ unread: false }) };
  let stop;
  assert.doesNotThrow(() => { stop = badge.watchUnread(registry, 's1', () => {}); });
  stop();
});

/* ================================================================== *
 * 5) 接线：entry.ts 必须真的订阅并真的用上新的图标（防止「函数写好了但没人用」）
 * ================================================================== */

test('未读徽标 接线: entry.ts 的 HeaderButton 必须订阅 registry 并取消订阅', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/client/entry.ts', import.meta.url), 'utf8');
  assert.match(source, /watchUnread\(registry, id/, 'HeaderButton 必须订阅它自己那个会话的未读');
  assert.match(source, /return watchUnread\(/, '必须在 useEffect 里返回取消订阅函数（否则泄漏）');
  assert.match(source, /headerButtonState\(unread, busy\)/, '按钮状态必须走统一判定');
  assert.match(source, /createHeaderContent\(h\)/, '按钮内容必须是自绘图标（不再是文字），且以元素树交给 React');
  assert.equal(/createHeaderContent\(document\)/.test(source), false, '不得把 DOM 节点当 children 交给 React（真实 React 渲染不出来）');
  assert.match(source, /'data-unread': view\.unread/, '未读必须体现在按钮的 data-unread 上（CSS 靠它切徽标）');
  assert.match(source, /'data-busy': view\.busy/, '忙碌必须体现在按钮的 data-busy 上（CSS 靠它切弧）');
  assert.equal(/'\? ·'/.test(source), false, '不得再出现旧版「? ·」文案');
});

test('未读徽标 真链路: 用真 registry + 真订阅，模拟页面上三个时刻', () => {
  const registry = realRegistry();
  const id = 'session-real';
  let view = badge.headerButtonState(registry.get(id)?.unread, false);
  const stop = badge.watchUnread(registry, id, () => { view = badge.headerButtonState(registry.get(id)?.unread, false); });
  try {
    registry.update(id, { unread: true });
    assert.equal(view.unread, true, '时刻1（关窗时宿主 unread=true）：按钮必须显示徽标');

    registry.update(id, { unread: false, open: true });
    assert.equal(view.unread, false, '时刻2（打开浮窗后）：徽标必须消失');

    registry.update(id, { unread: true });
    assert.equal(view.unread, true, '时刻3（问答结束后）：徽标必须回来');
  } finally { stop(); }
});
