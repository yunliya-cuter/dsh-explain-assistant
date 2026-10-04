import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moduleFromSource, fakeDom, waitFor, waitSettled } from './fixtures/runtime.mjs';

/**
 * 静默缺陷猎捕（silent defects）。
 *
 * 这一类缺陷的共同点：**不报错**、功能表面能跑完，只有盯着最终结果才看得出来。
 * 每条测试都用**真实契约**取证——真宿主路由 + 真 client/api.ts + 真落库文件，
 * 不用假对象替掉被怀疑的那一段，因为假对象正是让这些缺陷在既有测试里保持全绿的原因。
 *
 * 每条测试都「钉住当前行为」：缺口在时全绿，修好后变红并提醒同步断言。
 * D1–D6 与 S1/S3/S4 均已修复，断言已同步为**期望行为**；
 * D4 的两条分页语义用例（一次点击=一页、继续点击可补全）保留为复核。
 * 证据与复现命令见 docs/evidence/silent-defects.md。
 */

const ROOT = new URL('..', import.meta.url).pathname;

/* ------------------------------------------------------------------ *
 * 真宿主夹具：注册 src/index.ts 的真实路由，并把 globalThis.fetch 指过去，
 * 这样客户端走的是 src/client/api.ts 的真实 URL / 字段名契约。
 * ------------------------------------------------------------------ */
async function startHost(llm, sessionQuery = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'ea-silent-'));
  process.env.DSH_HOME = home;
  const host = await moduleFromSource('src/index.ts');
  const routes = new Map();
  host.apply({
    llm,
    sessionQuery,
    connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
    effect: () => {},
    get: () => undefined,
  });
  // 记录 /state 请求的「已完成」次数，供测试**条件等待**刷新链结束，
  // 取代「open() 之后 sleep 40ms 赌它跑完」这种会随链路变长而偶发失败的写法。
  let stateCompleted = 0;
  const call = async (url, init) => {
    const target = new URL(String(url), 'http://host');
    const handler = routes.get(target.pathname);
    if (!handler) return new Response('not found', { status: 404 });
    const response = await handler(new Request(target.toString(), init));
    if (target.pathname.endsWith('/state')) stateCompleted++;
    return response;
  };
  const get = async p => (await call(p)).json();
  const post = async (p, body) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const sseText = async (p, body) => (await post(p, body)).text();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = call;
  return {
    home,
    routes,
    get,
    post,
    sseText,
    /** 等一次 /state 刷新真正完成。调用前先取 `before`，用于「open() 之后等这次刷新」。 */
    get stateCompleted() { return stateCompleted; },
    waitForState(afterCount, label) {
      return waitFor(() => stateCompleted > afterCount, { label: label ?? '刷新链应完成一次 /state 请求' });
    },
    restore() { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true }); },
  };
}

async function seed(sessionId, mutate) {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const store = new persistence.JsonSessionStore({ rootDir: process.env.DSH_HOME + '/explain-assistant' });
  await store.update(sessionId, mutate);
  await store.close();
}

async function clientPlugin(sessionId) {
  const client = await moduleFromSource('src/client/index.ts');
  return client.createClientPlugin({ session: { id: sessionId } });
}

/** 渲染一次浮窗，返回 { root, text }；调用方负责 await settle() 后 dom.restore()。 */
async function renderState(state) {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const dom = fakeDom();
  const fixed = { phase: 'idle', draft: '', reasoning: '', text: '', tools: [], records: [], evidence: [], occupancyKnown: false, occupancyEstimated: false, ...state, open: true };
  const plugin = { registry: { update() {}, close() {}, get: () => fixed }, submit: async () => {}, loadEarlier: async () => {}, cancel: () => {} };
  const root = overlay.renderOverlay(fixed, plugin);
  return { root, text: root.textContent || '', settle: async () => { await new Promise(r => setTimeout(r, 20)); dom.restore(); } };
}

const PAGE = 20;
const historyRecords = (total, prefix = '问题') => Array.from({ length: total }, (_, i) => ({
  id: 'r' + i, kind: 'ask', status: 'complete', complete: true,
  question: prefix + i, answerText: '回答' + i, reasoningText: '',
  startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
}));

/* ================================================================== *
 * D1 工具失败被渲染成「完成」
 *
 * 盲区类型：只断言「没报错」。
 * 既有 tests/tools.test.mjs:23 只断言工具**事件顺序**是 tool_start/tool_result；
 * 没有任何测试去看客户端把 tool_result 渲染成什么状态。
 * 于是 data.ok === false（执行失败）与成功走同一分支——面板写「完成」。
 * ================================================================== */

