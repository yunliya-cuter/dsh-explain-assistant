import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource, fakeDom, FakeElement, waitFor } from './fixtures/runtime.mjs';

/**
 * F8（§7 / §10 / §11.9）：**模型不可用时的降级层**必须是行为级、不可回退的。
 *
 * 文档原文（business-logic.md §7 最后两条）：
 *   「不让联网大模型成为基本功能的强依赖：模型不可用时仍能查看既有记录、真实依据和基本说明」
 *   「自由问答通常需要模型；基本说明不能冒充完整智能回答」
 *
 * 与既有 round8-fixes.test.mjs 的区别（那里也有两条 F8）：
 * 那两条是**手工把 phase 设成 'error' 再渲染**——它们只证明了「渲染函数能画出来」，
 * **不证明三种失败状态真的会把客户端带到那个状态**。本文件三种造态全部走**真实链路**：
 * 真宿主路由 + 真 client 插件 + 真 SSE 事件，最后渲染真浮窗，断言三件事同时成立。
 * 所以这里能抓住「有人在事件处理里漏了某个终态」这类缺陷，而手工设 phase 的测试抓不到。
 *
 * 三条必须同时成立（对每种造态都断言）：
 *   a. 既有记录与依据**仍然展示**（不能被错误态整块盖掉）；
 *   b. 有一段本地「基本说明」；
 *   c. 它**明确写清这不是模型给的解释**（§7，不能冒充完整智能回答）。
 */

/* ---------------- 真宿主：用 src/index.ts 注册真实路由（A/B 两种造态） ---------------- */

async function startIndexHost(llm, models) {
  const home = mkdtempSync(join(tmpdir(), 'ea-f8-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  // 关键：把**宿主真正持有的那个对象**暴露出去。若是把 stream 拷贝进一个临时字面量再 apply，
  // 之后改外层对象影响不到宿主（宿主抓的是 apply 那一刻的引用），测试会误判成「功能没生效」。
  const llmService = {
    listProviders: async () => ['p'],
    listModels: async () => models,
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
  return { home, routes, llm: llmService, restore() { rmSync(home, { recursive: true, force: true }); } };
}

/**
 * 把 globalThis.fetch 指到真实路由上（客户端走真实 src/client/api.ts 契约）。
 *
 * 两种路由表的键名不同，都要认：
 * - `src/index.ts` 的 apply() 注册的是带 /api 前缀的路径；
 * - `createExplainAssistantRoutes()` 返回的 Map 键不带 /api。
 * 所以这里依次尝试「原路径」和「去掉 /api 的路径」，两条链路都能被真实打到。
 */
function pointFetchAt(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url), 'http://host');
    const handler = routes.get(target.pathname) ?? routes.get(target.pathname.replace('/api', ''));
    if (!handler) return new Response(JSON.stringify({ error: { code: 'NO_ROUTE', message: '路由未注册：' + target.pathname } }), { status: 404 });
    return handler(new Request(target.toString(), init));
  };
  return () => { globalThis.fetch = original; };
}

/* ---------------- 造态用的假模型 ---------------- */

/** 模型提供方报错：适配器把故障归一化成 finish(reason.kind='error')。 */
const failingLlm = () => ({
  stream: () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'LLM_FAILED', message: 'boom' } } };
  })(),
});
/** 连上了但永远不吐字：用来触发超时。 */
const stalledLlm = () => ({ stream: () => (async function* () { await new Promise(() => {}); })() });
const fineLlm = () => ({
  stream: () => (async function* () { yield { type: 'text-delta', text: '模型的正常回答' }; yield { type: 'finish', done: true }; })(),
});

/**
 * 目录里必须真的有我们要选的 p/m —— 否则 selectModel 会（正确地）以 MODEL_NOT_FOUND 拒绝，
 * 那是另一条路径，会把本测试带偏。这里让造态 A/B/D 都用同一份真实目录。
 */
const CATALOG = [{ id: 'm', name: 'Model M', provider: 'p' }];

const SELECTED = [
  { id: 'e1', title: 'read_file', summary: '真实读到的配置内容', source: 'selected_frozen', evidenceState: 'observed' },
];

/* ---------------- 渲染真浮窗，返回可见文本 ---------------- */

async function renderOverlayText(state) {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  const plugin = { registry: { update() {}, close() {}, get: () => state }, submit: async () => {}, loadEarlier: async () => {}, cancel() {} };
  try {
    const root = overlay.renderOverlay(state, plugin);
    return root.textContent || '';
  } finally {
    await new Promise(r => setTimeout(r, 20));
    dom.restore();
  }
}

