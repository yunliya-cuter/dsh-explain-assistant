import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource, waitFor } from './fixtures/runtime.mjs';

/**
 * §5.1/§8/§10：历史分页的**不重复 / 不倒退**闸（行为级）。
 *
 * ── 这里守的是 verify-3082 在页面上发现、Lead 独立复现并定位的真缺陷 ────────
 * 现象：记录超过 20 条时，反复「关闭浮窗 + 打开 + 点查看更早历史」，
 * 界面条目越翻越多（24 → 28 → 32），而磁盘始终 24 —— **界面在说假话**（违反 §10「不静默失败」）。
 *
 * 两处根因叠加（都已修）：
 * A. **刷新把「已翻到底」覆盖回可翻状态**
 *    宿主 state 恒按「首屏 = 最近一页」算（src/index.ts，pageStart = 总数 − 20），
 *    只要总数 > 一页就恒返回 hasEarlier:true / historyCursor:"4"；
 *    而客户端 refreshState 无条件照抄这两个字段 → 一次刷新（**打开浮窗本身就会触发**）
 *    就把「已翻到底」改回来，游标也指回已经加载过的那一页。
 *    → 「关闭再打开能查看」(§8) 恰恰成了触发条件。
 * B. **loadEarlier 前置拼接无去重**（旧实现 [...新页, ...已有]）→ 同一批再来一次整段重复。
 *
 * 与既有 tests/history-pagination.test.mjs 的区别：
 * 那份是**源码扫描 + 宿主分页纯逻辑**；本文件走**真链路**
 * （真磁盘 → 真宿主路由 → 真客户端 refreshState/loadEarlier → 真 registry），
 * 复刻的正是页面上那条「关+开+翻」的用户路径。
 */

