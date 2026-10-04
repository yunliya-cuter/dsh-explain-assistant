import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource, fakeDom, FakeElement, waitFor } from './fixtures/runtime.mjs';

/**
 * 「刷新三项」及其同族不变量的**行为级回归闸**。
 *
 * 这三条各自对应之前修过的静默缺陷（S1 / S4 / S3），外加一条分页窗口不变量：
 *   1. 压缩摘要不退回「没压缩过」（S1）；反例：本次压缩刚失败，不得被宿主的旧摘要盖成「已压缩」（C2）。
 *   2. 未读徽标刷新后仍在（S4）。
 *   3. 历史里能看到答案正文（S3 同族；宿主下发的是 answerText/startedAt 那套字段名）。
 *   4. 刷新不得用首屏那一页替换本地已翻出的更早记录（D4 的分页窗口不变量）。
 *
 * 与既有断言的区别（本文件存在的理由）：
 * - silent-defects.test.mjs 里的 S1/S3/S4 是**分散**的，且大多是「跑一次 compact / ask 再断言」；
 * - audit-round6-regressions.test.mjs 的 C2 只有**源码 grep** 与伪造 api；
 * - 本文件统一走**真链路**：真磁盘落库 → 真宿主路由（src/index.ts）→ 真 api.state
 *   → 真 refreshState 回写 → 真浮窗渲染。**没有任何一条是「手工设 state 再渲染」。**
 */

const STATE_PATH = '/api/explain-assistant/state';

/* ---------------- 真宿主：src/index.ts + 真磁盘落库 ---------------- */

async function startHost(llm) {
  const home = mkdtempSync(join(tmpdir(), 'ea-refresh-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  const llmService = {
    listProviders: async () => ['p'],
    listModels: async () => [{ id: 'm', provider: 'p' }],
    stream: llm.stream,
    resolveModelInfo: async () => ({ context: { contextWindow: 128000 } }),
  };
  try {
    const index = await moduleFromSource('src/index.ts');
    index.apply({
      llm: llmService,
      sessionQuery: {},
      connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
      effect: () => {},
      get: () => undefined,
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
  return {
    home,
    llm: llmService,
    rootDir: join(home, 'explain-assistant'),
    routes,
    restore() { rmSync(home, { recursive: true, force: true }); },
  };
}

/** 直接往磁盘落库（模拟「上一次会话留下的状态」）。 */
async function seedDisk(rootDir, sessionId, mutate) {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const store = new persistence.JsonSessionStore({ rootDir });
  try { await store.update(sessionId, mutate); } finally { await store.close(); }
}

/** 把 globalThis.fetch 指到真路由（客户端走真实 src/client/api.ts 契约）。 */
function pointFetchAt(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url), 'http://host');
    const handler = routes.get(target.pathname) ?? routes.get(target.pathname.replace('/api', ''));
    if (!handler) return new Response(JSON.stringify({ error: { code: 'NO_ROUTE', message: target.pathname } }), { status: 404 });
    return handler(new Request(target.toString(), init));
  };
  return () => { globalThis.fetch = original; };
}

const okLlm = () => ({ stream: () => (async function* () { yield { type: 'text-delta', text: '回答正文' }; yield { type: 'finish', done: true }; })() });

function record(i, prefix = '问题') {
  const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
  return { id: 'r' + i, kind: 'ask', status: 'complete', complete: true, question: prefix + i, answerText: '回答' + i, reasoningText: '', evidence: [], tools: [], images: [], startedAt: at, updatedAt: at };
}

async function renderText(state) {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  const plugin = { registry: { update() {}, close() {}, get: () => state }, submit: async () => {}, loadEarlier: async () => {}, cancel() {} };
  try {
    const root = overlay.renderOverlay({ ...state, open: true }, plugin);
    return root.textContent || '';
  } finally { await new Promise(r => setTimeout(r, 20)); dom.restore(); }
}

/* ================================================================== *
 * 1) S1（§9.1）：压缩摘要不退回「没压缩过」
 * ================================================================== */

test('刷新1: 宿主 compactState（有 summary、无 status）经真 refreshState 后必须成为 complete 且正文在', async () => {
  const host = await startHost(okLlm());
  const restoreFetch = pointFetchAt(host.routes);
  try {
    // 磁盘上的落库结构就是 §9.1 的形状：有 summary，没有 status（只有成功才落库）
    await seedDisk(host.rootDir, 's1', state => {
      state.compactState = { version: 1, summary: '磁盘上的摘要正文', sourceRecordIds: [], createdAt: '2026-01-01T00:00:00.000Z' };
    });
    // 前置自检：宿主确实把摘要下发下来了（否则后面断言「客户端采用」就是假绿）
    const served = (await host.routes.get(STATE_PATH)(new Request('http://host' + STATE_PATH + '?sessionId=s1'))).clone();
    const payload = await served.json();
    assert.equal(payload.payload.compactState?.summary, '磁盘上的摘要正文', '前置条件：宿主必须真的下发摘要');
    assert.equal('status' in (payload.payload.compactState || {}), false, '前置条件：宿主落库结构不含 status');

    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: { id: 's1' } });
    try {
      plugin.open();                       // 全新实例 = 刷新页面
      // 条件等待，不用固定 sleep：open() 是异步链（markRead 与 refreshState 并行），
      // 固定 80ms 是「赌它跑完了」——链路一变长就偶发失败（曾表现为 3 次里红 1 次）。
      // waitFor 超时会抛错，所以真出问题测试仍会红，不会变成假绿。
      await waitFor(() => plugin.registry.get('s1').compactState?.summary, {
        label: '刷新后 compactState.summary 应写回 registry',
      });
      const state = plugin.registry.get('s1');
      assert.equal(state.compactState?.summary, '磁盘上的摘要正文', '刷新后摘要必须回来，不能退回「没压缩过」');
      assert.equal(state.compactState?.status, 'complete', '有摘要即视为已压缩（宿主落库结构没有 status，必须补回语义）');
      assert.match(await renderText(state), /磁盘上的摘要正文/, '界面上必须看得到摘要正文');
    } finally { plugin.dispose(); }
  } finally { restoreFetch(); host.restore(); }
});