/** 三条硬要求一次断言完。 */
function assertFallbackContract(text, label) {
  // a. 既有依据仍然展示（不依赖模型）
  assert.match(text, /这些依据仍然可以查看/, label + '：§7 要求模型不可用时仍能查看既有依据');
  assert.match(text, /真实读到的配置内容/, label + '：依据正文必须真的渲染出来，不能只给标题');
  // b. 有基本说明
  assert.match(text, /现在能告诉你的基本说明/, label + '：必须有本地「基本说明」');
  // c. 明确不是模型回答（§7 最后一条）
  assert.match(text, /不是模型对你想问的问题给出的解释/, label + '：必须声明这不是模型给的解释，不能冒充完整智能回答');
}

/* ================================================================== *
 * 造态 E（混合历史）：**先成功问过一次**，之后模型服务消失
 *
 * 为什么单列：这是用户的真实使用路径（他前面问过、拿到过回答，然后模型挂了）。
 * 此时 state.records.length 非 0，降级说明会走 **另一条分支**
 * （overlay.tsx:165「你的历史问答记录仍然完整保留…」），与前面的「空历史」不是同一段代码。
 * 要验的是：**旧的成功记录与新出现的降级说明并存，而不是二选一**，
 * 且旧记录内容**一字不改**（§8「关闭再打开能查看」/ §10「保留已有问答」）。
 * ================================================================== */

test('F8 行为级: 先成功再遇到模型不可用时，旧记录与降级说明并存且旧记录不改', async () => {
  // stream 第一次给正常回答，之后置空 —— 模拟「模型服务消失」
  // （llm.ts:116 对 !ctx.llm?.stream 明确返回 MODEL_UNAVAILABLE，这是真实的不可用判定）
  const host = await startIndexHost({ stream: () => (async function* () { yield { type: 'text-delta', text: '第一次的成功回答' }; yield { type: 'finish', done: true }; })() }, CATALOG);
  const restoreFetch = pointFetchAt(host.routes);
  const client = await moduleFromSource('src/client/index.ts');
  const plugin = client.createClientPlugin({ session: { id: 's' } });
  try {
    plugin.open();
    // 等 open() 引发的刷新链真的完成，再继续（不用固定 sleep 赌它跑完）。
    await waitFor(() => plugin.registry.get('s').catalog, { label: '首屏应拉到模型目录' });
    await plugin.api.selectModel('s', { provider: 'p', model: 'm' });
    plugin.registry.update('s', { evidence: SELECTED });

    // —— 第一步：正常问一次，拿到成功记录 ——
    await plugin.submit('第一次提问');
    const afterFirst = plugin.registry.get('s');
    assert.equal(afterFirst.phase, 'complete', '第一次提问必须成功：' + afterFirst.phase);
    assert.ok(afterFirst.records.length >= 1, '必须留下一条成功记录');
    const successRecord = afterFirst.records.find(r => r.question === '第一次提问');
    assert.ok(successRecord, '成功记录必须能按问题找到：' + JSON.stringify(afterFirst.records.map(r => r.question)));
    const frozenSnapshot = JSON.stringify(successRecord);
    assert.match(JSON.stringify(successRecord), /第一次的成功回答/, '成功记录里必须含回答正文');

    // —— 第二步：模型服务消失，再问一次 ——
    // 改的是宿主真正持有的那个服务对象（startIndexHost 已把它暴露出来）
    host.llm.stream = undefined;
    await plugin.submit('第二次提问');
    const state = plugin.registry.get('s');

    assert.equal(state.phase, 'error', '模型不可用必须落到失败态：' + state.phase);
    assert.match(String(state.error), /[\u4e00-\u9fff]/, '失败原因必须中文：' + state.error);

    // d. 旧的成功记录不被删、不被改（内容一字不改）
    const stillThere = state.records.find(r => r.question === '第一次提问');
    assert.ok(stillThere, '旧的成功记录必须仍然在，不能被这次失败连带清掉');
    assert.equal(JSON.stringify(stillThere), frozenSnapshot, '旧记录内容必须一字不改');

    // a. 既有依据仍可见
    assert.equal(state.evidence.length, 1, '既有依据不得被清掉');

    const text = await renderOverlayText(state);

    // a. 依据照常渲染
    assert.match(text, /真实读到的配置内容/, '既有依据正文必须仍然渲染出来');
    // b. 基本说明出现，且**与既有记录并存**（不是二选一）
    assert.match(text, /第一次提问/, '历史里必须仍看得到第一次的问题');
    assert.match(text, /第一次的成功回答/, '历史里必须仍看得到第一次的回答（§8 关掉重开能查看）');
    assert.match(text, /现在能告诉你的基本说明/, '必须有基本说明');
    assert.match(text, /历史问答记录仍然完整保留/, '混合历史分支下必须明确告诉用户记录没丢');
    // c. 不冒充模型回答
    assert.match(text, /不是模型对你想问的问题给出的解释/, '必须声明这不是模型给的解释');
    // 三者共存：依据 + 旧记录 + 降级说明同屏
    assert.ok(
      /真实读到的配置内容/.test(text) && /第一次的成功回答/.test(text) && /现在能告诉你的基本说明/.test(text),
      '依据、旧记录、降级说明必须同时可见，不能互相顶替',
    );
  } finally { plugin.dispose(); restoreFetch(); host.restore(); }
});