async function startHost() {
  const home = mkdtempSync(join(tmpdir(), 'ea-f2page-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  try {
    const index = await moduleFromSource('src/index.ts');
    index.apply({
      llm: { listProviders: async () => ['p'], listModels: async () => [{ id: 'm', provider: 'p' }] },
      sessionQuery: {},
      connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
      effect: () => {}, get: () => undefined,
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
  const rootDir = join(home, 'explain-assistant');
  const original = globalThis.fetch;
  // /state 的**完成计数**：用于「等这一次刷新真的写完」。
  //
  // 为什么必须有它（我踩过两次）：用「records.length」或「historyCursor === undefined」
  // 之类**在刷新前就已经成立**的条件去等刷新，waitFor 会立刻返回，等于没等 ——
  // 于是测的是刷新前的状态，把守卫改坏了测试却不红（假绿）。
  // 只有「计数增加」能证明「这一次刷新发生了并写完了」。
  let stateCompleted = 0;
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url), 'http://host');
    const entry = routes.get(target.pathname) ?? routes.get(target.pathname.replace('/api', ''));
    if (!entry) return new Response('{}', { status: 404 });
    const handler = typeof entry === 'function' ? entry : entry.fetch;
    const response = await handler(new Request(target.toString(), init));
    if (target.pathname.endsWith('/state')) stateCompleted++;
    return response;
  };
  return {
    home, rootDir, routes,
    get stateCompleted() { return stateCompleted; },
    waitForState(after, label) { return waitFor(() => stateCompleted > after, { label: label ?? '这一次 /state 刷新应完成' }); },
    restore() { globalThis.fetch = original; rmSync(home, { recursive: true, force: true }); },
  };
}

const makeRecords = (total) => Array.from({ length: total }, (_, i) => ({
  id: 'r' + i, kind: 'ask', status: 'complete', complete: true,
  question: '问题' + i, answerText: '回答' + i, reasoningText: '', evidence: [], tools: [], images: [],
  startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
}));

async function seed(rootDir, id, total) {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const store = new persistence.JsonSessionStore({ rootDir });
  try {
    await store.update(id, s => { s.records = makeRecords(total); s.explicitModel = { provider: 'p', model: 'm' }; });
  } finally { await store.close(); }
}

async function pluginFor(id) {
  const client = await moduleFromSource('src/client/index.ts');
  return client.createClientPlugin({ session: { id } });
}

/* ================================================================== *
 * 1) 原始缺陷的完整时序（用户可见的那条路径）
 * ================================================================== */

test('分页 A: 关闭再打开（触发刷新）不得把「已翻到底」改回可翻状态', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'f2a', 24);
    const plugin = await pluginFor('f2a');
    try {
      plugin.open();
      await waitFor(() => plugin.registry.get('f2a').records.length === 20, { label: '首屏应给最近一页' });
      assert.equal(plugin.registry.get('f2a').hasEarlier, true, '前置：总数 24 > 一页 20，确实还有更早');

      await plugin.loadEarlier();
      const afterLoad = plugin.registry.get('f2a');
      assert.equal(afterLoad.records.length, 24, '翻页后应拿到全部 24 条');
      assert.equal(afterLoad.hasEarlier, false, '翻到底后必须说「没有更早了」');
      // 游标也必须**当场清掉**。旧实现是「有 cursor 才写」，到底时保留上一次的旧游标 ——
      // 陈旧游标本身不显示，但任何再触发一次翻页的路径都会用它把已加载过的那页重新取回来。
      assert.equal(afterLoad.historyCursor, undefined, '翻到底时必须清掉游标（不得留陈旧游标供下次重复加载）');

      // 关闭再打开 = §8 要求的「关闭再打开能查看」，也正是缺陷的触发条件
      //
      // 注意等待条件：不能用「records.length === 24」——那个条件在 loadEarlier 之后
      // **已经成立**，waitFor 会立刻返回、等于没等刷新（我第一版就是这样，测的是刷新前的状态）。
      // 这里改为等一个「只可能由刷新带来」的信号：宿主下发 totalRecords 后客户端算出的
      // 剩余量归零 → 游标被显式清掉（undefined）。刷新前它是旧的 '4'。
      const stateBefore = host.stateCompleted;
      plugin.open();
      await host.waitForState(stateBefore, '这一次刷新必须真的发生并写完');
      const afterRefresh = plugin.registry.get('f2a');
      assert.equal(afterRefresh.records.length, 24, '刷新后条数不得变化（磁盘就是 24）');
      assert.equal(afterRefresh.hasEarlier, false,
        '刷新不得把「已翻到底」改回 true —— 否则界面上又会冒出「查看更早历史」按钮，用户一点就重复');
      assert.equal(afterRefresh.historyCursor, undefined, '刷新不得把游标退回已经加载过的那一页');
    } finally { plugin.dispose(); }
  } finally { host.restore(); }
});

test('分页 B: 反复「关闭+打开+点翻页」不得让界面条目越翻越多（界面必须与磁盘一致）', async () => {
  const host = await startHost();
  try {
    const TOTAL = 24;
    await seed(host.rootDir, 'f2b', TOTAL);
    const plugin = await pluginFor('f2b');
    try {
      plugin.open();
      await waitFor(() => plugin.registry.get('f2b').records.length === 20, { label: '首屏应给最近一页' });
      // 模拟真实用户：**只有按钮可见时才点它**（按钮不可见就没有「重复点击」这回事）
      const clickIfVisible = async () => {
        if (!plugin.registry.get('f2b').hasEarlier) return false;
        await plugin.loadEarlier();
        return true;
      };
      await clickIfVisible();
      assert.equal(plugin.registry.get('f2b').records.length, TOTAL, '第一次点应拿到全部');

      for (let round = 1; round <= 3; round++) {
        const stateBefore = host.stateCompleted;
        plugin.open();                                       // 关闭再打开
        await host.waitForState(stateBefore, '第' + round + '轮刷新必须真的发生并写完');
        await clickIfVisible();
        const st = plugin.registry.get('f2b');
        assert.equal(st.records.length, TOTAL,
          '第' + round + '轮后条数仍必须是 ' + TOTAL + '（实际 ' + st.records.length + '）—— 界面不得比磁盘多');
        assert.equal(new Set(st.records.map(r => r.id)).size, st.records.length, '第' + round + '轮后不得出现重复条目');
      }
    } finally { plugin.dispose(); }
  } finally { host.restore(); }
});

