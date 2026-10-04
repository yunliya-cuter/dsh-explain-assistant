import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * §4/§8 F6：接住 DSH 真实的**归档信号**（`workspaces` 服务的 `archivedSessionIds`），
 * 在「归档那一刻」清理本插件为该会话保存的记录。
 *
 * 这是**删数据**的功能，所以断言重心是「不该删的绝不删」：
 * - 第一份快照只建基线（否则插件一加载就会把历史归档的老记录删掉）；
 * - 已在集合里的 id 重复推送不重复触发（幂等）；
 * - unarchive 不触发任何删除；
 * - 拿不到集合 / 服务抛异常 → 保留不删、不崩。
 */

const watch = await moduleFromSource('src/client/archive-watch.ts');

/** 可控的假 workspaces 服务：能改快照、能手动触发订阅者。 */
function fakeSource(initial, options = {}) {
  // 默认 phase='ready'；但**允许显式传 phase:'pending'** 来复现「就绪前」的真实时序。
  let snapshot = { archivedSessionIds: initial, phase: options.phase ?? 'ready' };
  const listeners = new Set();
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    /** 推一份新快照并通知订阅者（模拟 follow 增量推下来）。 */
    push(ids, options2 = {}) { snapshot = { archivedSessionIds: ids, phase: options2.phase ?? 'ready' }; for (const l of [...listeners]) l(); },
    get listenerCount() { return listeners.size; },
    failNext(error) { this._fail = error; },
  };
}

/* ================================================================== *
 * 0) 最关键的一条：第一份快照只建基线，绝不触发清理
 * ================================================================== */

test('归档信号 防误删: 第一份快照只建基线，历史归档的老会话不得被清理', async () => {
  // 【真实时序】插件加载时宿主 follow 还没就绪：phase='pending'、archivedSessionIds=[]（**合法空数组**）。
  // baseline 到达后才 phase='ready' 并带来历史归档。
  // 旧版本这条测试手工构造的第一份快照**已经是就绪状态**，恰好绕过了真实时序，
  // 所以它没能挡住 0.1.38 那次「一次性误删 30 条」的事故。现在按真实时序来。
  const calls = [];
  const fake = fakeSource([], { phase: 'pending' });          // 就绪前：合法的空数组
  const watcher = watch.createArchiveWatcher({ source: fake.source, onArchived: id => { calls.push(id); } });
  try {
    assert.deepEqual(calls, [], '未就绪的空数组绝不能建立基线（否则历史归档会全被判成「新归档」）');
    fake.push(['old-archived-1', 'old-archived-2'], { phase: 'ready' });   // baseline 到达
    assert.deepEqual(calls, [], '就绪后的第一份快照只建基线：历史归档的老会话不得被清理');
    assert.deepEqual(watcher.sync(), [], '再手动同步一次也仍然是空（基线已建立，无「新进入」）');
    assert.deepEqual(calls, []);
  } finally { watcher.dispose(); }
});

/* ================================================================== *
 * 1) 「那一刻」：集合从 [] 变 [S] → 只对 S 触发一次
 * ================================================================== */

test('归档信号: 会话新进入归档集合时，只对该会话触发一次清理', async () => {
  const calls = [];
  const fake = fakeSource([]);
  const watcher = watch.createArchiveWatcher({ source: fake.source, onArchived: id => { calls.push(id); } });
  try {
    assert.deepEqual(calls, [], '还没有任何会话被归档');
    fake.push(['S']);                                  // 用户归档了 S —— 就是「那一刻」
    assert.deepEqual(calls, ['S'], '必须对刚归档的 S 触发清理');
  } finally { watcher.dispose(); }
});

test('归档信号: 两个会话先后归档，各自触发一次、只触发自己', async () => {
  const calls = [];
  const fake = fakeSource([]);
  const watcher = watch.createArchiveWatcher({ source: fake.source, onArchived: id => { calls.push(id); } });
  try {
    fake.push(['A']);
    fake.push(['A', 'B']);
    assert.deepEqual(calls, ['A', 'B'], '顺序与内容都要对：先 A 后 B，且不重复推 A');
  } finally { watcher.dispose(); }
});

/* ================================================================== *
 * 2) 幂等：同一集合重复推送不得重复触发
 * ================================================================== */