test('刷新1 反例: 本次压缩没拿到摘要时，宿主的旧摘要不得把失败盖成「已压缩」', async () => {
  // 磁盘上已有上一次成功的摘要；这次压缩「跑完了但没吐摘要」。
  //
  // 为什么必须用「跑完但空摘要」而不是「模型报错」：
  // refreshState 只在 **complete 事件**分支被调用（index.ts:168），**error 事件不调**。
  // 若用模型报错造态，refreshState 根本不会跑，那条「失败态优先」的防线也就**没被检验到**——
  // 测试会绿，但它是假绿。（我第一版就是这么写的，证伪实验里改坏防线却不变红，才查出来。）
  // 只有走 complete → 本地置 error → 紧接着 refreshState 拉回宿主旧摘要，才真的打到那条防线。
  const emptyCompact = { stream: () => (async function* () { yield { type: 'text-delta', text: '' }; yield { type: 'finish', done: true }; })() };
  const host = await startHost(emptyCompact);
  const restoreFetch = pointFetchAt(host.routes);
  try {
    await seedDisk(host.rootDir, 's1c2', state => {
      state.compactState = { version: 1, summary: '上一次成功留下的旧摘要', sourceRecordIds: [], createdAt: '2026-01-01T00:00:00.000Z' };
      state.explicitModel = { provider: 'p', model: 'm' };
    });
    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: { id: 's1c2' } });
    try {
      plugin.open();
      await waitFor(() => plugin.registry.get('s1c2').compactState?.summary, {
        label: '首次刷新应写回宿主旧摘要',
      });
      assert.equal(plugin.registry.get('s1c2').compactState?.summary, '上一次成功留下的旧摘要', '前置：首次刷新先采用宿主旧摘要');

      await plugin.submit('/compact');     // 本次压缩跑完但没有摘要
      // 等压缩走到失败态（条件等待，不用固定 sleep）。
      await waitFor(() => plugin.registry.get('s1c2').compactState?.status === 'error', {
        label: '空摘要的压缩应落到 error 态',
      });
      const state = plugin.registry.get('s1c2');
      // 关键：这一次 refreshState 真的被调用了（走的是 complete 分支），所以下面断言的是
      // 「宿主旧摘要没有把本地失败态盖掉」这条防线本身。
      assert.equal(state.compactState?.status, 'error',
        '本次没拿到摘要必须保留失败态，不能被宿主旧摘要盖成已压缩，实际：' + JSON.stringify(state.compactState));

      const text = await renderText(state);
      assert.match(text, /压缩(失败|已中断)/, '界面必须显示失败/中断，而不是「已压缩」');
      assert.equal(/已压缩：/.test(text), false, '不得把本次失败显示成「已压缩」（C2 反例）');
    } finally { plugin.dispose(); }
  } finally { restoreFetch(); host.restore(); }
});

/* ================================================================== *
 * 2) S4（§10）：未读徽标刷新后仍在
 * ================================================================== */

test('刷新2: 宿主 unread=true 时，刷新后未读必须恢复；而打开浮窗必须清除', async () => {
  // 注意语义区分（§10）：
  // - 「刷新页面」= 冷启动重新拉宿主状态（HeaderButton 挂载 → primeUnread），**不得打开浮窗**；
  // - 「打开浮窗」= 用户点开，按 §10 **必须清除未读**。
  // 这条测试原先用 open() 来模拟「刷新」，在新语义下那个动作恰恰是「清除」——
  // 所以改成用真实的刷新路径（primeUnread）来断言，并额外钉住「打开即清除」。
  const host = await startHost(okLlm());
  const restoreFetch = pointFetchAt(host.routes);
  try {
    await seedDisk(host.rootDir, 's4', state => { state.unread = true; });
    const served = (await (await host.routes.get(STATE_PATH)(new Request('http://host' + STATE_PATH + '?sessionId=s4'))).json());
    assert.equal(served.payload.unread, true, '前置条件：宿主确实下发 unread:true');

    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: { id: 's4' } });
    try {
      await plugin.primeUnread('s4');                     // 刷新页面：冷启动拉一次宿主状态
      assert.equal(plugin.registry.get('s4').unread, true, '刷新后未读徽标必须还在（此前漏了 unread 这个键）');

      plugin.open();                                      // 用户打开浮窗
      // 本地清除在 open() 里是同步完成的，但仍用条件等待表达「最终必须为已读」，
      // 避免依赖「恰好 150ms 内没被后续刷新写回」这种时序假设。
      await waitFor(() => plugin.registry.get('s4').unread === false, {
        label: '§10 打开浮窗后未读必须清除',
      });
    } finally { plugin.dispose(); }
  } finally { restoreFetch(); host.restore(); }
});

