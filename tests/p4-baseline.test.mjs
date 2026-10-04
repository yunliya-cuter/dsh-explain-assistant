import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { moduleFromSource, fakeDom, FakeElement } from './fixtures/runtime.mjs';

/**
 * P4 条目（F2/F3/F4/F6/F8/F10）的测试。
 *
 * 本文件最初是 task-5 交付的「基线建档」：锁定**当时**的真实行为，缺口在时全绿，
 * 修好后应变红提醒同步改断言。F2 与 F3 已修复，相关断言已同步更新为**期望行为**；
 * 仍标「（当前行为）」的是尚未开工的条目（F3 的工具循环形状、F4、F6、F8）。
 * 每条测试名/注释都标了编号，便于按编号定位落点。
 *
 * 全部断言都走真实代码路径：要么通过 tests/fixtures/runtime.mjs 的 moduleFromSource()
 * 加载 src/*.ts，要么调用插件真实的 apply() 注册路由后用真实 Request 打进去。
 * 不修改 src/、package.json 与任何既有测试文件。
 */

const index = await moduleFromSource('src/index.ts');
const persistence = await moduleFromSource('src/host/persistence.ts');
const overlay = await moduleFromSource('src/client/overlay.tsx');
const prompts = await moduleFromSource('src/host/prompts.ts');
const llm = await moduleFromSource('src/host/llm.ts');
const selectionModule = await moduleFromSource('src/client/selection.ts');

const readSource = (relative) => readFile(new URL('../' + relative, import.meta.url), 'utf8');

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