test('归档信号 幂等: 同一集合重复推送（[S]→[S]）不得重复触发清理', async () => {
  const calls = [];
  const fake = fakeSource([]);
  const watcher = watch.createArchiveWatcher({ source: fake.source, onArchived: id => { calls.push(id); } });
  try {
    fake.push(['S']);
    fake.push(['S']);
    fake.push(['S']);
    assert.deepEqual(calls, ['S'], '重复推送同一集合只能触发一次，实际：' + JSON.stringify(calls));
  } finally { watcher.dispose(); }
});

test('归档信号 幂等: 集合内容顺序变化但成员不变时也不得重复触发', async () => {
  const calls = [];
  const fake = fakeSource([]);
  const watcher = watch.createArchiveWatcher({ source: fake.source, onArchived: id => { calls.push(id); } });
  try {
    fake.push(['A', 'B']);
    fake.push(['B', 'A']);                             // 只是顺序变了，成员没变
    assert.deepEqual(calls, ['A', 'B'], '顺序变化不是「新进入」，不得重复触发');
  } finally { watcher.dispose(); }
});

/* ================================================================== *
 * 3) unarchive 不得触发任何删除
 * ================================================================== */

test('归档信号 反例: 取消归档（集合移除）不得触发任何清理', async () => {
  const calls = [];
  const fake = fakeSource([]);
  const watcher = watch.createArchiveWatcher({ source: fake.source, onArchived: id => { calls.push(id); } });
  try {
    fake.push(['S']);
    assert.deepEqual(calls, ['S']);
    calls.length = 0;
    fake.push([]);                                     // 用户取消了归档
    assert.deepEqual(calls, [], '取消归档只是从集合移除，不得触发任何删除或恢复');
  } finally { watcher.dispose(); }
});

test('归档信号 反例: 从未归档的会话绝不触发清理', async () => {
  const calls = [];
  const fake = fakeSource([]);
  const watcher = watch.createArchiveWatcher({ source: fake.source, onArchived: id => { calls.push(id); } });
  try {
    fake.push([]);                                     // 一直是空集合
    assert.deepEqual(calls, [], '没有新归档就不该有任何清理');
  } finally { watcher.dispose(); }
});

/* ================================================================== *
 * 4) 降级：拿不到服务 / 抛异常 → 不崩、不删
 * ================================================================== */

test('归档信号 降级: 服务抛异常时保留全部记录且不崩', async () => {
  const calls = [];
  const broken = {
    getSnapshot() { throw new Error('workspaces service down'); },
    subscribe() { throw new Error('workspaces service down'); },
  };
  const logs = [];
  let watcher;
  assert.doesNotThrow(() => {
    watcher = watch.createArchiveWatcher({ source: broken, onArchived: id => { calls.push(id); }, logger: m => logs.push(m) });
  }, '服务不可用时不得抛给调用方');
  try {
    assert.deepEqual(calls, [], '服务不可用绝不能触发任何清理');
    assert.deepEqual(watcher.sync(), [], '同步也要安全返回空');
    assert.ok(logs.length > 0, '必须留下日志说明降级了');
  } finally { watcher?.dispose(); }
});

test('归档信号 降级: 快照缺少 archivedSessionIds 时不得当成「全部归档」', async () => {
  const calls = [];
  let snapshot = { somethingElse: true };
  const listeners = new Set();
  const watcher = watch.createArchiveWatcher({
    source: { getSnapshot: () => snapshot, subscribe(l) { listeners.add(l); return () => listeners.delete(l); } },
    onArchived: id => { calls.push(id); },
  });
  try {
    assert.deepEqual(calls, [], '拿不到集合时保留不删');
    snapshot = {};
    for (const l of listeners) l();
    assert.deepEqual(calls, [], '集合形状不对时同样保留不删');
  } finally { watcher.dispose(); }
});