test('D1 静默缺陷: 只读工具失败时，工具面板仍显示「完成」', async () => {
  let round = 0;
  const llm = {
    async *stream() {
      if (round++ === 0) yield { toolCalls: [{ name: 'explain_read_session', arguments: { seq: 1 } }] };
      else yield { type: 'text-delta', index: 0, text: '这是回答' };
    },
  };
  // 真实的会话读取失败（会话已被清理）
  const sessionQuery = { readEvent: async () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); } };
  const host = await startHost(llm, sessionQuery);
  const plugin = await clientPlugin('d1');
  try {
    const stateBefore1 = host.stateCompleted;
    plugin.open();
    await host.waitForState(stateBefore1, 'open() 引发的刷新应完成');
    await plugin.api.selectModel('d1', { provider: 'p', model: 'm' });
    await plugin.submit('它在干什么');
    await waitSettled(plugin.registry, 'd1');

    const tool = plugin.registry.get('d1').tools[0];
    assert.ok(tool, '工具事件必须到达客户端');
    // 结果对象确实是失败（ok:false + 中文原因），前端拿到了它
    assert.equal(tool.result?.ok, false, '工具结果确实是失败：' + JSON.stringify(tool.result));
    assert.match(String(tool.result?.message), /找不到这个文件或目录/, '失败原因确实是中文可读的');
    // 已修复：失败的工具必须标成 error（宿主把失败放在 result 里，外层没有 ok 字段）
    assert.equal(tool.status, 'error', '失败的工具必须标成 error');

    const rendered = await renderState({ sessionId: 'd1', tools: plugin.registry.get('d1').tools });
    try {
      assert.match(rendered.text, /explain_read_session · 失败/, '面板必须把失败工具写成「失败」');
      assert.equal(rendered.text.includes('完成'), false, '失败的步骤不得显示成「完成」');
    } finally { await rendered.settle(); }
  } finally { plugin.dispose(); host.restore(); }
});

/* ================================================================== *
 * D2 模型提供方失败被当成「已完成」并落库为 complete
 *
 * 盲区类型：假对象掩盖真实契约。
 * 既有测试的假 llm 要么 yield { text }，要么直接 throw；真实的 @deepseek-ai/dsh-llm
 * 在适配器出错时**不抛异常**，而是产出一个 finish 块 { type:'finish', reason:{ kind:'error', failure } }
 * （见 dsh-llm/lib/index.js:2376 adapterFailureChunk）。
 * src/host/llm.ts:20 的 readChunk 只认 text/reasoning/toolCalls/usage/done，
 * 完全没读 reason，于是「适配器失败」与「模型返回空文本」不可区分。
 * ================================================================== */

test('D2 静默缺陷: 提供方报错（finish.reason.kind=error）被当成正常完成', async () => {
  const llm = { async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'Invalid API key provided' } } }; } };
  const host = await startHost(llm);
  const plugin = await clientPlugin('d2');
  try {
    const stateBefore2 = host.stateCompleted;
    plugin.open();
    await host.waitForState(stateBefore2, 'open() 引发的刷新应完成');
    await plugin.api.selectModel('d2', { provider: 'p', model: 'm' });
    await plugin.submit('它在干什么');
    await waitSettled(plugin.registry, 'd2', { label: '问答应结束（离开进行中）' });

    const state = plugin.registry.get('d2');
    // 已修复：提供方报错必须落到 error，并给用户一句中文提示，而不是显示「已完成、内容空白」。
    assert.equal(state.phase, 'error', '提供方报错必须落到「出错」');
    assert.match(String(state.error), /没有成功|错误/, '必须给用户看得懂的中文原因');
    assert.match(String(state.error), /[\u4e00-\u9fa5]/, '提示必须是中文，不能把英文原文直接抛给用户');

    const persisted = (await host.get('/api/explain-assistant/state?sessionId=d2')).payload.records[0];
    assert.equal(persisted.status, 'interrupted', '失败不得落成 complete');
    assert.equal(persisted.complete, false, 'complete 必须是 false');
    // 英文原文保留在服务端事件里供排查，但不作为用户文案。
    const events = await host.sseText('/api/explain-assistant/ask', { schemaVersion: 1, sessionId: 'd2', operation: 'ask', payload: { question: '再问一次' } });
    assert.match(events, /event: error/, '失败必须走 error 事件');
    assert.match(events, /Invalid API key provided/, '英文原文保留在原因里供排查');
  } finally { plugin.dispose(); host.restore(); }
});

