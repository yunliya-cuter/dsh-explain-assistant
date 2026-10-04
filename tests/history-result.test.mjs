import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource, fakeDom } from './fixtures/runtime.mjs';

/**
 * F2/F3 余项：展开单条历史记录的**完整内容**（GET /history-result）。
 *
 * 对照条款：
 * - 业务 §5.1「更早历史需通过宿主提供的读取能力取得」；
 * - 业务 §8「关闭再打开能查看并继续追问」「每个主对话有自己对应的记录，不混入其他主对话」；
 * - 业务 §11.6「依据可展开核查」；实施 §4「GET /explain-assistant/history-result：
 *   同一记录内按区块继续加载完整工具结果、reasoning 或图片元数据；不重执行、不重读工作区」。
 *
 * 修之前：service 层没有 loadHistoryResult，路由回落到 payload:{}，
 * 客户端 api.historyResult 全仓没有调用点（死代码），用户在界面上看不到任何一条记录的完整依据。
 *
 * 三条必须覆盖的情况（本文件的主线）：
 * 1. 有数据返回（并真的分页、能翻到底、三组字段各自按页带来）；
 * 2. 记录不存在；
 * 3. 跨会话取不到。
 * 另外钉住「宿主没实现时报错而不是静默返回空」和「客户端真的调用它、真的能续读」。
 */

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const PAGE = 20;