test('归档信号 防误删: 读不到集合后（失败），再读到一份含老会话的集合时，老会话不得被当成新归档', async () => {
  // 这条为什么必须存在：
  // 如果把「这次读失败」当成「集合变空了」并更新基线，那么下一次成功读到时，
  // 集合里那些**很久以前就归档**的会话就会全部被判成「新进入」→ 批量误删用户记录。
  // 所以读失败时必须**保留原基线不变**。
  const calls = [];
  const listeners = new Set();
  let mode = 'ok';                                   // ok | throw | badshape
  const archived = ['old-1', 'old-2'];
  const source = {
    getSnapshot() {
      if (mode === 'throw') throw new Error('temporary failure');
      if (mode === 'badshape') return {};            // 形状不对 = 也读不到
      if (mode === 'pending') return { phase: 'pending', archivedSessionIds: [] };  // 未就绪
      return { phase: 'ready', archivedSessionIds: archived };
    },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
  };
  const watcher = watch.createArchiveWatcher({ source, onArchived: id => { calls.push(id); }, logger: () => {} });
  try {
    // 基线：老会话已经在归档集合里（第一份快照只建基线，不触发）
    assert.deepEqual(calls, [], '前置：基线建立，老会话不触发');

    // 读失败一次（两种失败形态都试）
    mode = 'throw';
    assert.deepEqual(watcher.sync(), [], '读失败必须安全返回空');
    assert.deepEqual(calls, [], '读失败不得触发任何清理');

    // 恢复可读：仍是同一批老会话 —— **绝不能**被当成「新归档」
    mode = 'ok';
    assert.deepEqual(watcher.sync(), [], '恢复可读后，老会话不得被当成新进入（否则会批量误删）');
    assert.deepEqual(calls, [], '老会话在任何情况下都不许触发清理');

    // 形状不对也同理
    mode = 'badshape';
    watcher.sync();
    mode = 'ok';
    assert.deepEqual(watcher.sync(), [], '形状不对再恢复，同样不得把老会话当新归档');
    assert.deepEqual(calls, []);

    // 未就绪（phase='pending'，archivedSessionIds 是**合法空数组**）也同理 ——
    // 这正是 0.1.38 误删 30 条的那条路径：空数组不是「集合为空」，是「还不知道」。
    mode = 'pending';
    watcher.sync();
    assert.deepEqual(calls, [], '未就绪的空数组不得触发任何清理，也不得建立基线');
    mode = 'ok';
    assert.deepEqual(watcher.sync(), [], '从未就绪恢复后，老会话仍不得被当成新归档');
    assert.deepEqual(calls, []);

    // 反向确认：真的来了一个**新**归档，仍然照常触发（证明不是把功能整个关掉了）
    archived.push('brand-new');
    assert.deepEqual(watcher.sync(), ['brand-new'], '新的归档仍必须触发（这条防线不能把功能一起挡掉）');
    assert.deepEqual(calls, ['brand-new']);
  } finally { watcher.dispose(); }
});

test('归档信号 降级: onArchived 抛异常不影响后续会话，也不打断订阅', async () => {
  const calls = [];
  const fake = fakeSource([]);
  const watcher = watch.createArchiveWatcher({
    source: fake.source,
    onArchived: id => { calls.push(id); if (id === 'A') throw new Error('cleanup failed'); },
    logger: () => {},
  });
  try {
    fake.push(['A', 'B']);
    assert.deepEqual(calls, ['A', 'B'], 'A 的清理失败不得让 B 被跳过');
    fake.push(['A', 'B', 'C']);
    assert.deepEqual(calls, ['A', 'B', 'C'], '一次失败不得破坏订阅（C 仍要触发）');
  } finally { watcher.dispose(); }
});

/* ================================================================== *
 * 5) 生命周期：dispose 取消订阅
 * ================================================================== */

test('归档信号: dispose 必须取消订阅，之后推送不再触发', async () => {
  const calls = [];
  const fake = fakeSource([]);
  const watcher = watch.createArchiveWatcher({ source: fake.source, onArchived: id => { calls.push(id); } });
  assert.equal(fake.listenerCount, 1, '订阅后应有 1 个监听者');
  watcher.dispose();
  assert.equal(fake.listenerCount, 0, 'dispose 必须取消订阅（否则泄漏）');
  assert.equal(watcher.disposed, true);
  fake.push(['Z']);
  assert.deepEqual(calls, [], 'dispose 之后不得再触发');
});

/* ================================================================== *
 * 6) 宿主：新增的 forget 路由确实接上了 service.forget
 * ================================================================== */