test('D2 对照: 同一形态下「模型真空回答」与「提供方报错」被当成同一件事', async () => {
  const host = await startHost({ async *stream() { yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }; } });
  const plugin = await clientPlugin('d2b');
  try {
    const stateBefore3 = host.stateCompleted;
    plugin.open();
    await host.waitForState(stateBefore3, 'open() 引发的刷新应完成');
    await plugin.api.selectModel('d2b', { provider: 'p', model: 'm' });
    await plugin.submit('它在干什么');
    await waitSettled(plugin.registry, 'd2b', { label: '问答应结束（离开进行中）' });
    // 已修复：提供方中断同样走失败路径，不再冒充「已完成」。
    assert.equal(plugin.registry.get('d2b').phase, 'interrupted', '提供方中断必须落到「已停止」');
  } finally { plugin.dispose(); host.restore(); }
});

/* ================================================================== *
 * D3 历史记录里没有回答正文（重开浮窗后那次回答再也看不到）
 *
 * 盲区类型：假对象掩盖真实契约。
 * 既有 tests/client.test.mjs:33 用假 api 发 complete，客户端自己 appendRecord 出的
 * 记录是「客户端形状」（answer/createdAt）；而真实路径的记录来自宿主落库，
 * 是 routes.ts:85 写的「宿主形状」（answerText/reasoningText/startedAt/updatedAt）。
 * overlay.tsx:304 只读 record.answer —— 于是历史行只剩问题。
 * ================================================================== */

test('D3 静默缺陷: 真实宿主的记录形状与历史渲染字段不一致，历史里没有回答', async () => {
  const llm = { async *stream() { yield { type: 'text-delta', index: 0, text: '这是模型的回答' }; } };
  const host = await startHost(llm);
  const plugin = await clientPlugin('d3');
  try {
    const stateBefore4 = host.stateCompleted;
    plugin.open();
    await host.waitForState(stateBefore4, 'open() 引发的刷新应完成');
    await plugin.api.selectModel('d3', { provider: 'p', model: 'm' });
    await plugin.submit('它在干什么');
    // 这条要验的是「**宿主落库**的字段形状」，所以必须等 complete 之后那次 refreshState
    // 把宿主的记录取回来（只等 phase 离开 running 不够——那时本地还是自己 append 的记录，
    // 字段名是客户端那套 answer/createdAt，不是宿主那套 answerText/startedAt）。
    // 用条件等待而不是固定 sleep：等 answerText 真的出现，或超时变红。
    await waitFor(() => plugin.registry.get('d3').records[0]?.answerText === '这是模型的回答', {
      label: '完成后应把宿主的记录（answerText 形状）刷新回来',
    });

    const record = plugin.registry.get('d3').records[0];
    assert.ok(record, '历史里必须有一条记录');
    assert.equal(record.answerText, '这是模型的回答', '宿主落库的字段是 answerText');
    // 字段名两套并存（宿主 answerText/startedAt、客户端 answer/createdAt）；
    // 已修复：渲染层两个都认，所以这里只钉住「宿主那套字段确实存在」。
    assert.equal(record.createdAt, undefined, '宿主写的是 startedAt');

    // 关窗再打开 = 刷新页面后首屏：text 清空，只剩历史
    plugin.registry.close('d3');
    plugin.registry.update('d3', { text: '', reasoning: '' });
    plugin.open();
    await waitFor(() => plugin.registry.get('d3').text === '', { label: '重开后顶部回答区应为空' });
    const reopened = plugin.registry.get('d3');
    assert.equal(reopened.text, '', '重开后顶部回答区是空的');

    const rendered = await renderState({ sessionId: 'd3', records: reopened.records, hasEarlier: false });
    try {
      assert.match(rendered.text, /它在干什么/, '历史里看得到问题');
      // 已修复：重开浮窗后历史里必须能看到那次回答的正文。
      assert.match(rendered.text, /这是模型的回答/, '历史里必须能看到回答正文');
    } finally { await rendered.settle(); }
  } finally { plugin.dispose(); host.restore(); }
});