/* ================================================================== *
 * 造态 A：未选模型（MODEL_UNAVAILABLE）
 * ================================================================== */

test('F8 行为级: 未选模型时，既有依据 + 基本说明 + 明确声明非模型回答', async () => {
  // 目录里有模型，但用户没选 → resolveModel 抛 MODEL_UNAVAILABLE（§7/§11.8：不偷偷用默认模型）
  const host = await startIndexHost(fineLlm(), CATALOG);
  const restoreFetch = pointFetchAt(host.routes);
  const client = await moduleFromSource('src/client/index.ts');
  const plugin = client.createClientPlugin({ session: { id: 's' } });
  try {
    plugin.open();
    // 等 open() 引发的刷新链真的完成，再继续（不用固定 sleep 赌它跑完）。
    await waitFor(() => plugin.registry.get('s').catalog, { label: '首屏应拉到模型目录' });
    plugin.registry.update('s', { evidence: SELECTED });   // 用户此前已经点选过依据
    await plugin.submit('它在干什么');

    const state = plugin.registry.get('s');
    assert.equal(state.phase, 'error', '未选模型必须以失败态结束，而不是静默');
    assert.match(String(state.error), /[\u4e00-\u9fff]/, '失败原因必须是中文：' + state.error);
    assert.equal(state.evidence.length, 1, '客户端的既有依据不得被清掉');
    assert.ok(state.records.length >= 1, '这次失败的尝试应留下记录（§10 不静默失败）');

    assertFallbackContract(await renderOverlayText(state), '未选模型');
  } finally { plugin.dispose(); restoreFetch(); host.restore(); }
});

/* ================================================================== *
 * 造态 B：模型调用失败（error 事件）
 * ================================================================== */

test('F8 行为级: 模型调用失败时，既有依据 + 基本说明 + 明确声明非模型回答', async () => {
  const host = await startIndexHost(failingLlm(), CATALOG);
  const restoreFetch = pointFetchAt(host.routes);
  const client = await moduleFromSource('src/client/index.ts');
  const plugin = client.createClientPlugin({ session: { id: 's' } });
  try {
    plugin.open();
    // 等 open() 引发的刷新链真的完成，再继续（不用固定 sleep 赌它跑完）。
    await waitFor(() => plugin.registry.get('s').catalog, { label: '首屏应拉到模型目录' });
    await plugin.api.selectModel('s', { provider: 'p', model: 'm' });
    plugin.registry.update('s', { evidence: SELECTED });
    await plugin.submit('它在干什么');

    const state = plugin.registry.get('s');
    assert.equal(state.phase, 'error', '模型报错必须落到 error 态（不得冒充 complete）');
    assert.match(String(state.error), /[\u4e00-\u9fff]/, '失败原因必须是中文：' + state.error);
    assert.equal(state.evidence.length, 1, '既有依据不得被清掉');

    assertFallbackContract(await renderOverlayText(state), '模型调用失败');
  } finally { plugin.dispose(); restoreFetch(); host.restore(); }
});

/* ================================================================== *
 * 造态 C：超时
 * ================================================================== */