/* ================================================================== *
 * 3) S3 同族（§8）：历史里能看到答案正文（宿主字段名 answerText/startedAt）
 * ================================================================== */

test('刷新3: 宿主用 answerText/startedAt 下发时，刷新后历史必须渲染出回答正文', async () => {
  const host = await startHost(okLlm());
  const restoreFetch = pointFetchAt(host.routes);
  try {
    await seedDisk(host.rootDir, 's3', state => { state.records = [record(1, '磁盘上的问题')]; });
    const served = await (await host.routes.get(STATE_PATH)(new Request('http://host' + STATE_PATH + '?sessionId=s3'))).json();
    const servedRecord = served.payload.records[0];
    // 前置自检：宿主下发的确实是「宿主那套字段名」，不是客户端那套
    assert.equal(typeof servedRecord.answerText, 'string', '前置：宿主下发 answerText');
    assert.equal('answer' in servedRecord, false, '前置：宿主不下发客户端字段名 answer');
    assert.equal(typeof servedRecord.startedAt, 'string', '前置：宿主下发 startedAt');

    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: { id: 's3' } });
    try {
      plugin.open();
      await waitFor(() => plugin.registry.get('s3').records.length >= 1, { label: '刷新后应拿到历史记录' });
      const state = plugin.registry.get('s3');
      assert.ok(state.records.length >= 1, '刷新后必须拿到历史记录');
      const text = await renderText(state);
      assert.match(text, /磁盘上的问题/, '历史里必须看得到问题');
      assert.match(text, /回答1/, '历史里必须看得到回答正文（此前只剩问题，答案看不到）');
    } finally { plugin.dispose(); }
  } finally { restoreFetch(); host.restore(); }
});

/* ================================================================== *
 * 4) 分页窗口不变量（§5.1）：刷新不得丢已翻出的更早记录
 * ================================================================== */

test('刷新4: 已翻出更早记录后，一次真 refreshState 不得丢掉它们（不挖空洞）', async () => {
  const TOTAL = 45;
  const host = await startHost(okLlm());
  const restoreFetch = pointFetchAt(host.routes);
  try {
    await seedDisk(host.rootDir, 'pg', state => {
      state.records = Array.from({ length: TOTAL }, (_, i) => record(i));
      state.explicitModel = { provider: 'p', model: 'm' };
    });
    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: { id: 'pg' } });
    try {
      plugin.open();
      await waitFor(() => plugin.registry.get('pg').records.length === 20, { label: '首屏应给最近一页' });
      const first = plugin.registry.get('pg');
      assert.equal(first.records.length, 20, '前置：首屏只给最近一页');
      assert.equal(first.historyCursor, String(TOTAL - 20), '前置：下发游标');

      await plugin.loadEarlier();
      const afterEarlier = plugin.registry.get('pg');
      assert.equal(afterEarlier.records.length, 40, '前置：翻出第二页后本地有 40 条');
      const beforeRefresh = afterEarlier.records.map(r => r.question);

      // 触发一次真正的 refreshState（open() 内部就是 void refreshState(sessionId)），而不是换个实例重开
      plugin.open();
      // 等这次刷新真的写完（记录数仍应为 40，且游标/内容已回写）——用条件等待而非固定 sleep。
      await waitFor(() => plugin.registry.get('pg').records.length >= 40, { label: '刷新后已翻出的记录应仍保留' });
      const afterRefresh = plugin.registry.get('pg');
      const shown = afterRefresh.records.map(r => r.question);

      // 已翻出的更早记录必须原样保留：不得被首屏那一页替换掉
      for (const q of beforeRefresh) {
        assert.ok(shown.includes(q), '刷新不得丢掉已加载的更早记录：缺了 ' + q);
      }
      assert.ok(shown.length >= 40, '刷新后条数不得缩水（首屏只有 20 条，缩水就说明用了首屏替换），实际 ' + shown.length);
      // 不得出现空洞：记录必须仍然连续
      const missing = Array.from({ length: TOTAL }, (_, i) => '问题' + i).filter(q => !shown.includes(q));
      assert.deepEqual(missing, Array.from({ length: TOTAL - shown.length }, (_, i) => '问题' + i),
        '未加载的只能是**最早**那一段，不能是中间被挖空的一段');
    } finally { plugin.dispose(); }
  } finally { restoreFetch(); host.restore(); }
});