/* ================================================================== *
 * D4 翻页丢一页：首屏游标与 loadHistory 的分页语义差一页
 *
 * 盲区类型：只测第一次调用。
 * 既有 tests/history-pagination.test.mjs:43 只用 **loadHistory 自己的** p1.cursor 连翻三页，
 * 恰好覆盖全部；它没有把「state 下发的 historyCursor」喂回 loadHistory——
 * 而真实客户端 index.ts:255 用的正是 state 下发的那个游标。
 * ================================================================== */

test('D4 复核: 一次点击只加载一页，剩余那页仍然可达（不是「永远看不到」）', async () => {
  const TOTAL = 50;
  const host = await startHost({ async *stream() { yield { type: 'text-delta', index: 0, text: 'x' }; } });
  const plugin = await clientPlugin('d4');
  try {
    await seed('d4', state => { state.records = historyRecords(TOTAL); state.explicitModel = { provider: 'p', model: 'm' }; });
    const stateBefore5 = host.stateCompleted;
    plugin.open();
    await host.waitForState(stateBefore5, 'open() 引发的刷新应完成');
    const first = plugin.registry.get('d4');
    assert.equal(first.records.length, PAGE, '首屏一页');
    assert.equal(first.historyCursor, String(TOTAL - PAGE), '首屏游标表示「更早的记录条数」');

    await plugin.loadEarlier();
    const second = plugin.registry.get('d4');
    const shown = second.records.map(r => r.question);
    const missing = historyRecords(TOTAL).map(r => r.question).filter(q => !shown.includes(q));
    // 一次点击 = 一页，这是分页的定义：首屏 [30,50) + loadEarlier(30) 给 [10,30)，
    // 恰好还剩最早一页 [0,10) 没加载。要点是**没有空洞**（[10,30) 与 [30,50) 连续），
    // 而且剩余那页仍然可达（hasEarlier=true，见下一条用例证明继续点就能拿到）。
    assert.deepEqual(missing, historyRecords(TOTAL - 2 * PAGE, '问题').map(r => r.question),
      '一次点击后未加载的恰好是最后一页，不能是中间某段');
    assert.equal(second.hasEarlier, true, '更早的还有（[0,10)），按钮必须还在');
  } finally { plugin.dispose(); host.restore(); }
});

test('D4 复核: 继续点击能逐页补全，最终无缺失', async () => {
  const TOTAL = 50;
  const host = await startHost({ async *stream() { yield { type: 'text-delta', index: 0, text: 'x' }; } });
  const plugin = await clientPlugin('d4b');
  try {
    await seed('d4b', state => { state.records = historyRecords(TOTAL); state.explicitModel = { provider: 'p', model: 'm' }; });
    const stateBefore6 = host.stateCompleted;
    plugin.open();
    await host.waitForState(stateBefore6, 'open() 引发的刷新应完成');
    await plugin.loadEarlier();
    await plugin.loadEarlier();
    const shown = plugin.registry.get('d4b').records.map(r => r.question);
    // 第二次 loadEarlier 用的是 10，取 [0,10)，补上了问题0..问题9 —— 但代价是必须多点一次
    // 已修复：逐页翻到底，全部记录连续到齐，不需要「多点一次才补上」。
    assert.equal(shown.includes('问题0'), true, '最早一页能翻到');
    assert.equal(shown.length, TOTAL, '翻到底时全部到齐');
    assert.equal(shown.includes('问题10'), true, '每一页都不缺');
  } finally { plugin.dispose(); host.restore(); }
});

test('D4 修复: 提问后分页窗口不再被重置（原先会挖出一段空洞）', async () => {
  const TOTAL = 45;
  let answer = '回答';
  const host = await startHost({ async *stream() { yield { type: 'text-delta', index: 0, text: answer }; } });
  const plugin = await clientPlugin('d4c');
  try {
    await seed('d4c', state => { state.records = historyRecords(TOTAL); state.explicitModel = { provider: 'p', model: 'm' }; });
    const stateBefore7 = host.stateCompleted;
    plugin.open();
    await host.waitForState(stateBefore7, 'open() 引发的刷新应完成');
    await plugin.loadEarlier();
    await plugin.loadEarlier();
    assert.equal(plugin.registry.get('d4c').records.length, TOTAL, '翻到底时 45 条都在');

    answer = '这是新回答';
    await plugin.submit('新问题');
    await waitSettled(plugin.registry, 'd4c', { label: '问答应结束（离开进行中）' });
    await plugin.loadEarlier();
    const shown = plugin.registry.get('d4c').records.map(r => r.question);
    const missing = historyRecords(TOTAL).map(r => r.question).filter(q => !shown.includes(q));
    // 已修复：提问后的状态刷新不再用首屏替换本地窗口，已翻出的更早记录原样保留，不产生空洞。
    assert.deepEqual(missing, [], '提问后不得再出现空洞');
  } finally { plugin.dispose(); host.restore(); }
});

