import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource, waitFor } from './fixtures/runtime.mjs';

/**
 * 「宿主/替身可能不支持某个 api 方法」时的**健壮性**回归闸。
 *
 * ── 这里守的是一个真实回归（Lead 抓到）──────────────────────────────
 * 曾经的写法：void api.markRead(id).catch(...)。
 * .catch() 只能接住「方法返回 Promise 之后」的失败，**接不住「方法压根不存在」这种同步抛出**：
 * TypeError 会**同步炸掉 open()** → 浮窗直接打不开。而它上面刚写着注释承诺
 * 「宿主不可用/不支持 → 降级为仅本地清除」——实现没有兑现承诺。
 * 全量 371 条里 7 条红，全是同一个 TypeError（那些测试用的 api 替身没有 markRead）。
 *
 * 修法：把调用推迟到微任务 —— Promise.resolve().then(() => api.x(...))，
 * 这样 TypeError 与网络错误走同一条 catch 路径。
 *
 * 本文件用**参数化**方式把「逐个抽掉某个 api 方法」跑一遍，确保每个入口都真的降级而不是炸掉。
 * 这类测试很值得留：它们当初就是靠 api 替身缺少新方法暴露了那个 bug。
 */

const client = await moduleFromSource('src/client/index.ts');

/** 完整的 api 替身；测试时逐个删掉其中一个方法。 */
function fullApi() {
  return {
    state: async () => ({ payload: {} }),
    models: async () => ({ payload: {} }),
    selectModel: async () => ({}),
    history: async () => ({ payload: {} }),
    historyResult: async () => ({ payload: {} }),
    ask: async () => {},
    compact: async () => {},
    cancel: async () => {},
    forget: async () => ({}),
    markRead: async () => ({}),
  };
}

const ALL_METHODS = ['state', 'models', 'selectModel', 'history', 'historyResult', 'ask', 'compact', 'cancel', 'forget', 'markRead'];

/** 每个入口：给定一个可能缺方法的 api，调用它。 */
const ENTRIES = {
  'open()': async (p) => { p.open(); await new Promise(r => setTimeout(r, 0)); },   // 只让微任务/一轮宏任务跑完；本组断言的是「不抛」而非最终状态
  'primeUnread()': (p) => p.primeUnread('s'),
  'loadEarlier()': (p) => p.loadEarlier(),
  'openHistoryDetail()': (p) => p.openHistoryDetail('r1'),
  'loadMoreHistoryDetail()': (p) => p.loadMoreHistoryDetail(),
  'submit()': (p) => p.submit('问题'),
  'forget()': (p) => p.forget('s'),
  'cancel()': async (p) => { p.cancel(); },
  'dispose()': async (p) => { p.dispose(); },
};

test('api 缺失支持: 任意 api 方法不存在时，所有入口都不得同步抛出（必须降级）', async () => {
  const failures = [];
  let n = 0;
  for (const missing of ALL_METHODS) {
    const api = fullApi();
    delete api[missing];
    for (const [name, call] of Object.entries(ENTRIES)) {
      const plugin = client.createClientPlugin({ api, session: { id: 'sess-' + (++n) } });
      try {
        await call(plugin);
      } catch (error) {
        failures.push('缺 ' + missing + ' 时 ' + name + ' 抛出：' + (error && error.message ? error.message : String(error)));
      }
      try { plugin.dispose(); } catch { /* 清理阶段异常不影响本断言 */ }
    }
  }
  assert.deepEqual(failures, [], '这些入口必须降级而不是炸掉（同步抛出会让浮窗打不开/会话被锁死）：' + failures.join(' / '));
});

test('api 缺失支持: 缺 markRead 时 open() 仍必须成功打开浮窗（原回归的直接复现）', async () => {
  const api = fullApi();
  delete api.markRead;                                   // 旧版宿主 / 精简替身
  const plugin = client.createClientPlugin({ api, session: { id: 'no-markread' } });
  try {
    assert.doesNotThrow(() => plugin.open(), '缺 markRead 时 open() 绝不能抛（否则浮窗打不开）');
    // open 里本地状态是**同步**置好的，不需要等网络。
    assert.equal(plugin.registry.get('no-markread').open, true, '浮窗必须真的打开了');
    assert.equal(plugin.registry.get('no-markread').unread, false, '降级为「仅本地清除」');
  } finally { plugin.dispose(); }
});

test('api 缺失支持: 缺 state 时刷新链降级，但 open() 与冷启动预取都不得抛', async () => {
  const api = fullApi();
  delete api.state;
  const plugin = client.createClientPlugin({ api, session: { id: 'no-state' } });
  try {
    assert.doesNotThrow(() => plugin.open(), '缺 state 不得让 open() 抛');
    await assert.doesNotReject(() => plugin.primeUnread('no-state'), 'primeUnread 承诺「失败静默降级」，不得 reject');
    assert.equal(plugin.registry.get('no-state').open, true, '浮窗仍必须打开（刷新失败只是取不到最新状态）');
  } finally { plugin.dispose(); }
});

