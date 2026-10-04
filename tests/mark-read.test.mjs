import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource, waitFor, expectNever } from './fixtures/runtime.mjs';

/**
 * §10：**打开对应浮窗后清除未读**（文档 docs/implementation-plan.md:107 明文要求）。
 *
 * 原缺陷（verify-3082 页面实测，0.1.38）：打开浮窗后徽标仍是「? ·」。机制：
 * `registry.open()` 本地确实置了 `unread:false`（store.ts:95），**但紧接着 refreshState()**
 * 又把宿主返回的 `unread:true` 写了回来（client/index.ts:245）；而宿主侧只有 markUnread、
 * **没有「标记已读」接口**，所以它永远返回 true —— 清除后立刻又亮，且刷新页面还会变回 true。
 *
 * 修法：新增宿主 mark-read 路由，客户端打开浮窗时**先让宿主标记已读、再刷新**（串行，避免闪烁）。
 *
 * 本文件全部**从真实状态变化出发**（真路由 + 真磁盘 + 真 registry），不手工构造 props 渲染一次。
 */

async function startHost(llm) {
  const home = mkdtempSync(join(tmpdir(), 'ea-markread-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  try {
    const index = await moduleFromSource('src/index.ts');
    index.apply({
      llm: { listProviders: async () => ['p'], listModels: async () => [{ id: 'm', provider: 'p' }],
             stream: llm.stream, resolveModelInfo: async () => ({ context: { contextWindow: 128000 } }) },
      sessionQuery: {},
      connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
      effect: () => {}, get: () => undefined,
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
  const rootDir = join(home, 'explain-assistant');
  const rawFetch = async (url, init) => {
    const target = new URL(String(url), 'http://host');
    const entry = routes.get(target.pathname) ?? routes.get(target.pathname.replace('/api', ''));
    if (!entry) return new Response(JSON.stringify({ error: { code: 'NO_ROUTE' } }), { status: 404 });
    const handler = typeof entry === 'function' ? entry : entry.fetch;
    return handler(new Request(target.toString(), init));
  };
  return {
    home, rootDir, routes, rawFetch,
    recordPath: (id) => join(rootDir, 'sessions', id + '.json'),
    hostUnread(id) { const p = join(rootDir, 'sessions', id + '.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).unread : undefined; },
    restore() { rmSync(home, { recursive: true, force: true }); },
  };
}

async function seed(rootDir, id, mutate) {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const store = new persistence.JsonSessionStore({ rootDir });
  try { await store.update(id, mutate); } finally { await store.close(); }
}

/** 把 globalThis.fetch 指到真路由；可拦截特定路径模拟失败。 */
function pointFetchAt(host, intercept) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (intercept && String(url).includes(intercept.path)) throw new Error(intercept.message);
    return host.rawFetch(url, init);
  };
  return () => { globalThis.fetch = original; };
}

const okLlm = () => ({ stream: () => (async function* () { yield { type: 'text-delta', text: '回答' }; yield { type: 'finish', done: true }; })() });

/* ================================================================== *
 * 1) 核心：打开浮窗后，本地与宿主都必须清除
 * ================================================================== */

test('清除未读: 打开浮窗后本地 unread 变 false，且**宿主侧也变 false**（刷新后不会变回来）', async () => {
  const host = await startHost(okLlm());
  const restore = pointFetchAt(host);
  try {
    await seed(host.rootDir, 'mr-1', s => { s.unread = true; s.records = []; });
    assert.equal(host.hostUnread('mr-1'), true, '前置：宿主侧确实是未读');

    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: { id: 'mr-1' } });
    try {
      await plugin.primeUnread('mr-1');                   // 冷启动拿到未读
      assert.equal(plugin.registry.get('mr-1').unread, true, '前置：本地未读已恢复');

      plugin.open();                                      // 打开浮窗
      await waitFor(() => host.hostUnread('mr-1') === false, { label: '宿主侧未读应被清除' });
      await waitFor(() => plugin.registry.get('mr-1').unread === false, { label: '本地未读应被清除' });

      assert.equal(plugin.registry.get('mr-1').unread, false, '打开浮窗后本地的未读必须清除');
      // 关键：宿主也必须清掉。旧实现只清本地，宿主永远返回 true → 刷新又亮。
      assert.equal(host.hostUnread('mr-1'), false, '清除必须**落到宿主**，否则刷新页面又变回未读');
    } finally { plugin.dispose(); }
  } finally { restore(); host.restore(); }
});

test('清除未读 真链路: 「未读 → 打开 → 清除」整条链，且重新刷新后仍是已读', async () => {
  const host = await startHost(okLlm());
  const restore = pointFetchAt(host);
  try {
    await seed(host.rootDir, 'mr-2', s => { s.unread = true; s.records = []; });
    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: { id: 'mr-2' } });
    try {
      await plugin.primeUnread('mr-2');
      assert.equal(plugin.registry.get('mr-2').unread, true, '① 未读');
      plugin.open();
      await waitFor(() => plugin.registry.get('mr-2').unread === false, { label: '② 打开后应清除' });
      assert.equal(plugin.registry.get('mr-2').unread, false, '② 打开后清除');

      // ③ 模拟「刷新页面」：换一个全新实例，重新从宿主拉
      plugin.dispose();
      const fresh = client.createClientPlugin({ session: { id: 'mr-2' } });
      try {
        await fresh.primeUnread('mr-2');
        assert.equal(fresh.registry.get('mr-2').unread, false, '③ 刷新后仍是已读（这才说明清除真的落到了宿主）');
      } finally { fresh.dispose(); }
    } finally { plugin.dispose(); }
  } finally { restore(); host.restore(); }
});