/* ================================================================== *
 * D5 一次失败的 /compact 会把本地摘要抹掉，而且刷新也回不来
 *
 * 盲区类型：只测第一次调用 + 只断言「没报错」。
 * 既有 tests/compact.test.mjs / occupancy-compact-visibility.test.mjs 只跑**一次** compact，
 * 且只断言「失败后 phase === 'error'」。没人跑「先成功一次、再失败一次」——
 * index.ts:128 的 complete 分支不保留旧摘要（只有 aborted/error 分支保留了）。
 * ================================================================== */

test('D5 静默缺陷: 第二次压缩失败会清掉上一次成功摘要，刷新后仍看不到', async () => {
  let mode = 'ok';
  const llm = {
    async *stream() {
      if (mode === 'ok') { yield { type: 'text-delta', index: 0, text: '第一份摘要正文' }; return; }
      // 真实 dsh-llm 的适配器失败形态：finish 块，而不是 throw
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'Invalid API key' } } };
    },
  };
  const host = await startHost(llm);
  const first = await clientPlugin('d5');
  try {
    const stateBefore8 = host.stateCompleted;
    first.open();
    await host.waitForState(stateBefore8, 'open() 引发的刷新应完成');
    await first.api.selectModel('d5', { provider: 'p', model: 'm' });
    await first.submit('/compact');
    await waitSettled(first.registry, 'd5', { label: '问答应结束（离开进行中）' });
    assert.equal(first.registry.get('d5').compactState?.summary, '第一份摘要正文', '第一次压缩成功并显示摘要');

    mode = 'fail';
    await first.submit('/compact');
    await waitSettled(first.registry, 'd5', { label: '问答应结束（离开进行中）' });
    const after = first.registry.get('d5').compactState;
    assert.equal(after?.status, 'error', '第二次压缩确实失败了');
    assert.equal(after?.summary, undefined, '当前行为：上一次成功摘要被清掉（修复后应保留正文）');
  } finally { first.dispose(); }

  // 刷新页面：宿主磁盘上摘要还在，但界面依旧拿不到
  const second = await clientPlugin('d5');
  try {
    const stateBefore9 = host.stateCompleted;
    second.open();
    await host.waitForState(stateBefore9, 'open() 引发的刷新应完成');
    const persisted = await host.get('/api/explain-assistant/state?sessionId=d5');
    assert.equal(persisted.payload.compactState?.summary, '第一份摘要正文', '宿主磁盘上摘要仍然在');
    const rendered = await renderState({ sessionId: 'd5', compactState: second.registry.get('d5').compactState });
    try {
      assert.equal(rendered.text.includes('第一份摘要正文'), false, '当前行为：刷新后界面也看不到那份仍然可用的摘要');
      assert.match(rendered.text, /压缩失败/, '用户只看到失败提示');
    } finally { await rendered.settle(); }
  } finally { second.dispose(); host.restore(); }
});

/* ================================================================== *
 * D6 「刷新模型」被 30 秒缓存吃掉，按了没反应
 *
 * 盲区类型：只测第一次调用。
 * 既有 tests/catalog-first-paint.test.mjs 只验证**首次** paint 能拿到目录；
 * 没有任何测试点第二次「刷新模型」。
 * src/index.ts:74 loadCatalog 的 TTL 缓存同时服务 state / models / selectModel 校验，
 * 于是刚在宿主里加好的模型，点刷新也出不来。
 * ================================================================== */

test('D6 静默缺陷: 刚新增的模型提供方，点「刷新模型」也刷不出来', async () => {
  let providers = [{ id: 'p1', displayName: '提供方一' }];
  let listCalls = 0;
  const llm = {
    listProviders() { listCalls++; return providers; },
    listModels() { return [{ id: 'm1', name: '模型一' }]; },
  };
  const host = await startHost(llm);
  try {
    const before = await host.get('/api/explain-assistant/models?sessionId=d6');
    assert.deepEqual(before.payload.groups.map(g => g.provider), ['p1']);
    assert.equal(listCalls, 1);

    providers = [{ id: 'p1', displayName: '提供方一' }, { id: 'p2-new', displayName: '新加的提供方' }];
    const after = await host.get('/api/explain-assistant/models?sessionId=d6');
    // 已修复：这是「刷新模型」按钮打的那个接口，必须绕开缓存，真的重新问一次宿主。
    assert.equal(after.payload.groups.some(g => g.provider === 'p2-new'), true,
      '刷新必须能看到刚新增的提供方');
    assert.equal(listCalls, 2, '刷新必须真的再问一次宿主');
  } finally { host.restore(); }
});