/* ================================================================== *
 * 2) B 的独立防线：同一游标取回两次不得渲染重复
 * ================================================================== */

test('分页 B2: 同一游标取回两次，不得把同样的记录渲染两遍（按 id 去重）', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'f2c', 24);
    const plugin = await pluginFor('f2c');
    try {
      plugin.open();
      await waitFor(() => plugin.registry.get('f2c').records.length === 20, { label: '首屏应给最近一页' });

      // 手动把游标**退回**同一页再翻一次：模拟「同一批被取回两次」。
      // 防御性断言——无论什么原因重复取回，都不得渲染重复条目。
      plugin.registry.update('f2c', { historyCursor: '4' });
      await plugin.loadEarlier();
      const once = plugin.registry.get('f2c').records.length;
      plugin.registry.update('f2c', { historyCursor: '4' });   // 再退回去
      await plugin.loadEarlier();
      const twice = plugin.registry.get('f2c');

      assert.equal(twice.records.length, once, '同一游标再取一次不得增加条目（实际 ' + once + ' → ' + twice.records.length + '）');
      assert.equal(new Set(twice.records.map(r => r.id)).size, twice.records.length, '不得出现重复 id');
    } finally { plugin.dispose(); }
  } finally { host.restore(); }
});

/* ================================================================== *
 * 3) 边界：本地刚追加、宿主还没有的记录不得让「还有更早」算错（Lead 点名提醒）
 * ================================================================== */

test('分页 边界: 本地刚追加、宿主还没有的记录不得把「还有更早」误算成 false', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'f2d', 24);
    const plugin = await pluginFor('f2d');
    try {
      plugin.open();
      await waitFor(() => plugin.registry.get('f2d').records.length === 20, { label: '首屏应给最近一页' });
      assert.equal(plugin.registry.get('f2d').hasEarlier, true);

      // 造一条「本地有、宿主没有」的记录（真实场景：回答刚结束，本地先 append，宿主尚未落库）
      plugin.registry.update('f2d', current => {
        current.records = [...current.records, { id: 'local-only', question: '本地新记录', answerText: 'x' }];
      });
      const stateBeforeEdge = host.stateCompleted;
      plugin.open();                                          // 再刷新一次
      await host.waitForState(stateBeforeEdge, '这一次刷新必须真的发生并写完');
      // 本地 21 条里只有 20 条来自宿主 → 仍必须认为还有更早
      // （若直接把本地条数当「已加载」，就会算成 21≥21 → 误判「没有更早」，更早的记录永远看不到）
      assert.equal(plugin.registry.get('f2d').hasEarlier, true, '本地多出的那一条不得让「还有更早」变成 false');
    } finally { plugin.dispose(); }
  } finally { host.restore(); }
});

/* ================================================================== *
 * 4) 宿主确实下发了总数（客户端算法依赖它）
 * ================================================================== */

test('分页 接线: 宿主 state 必须下发 totalRecords（客户端据它算 hasEarlier）', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'f2e', 24);
    const entry = host.routes.get('/api/explain-assistant/state');
    const handler = typeof entry === 'function' ? entry : entry.fetch;
    const payload = await (await handler(new Request('http://h/api/explain-assistant/state?sessionId=f2e'))).json();
    assert.equal(payload.payload.totalRecords, 24, '宿主必须下发总条数（客户端算「还有更早」依赖它）');
    assert.equal(payload.payload.records.length, 20, '首屏仍只给一页');
    assert.equal(payload.payload.hasEarlier, true, '宿主自己的 hasEarlier 保持原语义不变（首屏视角）');
  } finally { host.restore(); }
});