test('F8 行为级: 超时时，既有依据 + 基本说明 + 明确声明非模型回答', async () => {
  // 超时参数只在 createExplainAssistantRoutes 上可注入（index.ts 没暴露），所以这里直接建路由。
  const routesModule = await moduleFromSource('src/host/routes.ts');
  const routes = routesModule.createExplainAssistantRoutes({
    service: {
      isSessionAllowed: async () => true,
      isArchived: async () => false,
      buildMessages: async () => [{ role: 'user', content: [{ type: 'text', text: '问' }] }],
      resolveModel: async () => ({ selection: { provider: 'p', model: 'm' } }),
      loadState: async () => ({ schemaVersion: 1, sessionId: 's', historyRevision: 0, records: [], unread: false, archived: false, createdAt: '', updatedAt: '' }),
      llm: stalledLlm(),
      llmTimeouts: { totalTimeoutMs: 200, idleTimeoutMs: 150 },
      saveRecord: async () => {}, markUnread: async () => {}, saveCompact: async () => {},
    },
  });
  const restoreFetch = pointFetchAt(routes);
  const client = await moduleFromSource('src/client/index.ts');
  const plugin = client.createClientPlugin({ session: { id: 's' } });
  try {
    plugin.open();
    // 等 open() 引发的刷新链真的完成，再继续（不用固定 sleep 赌它跑完）。
    await waitFor(() => plugin.registry.get('s').catalog, { label: '首屏应拉到模型目录' });
    plugin.registry.update('s', { evidence: SELECTED });
    await plugin.submit('它在干什么');

    const state = plugin.registry.get('s');
    assert.equal(state.phase, 'interrupted', '超时必须落到「已停止」，不能一直挂着：' + state.phase);
    assert.match(String(state.error), /[\u4e00-\u9fff]/, '超时原因必须是中文：' + state.error);
    assert.equal(state.evidence.length, 1, '既有依据不得被清掉');

    assertFallbackContract(await renderOverlayText(state), '超时');
  } finally { plugin.dispose(); restoreFetch(); }
});

test('F8 行为级: 降级层要如实体现在「历史记录与工具过程」上，不编造成功', async () => {
  const host = await startIndexHost(failingLlm(), CATALOG);
  const restoreFetch = pointFetchAt(host.routes);
  const client = await moduleFromSource('src/client/index.ts');
  const plugin = client.createClientPlugin({ session: { id: 's' } });
  try {
    plugin.open();
    // 等 open() 引发的刷新链真的完成，再继续（不用固定 sleep 赌它跑完）。
    await waitFor(() => plugin.registry.get('s').catalog, { label: '首屏应拉到模型目录' });
    await plugin.api.selectModel('s', { provider: 'p', model: 'm' });
    plugin.registry.update('s', { evidence: SELECTED });
    await plugin.submit('它在干什么');

    const state = plugin.registry.get('s');
    // §6.3/§11.7：失败的这次不得被说成成功；降级说明要如实讲「记录到几个步骤、其中几个失败」
    const text = await renderOverlayText({
      ...state,
      tools: [{ id: 't1', name: 'explain_read_session', status: 'ok' }, { id: 't2', name: 'explain_search_session', status: 'error' }],
    });
    assert.match(text, /2 个步骤/, '必须如实说明记录到几个步骤');
    assert.match(text, /1 个是失败的/, '必须如实指出有失败步骤，不得只报喜');
    assert.match(text, /历史问答记录仍然完整保留/, '必须告诉用户记录没丢');
    assertFallbackContract(text, '失败态降级');
  } finally { plugin.dispose(); restoreFetch(); host.restore(); }
});

/* ================================================================== *
 * 反例：正常完成时不得出现降级层（否则就是打扰用户）
 * ================================================================== */

test('F8 行为级 反例: 正常完成时不出现降级层', async () => {
  const host = await startIndexHost(fineLlm(), CATALOG);
  const restoreFetch = pointFetchAt(host.routes);
  const client = await moduleFromSource('src/client/index.ts');
  const plugin = client.createClientPlugin({ session: { id: 's' } });
  try {
    plugin.open();
    // 等 open() 引发的刷新链真的完成，再继续（不用固定 sleep 赌它跑完）。
    await waitFor(() => plugin.registry.get('s').catalog, { label: '首屏应拉到模型目录' });
    await plugin.api.selectModel('s', { provider: 'p', model: 'm' });
    plugin.registry.update('s', { evidence: SELECTED });
    await plugin.submit('它在干什么');

    const state = plugin.registry.get('s');
    assert.equal(state.phase, 'complete', '正常路径必须完成');
    const text = await renderOverlayText(state);
    assert.equal(/现在能告诉你的基本说明/.test(text), false, '正常完成时不得插入降级说明');
    assert.equal(/不是模型对你想问的问题给出的解释/.test(text), false, '正常完成时不得出现「这不是模型回答」的声明');
    assert.match(text, /模型的正常回答/, '正常回答必须照常显示');
  } finally { plugin.dispose(); restoreFetch(); host.restore(); }
});