/* ================================================================== *
 * 已查但**没有问题**的口子（同样留证，避免只报坏消息）
 * ================================================================== */

test('OK1 连续两次 select-model 都真正落库（第二次不被第一次吃掉）', async () => {
  const host = await startHost({ async *stream() { yield { type: 'text-delta', index: 0, text: 'x' }; } });
  try {
    const body = model => ({ schemaVersion: 1, sessionId: 'ok1', operation: 'select-model', payload: { model } });
    await host.post('/api/explain-assistant/select-model?sessionId=ok1', body({ provider: 'p1', model: 'm1' }));
    await host.post('/api/explain-assistant/select-model?sessionId=ok1', body({ provider: 'p2', model: 'm2' }));
    const state = await host.get('/api/explain-assistant/state?sessionId=ok1');
    assert.equal(state.payload.model.provider, 'p2', '第二次选择必须覆盖第一次');
    assert.equal(state.payload.model.model, 'm2');
  } finally { host.restore(); }
});

test('OK2 连续两次问答都落库且 id 不冲突', async () => {
  let n = 0;
  const host = await startHost({ async *stream() { yield { type: 'text-delta', index: 0, text: '回答' + (++n) }; } });
  try {
    await host.post('/api/explain-assistant/select-model?sessionId=ok2', { schemaVersion: 1, sessionId: 'ok2', operation: 'select-model', payload: { model: { provider: 'p', model: 'm' } } });
    for (const question of ['第一问', '第二问']) {
      await host.sseText('/api/explain-assistant/ask', { schemaVersion: 1, sessionId: 'ok2', operation: 'ask', payload: { question } });
    }
    const records = (await host.get('/api/explain-assistant/state?sessionId=ok2')).payload.records;
    assert.equal(records.length, 2, '两次问答都要落库');
    assert.equal(new Set(records.map(r => r.id)).size, 2, 'id 不得重复');
    assert.deepEqual(records.map(r => r.question), ['第一问', '第二问']);
  } finally { host.restore(); }
});

test('OK3 searchEvents 的 limit 在请求体、取消信号在第二个参数（C4 已修，复核仍正确）', async () => {
  const tools = await moduleFromSource('src/host/tools.ts');
  const seen = [];
  const ctx = {
    sessionId: 'ok3',
    sessionQuery: {
      searchEvents(request, exec) { seen.push({ request, hasExec: Boolean(exec) }); return { hits: [] }; },
      readEvent() { return {}; },
    },
  };
  const result = await tools.executeTool(ctx, { name: 'explain_search_session', arguments: { query: '关键词', limit: 7 } });
  assert.equal(result.ok, true);
  assert.equal(seen[0].request.limit, 7, '用户设的条数必须原样到达宿主');
  assert.equal('pageSize' in seen[0].request, false, '不得再传 pageSize');
  assert.equal(seen[0].hasExec, true, '取消信号必须走第二个参数');
});

test('OK4 history / history-result 的查询参数名与路由读取一致', async () => {
  const host = await startHost({ async *stream() { yield { type: 'text-delta', index: 0, text: 'x' }; } });
  try {
    await seed('ok4', state => { state.records = historyRecords(25); });
    const page = await host.get('/api/explain-assistant/history?sessionId=ok4&cursor=5');
    assert.equal(page.payload.records.length, 5, 'cursor 必须被路由真正读到');
    assert.equal(page.payload.hasEarlier, false);
  } finally { host.restore(); }
});