/* ================================================================== *
 * 2) 失败降级：不影响打开浮窗，且不得闪烁
 * ================================================================== */

test('清除未读 降级: mark-read 失败时不影响打开浮窗，本地仍清除且不闪回未读', async () => {
  const host = await startHost(okLlm());
  const restore = pointFetchAt(host, { path: 'mark-read', message: 'network down' });
  try {
    await seed(host.rootDir, 'mr-3', s => { s.unread = true; s.records = []; });
    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: { id: 'mr-3' } });
    try {
      await plugin.primeUnread('mr-3');
      assert.equal(plugin.registry.get('mr-3').unread, true);

      plugin.open();                                      // 不得因为接口失败而抛/卡住
      // 等刷新链跑完（mark-read 失败也要走完 → 本地保持清除）
      await waitFor(() => plugin.registry.get('mr-3').open === true, { label: '打开浮窗应成功' });
      await waitFor(() => plugin.registry.get('mr-3').unread === false, { label: '失败时仍应保持已清除' });

      const state = plugin.registry.get('mr-3');
      assert.equal(state.open, true, '打开浮窗这个动作本身必须成功（接口失败不影响它）');
      // 这条是「闪烁」的核心：紧随其后的 refreshState 会把宿主仍为 true 的值写回来，
      // 若不做抑制，用户会看到徽标清除后又亮。
      assert.equal(state.unread, false, 'mark-read 失败时也必须保持本地已清除（不得闪回未读）');
      assert.equal(host.hostUnread('mr-3'), true, '宿主侧仍是 true（接口确实失败了）——但界面不该因此又亮');
    } finally { plugin.dispose(); }
  } finally { restore(); host.restore(); }
});

test('清除未读 降级: 宿主没有 mark-read 路由时，打开浮窗仍成功且不抛', async () => {
  const host = await startHost(okLlm());
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('mark-read')) return new Response('{}', { status: 404 });
    return host.rawFetch(url, init);
  };
  try {
    await seed(host.rootDir, 'mr-4', s => { s.unread = true; s.records = []; });
    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: { id: 'mr-4' } });
    try {
      plugin.open();
      await waitFor(() => plugin.registry.get('mr-4').unread === false, { label: '降级为本地清除' });
      assert.equal(plugin.registry.get('mr-4').open, true, '宿主不支持时打开浮窗仍必须成功');
      assert.equal(plugin.registry.get('mr-4').unread, false, '降级为本地清除');
    } finally { plugin.dispose(); }
  } finally { globalThis.fetch = original; host.restore(); }
});

/* ================================================================== *
 * 3) 边界：已归档会话不得被 mark-read 重建文件
 * ================================================================== */