test('宿主 forget 路由: 调用后真的走 service.forget 并成功返回', async () => {
  const routesModule = await moduleFromSource('src/host/routes.ts');
  const called = [];
  const routes = routesModule.createExplainAssistantRoutes({
    service: { isSessionAllowed: async () => true, forget: async (id) => { called.push(id); return { removed: true }; } },
  });
  // 注意：plain 处理器从**查询串**读 sessionId（与 cancel 同一套约定），客户端 api.forget 也是这么发的。
  const response = await routes.get('/explain-assistant/forget')(new Request('http://t/explain-assistant/forget?sessionId=s-a', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, sessionId: 's-a', operation: 'forget', payload: {} }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, '归档清理路由必须可用：' + JSON.stringify(body));
  assert.equal(body.operation, 'forget', 'operation 必须被正确识别（旧的白名单会把它当 state）');
  assert.deepEqual(called, ['s-a'], '必须真的调用 service.forget');
});

test('宿主 forget 路由: 宿主没实现时给中文错误，不静默成功', async () => {
  const routesModule = await moduleFromSource('src/host/routes.ts');
  const routes = routesModule.createExplainAssistantRoutes({ service: { isSessionAllowed: async () => true } });
  // 注意：plain 处理器从**查询串**读 sessionId（与 cancel 同一套约定），客户端 api.forget 也是这么发的。
  const response = await routes.get('/explain-assistant/forget')(new Request('http://t/explain-assistant/forget?sessionId=s-a', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, sessionId: 's-a', operation: 'forget', payload: {} }),
  }));
  const body = await response.json();
  assert.equal(body.ok, false, '未实现时不得假装成功');
  assert.equal(body.error.code, 'DEPENDENCY_UNAVAILABLE');
  assert.match(body.error.message, /[\u4e00-\u9fff]/, '原因必须中文');
});

test('宿主 forget 路由 防回退: 会话已被标成归档后，forget 仍必须可用（不能被 isArchived 挡回 409）', async () => {
  const routesModule = await moduleFromSource('src/host/routes.ts');
  const calls = [];
  let archived = false;
  const routes = routesModule.createExplainAssistantRoutes({
    service: {
      isSessionAllowed: async () => true,
      // 第一次清理会把该会话标成 archived；之后用户取消归档再归档时，插件本地仍是 archived
      isArchived: async () => archived,
      forget: async (id) => { calls.push(id); archived = true; return { removed: true }; },
    },
  });
  const call = () => routes.get('/explain-assistant/forget')(new Request('http://t/explain-assistant/forget?sessionId=s-a', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, sessionId: 's-a', operation: 'forget', payload: {} }),
  }));
  const first = await call();
  assert.equal(first.status, 200, '第一次归档清理必须成功');
  // 关键：此时插件已把会话标成 archived。若 forget 走在 guard 之后，这里会 409，
  // 「取消归档→再归档」这条真实路径就永远清不掉新记录。
  const second = await call();
  assert.equal(second.status, 200, '已标归档后 forget 仍必须可用（不得被 isArchived 挡回 409）');
  assert.deepEqual(calls, ['s-a', 's-a'], '两次都必须真的调用 service.forget');
});

test('宿主 forget 路由 反例: 会话不被允许时仍然拒绝（跳过 isArchived 不等于跳过全部鉴权）', async () => {
  const routesModule = await moduleFromSource('src/host/routes.ts');
  const routes = routesModule.createExplainAssistantRoutes({
    service: { isSessionAllowed: async () => false, forget: async () => ({ removed: true }) },
  });
  const response = await routes.get('/explain-assistant/forget')(new Request('http://t/explain-assistant/forget?sessionId=s-a', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, sessionId: 's-a', operation: 'forget', payload: {} }),
  }));
  assert.equal(response.status, 403, '不允许的会话仍必须被拒');
  assert.equal((await response.json()).error.code, 'SESSION_FORBIDDEN');
});

test('宿主 forget 路由: 已在 entries 里注册（键带 /api 前缀）', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /'\/api\/explain-assistant\/forget', \['POST'\]/, '必须在 entries 注册 forget 路由');
  // 客户端入口必须注入 workspaces 服务，否则订阅拿不到
  const entry = readFileSync(new URL('../src/client/entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /export const inject = \['slots', 'workspaces'\]/, '必须注入 workspaces 服务');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-workspace-controller'), 'dsh.client.inject 必须含 workspace controller');
});