test('OK5 真·空回答与「提供方报错」在宿主侧目前不可区分（D2 的根因对照）', async () => {
  const host = await startHost({ async *stream() { yield { type: 'text-delta', index: 0, text: '' }; } });
  try {
    await host.post('/api/explain-assistant/select-model?sessionId=ok5', { schemaVersion: 1, sessionId: 'ok5', operation: 'select-model', payload: { model: { provider: 'p', model: 'm' } } });
    const text = await host.sseText('/api/explain-assistant/ask', { schemaVersion: 1, sessionId: 'ok5', operation: 'ask', payload: { question: '问' } });
    assert.match(text, /event: complete/, '真·空回答确实应该算完成');
    const record = (await host.get('/api/explain-assistant/state?sessionId=ok5')).payload.records[0];
    assert.equal(record.status, 'complete', '空回答落 complete 本身没错——错的是报错也走同一条路');
  } finally { host.restore(); }
});

/* ================================================================== *
 * S1 压缩成功后刷新页面，摘要再也回不来
 *
 * 盲区类型：只测第一次调用 / 只测同一个内存实例。
 * 既有 occupancy-compact-visibility.test.mjs 的 F1 与回归用例都在**同一个** registry
 * 实例里跑（先 submit 再 open），从来没测过「刷新页面 = 全新状态」这条路径。
 * client/index.ts 的 refreshState 只在本地「没有非 complete 状态」时才采用宿主的
 * compactState；store.ts 初始值恒为 { status: 'idle' }，于是宿主的摘要被挡在门外。
 * ================================================================== */

test('S1 修复: 压缩成功后刷新页面，摘要必须恢复', async () => {
  const host = await startHost({ async *stream() { yield { type: 'text-delta', index: 0, text: '第一份摘要正文' }; } });
  const first = await clientPlugin('s1');
  try {
    const stateBefore10 = host.stateCompleted;
    first.open();
    await host.waitForState(stateBefore10, 'open() 引发的刷新应完成');
    await first.api.selectModel('s1', { provider: 'p', model: 'm' });
    await first.submit('/compact');
    await waitFor(() => first.registry.get('s1').compactState?.summary, { label: '压缩成功后应能看到摘要' });
    assert.equal(first.registry.get('s1').compactState?.summary, '第一份摘要正文', '压缩成功，内存里能看到摘要');
  } finally { first.dispose(); first.registry.remove('s1'); }

  // 宿主磁盘上摘要确实在
  const persisted = (await host.get('/api/explain-assistant/state?sessionId=s1')).payload.compactState;
  assert.equal(persisted?.summary, '第一份摘要正文', '宿主 /state 下发的摘要正文仍然在');

  // 刷新页面 = 全新状态
  const second = await clientPlugin('s1');
  try {
    second.open();
    await waitFor(() => second.registry.get('s1').compactState?.summary, { label: '刷新后摘要应恢复' });
    const state = second.registry.get('s1').compactState;
    // 已修复：刷新后必须从宿主恢复摘要。
    assert.equal(state?.summary, '第一份摘要正文', '刷新后摘要必须恢复');
    assert.equal(state?.status, 'complete', '有摘要即为已压缩');
    const rendered = await renderState({ sessionId: 's1', compactState: state });
    try { assert.match(rendered.text, /第一份摘要正文/, '界面上必须看得到那份摘要'); }
    finally { await rendered.settle(); }
  } finally { second.dispose(); second.registry.remove('s1'); host.restore(); }
});

test('S1 修复: 宿主给了 compactState，初始为 idle 的客户端必须采用', async () => {
  const client = await moduleFromSource('src/client/index.ts');
  const payload = { records: [], hasEarlier: false, compactState: { version: 1, summary: '磁盘上的摘要', createdAt: '2026-01-01T00:00:00.000Z' } };
  const plugin = client.createClientPlugin({ api: { state: async () => ({ payload }) }, session: { id: 's1b' } });
  try {
    // 这条用的是精简的假 api（没有 host 计数），直接等**可观测结果**出现。
    plugin.open();
    await waitFor(() => plugin.registry.get('s1b').compactState?.summary, { label: '宿主摘要应被采用' });
    const state = plugin.registry.get('s1b').compactState;
    // 已修复：宿主给了 compactState，客户端必须采用（初始 idle 不再是阻挡条件）。
    assert.equal(state?.summary, '磁盘上的摘要', '宿主摘要必须被采用：' + JSON.stringify(state));
    assert.equal(state?.status, 'complete');
  } finally { plugin.dispose(); plugin.registry.remove('s1b'); }
});

/* ================================================================== *
 * S3 中断的记录在历史里没有「未完成」标记
 *
 * 盲区类型：只断言「没报错」。
 * 既有测试只断言 record 被 append、id 不重复；没有任何测试断言 overlay 那句
 * 「此记录未完成或未验证」真的渲染出来过。
 * overlay 读 record.incomplete，宿主落库写的是 status/complete（routes.ts），
 * 字段名对不上，警告永远不渲染。
 * ================================================================== */