/** 起一个真实的宿主上下文：注册插件路由，返回可直接打的 fetch 入口。 */
async function startHost({ models = [{ id: 'model-1', name: 'Model 1' }] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ea-p4-baseline-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let routes;
  try {
    routes = new Map();
    const ctx = {
      connection: { fetch: { register(entry) { routes.set(entry.path, entry.fetch); } } },
      llm: { listProviders: async () => ['provider-a'], listModels: async () => models },
      effect: () => {},
      get: () => undefined,
    };
    index.apply(ctx);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
  const rootDir = join(home, 'explain-assistant');
  return {
    home,
    rootDir,
    /** 用真实 Request 打插件注册的路由（查询串不参与路由键匹配）。 */
    call(path, init) {
      const handler = routes.get(path.split('?')[0]);
      assert.ok(handler, '路由未注册：' + path);
      return handler(new Request('http://localhost' + path, init));
    },
    store: () => new persistence.JsonSessionStore({ rootDir }),
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

/** 往某个会话的持久化记录里塞一条真实记录（走 store.update，不是手写 JSON）。 */
async function seedRecord(host, sessionId, question = '问题') {
  const store = host.store();
  await store.update(sessionId, (state) => {
    state.records.push({ id: sessionId + '-r1', kind: 'ask', status: 'complete', complete: true, question, answerText: '回答', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  });
  await store.close();
}

async function jsonBody(response) {
  assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true, '期望 JSON 响应');
  return response.json();
}

/* =====================================================================
 * F2（§5.1 / §8）：「更早历史」目前没有任何读取能力
 * 现状：service 的 hasEarlier 两处硬编码 false；loadHistoryResult 在 service 层无实现。
 * ===================================================================== */

test('F2: 记录不足一页时 state 不下发 hasEarlier（不出现翻页按钮）', async () => {
  const host = await startHost();
  try {
    await seedRecord(host, SESSION_A);
    const body = await jsonBody(await host.call('/api/explain-assistant/state?sessionId=' + SESSION_A));
    assert.equal(body.payload.records.length, 1, '记录确实存在');
    // F2 已修复（0.1.29 起）：hasEarlier 由「是否还有更早的一页」决定，
    // 只有 1 条记录时确实没有更早历史，所以这里是正确行为，不再是缺陷。
    assert.equal(body.payload.hasEarlier, false, '只有一条记录时不该出现翻页入口');
  } finally { host.cleanup(); }
});

test('F2: history 路由在记录不足一页时返回全部且不下发 hasEarlier', async () => {
  const host = await startHost();
  try {
    await seedRecord(host, SESSION_A);
    const body = await jsonBody(await host.call('/api/explain-assistant/history?sessionId=' + SESSION_A));
    assert.equal(body.payload.records.length, 1);
    assert.equal(body.payload.hasEarlier, false, '不足一页时没有更早历史');
  } finally { host.cleanup(); }
});

test('F2(已修复): history-result 返回该记录的完整内容，且跨会话取不到', async () => {
  const host = await startHost();
  try {
    await seedRecord(host, SESSION_A);
    const body = await jsonBody(await host.call('/api/explain-assistant/history-result?sessionId=' + SESSION_A + '&recordId=' + SESSION_A + '-r1'));
    // 翻面后的期望行为：不再是空对象，而是这条记录的完整内容。
    assert.notDeepEqual(body.payload, {}, 'payload 不得再恒为空对象（旧缺陷就是这个）');
    assert.equal(body.payload.sessionId, SESSION_A, '返回体必须自报属于哪个会话，供客户端对账');
    assert.equal(body.payload.recordId, SESSION_A + '-r1', '返回体必须自报就是这条记录');
    assert.ok(body.payload.record, '必须带回记录本体');
    assert.equal(body.payload.record.answerText, '回答', '必须带回落库的真实内容');
    const source = await readSource('src/index.ts');
    assert.match(source, /loadHistoryResult: async/, 'service 里必须真的有 loadHistoryResult 实现');
    // 防回退（§8 会话隔离）：用另一个会话的 sessionId 去要这条记录，必须拿不到内容。
    // 静默串会话等于把别人的记录漏出去，所以这条断言比「函数存在」更重要。
    const cross = await host.call('/api/explain-assistant/history-result?sessionId=' + SESSION_B + '&recordId=' + SESSION_A + '-r1');
    assert.equal(cross.status, 404, '跨会话取别人的记录必须被拒（旧行为是回空对象，看不出来）');
    const crossBody = await jsonBody(cross);
    assert.equal(crossBody.error.code, 'RECORD_NOT_FOUND', '必须给明确的中文错误码，不是空对象');
    assert.match(crossBody.error.message, /[\u4e00-\u9fff]/, '拒绝原因必须是中文');
  } finally { host.cleanup(); }
});

test('F2: 浮窗的「查看更早历史」按钮由 hasEarlier 把关（false 不渲染、true 渲染）', async () => {
  const base = {
    sessionId: 's', open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
    tools: [], records: [], loadingEarlier: false, evidence: [],
    occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: true,
  };
  const plugin = { registry: { update() {}, get: () => base }, api: {}, cancel() {}, submit() {}, loadEarlier() {} };
  const dom = fakeDom();
  try {
    const hidden = overlay.renderOverlay({ ...base, hasEarlier: false }, plugin);
    assert.equal(/查看更早历史/.test(hidden.textContent || ''), false, 'hasEarlier=false 时不得出现该按钮');
    const shown = overlay.renderOverlay({ ...base, hasEarlier: true }, plugin);
    assert.match(shown.textContent || '', /查看更早历史/, 'hasEarlier=true 时按钮存在（说明门闸就是这一个布尔值）');
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.restore();
  }
});

/* =====================================================================
 * F3（§7 / §11.6）：只读工具循环已定义但从未被调用；role=tool 消息形状不符契约
 * 现状：runAssistant 自己内联了工具循环，导出的 executeToolLoop 无人引用；
 *       压进 history 的 tool 消息只有 { role, content }，没有 toolCallId/source，
 *       content 也不是 dsh-llm 要求的 ContentBlock[]。
 * ===================================================================== */

test('F3: 导出的 executeToolLoop 在 src/ 里没有任何调用方（死代码，当前行为）', async () => {
  const tools = await moduleFromSource('src/host/tools.ts');
  assert.equal(typeof tools.executeToolLoop, 'function', '函数确实已定义');
  // 真实行为：它能在工具层跑通……
  const loop = await tools.executeToolLoop({ sessionId: SESSION_A, modelContext: { available: true } }, [{ name: 'explain_get_model_context', arguments: {} }]);
  assert.equal(loop.results.length, 1);
  assert.equal(loop.results[0].result.ok, true);
  // ……但 src/ 里除定义处外没有任何引用，问答主路径走的是 llm.ts 的内联循环。
  const files = ['src/index.ts', 'src/host/llm.ts', 'src/host/routes.ts', 'src/host/tools.ts'];
  const referencing = [];
  for (const file of files) {
    const source = await readSource(file);
    const hits = source.split('\n').filter(line => line.includes('executeToolLoop')).length;
    if (hits) referencing.push(file + ':' + hits);
  }
  // 钉住当前行为：只有 tools.ts 的定义那一处。修复后（主路径改用它）这里必须更新。
  assert.deepEqual(referencing, ['src/host/tools.ts:1']);
});

test('F3(已修复): 工具循环在 llm.ts 内，压入 history 的是 dsh-llm 契约形状', async () => {
  const source = await readSource('src/host/llm.ts');
  assert.match(source, /executeTool\(/, 'llm.ts 直接调用 executeTool');
  assert.match(source, /role:'assistant'/, '必须压入配对的 assistant 工具调用消息');
  assert.match(source, /toolCallId/, '工具结果必须带 toolCallId');
  assert.match(source, /source:\{kind:'tool'/, '工具结果必须带 source');
});

test('F3: role=tool 的消息形状不符合 dsh-llm 契约（当前行为）', async () => {
  const seen = [];
  const ctx = {
    model: { provider: 'p', model: 'm' },
    tools: { sessionId: SESSION_A, modelContext: { available: true, provider: 'p' } },
    llm: {
      async *stream(options) {
        seen.push(options.messages);
        if (seen.length === 1) yield { toolCalls: [{ name: 'explain_get_model_context', arguments: {} }] };
        else yield { text: '完成' };
      },
    },
  };
  const result = await llm.runAssistant(ctx, [{ role: 'user', content: [{ type: 'text', text: '问题' }] }]);
  assert.equal(result.complete, true);
  assert.equal(seen.length, 2, '第一轮拿到工具调用，第二轮才产出文本');

  const history = seen[1];
  const toolMessage = history.find(message => message.role === 'tool');
  assert.ok(toolMessage, '第二轮历史里确实带了工具结果');

  // 已修复：符合 dsh-llm 的 ToolResultMessage 契约
  // （@deepseek-ai/dsh-llm/lib/types/message.d.ts:152-160）
  // 要求 id / content: ContentBlock[] / source / toolCallId，并要有配对的 assistant 工具调用消息。
  assert.deepEqual(Object.keys(toolMessage).sort(), ['content', 'id', 'isError', 'role', 'source', 'toolCallId']);
  assert.equal(Array.isArray(toolMessage.content), true, 'content 必须是 ContentBlock[]');
  for (const block of toolMessage.content) {
    assert.equal(block.type, 'text', '工具结果以文本块回传');
    assert.equal(typeof block.text, 'string');
  }
  assert.equal(typeof toolMessage.toolCallId, 'string', '必须带 toolCallId');
  assert.deepEqual(toolMessage.source, { kind: 'tool', callId: toolMessage.toolCallId });
  // 模型必须能看到自己那次工具调用，上下文才闭合（适配器会校验 tool_use_id 配对）
  const assistantCall = history.filter(m => m.role === 'assistant').flatMap(m => m.content || []).find(b => b.type === 'tool-call');
  assert.ok(assistantCall, 'history 里必须有配对的 assistant tool-call 块');
  assert.equal(assistantCall.id, toolMessage.toolCallId, '两边的 callId 必须一致');
  assert.equal(typeof assistantCall.arguments, 'string', 'arguments 必须是原始 JSON 字符串（适配器要求）');
  assert.equal(history.some(m => m.role === 'assistant' && m.source?.kind === 'model'), true, 'assistant 必须带 source');
  // callId 现在确实随工具结果回传
  assert.ok(result.toolTrace[0].callId, 'trace 里有 callId');
  assert.equal(JSON.stringify(history).includes(String(result.toolTrace[0].callId)), true, 'callId 必须随工具结果回传');
  assert.equal(result.complete, true, '工具循环跑完应当 complete');
});

/* =====================================================================
 * F4（§6.3 / §11.7）：证据分级被硬编码成 observed
 * 现状：selection.evidenceFromElement 恒产出 evidenceState:'observed'；
 *       reported_only 全库只有类型定义与消费分支，没有任何产生路径。
 * ===================================================================== */

test('F4(已修复): 依据按卡片真实状态分级为 observed / reported_only / unavailable', () => {
  const makeCard = (attrs, text) => {
    const el = new FakeElement('div');
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    el.textContent = text;
    return el;
  };
  const cases = [
    ['已完成的工具卡片', { 'data-tool': 'read_file', 'data-state': 'done' }, '文件内容', 'observed'],
    ['失败的工具卡片', { 'data-tool': 'read_file', 'data-state': 'failed' }, '报错原文', 'observed'],
    ['仍在运行的工具卡片', { 'data-tool': 'read_file', 'data-state': 'ongoing' }, '还没结束', 'unavailable'],
    ['助手汇报卡片（主 agent 说的话）', { 'data-chat-node-key': 'node-1', 'data-chat-flow-kind': 'assistant-step' }, '我准备改配置', 'reported_only'],
    ['没有正文的卡片', { 'data-chat-node-key': 'node-2' }, '', 'unavailable'],
  ];
  for (const [label, attrs, text, expected] of cases) {
    const item = selectionModule.evidenceFromElement(makeCard(attrs, text), SESSION_A);
    assert.equal(item.evidenceState, expected, label + ' 应分级为 ' + expected + '，实际 ' + item.evidenceState);
  }
  const running = selectionModule.evidenceFromElement(makeCard({ 'data-tool': 't', 'data-state': 'running' }, 'x'), SESSION_A);
  assert.equal(running.incomplete, true, '运行中的卡片同时要标 incomplete');
  // 三级分级必须真的覆盖到三种取值，而不是只有一级。
  const tiers = new Set(cases.map(([, attrs, text]) => selectionModule.evidenceFromElement(makeCard(attrs, text), SESSION_A).evidenceState));
  assert.deepEqual([...tiers].sort(), ['observed', 'reported_only', 'unavailable'], '三级必须都产得出来');
});

test('F4(已修复): reported_only 现在有真实产生路径，消费端与生产端对得上', async () => {
  // 消费分支是真的、可用：
  assert.equal(prompts.evidenceTier({ evidenceState: 'reported_only' }), '仅据汇报');
  assert.equal(prompts.evidenceTier({ evidenceState: 'observed' }), '已观察到');
  assert.equal(prompts.evidenceTier({ evidenceState: 'unavailable' }), '无从得知');
  // 但没有任何代码把它写出来：所有 evidenceState 赋值点都是字面量 'observed'。
  const files = ['src/client/selection.ts', 'src/host/evidence.ts', 'src/host/prompts.ts', 'src/host/contracts.ts'];
  const producers = [];
  for (const file of files) {
    const source = await readSource(file);
    source.split('\n').forEach((line, i) => {
      if (/reported_only/.test(line) && !/export type EvidenceState|evidenceState === 'reported_only'/.test(line)) {
        producers.push(file + ':' + (i + 1));
      }
    });
  }
  assert.ok(producers.length > 0, 'reported_only 必须有产生路径，实际：' + JSON.stringify(producers));
  // selection.ts 里必须有真实的分级函数，而不是字面量。
  const selection = await readSource('src/client/selection.ts');
  assert.match(selection, /classifyEvidence/, '必须有分级判定函数');
  assert.match(selection, /'reported_only'/, '必须能产出 reported_only');
  assert.match(selection, /'unavailable'/, '必须能产出 unavailable');
  assert.equal(/evidenceState: 'observed', sessionId/.test(selection), false, '不得再硬编码 observed');
});

/* =====================================================================
 * F6（§4 / §8）：归档只被「读」，没有置位路径；retryPendingDeletes 从未被调用
 * ===================================================================== */

test('F6(已修复): 归档现在有置位路径（forget 会置 archived 并清空记录）', async () => {
  const source = await readSource('src/index.ts');
  // 本断言已按真实行为放宽（原先是钉住**逐字实现文本**）：
  // forget 现在会**删除**文件（规范 §8），删掉之后 store.load 会返回全新空状态（archived=false），
  // 所以 isArchived 还需要认得一个「已归档」的内存标记，才能挡住晚到写入把文件重建出来。
  // 但「归档状态最终仍源自落库的 archived 字段」这个不变量没变，这里继续钉住它。
  assert.match(source, /isArchived: async \(id: string\) =>[^\n]*state\.archived\)/, '归档状态仍必须从落库的 archived 字段读出');
  assert.match(source, /forgotten\.has\(id\)/, '删除文件后必须靠内存标记继续认得「已归档」（否则晚到写入会重建文件）');
  // 全库找写入点：除了 createEmptyState 的初始 false，没有任何地方把它置 true。
  const files = ['src/index.ts', 'src/host/persistence.ts', 'src/host/contracts.ts', 'src/host/routes.ts'];
  const writers = [];
  for (const file of files) {
    const text = await readSource(file);
    text.split('\n').forEach((line, i) => {
      if (/\.archived\s*=\s*(true|false)/.test(line) || /setArchived|archiveSession|onArchive/.test(line)) writers.push(file + ':' + (i + 1) + ' ' + line.trim().slice(0, 80));
    });
  }
  assert.ok(writers.length > 0, '必须出现归档置位路径，实际空');
  assert.match(source, /forget:/, '必须提供归档后的清理入口');
  assert.match(source, /state\.archived = true/, '归档时必须真的置位');
  // 新行为：必须真的调用 store.remove（规范 §8 要求删除，不是只清空）
  assert.match(source, /await store\.remove\(id\)/, '归档必须真的删除本插件 JSON（不能只清空）');
});

test('F6(已修复): 启动清理已接上，读侧归档拒绝仍然生效', async () => {
  const source = await readSource('src/index.ts');
  assert.match(source, /retryPendingDeletes/, '启动清理必须被调用');
  assert.match(source, /cleanupArchived/, '必须有统一的清理入口');
  // 启动清理必须容错：清理失败不能让插件启动失败。
  assert.match(source, /清理失败绝不能让插件启动失败|catch \(error\)/, '清理失败必须被吞掉，不能拖垮启动');
  // 读侧确实在工作：手工把 archived 置 true 后，路由会拒绝读取。
  const host = await startHost();
  try {
    const store = host.store();
    await store.update(SESSION_A, (state) => { state.archived = true; });
    await store.close();
    const response = await host.call('/api/explain-assistant/state?sessionId=' + SESSION_A);
    assert.equal(response.status, 409);
    const body = await jsonBody(response);
    assert.equal(body.error.code, 'SESSION_ARCHIVED');
    assert.equal(body.error.message, '当前主对话已归档，小助手不能再读取它。');
  } finally { host.cleanup(); }
});

test('F6(已修复): retryPendingDeletes 现在有真实调用方', async () => {
  const store = new persistence.JsonSessionStore({ rootDir: mkdtempSync(join(tmpdir(), 'ea-p4-f6-')) });
  try {
    assert.equal(typeof store.retryPendingDeletes, 'function', '函数确实已定义');
    // 真实行为：没有失败删除时它什么也不做，返回 {attempted:0, failed:0}。
    assert.deepEqual(await store.retryPendingDeletes(), { attempted: 0, failed: 0 });
    assert.deepEqual(store.pendingDeleteIds(), []);
  } finally { await store.close(); }
  const files = ['src/index.ts', 'src/host/routes.ts', 'src/host/persistence.ts'];
  const callers = [];
  for (const file of files) {
    const text = await readSource(file);
    text.split('\n').forEach((line, i) => {
      if (line.includes('retryPendingDeletes') && !line.trim().startsWith('async retryPendingDeletes')) callers.push(file + ':' + (i + 1));
    });
  }
  assert.ok(callers.length > 0, '必须有调用方，实际空：' + JSON.stringify(callers));
});

/* =====================================================================
 * F8（§7 / §10）：未选模型时 resolveModel 直接抛错，没有「基本说明」降级层
 * ===================================================================== */

/** 打一次真实的 ask 流式请求，把 SSE 帧解析成 {type, payload} 列表。 */
async function askEvents(host, question = '这一步在做什么') {
  const response = await host.call('/api/explain-assistant/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, sessionId: SESSION_A, operation: 'ask', payload: { question } }),
  });
  const text = await response.text();
  const events = [];
  for (const frame of text.split('\n\n')) {
    const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    const parsed = JSON.parse(dataLine.slice(6));
    events.push({ type: parsed.type, payload: parsed.payload });
  }
  return { response, events };
}

test('F8: 目录非空但未选模型时，ask 以 MODEL_UNAVAILABLE 失败，而不是降级回答（当前行为）', async () => {
  const host = await startHost();
  try {
    const { response, events } = await askEvents(host);
    assert.equal(response.status, 200, 'SSE 通道本身是 200');
    const error = events.find(event => event.type === 'error');
    assert.ok(error, '必须给出 error 事件，而不是静默结束');
    assert.equal(error.payload.code, 'MODEL_UNAVAILABLE');
    assert.equal(error.payload.message, '请先为解释小助手选择一个模型，然后再提问。小助手不会自动替你使用默认模型。');
    // 钉住当前行为：没有任何降级文本产出，也不存在「基本说明」层。
    assert.equal(events.some(event => event.type === 'text' || event.type === 'complete'), false, '当前不会给出任何降级内容');
  } finally { host.cleanup(); }
});

test('F8: 目录为空时同样直接失败（MODEL_NOT_FOUND），不是降级（当前行为）', async () => {
  const host = await startHost({ models: [] });
  try {
    const { events } = await askEvents(host);
    const error = events.find(event => event.type === 'error');
    assert.ok(error, '必须给出 error 事件');
    assert.equal(error.payload.code, 'MODEL_NOT_FOUND');
    assert.equal(error.payload.message, '当前没有可用的模型，无法为解释小助手生成回答。请检查模型配置后再试。');
  } finally { host.cleanup(); }
});

test('F8: 源码里 resolveModel 是抛错路径，没有返回占位模型或降级分支（当前行为）', async () => {
  const source = await readSource('src/index.ts');
  assert.match(source, /throw new ExplainAssistantError\(resolved\.kind === 'required' \? 'MODEL_UNAVAILABLE' : 'MODEL_NOT_FOUND', resolved\.message\)/, '未选/不可用时必须抛错');
  assert.equal(/provider: 'default'/.test(source), false, 'service 层不得提供 default 占位模型（修复后若要降级，本断言要改）');
  // 降级层不存在：全文没有「基本说明 / 降级」相关的产出路径。
  assert.equal(/基本说明|fallbackAnswer|degradedAnswer/.test(source), false, '「基本说明」降级层尚未实现（修复后这里应出现）');
});

/* =====================================================================
 * F10（§8）：两个真实会话的问答记录必须互不可见
 * ===================================================================== */

test('F10: 两个真实会话各自读回自己的记录，互不可见', async () => {
  const host = await startHost();
  try {
    await seedRecord(host, SESSION_A, 'A 的问题');
    await seedRecord(host, SESSION_B, 'B 的问题');

    const a = await jsonBody(await host.call('/api/explain-assistant/state?sessionId=' + SESSION_A));
    const b = await jsonBody(await host.call('/api/explain-assistant/state?sessionId=' + SESSION_B));
    assert.equal(a.payload.records.length, 1);
    assert.equal(b.payload.records.length, 1);
    assert.equal(a.payload.records[0].question, 'A 的问题');
    assert.equal(b.payload.records[0].question, 'B 的问题');
    assert.equal(JSON.stringify(a.payload.records).includes('B 的问题'), false, 'A 的读回里不得出现 B 的内容');
    assert.equal(JSON.stringify(b.payload.records).includes('A 的问题'), false, 'B 的读回里不得出现 A 的内容');
    assert.equal(a.payload.sessionId, SESSION_A);
    assert.equal(b.payload.sessionId, SESSION_B);
  } finally { host.cleanup(); }
});

test('F10: 把 A 的记录文件冒充成 B 时被拒读并隔离，内容不外泄（当前行为）', async () => {
  const host = await startHost();
  try {
    await seedRecord(host, SESSION_A, 'A 的秘密内容');
    const store = host.store();
    const { readFile: readFileRaw, writeFile: writeFileRaw } = await import('node:fs/promises');
    const aRaw = await readFileRaw(store.pathFor(SESSION_A), 'utf8');
    // 原样把 A 的落库内容写到 B 的路径上（模拟串号 / 人为复制）。
    await writeFileRaw(store.pathFor(SESSION_B), aRaw, 'utf8');

    const loaded = await store.load(SESSION_B);
    // 钉住当前行为：assertState 校验 sessionId，不符就隔离成空状态，而不是把 A 的记录当成 B 的。
    assert.equal(loaded.created, true);
    assert.ok(loaded.recoveredCorrupt, '必须走隔离路径');
    assert.deepEqual(loaded.state.records, [], '绝不把另一个会话的记录当自己的读出来');
    assert.equal(loaded.state.sessionId, SESSION_B);
    await store.close();
  } finally { host.cleanup(); }
});

test('F10: 会话标识经 safeSessionId 归一，路径穿越无法读到别的会话文件', async () => {
  const store = new persistence.JsonSessionStore({ rootDir: mkdtempSync(join(tmpdir(), 'ea-p4-f10-')) });
  try {
    assert.match(store.pathFor(SESSION_A), /[/\\]sessions[/\\]session-a\.json$/);
    for (const bad of ['../other', 'a/b', '', '中文会话', '.hidden']) {
      assert.throws(() => store.pathFor(bad), /会话标识无效/);
    }
  } finally { await store.close(); }
});