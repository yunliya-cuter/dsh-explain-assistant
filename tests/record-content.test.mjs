import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * §11.6「依据可展开核查」/ §6.3「依据分级」/ §8：**提问后落库的记录必须带可核查材料**。
 *
 * 修之前：`routes.ts` 调 `saveRecord` 时只写 9 个字段，**没有 evidence / tools / images**；
 * `llm.ts` 明明算出了 toolTrace，却在落库这一步被丢掉。后果是界面上「查看完整内容」
 * 点开也只有回答正文 —— 用户看不到「这条结论当时读了什么、跑了哪些工具」。
 * 实测当时落库目录下 15 个文件，带 tools/evidence 的为 **0**。
 *
 * 这组测试的写法刻意**从磁盘上读回落库文件**，而不是只看内存对象或只 grep 源码：
 * 这样「有人又把落库字段删了」会直接变红，而不是继续绿着骗人。
 */

const SESSION = 'session-record-content';

/** 起一个真宿主：注册 src/index.ts 的真实路由，并把落库目录暴露出来。 */
async function startHost(llm, sessionQuery = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ea-record-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let routes = new Map();
  try {
    const host = await moduleFromSource('src/index.ts');
    host.apply({
      llm, sessionQuery,
      connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
      effect: () => {},
      get: () => undefined,
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
  const call = async (url, init) => {
    const target = new URL(String(url), 'http://host');
    const handler = routes.get(target.pathname);
    if (!handler) return new Response('not found', { status: 404 });
    return handler(new Request(target.toString(), init));
  };
  const post = (p, body) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const sseText = async (p, body) => (await post(p, body)).text();
  const get = async p => (await call(p)).json();
  return {
    home,
    rootDir: join(home, 'explain-assistant'),
    get, post, sseText,
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

/** 直接从磁盘把该会话的落库文件读回来（绕开任何内存缓存）。 */
function readPersisted(rootDir, sessionId) {
  const file = join(rootDir, 'sessions', sessionId + '.json');
  assert.ok(existsSync(file), '落库文件必须存在：' + file);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 造一个会先调一次只读工具、再给出回答的模型。 */
function llmWithOneTool() {
  let round = 0;
  return {
    async *stream() {
      if (round++ === 0) yield { toolCalls: [{ name: 'explain_read_session', arguments: { seq: 1 } }] };
      else yield { type: 'text-delta', index: 0, text: '这是回答' };
    },
  };
}

const sessionQuery = {
  async readEvent() { return { events: [{ seq: 1, text: '主 agent 在做某件事' }] }; },
  async searchEvents() { return { hits: [] }; },
};

/** 先选模型（未选模型不会发请求，§7/§11.8），再提问并等落库。 */
async function askOnce(host, { evidence } = {}) {
  await host.post('/api/explain-assistant/select-model?sessionId=' + SESSION, {
    schemaVersion: 1, sessionId: SESSION, operation: 'select-model', payload: { model: { provider: 'p', model: 'm' } },
  });
  await host.sseText('/api/explain-assistant/ask', {
    schemaVersion: 1, sessionId: SESSION, operation: 'ask',
    payload: { question: '它在干什么', ...(evidence === undefined ? {} : { evidence }) },
  });
}

/* ================================================================== *
 * 1) 落库必须真的带 tools / evidence
 * ================================================================== */

test('提问后落库的记录里有 tools（至少 1 条），且形状合契约', async () => {
  const host = await startHost(llmWithOneTool(), sessionQuery);
  try {
    await askOnce(host);
    const state = readPersisted(host.rootDir, SESSION);
    const record = state.records[0];
    assert.ok(record, '必须落库一条记录');
    // 这一条就是「有人又把落库字段删了」时会变红的断言。
    assert.ok(Array.isArray(record.tools), '落库记录必须带 tools 数组（旧实现整个字段都没有）');
    assert.ok(record.tools.length >= 1, '提问跑过一次只读工具，落库必须至少有 1 条工具过程，实际：' + JSON.stringify(record.tools));
    const tool = record.tools[0];
    assert.equal(tool.tool, 'explain_read_session', '工具名必须如实记录');
    assert.ok(['ok', 'error'].includes(tool.status), '工具状态必须是真实结局：' + tool.status);
    assert.equal(typeof tool.startedAt, 'string', '必须有开始时间（ToolTrace 契约）');
  } finally { host.cleanup(); }
});

test('提问后落库的记录里有 evidence，且带 evidenceState 分级', async () => {
  const host = await startHost(llmWithOneTool(), sessionQuery);
  try {
    await askOnce(host);
    const record = readPersisted(host.rootDir, SESSION).records[0];
    assert.ok(Array.isArray(record.evidence), '落库记录必须带 evidence 数组（旧实现整个字段都没有）');
    assert.ok(record.evidence.length >= 1, '跑过工具就必须留下依据，实际：' + JSON.stringify(record.evidence));
    const item = record.evidence[0];
    // §6.3：不许一律写 observed
    assert.ok(['observed', 'reported_only', 'unavailable'].includes(item.evidenceState),
      'evidenceState 必须是三级之一，实际：' + item.evidenceState);
    assert.equal(typeof item.sessionId, 'string');
    assert.equal(typeof item.capturedAt, 'string');
    assert.equal(typeof item.truncated, 'boolean', '截断标志必须显式存在');
  } finally { host.cleanup(); }
});

test('用户选中的依据会落库，并沿用客户端的分级（不一律写 observed）', async () => {
  const host = await startHost(llmWithOneTool(), sessionQuery);
  try {
    // 客户端选中的是一段「主 agent 的汇报」→ 分级是 reported_only（§6.3：汇报不等于验证）
    await askOnce(host, { evidence: [{ id: 'node-1', title: '助手汇报', summary: '我准备改配置', evidenceState: 'reported_only', source: 'selected_frozen' }] });
    const record = readPersisted(host.rootDir, SESSION).records[0];
    const selected = record.evidence.find(item => item.title === '助手汇报');
    assert.ok(selected, '用户选中的依据必须落库，实际：' + JSON.stringify(record.evidence.map(e => e.title)));
    assert.equal(selected.evidenceState, 'reported_only', '必须沿用客户端判定，不得改写成 observed');
    assert.equal(selected.source, 'selected_frozen', '§5.2：选中即冻结');
  } finally { host.cleanup(); }
});

test('落库字段没被改坏：answerText / reasoningText / usage 形状照旧', async () => {
  const host = await startHost({ async *stream() { yield { type: 'text-delta', index: 0, text: '回答正文' }; yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } }; } }, sessionQuery);
  try {
    await askOnce(host);
    const record = readPersisted(host.rootDir, SESSION).records[0];
    assert.equal(record.answerText, '回答正文', 'answerText 形状必须保持（客户端与历史渲染都依赖它）');
    assert.equal(typeof record.reasoningText, 'string');
    assert.deepEqual(record.usage, { inputTokens: 5, outputTokens: 7 }, 'usage 必须原样保存');
    assert.equal(record.kind, 'ask');
    assert.equal(record.status, 'complete');
    assert.equal(typeof record.startedAt, 'string');
    assert.equal(typeof record.updatedAt, 'string');
  } finally { host.cleanup(); }
});

/* ================================================================== *
 * 2) 落库的东西必须能通过 history-result 读回来
 * ================================================================== */

test('history-result 能把落库的工具过程交出来（§11.6 端到端）', async () => {
  const host = await startHost(llmWithOneTool(), sessionQuery);
  try {
    await askOnce(host);
    const record = readPersisted(host.rootDir, SESSION).records[0];
    const payload = (await host.get('/api/explain-assistant/history-result?sessionId=' + SESSION + '&recordId=' + encodeURIComponent(record.id))).payload;
    assert.equal(payload.recordId, record.id);
    assert.ok(Array.isArray(payload.record.tools), '接口必须把 tools 交出来');
    assert.ok(payload.record.tools.length >= 1, '工具过程必须能读回，实际：' + JSON.stringify(payload.record.tools));
    assert.equal(payload.record.tools[0].tool, 'explain_read_session');
    assert.ok(payload.record.evidence.length >= 1, '依据必须能读回');
    assert.equal(payload.counts.tools, record.tools.length, 'counts 必须与落库条数一致');
    assert.equal(payload.counts.evidence, record.evidence.length);
  } finally { host.cleanup(); }
});

test('落库内容真的在磁盘上（不是只在内存里往返）', async () => {
  const host = await startHost(llmWithOneTool(), sessionQuery);
  try {
    await askOnce(host);
    const files = readdirSync(join(host.rootDir, 'sessions')).filter(name => name.endsWith('.json'));
    assert.ok(files.length >= 1, '必须真的写了落库文件');
    const raw = readFileSync(join(host.rootDir, 'sessions', SESSION + '.json'), 'utf8');
    assert.match(raw, /"tools"/, '落库文件正文里必须有 tools 字段（旧实现整个字段都不存在）');
    assert.match(raw, /"evidence"/, '落库文件正文里必须有 evidence 字段');
    assert.match(raw, /explain_read_session/, '工具名必须真的写进磁盘');
  } finally { host.cleanup(); }
});

/* ================================================================== *
 * 3) 大小上限：截断要留痕，不许悄悄丢
 * ================================================================== */

test('内容过大时按上限截断，并留下 truncated 痕迹（不静默丢）', async () => {
  const record = await moduleFromSource('src/host/record.ts');
  // 造 500 条依据（超过 RECORD_MAX_EVIDENCE = 200）
  const many = Array.from({ length: 500 }, (_, i) => ({
    schemaVersion: 1, sessionId: 's', kind: 'tool', title: '依据' + i, summary: '第' + i + '条',
    source: 'session_snapshot', evidenceState: 'observed', capturedAt: '2026-01-01T00:00:00.000Z',
    truncated: false, incomplete: false,
  }));
  const built = record.buildRecordContent({ sessionId: 's', toolTrace: [{ tool: 'explain_read_session', status: 'ok', result: { ok: true, value: many }, startedAt: '2026-01-01T00:00:00.000Z' }] });
  assert.ok(built.evidence.length <= record.RECORD_MAX_EVIDENCE, '条数必须被上限约束，实际 ' + built.evidence.length);
  assert.ok(built.evidence.length >= 1, '不能全丢光');
  const last = built.evidence[built.evidence.length - 1];
  assert.equal(last.truncated, true, '被截断时必须留痕：最后一条要标 truncated');
  assert.equal(last.incomplete, true, '截断意味着不完整，必须标 incomplete');
  assert.ok(last.metadata && typeof last.metadata.droppedByLimit === 'number', '必须记录丢了多少条：' + JSON.stringify(last.metadata));
  assert.ok(last.metadata.droppedByLimit > 0, '丢弃条数必须为正');
});

test('单条工具结果过大时也截断并标 truncated', async () => {
  const record = await moduleFromSource('src/host/record.ts');
  const huge = 'x'.repeat(200_000);
  const built = record.buildRecordContent({ sessionId: 's', toolTrace: [{ tool: 'explain_read_workspace_file', status: 'ok', result: { ok: true, value: huge }, startedAt: '2026-01-01T00:00:00.000Z' }] });
  assert.equal(built.tools.length, 1);
  assert.equal(built.tools[0].truncated, true, '超上限的工具结果必须标 truncated');
  assert.ok(String(built.tools[0].result).length < huge.length, '内容必须真的被截短');
});

test('组装永不抛异常：垃圾输入回合法的空形状', async () => {
  const record = await moduleFromSource('src/host/record.ts');
  for (const bad of [null, undefined, 123, 'string', { nope: true }]) {
    const built = record.buildRecordContent({ sessionId: 's', selectedEvidence: bad, toolTrace: bad });
    assert.deepEqual(built, { evidence: [], tools: [], images: [] }, '非法输入必须回空数组而不是抛错：' + JSON.stringify(bad));
  }
});

/* ================================================================== *
 * 4) 分级判据与客户端保持一致（避免同一件事两侧两个级别）
 * ================================================================== */

test('工具结局决定 evidenceState，且与客户端 selection.ts 用同一条判据', async () => {
  const record = await moduleFromSource('src/host/record.ts');
  assert.equal(record.evidenceStateForToolStatus('ok'), 'observed', '工具成功 = 记录已证实');
  assert.equal(record.evidenceStateForToolStatus('error'), 'observed', '工具失败也是已证实（证实的是这次失败）');
  assert.equal(record.evidenceStateForToolStatus('running'), 'unavailable', '还没定论 = 无从得知');
  // 与客户端源码的判据对照
  const source = readFileSync(new URL('../src/client/selection.ts', import.meta.url), 'utf8');
  assert.match(source, /state === 'done' \|\| state === 'ok' \|\| state === 'failed' \|\| state === 'error'/, '客户端判据不得被改窄');
});

test('认不出的 evidenceState 退成 unavailable，绝不默认 observed', async () => {
  const record = await moduleFromSource('src/host/record.ts');
  for (const bad of [undefined, null, 'made-up', 42, {}]) {
    assert.equal(record.normalizeEvidenceState(bad), 'unavailable', '认不出时必须退回「无从得知」：' + JSON.stringify(bad));
  }
  assert.equal(record.normalizeEvidenceState('reported_only'), 'reported_only', '合法分级必须原样保留');
});