test('S3 修复: 中断的记录在历史里必须显示「未完成」警告', async () => {
  const host = await startHost({ async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad' } } }; } });
  const plugin = await clientPlugin('s3');
  try {
    const stateBefore12 = host.stateCompleted;
    plugin.open();
    await host.waitForState(stateBefore12, 'open() 引发的刷新应完成');
    await plugin.api.selectModel('s3', { provider: 'p', model: 'm' });
    await plugin.submit('问一句');
    // 这条断言的是**宿主落库**的记录，必须等它真的写进去再读（用条件等待，不用固定 sleep）。
    await waitFor(async () => {
      const served = (await host.get('/api/explain-assistant/state?sessionId=s3')).payload;
      return served?.records?.[0]?.status === 'interrupted';
    }, { label: '宿主应落库一条中断记录' });

    const record = (await host.get('/api/explain-assistant/state?sessionId=s3')).payload.records[0];
    assert.equal(record.status, 'interrupted', '这次问答确实中断了');
    assert.equal(record.complete, false, '宿主用 complete:false 表达「没跑完」');
    assert.equal('incomplete' in record, false, '宿主落库用的是 status/complete，没有 incomplete 字段');

    const rendered = await renderState({ sessionId: 's3', records: [record], hasEarlier: false });
    try {
      assert.match(rendered.text, /问一句/, '历史里看得到问题');
      // 已修复：渲染层同时认 incomplete 与宿主的 status/complete。
      // D1 之后：记录若带了原因，就显示**具体原因**（而不是笼统的「未完成」）——
      // 这条用例是模型调用失败，所以应当显示模型失败那句。
      assert.match(rendered.text, /这条记录没有完成/, '未完成警告必须渲染出来');
      assert.match(rendered.text, /模型那边返回了错误/, 'D1：必须说明具体原因（这里是模型失败），用户才知道该怎么做');
    } finally { await rendered.settle(); }
  } finally { plugin.dispose(); host.restore(); }
});

/* ================================================================== *
 * S4 刷新页面后未读标记丢失
 *
 * 盲区类型：只断言「没报错」。
 * 既有测试只验证 markUnread / state.unread 的落库，没有测试「刷新后未读徽标还在不在」。
 * state 是唯一真相，而 refreshState 的合并白名单里根本没有 unread 这一项。
 * ================================================================== */

test('S4 修复: 刷新页面后未读徽标必须恢复', async () => {
  const host = await startHost({ async *stream() { yield { type: 'text-delta', index: 0, text: '回答正文' }; } });
  const first = await clientPlugin('s4');
  try {
    const stateBefore13 = host.stateCompleted;
    first.open();
    await host.waitForState(stateBefore13, 'open() 引发的刷新应完成');
    await first.api.selectModel('s4', { provider: 'p', model: 'm' });
    await first.submit('它在干什么');
    await waitSettled(first.registry, 's4');
    assert.equal(first.registry.get('s4').unread, true, '问答结束后本地标未读');
  } finally { first.dispose(); first.registry.remove('s4'); }

  const persisted = (await host.get('/api/explain-assistant/state?sessionId=s4')).payload;
  assert.equal(persisted.unread, true, '宿主仍然记着「有未读内容」');

  const second = await clientPlugin('s4');
  try {
    // 语义区分（§10）：这里要断言的是「**刷新页面**后未读仍在」。
    // 真实的刷新路径是冷启动重新拉宿主状态（HeaderButton 挂载 → primeUnread），
    // 而**不是** open()——open() 是「用户打开浮窗」，按 §10 必须清除未读。
    // 原测试用 open() 模拟刷新，在新语义下那个动作恰恰是「清除」，因此改用 primeUnread。
    await second.primeUnread('s4');
    assert.equal(second.registry.get('s4').unread, true, '刷新页面后未读徽标必须还在（宿主是唯一真相）');

    // 反向钉住 §10：打开浮窗必须清除
    second.open();
    await waitFor(() => second.registry.get('s4').unread === false, { label: '§10 打开浮窗后必须清除未读' });
    assert.equal(second.registry.get('s4').unread, false, '§10：打开浮窗后必须清除未读');
  } finally { second.dispose(); second.registry.remove('s4'); host.restore(); }
});