test('清除未读 边界: 已归档会话收到 mark-read 时，不得重建已删除的记录文件', async () => {
  const host = await startHost(okLlm());
  const restore = pointFetchAt(host);
  try {
    await seed(host.rootDir, 'mr-5', s => { s.unread = true; s.records = []; });
    const path = host.recordPath('mr-5');
    // 先归档（文件被删除）
    await host.rawFetch('http://h/api/explain-assistant/forget?sessionId=mr-5', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, sessionId: 'mr-5', operation: 'forget', payload: {} }),
    });
    assert.equal(existsSync(path), false, '前置：归档后文件已删除');

    // 迟到的 mark-read（浮窗仍开着 / 用户交互）不得把文件建回来
    await host.rawFetch('http://h/api/explain-assistant/mark-read?sessionId=mr-5', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, sessionId: 'mr-5', operation: 'mark-read', payload: {} }),
    });
    assert.equal(existsSync(path), false, '已归档会话的 mark-read 绝不能把记录文件重建出来');
  } finally { restore(); host.restore(); }
});

test('清除未读 边界: 无当前会话时不发请求、不崩', async () => {
  const host = await startHost(okLlm());
  let markReadCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('mark-read')) markReadCalls++;
    return host.rawFetch(url, init);
  };
  try {
    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: () => undefined });   // 没有当前会话
    try {
      assert.doesNotThrow(() => plugin.open(), '没有会话时打开浮窗不得抛');
      // 这是「**不得发生**」的断言：给它一个固定观察窗口更诚实（不能用 waitFor 等它发生）。
      // 60ms 足够让本应发出的请求显形；窗口内出现任何一次就判失败。
      await expectNever(() => markReadCalls > 0, { durationMs: 60, label: '没有当前会话时不应发出 mark-read' });
      assert.equal(markReadCalls, 0, '没有当前会话时不得发 mark-read 请求（§「无当前 Session 不显示」）');
    } finally { plugin.dispose(); }
  } finally { globalThis.fetch = original; host.restore(); }
});

/* ================================================================== *
 * 4) 不回归：新回答到来时仍必须置未读
 * ================================================================== */

test('清除未读 不回归: 新回答到来时必须重新点亮未读（不能把「有新内容」一起弄没）', async () => {
  const host = await startHost(okLlm());
  const restore = pointFetchAt(host);
  try {
    await seed(host.rootDir, 'mr-6', s => { s.unread = false; s.records = []; s.explicitModel = { provider: 'p', model: 'm' }; });
    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: { id: 'mr-6' } });
    try {
      plugin.open();                                       // 先打开（此时已读）
      await waitFor(() => plugin.registry.get('mr-6').unread === false, { label: '前置：打开后是已读' });
      assert.equal(plugin.registry.get('mr-6').unread, false, '前置：打开后是已读');

      await plugin.submit('解释一下');                      // 新回答到来
      await waitFor(() => plugin.registry.get('mr-6').unread === true, { label: '新回答应重新置未读' });
      assert.equal(plugin.registry.get('mr-6').unread, true, '新回答到来必须重新置未读（否则用户不知道有新内容）');
      assert.equal(host.hostUnread('mr-6'), true, '宿主侧也应为未读（刷新后徽标仍在）');
    } finally { plugin.dispose(); }
  } finally { restore(); host.restore(); }
});

/* ================================================================== *
 * 5) 接线
 * ================================================================== */

test('清除未读 接线: 宿主注册 mark-read 路由，客户端在 open() 里调用', async () => {
  const { readFileSync } = await import('node:fs');
  const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const clientSource = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8');
  assert.match(indexSource, /'\/api\/explain-assistant\/mark-read', \['POST'\]/, '必须在 entries 注册 mark-read（键带 /api 前缀）');
  assert.match(indexSource, /markRead: async \(id: string\)[^\n]*isForgotten/, '宿主 markRead 必须用 isForgotten 把关（防重建已删文件）');
  assert.match(clientSource, /api\.markRead\(sessionId\)/, '客户端 open() 必须真的调用 markRead');
  // 顺序：先 markRead，再 refreshState
  const markAt = clientSource.indexOf('api.markRead(sessionId)');
  // 刷新那一行现在带 { keepCleared: true }（抑制「打开」引发的这次刷新把 true 写回来），
  // 所以这里匹配 refreshState(sessionId 之后的内容，不写死参数。
  const refreshAt = clientSource.indexOf('refreshState(sessionId, { keepCleared: true })');
  assert.ok(markAt > 0, '客户端必须真的调用 markRead');
  assert.ok(refreshAt > markAt, '必须先让宿主标记已读、再刷新（否则刷新可能把 true 写回来）');
  assert.match(clientSource, /options\?\.keepCleared === true && payload\.unread === true/,
    '打开引发的这次刷新必须抑制宿主的 true（否则清除后立刻又亮）');
});
