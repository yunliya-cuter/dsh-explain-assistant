import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource } from './fixtures/runtime.mjs';

const llm = await moduleFromSource('src/host/llm.ts');
const routesModule = await moduleFromSource('src/host/routes.ts');

const cjk = (t) => (t.match(/[\u4e00-\u9fff]/g) || []).length;
const textOf = (content) => Array.isArray(content) ? content.map(b => b.text || '').join('') : String(content);

function captureLlm() {
  const seen = [];
  return {
    seen,
    stream(options) {
      seen.push(options.messages);
      const chunks = [{ type: 'text-delta', text: '压缩后的中文摘要' }, { type: 'finish', done: true }];
      return (async function* () { for (const c of chunks) yield c; })();
    },
  };
}

test('压缩指令是中文，且要求保留限制性标注', async () => {
  assert.ok(cjk(llm.COMPACT_INSTRUCTION) / llm.COMPACT_INSTRUCTION.length > 0.5, '压缩指令主体必须是中文');
  assert.match(llm.COMPACT_INSTRUCTION, /该步未提供足够信息/, '必须要求保留固定的信息不足标注');
  assert.match(llm.COMPACT_INSTRUCTION, /依据|分级/, '必须要求保留依据分级');
  assert.match(llm.COMPACT_INSTRUCTION, /白话/, '必须要求白话中文');
});

test('压缩请求发给模型的消息 content 是内容块数组，不是裸字符串', async () => {
  const llmStub = captureLlm();
  const result = await llm.compactAssistant({ llm: llmStub, model: { provider: 'p', model: 'm' } }, [{ role: 'system', content: [{ type: 'text', text: '系统' }] }]);
  assert.equal(result.complete, true);
  const last = llmStub.seen[0][llmStub.seen[0].length - 1];
  assert.ok(Array.isArray(last.content), '压缩指令的 content 必须是数组，否则适配器 flatMap 会抛错');
  assert.equal(last.content[0].type, 'text');
  assert.ok(cjk(textOf(last.content)) > 20, '压缩指令必须是中文');
});

function serviceFixture(overrides) {
  return Object.assign({
    loadState: async () => ({}),
    toolContext: async () => ({}),
    isSessionAllowed: async () => true,
    isArchived: async () => false,
    buildMessages: async () => [{ role: 'system', content: [{ type: 'text', text: '系统' }] }],
    resolveModel: async () => ({ selection: { provider: 'p', model: 'm' } }),
    saveRecord: async () => {},
    markUnread: async () => {},
  }, overrides || {});
}

function sseRequest(operation, payload) {
  return new Request('http://local/api/explain-assistant/' + operation, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, sessionId: 'session-a', operation, payload: payload || {} }),
  });
}

async function readSse(response) {
  const text = await response.text();
  return text.split('\n\n').filter(Boolean).map(block => {
    const type = (block.match(/^event: (.+)$/m) || [])[1];
    const data = (block.match(/^data: (.+)$/m) || [])[1];
    return { type, data: data ? JSON.parse(data) : undefined };
  });
}

test('压缩成功时 saveCompact 被调用，且落的是模型产出的摘要', async () => {
  const calls = [];
  const routes = routesModule.createExplainAssistantRoutes({
    service: serviceFixture({
      llm: captureLlm(),
      saveCompact: async (id, compact) => calls.push({ id, compact }),
    }),
  });
  const response = await routes.get('/explain-assistant/compact')(sseRequest('compact'));
  const events = await readSse(response);
  assert.ok(events.some(e => e.type === 'complete'), 'SSE 必须以 complete 结束');
  assert.equal(calls.length, 1, '成功压缩必须落库一次');
  assert.equal(calls[0].id, 'session-a');
  assert.ok(calls[0].compact.summary.includes('压缩后的中文摘要'), '落库的必须是模型产出的摘要');
});

test('反例：压缩未跑完时绝不调用 saveCompact，保留此前可用的压缩状态', async () => {
  const calls = [];
  const failing = { stream: () => (async function* () { throw new Error('模型炸了'); })() };
  const routes = routesModule.createExplainAssistantRoutes({
    service: serviceFixture({ llm: failing, saveCompact: async (...args) => calls.push(args) }),
  });
  const response = await routes.get('/explain-assistant/compact')(sseRequest('compact'));
  await readSse(response);
  assert.equal(calls.length, 0, '压缩失败时不得覆盖已有 compactState');
});

test('反例：saveCompact 未实现时压缩仍能正常结束，不抛未处理拒绝', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const routes = routesModule.createExplainAssistantRoutes({ service: serviceFixture({ llm: captureLlm() }) });
    const response = await routes.get('/explain-assistant/compact')(sseRequest('compact'));
    const events = await readSse(response);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(events.some(e => e.type === 'complete' || e.type === 'error'), '必须有终态事件');
    assert.equal(rejections.length, 0, '不得派生未处理拒绝');
  } finally { process.off('unhandledRejection', onRejection); }
});
