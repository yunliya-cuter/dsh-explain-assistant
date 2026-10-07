import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource, waitFor } from './fixtures/runtime.mjs';

/**
 * §4/§10 冷启动未读徽标：**硬刷新后不必先打开浮窗，入口就该显示「? ·」**。
 *
 * 缺陷（verify-3082 在 3082 上实测，0.1.37）：
 * 宿主 /state 返回 unread=true（curl 实测），硬刷新页面后不打开浮窗，
 * 入口按钮 textContent 仍是「?」、title 仍是「打开解释小助手」；
 * **必须先点开一次浮窗**（触发 /state 拉取）再关闭，才变成「? ·」。
 * 用户可见后果：刷新后即使有新内容，入口也不提示。
 *
 * 根因：unread 只在 refreshState()（/state 回来之后）才写进 registry，
 * 而 refreshState 只在 open() / 回答完成后调用；冷页面首次渲染时 registry 里
 * 该会话还是初始 unread=false，按钮读到的就是 false。
 *
 * 本文件的测试全部**从状态变化出发**（走真 api.state → 真 registry → 真按钮文案判定），
 * 不手工构造 props 渲染一次——那种写法恰好会漏掉这个 bug。
 */

const client = await moduleFromSource('src/client/index.ts');
const badge = await moduleFromSource('src/client/header-badge.ts');

/** 可控 api：记录调用次数，可让 /state 失败。 */
function fakeApi(unread = true) {
  let calls = 0;
  let fail = false;
  let gate = null;
  const api = {
    get calls() { return calls; },
    set fail(value) { fail = value; },
    set gate(value) { gate = value; },
    async state() {
      calls++;
      if (gate) await gate;
      if (fail) throw new Error('state failed');
      return { payload: { unread, records: [], hasEarlier: false } };
    },
    models: async () => ({ payload: {} }),
    selectModel: async () => ({}),
    history: async () => ({ payload: {} }),
    historyResult: async () => ({ payload: {} }),
    ask: async () => {}, compact: async () => {}, cancel: async () => {},
    forget: async () => ({}),
  };
  return api;
}

/* ================================================================== *
 * 1) 核心：冷启动就能拿到未读，按钮显示 ? ·
 * ================================================================== */

test('冷启动徽标: 宿主 unread=true 时，不打开浮窗也必须变成「? ·」', async () => {
  const api = fakeApi(true);
  const plugin = client.createClientPlugin({ api, session: { id: 'cold-1' } });
  try {
    // 冷启动：registry 里这个会话还没有任何宿主数据
    assert.equal(plugin.registry.get('cold-1').unread, false, '前置：冷启动时本地还没有未读');

    // 模拟 HeaderButton 挂载时的预取（entry.ts 中确实这么做）
    await plugin.primeUnread('cold-1');

    const unread = plugin.registry.get('cold-1').unread;
    assert.equal(unread, true, '冷启动预取后必须拿到宿主未读');
    assert.equal(badge.headerButtonText(unread), '? ·', '按钮必须显示「? ·」，不需要先点开浮窗');
    assert.equal(badge.headerButtonTitle(unread), '解释小助手有新内容');
  } finally { plugin.dispose(); }
});

test('冷启动徽标 真链路: 预取 → 订阅触发 → 按钮文案跟着变', async () => {
  const api = fakeApi(true);
  const plugin = client.createClientPlugin({ api, session: { id: 'cold-2' } });
  let text = '?';
  const stop = badge.watchUnread(plugin.registry, 'cold-2', () => {
    text = badge.headerButtonText(plugin.registry.get('cold-2').unread);
  });
  try {
    assert.equal(text, '?', '前置：还没有未读');
    await plugin.primeUnread('cold-2');           // 冷启动预取
    assert.equal(text, '? ·', '预取写入 registry 后，订阅必须通知按钮重渲染（整条链都要通）');
  } finally { stop(); plugin.dispose(); }
});

/* ================================================================== *
 * 2) 去重：同一会话只打一次
 * ================================================================== */

test('冷启动徽标 去重: 同一会话并发多次预取只打一次接口', async () => {
  const api = fakeApi(true);
  let release;
  api.gate = new Promise(resolve => { release = resolve; });   // 卡住，制造并发窗口
  const plugin = client.createClientPlugin({ api, session: { id: 'dedup-1' } });
  try {
    const all = [1, 2, 3, 4, 5].map(() => plugin.primeUnread('dedup-1'));
    release();
    await Promise.all(all);
    assert.equal(api.calls, 1, '同一会话并发 5 次预取只应打 1 次接口，实际 ' + api.calls);
  } finally { plugin.dispose(); }
});

test('冷启动徽标 去重: 已预取过的会话再次预取不再打接口（避免每按钮一次请求）', async () => {
  const api = fakeApi(true);
  const plugin = client.createClientPlugin({ api, session: { id: 'dedup-2' } });
  try {
    await plugin.primeUnread('dedup-2');
    const first = api.calls;
    await plugin.primeUnread('dedup-2');
    await plugin.primeUnread('dedup-2');
    assert.equal(api.calls, first, '重复预取不得再打接口');
    assert.equal(first, 1, '第一次应当打了一次');
  } finally { plugin.dispose(); }
});