/** 起一个真宿主：注册 src/index.ts 的真实路由，返回可直接打的入口。 */
async function startHost() {
  const home = mkdtempSync(join(tmpdir(), 'ea-history-result-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let routes = new Map();
  try {
    const index = await moduleFromSource('src/index.ts');
    index.apply({
      connection: { fetch: { register(entry) { routes.set(entry.path, entry.fetch); } } },
      llm: { listProviders: async () => [], listModels: async () => [] },
      effect: () => {},
      get: () => undefined,
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
  const rootDir = join(home, 'explain-assistant');
  return {
    rootDir,
    call(path) {
      const handler = routes.get(path.split('?')[0]);
      assert.ok(handler, '路由未注册：' + path);
      return handler(new Request('http://localhost' + path));
    },
    async json(path) { return (await this.call(path)).json(); },
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

/** 造一条内容很长的记录：依据/工具/图片各 45 条，用来验证真的分页。 */
function longRecord(id) {
  return {
    id,
    kind: 'ask',
    status: 'complete',
    complete: true,
    question: '这一步在做什么',
    answerText: '它在读取配置并校验。',
    reasoningText: '先看配置，再看依赖。',
    evidence: Array.from({ length: 45 }, (_, i) => ({
      schemaVersion: 1, sessionId: SESSION_A, kind: 'tool', seq: i,
      title: '依据' + i, summary: '第' + i + '条依据摘要', source: 'selected_frozen',
      evidenceState: 'observed', capturedAt: '2026-01-01T00:00:00.000Z', truncated: false, incomplete: false,
    })),
    tools: Array.from({ length: 45 }, (_, i) => ({
      tool: 'explain_read_workspace_file', callId: 'call-' + i, arguments: { path: 'src/f' + i + '.ts' },
      status: 'ok', result: { ok: true, bytes: i }, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.000Z',
    })),
    images: Array.from({ length: 45 }, (_, i) => ({
      id: 'img-' + i, relativePath: 'images/' + i + '.png', mediaType: 'image/png', bytes: 1024 + i,
      sha256: 'sha-' + i, capturedAt: '2026-01-01T00:00:00.000Z',
    })),
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function seedLong(host, sessionId, id) {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const store = new persistence.JsonSessionStore({ rootDir: host.rootDir });
  try { await store.update(sessionId, state => { state.records = [longRecord(id)]; }); }
  finally { await store.close(); }
}

/* ================================================================== *
 * 1) 有数据返回：真的分页，且能翻到底
 * ================================================================== */

test('有数据返回: 首屏给出该记录的完整内容与三组总数', async () => {
  const host = await startHost();
  try {
    await seedLong(host, SESSION_A, 'rec-1');
    const body = await host.json('/api/explain-assistant/history-result?sessionId=' + SESSION_A + '&recordId=rec-1');
    const payload = body.payload;
    assert.equal(body.operation, 'history-result', '操作名必须是 history-result');
    assert.equal(payload.sessionId, SESSION_A, '返回体必须自报属于哪个会话');
    assert.equal(payload.recordId, 'rec-1', '返回体必须自报就是这条记录');
    assert.equal(payload.record.answerText, '它在读取配置并校验。', '回答正文必须原样带出');
    assert.equal(payload.record.reasoningText, '先看配置，再看依赖。', '完整推理必须原样带出（§11.6 依据可核查）');
    // 一页 20 条，首屏给第一页
    assert.equal(payload.record.evidence.length, PAGE, '依据首屏一页 ' + PAGE + ' 条');
    assert.equal(payload.record.tools.length, PAGE, '工具首屏一页 ' + PAGE + ' 条');
    assert.equal(payload.record.images.length, PAGE, '图片首屏一页 ' + PAGE + ' 条');
    // counts 是**总数**，不随分页缩水，界面靠它显示「已显示 20 / 共 45」
    assert.deepEqual(payload.counts, { evidence: 45, tools: 45, images: 45 }, 'counts 必须是完整总数');
    assert.equal(payload.hasEarlier, true, '还有没取完的内容时必须说还有');
    assert.equal(payload.cursor, String(PAGE), '游标必须指向下一页');
  } finally { host.cleanup(); }
});

test('有数据返回: 按游标能一直翻到底，且不重复不丢条目', async () => {
  const host = await startHost();
  try {
    await seedLong(host, SESSION_A, 'rec-1');
    const seen = [];
    let cursor = undefined;
    let pages = 0;
    for (;;) {
      const query = '/api/explain-assistant/history-result?sessionId=' + SESSION_A + '&recordId=rec-1' + (cursor ? '&cursor=' + cursor : '');
      const payload = (await host.json(query)).payload;
      pages++;
      assert.ok(pages <= 5, '必须能在有限页内翻完，避免游标不前进导致死循环');
      for (const item of payload.record.evidence) seen.push(item.title);
      if (!payload.hasEarlier) break;
      cursor = payload.cursor;
    }
    assert.equal(pages, 3, '45 条 / 每页 20 条 = 3 页');
    assert.equal(seen.length, 45, '翻完后必须正好拿到全部 45 条');
    assert.equal(new Set(seen).size, 45, '翻页不得出现重复条目');
    assert.equal(seen[0], '依据0', '必须从第一条开始往后读（不是从中间开始）');
    assert.equal(seen[44], '依据44', '必须读到最后一条');
  } finally { host.cleanup(); }
});

test('有数据返回: 内容很短时一次给完，不说「还有更多」', async () => {
  const host = await startHost();
  try {
    const persistence = await moduleFromSource('src/host/persistence.ts');
    const store = new persistence.JsonSessionStore({ rootDir: host.rootDir });
    await store.update(SESSION_A, state => {
      state.records = [{ id: 'short-1', kind: 'ask', status: 'complete', complete: true, question: 'q', answerText: 'A', reasoningText: '',
        evidence: [{ schemaVersion: 1, sessionId: SESSION_A, kind: 'tool', title: '唯一依据', source: 'selected_frozen', evidenceState: 'observed', capturedAt: '2026-01-01T00:00:00.000Z', truncated: false, incomplete: false }],
        tools: [], images: [], startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }];
    });
    await store.close();
    const payload = (await host.json('/api/explain-assistant/history-result?sessionId=' + SESSION_A + '&recordId=short-1')).payload;
    assert.equal(payload.record.evidence.length, 1);
    assert.equal(payload.hasEarlier, false, '取完了就必须说没有更多');
    assert.equal(payload.cursor, null, '取完后游标为 null');
  } finally { host.cleanup(); }
});

/* ================================================================== *
 * 2) 记录不存在：必须明确报错，不得静默返回空
 * ================================================================== */

test('记录不存在: 明确的中文错误码，而不是空对象', async () => {
  const host = await startHost();
  try {
    await seedLong(host, SESSION_A, 'rec-1');
    const response = await host.call('/api/explain-assistant/history-result?sessionId=' + SESSION_A + '&recordId=does-not-exist');
    assert.equal(response.status, 404, '记录不存在必须是 404，不能被当成一次成功读取');
    const body = await response.json();
    assert.equal(body.ok, false, '不得回 success 信封');
    assert.equal(body.error.code, 'RECORD_NOT_FOUND', '错误码必须明确');
    assert.match(body.error.message, /[\u4e00-\u9fff]/, '原因必须是中文，用户要能看懂：' + body.error.message);
    assert.equal('payload' in body && Object.keys(body.payload || {}).length > 0, false, '不得再回落成 payload:{}');
  } finally { host.cleanup(); }
});

test('记录不存在: 会话里一条记录都没有时同样明确报错', async () => {
  const host = await startHost();
  try {
    const body = await (await host.call('/api/explain-assistant/history-result?sessionId=' + SESSION_A + '&recordId=rec-1')).json();
    assert.equal(body.error.code, 'RECORD_NOT_FOUND');
    assert.match(body.error.message, /[\u4e00-\u9fff]/);
  } finally { host.cleanup(); }
});

test('记录不存在 反例: 缺 recordId 参数给 INVALID_REQUEST，而不是当成「记录不存在」', async () => {
  const host = await startHost();
  try {
    const response = await host.call('/api/explain-assistant/history-result?sessionId=' + SESSION_A);
    assert.equal(response.status, 400, '请求本身不完整是 400');
    const body = await response.json();
    assert.equal(body.error.code, 'INVALID_REQUEST');
    assert.match(body.error.message, /recordId/, '要告诉调用方缺的是哪个参数');
  } finally { host.cleanup(); }
});

/* ================================================================== *
 * 3) 跨会话取不到（§8 不混入其他主对话）
 * ================================================================== */

test('跨会话取不到: A 的 sessionId 要 B 的 recordId，必须被拒', async () => {
  const host = await startHost();
  try {
    await seedLong(host, SESSION_A, 'rec-a');
    await seedLong(host, SESSION_B, 'rec-b');
    const response = await host.call('/api/explain-assistant/history-result?sessionId=' + SESSION_A + '&recordId=rec-b');
    assert.equal(response.status, 404, '不能把别的会话的记录交出来');
    const body = await response.json();
    assert.equal(body.error.code, 'RECORD_NOT_FOUND');
    assert.match(body.error.message, /[\u4e00-\u9fff]/, '拒绝原因必须是中文');
    assert.equal(JSON.stringify(body).includes('rec-b'), false, '拒绝响应里不得回显对方记录的内容');
  } finally { host.cleanup(); }
});

test('跨会话取不到 反例: 各会话读自己的记录仍然正常（隔离不是「谁都读不到」）', async () => {
  const host = await startHost();
  try {
    await seedLong(host, SESSION_A, 'rec-a');
    await seedLong(host, SESSION_B, 'rec-b');
    const a = (await host.json('/api/explain-assistant/history-result?sessionId=' + SESSION_A + '&recordId=rec-a')).payload;
    const b = (await host.json('/api/explain-assistant/history-result?sessionId=' + SESSION_B + '&recordId=rec-b')).payload;
    assert.equal(a.recordId, 'rec-a');
    assert.equal(b.recordId, 'rec-b');
    assert.equal(a.sessionId, SESSION_A);
    assert.equal(b.sessionId, SESSION_B);
  } finally { host.cleanup(); }
});

test('宿主没实现时必须报错，不得再回落成 payload:{}', async () => {
  const routesModule = await moduleFromSource('src/host/routes.ts');
  const routes = routesModule.createExplainAssistantRoutes({ service: { isSessionAllowed: async () => true } });
  const response = await routes.get('/explain-assistant/history-result')(new Request('http://t/explain-assistant/history-result?sessionId=' + SESSION_A + '&recordId=r1'));
  assert.notEqual(response.status, 200, '未实现不能装作成功');
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'DEPENDENCY_UNAVAILABLE');
  assert.match(body.error.message, /[\u4e00-\u9fff]/, '原因必须中文');
});

/* ================================================================== *
 * 客户端：不是只加一个没人调的函数
 * ================================================================== */

/** 假 api：记录真实调用参数，并按页回数据。 */
function fakeApi(pages) {
  const calls = [];
  return {
    calls,
    state: async () => ({ payload: { records: [], hasEarlier: false } }),
    models: async () => ({ payload: { groups: [], failures: [] } }),
    selectModel: async () => ({ payload: {} }),
    history: async () => ({ payload: { records: [], hasEarlier: false } }),
    historyResult: async (sessionId, recordId, cursor) => {
      calls.push({ sessionId, recordId, cursor });
      return { payload: pages[String(cursor)] };
    },
    ask: async () => {}, compact: async () => {}, cancel: async () => {},
  };
}

test('客户端真的调用 loadHistoryResult，并把游标接上翻下一页', async () => {
  const client = await moduleFromSource('src/client/index.ts');
  const pages = {
    undefined: { sessionId: SESSION_A, recordId: 'rec-1', record: { id: 'rec-1', question: 'q', answerText: 'A', evidence: [{ title: '依据0' }], tools: [], images: [] }, counts: { evidence: 45, tools: 0, images: 0 }, cursor: '20', hasEarlier: true },
    '20': { sessionId: SESSION_A, recordId: 'rec-1', record: { id: 'rec-1', question: 'q', answerText: 'A', evidence: [{ title: '依据20' }], tools: [], images: [] }, counts: { evidence: 45, tools: 0, images: 0 }, cursor: null, hasEarlier: false },
  };
  const api = fakeApi(pages);
  const plugin = client.createClientPlugin({ api, session: { id: SESSION_A } });
  try {
    await plugin.openHistoryDetail('rec-1');
    const first = plugin.registry.get(SESSION_A).historyDetail;
    assert.equal(api.calls.length, 1, '必须真的打到 /history-result（旧实现这里是死代码，一次都不会打）');
    assert.deepEqual(api.calls[0], { sessionId: SESSION_A, recordId: 'rec-1', cursor: undefined }, '第一次不带游标');
    assert.equal(first.status, 'ready');
    assert.equal(first.record.evidence.length, 1);
    assert.equal(first.hasEarlier, true, '还有下一页时要记下来');

    await plugin.loadMoreHistoryDetail();
    assert.equal(api.calls.length, 2, '点「继续加载」必须再打一次');
    assert.deepEqual(api.calls[1], { sessionId: SESSION_A, recordId: 'rec-1', cursor: '20' }, '第二次必须带上游标');
    const second = plugin.registry.get(SESSION_A).historyDetail;
    assert.equal(second.record.evidence.length, 2, '两页必须接起来（不是整份替换）');
    assert.deepEqual(second.record.evidence.map(item => item.title), ['依据0', '依据20'], '顺序：先第一页再第二页');
    assert.equal(second.hasEarlier, false, '翻到底后不再显示继续加载');
  } finally { plugin.dispose(); }
});

test('客户端: 宿主报「记录不存在」时把中文原因显示出来，不显示成「没有内容」', async () => {
  const client = await moduleFromSource('src/client/index.ts');
  const api = fakeApi({});
  api.historyResult = async () => { throw Object.assign(new Error('这条小助手记录不存在，或者它属于另一个主对话，无法查看。'), { code: 'RECORD_NOT_FOUND' }); };
  const plugin = client.createClientPlugin({ api, session: { id: SESSION_A } });
  try {
    await plugin.openHistoryDetail('missing');
    const detail = plugin.registry.get(SESSION_A).historyDetail;
    assert.equal(detail.status, 'error');
    assert.match(detail.error, /记录不存在/, '必须把宿主的真实原因带到界面上：' + detail.error);
  } finally { plugin.dispose(); }
});

test('客户端: 返回体自报属于别的会话时拒绝显示（§8 不混入其他主对话）', async () => {
  const client = await moduleFromSource('src/client/index.ts');
  const api = fakeApi({ undefined: { sessionId: SESSION_B, recordId: 'rec-b', record: { id: 'rec-b', answerText: '别人的回答' }, counts: {}, cursor: null, hasEarlier: false } });
  const plugin = client.createClientPlugin({ api, session: { id: SESSION_A } });
  try {
    await plugin.openHistoryDetail('rec-b');
    const detail = plugin.registry.get(SESSION_A).historyDetail;
    assert.equal(detail.status, 'error', '别的会话的记录不得显示');
    assert.equal(detail.record, undefined, '内容不得进入界面状态');
  } finally { plugin.dispose(); }
});

test('客户端: 收起后不再保留展开状态', async () => {
  const client = await moduleFromSource('src/client/index.ts');
  const api = fakeApi({ undefined: { sessionId: SESSION_A, recordId: 'rec-1', record: { id: 'rec-1', answerText: 'A' }, counts: {}, cursor: null, hasEarlier: false } });
  const plugin = client.createClientPlugin({ api, session: { id: SESSION_A } });
  try {
    await plugin.openHistoryDetail('rec-1');
    assert.ok(plugin.registry.get(SESSION_A).historyDetail, '展开后才收起');
    plugin.closeHistoryDetail();
    assert.equal(plugin.registry.get(SESSION_A).historyDetail, undefined);
  } finally { plugin.dispose(); }
});

/* ---------------- 页面入口：浮窗上真的有一个能点的按钮 ---------------- */

test('浮窗入口: 每条历史记录旁都有「查看完整内容」，点了会去打宿主', async () => {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const dom = fakeDom();
  const opened = [];
  const base = {
    sessionId: SESSION_A, open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
    tools: [], loadingEarlier: false, evidence: [], occupancyKnown: false, occupancyEstimated: false,
    quickQuestionsDismissed: true, hasEarlier: false,
    records: [{ id: 'rec-1', question: '这一步在做什么', answerText: '回答', startedAt: '2026-01-01T00:00:00.000Z' }],
  };
  const plugin = { registry: { update() {}, get: () => base }, api: {}, cancel() {}, submit() {}, loadEarlier() {}, openHistoryDetail: (id) => { opened.push(id) } };
  try {
    const root = overlay.renderOverlay(base, plugin);
    assert.match(root.textContent, /查看完整内容/, '记录旁必须有可点入口（旧实现没有任何入口）');
    const entry = root.querySelector('.ea-record-detail');
    assert.ok(entry, '入口必须挂在这条记录上');
    entry.click();
    assert.deepEqual(opened, ['rec-1'], '点击必须真的去取这条记录的完整内容');
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.restore();
  }
});

test('浮窗入口: 展开后显示完整依据与工具过程，并有「继续加载」', async () => {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const dom = fakeDom();
  let more = 0;
  const base = {
    sessionId: SESSION_A, open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
    tools: [], records: [], loadingEarlier: false, evidence: [], occupancyKnown: false, occupancyEstimated: false,
    quickQuestionsDismissed: true, hasEarlier: false,
    historyDetail: {
      recordId: 'rec-1', status: 'ready', hasEarlier: true, loadingMore: false,
      counts: { evidence: 45, tools: 1, images: 0 },
      cursor: '20',
      record: {
        id: 'rec-1', question: '这一步在做什么', answerText: '它在读取配置。', reasoningText: '先看配置。',
        evidence: [{ title: '依据0', summary: '第0条依据摘要', source: 'selected_frozen', evidenceState: 'observed' }],
        tools: [{ tool: 'explain_read_workspace_file', status: 'ok', arguments: { path: 'src/f0.ts' }, result: { ok: true } }],
        images: [],
      },
    },
  };
  const plugin = { registry: { update() {}, get: () => base }, api: {}, cancel() {}, submit() {}, loadEarlier() {}, loadMoreHistoryDetail: () => { more++ }, closeHistoryDetail() {} };
  try {
    const root = overlay.renderOverlay(base, plugin);
    assert.match(root.textContent, /这条记录的完整内容/, '必须有展开面板');
    assert.match(root.textContent, /第0条依据摘要/, '完整依据必须显示出来（§11.6）');
    assert.match(root.textContent, /explain_read_workspace_file/, '完整工具过程必须显示出来');
    assert.match(root.textContent, /共 45 条/, '必须告诉用户总数，不能只给一页还装作是全部');
    const moreButton = root.querySelector('.ea-detail-more');
    assert.ok(moreButton, '还有内容时必须给「继续加载」');
    moreButton.click();
    assert.equal(more, 1, '点击必须真的去取下一页');
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.restore();
  }
});

test('浮窗入口: 展开失败时显示中文原因，且不冒充满内容', async () => {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const dom = fakeDom();
  const base = {
    sessionId: SESSION_A, open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
    tools: [], records: [], loadingEarlier: false, evidence: [], occupancyKnown: false, occupancyEstimated: false,
    quickQuestionsDismissed: true, hasEarlier: false,
    historyDetail: { recordId: 'missing', status: 'error', hasEarlier: false, loadingMore: false, error: '这条小助手记录不存在，或者它属于另一个主对话，无法查看。' },
  };
  const plugin = { registry: { update() {}, get: () => base }, api: {}, cancel() {}, submit() {}, loadEarlier() {} };
  try {
    const root = overlay.renderOverlay(base, plugin);
    assert.match(root.textContent, /记录不存在/, '失败原因必须是中文可读的（§10 不静默失败）');
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.restore();
  }
});
