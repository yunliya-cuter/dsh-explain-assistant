import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource, fakeDom, FakeElement } from './fixtures/runtime.mjs';

/**
 * §4/§8/§10 入口按钮的**未读徽标**：`?` ↔ `? ·`。
 *
 * ── 这条修的是什么 ──────────────────────────────────────────────────
 * verify-3082 在 3082 页面上实测：宿主接口确实下发 `unread: true`（curl 实测），
 * 但按钮**始终**是 `?`，三种时刻测到的 `? ·` 数量**恒为 0**。
 * 根因：`HeaderButton` 只**读** registry，却**没有订阅**它——唯一的订阅在 OverlayBridge，
 * 而那只重渲染浮窗那棵树；header 按钮是另一处独立的 slot 注册。
 * 所以数据在、按钮不刷新。
 *
 * ── 为什么本文件不写成「手工构造 props 渲染一次」 ────────────────────
 * 那正是这个缺陷的盲区：渲染函数**看着完全正确**，错的是「没人通知它重渲染」。
 * 手工渲染一次会**恒过**，等于没测。所以本文件全部**从真实状态变化出发**：
 * 先建真实 registry，改状态，再断言订阅回调被触发 / 按钮文案变化。
 */

const badge = await moduleFromSource('src/client/header-badge.ts');
const store = await moduleFromSource('src/client/store.ts');

/** 用一个真实 AssistantRegistry（不是手搓替身），这样 subscribe/emit 的语义是真的。 */
function realRegistry() {
  return new store.AssistantRegistry();
}

/* ================================================================== *
 * 1) 文案：unread 决定 ? 还是 ? ·
 * ================================================================== */

test('未读徽标: unread=true 时文案是「? ·」、title 是「解释小助手有新内容」', async () => {
  assert.equal(badge.headerButtonText(true), '? ·', '未读时必须显示圆点');
  assert.equal(badge.headerButtonTitle(true), '解释小助手有新内容', '未读时 title 必须说明有新内容');
  assert.equal(badge.headerButtonText(false), '?', '无未读时就是「?」');
  assert.equal(badge.headerButtonTitle(false), '打开解释小助手');
  // 非布尔值一律按「未读」处理（不显示徽标），避免把 undefined 当成有新内容
  for (const bad of [undefined, null, 0, '', 'true', {}]) {
    assert.equal(badge.headerButtonText(bad), '?', '非 true 不得显示徽标：' + JSON.stringify(bad));
  }
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
    // 初始不触发：订阅时不该主动回调
    assert.deepEqual(seen, [], '订阅本身不得立刻回调');

    // 真实的状态变化：这就是 registry.update(..., { unread: true }) 在真实链路里做的事
    registry.update('s1', { unread: true });
    assert.deepEqual(seen, [true], 'unread 变成 true 必须触发回调（否则按钮永远不刷新）');

    // 回到 false 也要触发（用户打开浮窗后徽标该消失）
    registry.update('s1', { unread: false });
    assert.deepEqual(seen, [true, false], 'unread 回到 false 也必须触发');

    // 同一个值重复设置不重复触发（避免白重渲染）
    registry.update('s1', { unread: false });
    assert.deepEqual(seen, [true, false], '值没变不得重复触发');
  } finally { stop(); }
});

test('未读徽标 行为级: 按钮文案随真实 unread 变化而改变（? → ? · → ?）', () => {
  const registry = realRegistry();
  registry.get('s1');
  // 模拟组件：把「当前应为的文案」记下来，回调时重算
  let text = badge.headerButtonText(registry.get('s1')?.unread);
  const stop = badge.watchUnread(registry, 's1', () => {
    text = badge.headerButtonText(registry.get('s1')?.unread);
  });
  try {
    assert.equal(text, '?', '初始无未读');
    registry.update('s1', { unread: true });
    assert.equal(text, '? ·', '出现未读后按钮必须变成「? ·」（页面上此前恒为「?」）');
    registry.update('s1', { unread: false });
    assert.equal(text, '?', '打开浮窗后必须回到「?」');
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

    // 反向确认：本会话自己的未读仍然照常触发（不是把功能整个关掉）
    registry.update('s1', { unread: true });
    assert.deepEqual(seen, [true], '本会话的未读必须触发');
  } finally { stop(); }
});

test('未读徽标 隔离: 切换会话后读到的必须是新会话的未读（不串会话）', () => {
  const registry = realRegistry();
  registry.update('s1', { unread: true });
  registry.update('s2', { unread: false });
  assert.equal(badge.headerButtonText(registry.get('s1')?.unread), '? ·', 's1 有未读');
  assert.equal(badge.headerButtonText(registry.get('s2')?.unread), '?', 's2 没有未读');

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

  // 幂等：重复 stop 不应抛
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
 * 5) 接线：entry.ts 必须真的订阅（防止「函数写好了但没人用」）
 * ================================================================== */

test('未读徽标 接线: entry.ts 的 HeaderButton 必须订阅 registry 并取消订阅', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/client/entry.ts', import.meta.url), 'utf8');
  assert.match(source, /watchUnread\(registry, id/, 'HeaderButton 必须订阅它自己那个会话的未读');
  assert.match(source, /return watchUnread\(/, '必须在 useEffect 里返回取消订阅函数（否则泄漏）');
  assert.match(source, /headerButtonText\(unread\)/, '按钮文案必须走统一判定');
  assert.match(source, /headerButtonTitle\(unread\)/, '按钮 title 必须走统一判定');
  // 旧写法：直接读 state?.unread 内联三元判断（就是当初没有被订阅的那版）
  assert.equal(/\}, state\?\.unread \? '\? ·' : '\?'\)/.test(source), false, '不得再用未订阅的内联三元写法');
});

test('未读徽标 真链路: 用真 registry + 真订阅，模拟页面上三个时刻', () => {
  const registry = realRegistry();
  const id = 'session-real';
  let text = badge.headerButtonText(registry.get(id)?.unread);
  const stop = badge.watchUnread(registry, id, () => { text = badge.headerButtonText(registry.get(id)?.unread); });
  try {
    // 时刻1：宿主下发 unread:true（refreshState 回写时就是这个效果）
    registry.update(id, { unread: true });
    assert.equal(text, '? ·', '时刻1（关窗时宿主 unread=true）：按钮必须显示「? ·」');

    // 时刻2：用户打开浮窗 → open() 里 unread 被清掉
    registry.update(id, { unread: false, open: true });
    assert.equal(text, '?', '时刻2（打开浮窗后）：按钮必须回到「?」');

    // 时刻3：问答结束 → markUnread
    registry.update(id, { unread: true });
    assert.equal(text, '? ·', '时刻3（问答结束后）：按钮必须显示「? ·」');
  } finally { stop(); }
});