test('冷启动徽标 去重: 不同会话各自预取一次（不是全局只拉一个）', async () => {
  const api = fakeApi(true);
  const plugin = client.createClientPlugin({ api, session: { id: 'a' } });
  try {
    await plugin.primeUnread('a');
    await plugin.primeUnread('b');
    assert.equal(api.calls, 2, '两个不同的会话应各自预取一次');
    assert.equal(plugin.registry.get('a').unread, true);
    assert.equal(plugin.registry.get('b').unread, true);
  } finally { plugin.dispose(); }
});

/* ================================================================== *
 * 3) 降级：拿不到就显示 ?，不抛不阻塞
 * ================================================================== */

test('冷启动徽标 降级: /state 失败时显示「?」且不抛、不留错误态', async () => {
  const api = fakeApi(true);
  api.fail = true;
  const plugin = client.createClientPlugin({ api, session: { id: 'fail-1' } });
  try {
    await assert.doesNotReject(() => plugin.primeUnread('fail-1'), '预取失败不得抛给调用方');
    const state = plugin.registry.get('fail-1');
    assert.equal(state.unread, false, '拿不到就保持「无未读」→ 按钮显示「?」');
    assert.equal(badge.headerButtonText(state.unread), '?', '降级显示「?」');
    assert.equal(state.error, undefined, '预取失败不得往界面写错误态（它只是锦上添花）');
  } finally { plugin.dispose(); }
});

test('冷启动徽标 降级: 返回体里没有 unread 时不得凭空显示未读（两个方向都要挡）', async () => {
  // 这条要挡**两个方向**，缺一个方向就测不出「无条件写 true」这种改坏：
  //   方向1：本地无未读 + 宿主没给字段 → 必须仍是 false（不得凭空显示「有新内容」骗用户）
  //   方向2：本地有未读 + 宿主没给字段 → 必须保留 true（不得把本地未读抹掉）
  // 只测方向2 的话，把实现改成「无条件写 true」仍然全绿（我第一版就是这样，证伪抓出来的）。
  for (const initial of [false, true]) {
    const api = fakeApi(true);
    api.state = async () => ({ payload: { records: [] } });    // 没有 unread 字段
    const plugin = client.createClientPlugin({ api, session: { id: 'nofield-' + initial } });
    try {
      if (initial) plugin.registry.update('nofield-' + initial, { unread: true });
      await plugin.primeUnread('nofield-' + initial);
      assert.equal(plugin.registry.get('nofield-' + initial).unread, initial,
        '宿主没给 unread 时必须保持本地原值（初始=' + initial + '）');
    } finally { plugin.dispose(); }
  }
});

test('冷启动徽标 降级: 空 sessionId 不请求、不抛', async () => {
  const api = fakeApi(true);
  const plugin = client.createClientPlugin({ api, session: { id: 'x' } });
  try {
    await assert.doesNotReject(() => plugin.primeUnread(''));
    assert.equal(api.calls, 0, '空 id 不得打接口');
  } finally { plugin.dispose(); }
});

/* ================================================================== *
 * 4) 不改变既有语义 & 接线
 * ================================================================== */

test('冷启动徽标 不回归: 打开浮窗仍必须立即清除未读', async () => {
  const api = fakeApi(false);
  const plugin = client.createClientPlugin({ api, session: { id: 'open-1' } });
  try {
    plugin.registry.update('open-1', { unread: true });
    plugin.open();                                    // 打开浮窗
    await waitFor(() => plugin.registry.get('open-1').unread === false, { label: '打开浮窗应清除未读' });
    assert.equal(plugin.registry.get('open-1').unread, false, '打开浮窗后必须立即清除未读（既有语义不得改变）');
  } finally { plugin.dispose(); }
});

test('冷启动徽标 接线: HeaderButton 挂载时必须预取 unread', async () => {
  const { readFileSync } = await import('node:fs');
  const entry = readFileSync(new URL('../src/client/entry.ts', import.meta.url), 'utf8');
  const pluginSource = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8');
  assert.match(entry, /plugin\.primeUnread\?\.\(id\)/, 'HeaderButton 必须在挂载时预取该会话的 unread');
  assert.match(pluginSource, /const primeUnread = /, 'client plugin 必须实现 primeUnread');
  assert.match(pluginSource, /primedUnread\.get\(sessionId\)/, '预取必须按会话去重（in-flight 复用）');
  // 这里原先写的是 /primeUnread \};/ —— 它把「primeUnread 是返回对象的**最后一个**键」
  // 也当成了要求。2026-10-04 新增 saveGeometry 后，primeUnread 不再是最后一个键，
  // 这条断言就红了，但**导出本身一直都在**（按钮一直调得到）。这属于「钉住了字面写法」，
  // 改成与键顺序无关的写法，仍然只断言真正要断言的那件事：primeUnread 必须被导出。
  assert.match(pluginSource, /primeUnread[,}]/, 'primeUnread 必须被导出，否则按钮调不到');
});