/**
 * 造一条**真的带 requestId** 的活动请求。
 *
 * 为什么必须这样造：cancel 那一行有 `if (cancelId)` 前置——若 requestId 没被设上，
 * 那行根本不会执行，测试就**测不到**想守的防线（我第一版就是这样，证伪时改回裸调却不变红）。
 * requestId 只在宿主发出 start 事件时写入（index.ts 的 event.type === 'start' 分支），
 * 所以这里必须让假 api 真的**发出一个 start 事件**。
 */
function apiWithStartEvent(options = {}) {
  const api = fullApi();
  // 注意：事件的 sessionId 必须与**真实会话一致**——applyEvent 有一条
  // 「事件里的 sessionId 与当前请求不符就丢弃」的防护（index.ts:90）。
  // 我第一版写死了 'x'，导致事件被丢弃、requestId 永远是 undefined，测试直接超时（这本身是好事：
  // 它说明 waitFor 的前置条件真的被执行了，没有静默放过）。
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  api.ask = async (sessionId, _question, _signal, _evidence, onEvent) => {
    onEvent({ type: 'start', data: { sessionId, requestId: 'req-1', payload: {} } });
    // 默认「保持挂起」：请求还没结束才谈得上「中途取消」。
    // 若立刻 resolve，请求就正常跑完了，cancel 的拦截会被随后的完成逻辑盖回去（我踩过）。
    if (options.hold) await pending;
  };
  api.releaseAsk = () => release && release();
  return api;
}

test('api 缺失支持: dispose 时缺 cancel 不得中断清理（否则样式/订阅泄漏）', async () => {
  const api = apiWithStartEvent();
  delete api.cancel;
  const plugin = client.createClientPlugin({ api, session: { id: 'no-cancel' } });
  plugin.registry.update('no-cancel', { open: true });
  plugin.submit('问题').catch(() => undefined);
  // 等到 requestId 真的被写进 registry —— 这是「cancel 那行会被执行」的前置条件。
  await waitFor(() => plugin.registry.get('no-cancel').requestId === 'req-1', { label: 'start 事件应写入 requestId' });
  let threw;
  try { plugin.dispose(); } catch (error) { threw = error; }
  assert.equal(threw, undefined, 'dispose 必须安全完成（缺 cancel 不能中途炸掉清理）');
  // 用可观察到的清理结果代替内部标志位（disposed 没有对外暴露）：
  // dispose 会关掉打开的浮窗并把当前会话置空；若 cancel 那行同步抛出打断了流程，这两件事就做不完。
  assert.equal(plugin.registry.get('no-cancel').open, false, 'dispose 必须真的把打开的浮窗关掉（证明确实走完了清理）');
  assert.equal(plugin.registry.currentSessionId, undefined, 'dispose 必须把当前会话置空（这步在 cancel 之后，能证明流程没被中断）');
});

test('api 缺失支持: cancel() 时缺 cancel 方法不得中断「停止」动作（用户仍须看到已停止）', async () => {
  const api = apiWithStartEvent({ hold: true });        // 让请求悬着，才谈得上「中途取消」
  delete api.cancel;
  const plugin = client.createClientPlugin({ api, session: { id: 'no-cancel2' } });
  // cancel() 会先看「当前会话」（registry.currentSessionId）再取活动请求；
  // 真实运行时由 entry 的 setSession 建立。这里必须显式建立，否则 cancel 直接早退，
  // 测试就**测不到** cancel 那一行（我第一版漏了这句，断言拿到 running 才发现）。
  plugin.setSession('no-cancel2');
  plugin.submit('问题').catch(() => undefined);
  await waitFor(() => plugin.registry.get('no-cancel2').requestId === 'req-1', { label: 'start 事件应写入 requestId' });
  let threw;
  try { plugin.cancel(); } catch (error) { threw = error; }
  assert.equal(threw, undefined, '缺 cancel 时用户点「停止」不能崩');
  assert.equal(plugin.registry.get('no-cancel2').phase, 'interrupted', '必须仍然落到「已停止」态（本地中断不依赖宿主接口）');
  api.releaseAsk();
});

test('api 缺失支持 锚点: 直接调用不存在的方法必然同步抛（说明本防线确实必要）', () => {
  const api = fullApi();
  delete api.markRead;
  assert.throws(() => api.markRead('s'), TypeError, '不存在的方法被调用必然同步抛 TypeError —— 所以必须先包进微任务');
});

test('api 缺失支持 接线: 这些可能缺失的 api 调用都必须过 callApi', async () => {
  const { readFileSync } = await import('node:fs');
  const sourceText = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8');
  assert.equal(/return api\.state\(/.test(sourceText), false, 'refreshState 不得裸调 api.state');
  assert.equal(/const task = api\.state\(/.test(sourceText), false, 'primeUnread 不得裸调 api.state');
  assert.equal(/void api\.cancel\(/.test(sourceText), false, 'cancel/dispose 不得裸调 api.cancel');
  assert.equal(/const task = kind === 'compact' \? api\./.test(sourceText), false, 'run() 不得裸调 api.ask/compact');
  assert.match(sourceText, /const callApi = /, '必须保留 callApi 包装');
});
