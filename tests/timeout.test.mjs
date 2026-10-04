import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleFromSource } from './fixtures/runtime.mjs';

const llm = await moduleFromSource('src/host/llm.ts');
const routesModule = await moduleFromSource('src/host/routes.ts');

const neverEnding = () => ({
  // 连上了但永远不吐字：模拟「模型挂住」
  stream: () => (async function* () { await new Promise(() => {}); })(),
});

const slow = (ms, text) => ({
  stream: () => (async function* () {
    await new Promise(r => setTimeout(r, ms));
    yield { type: 'text-delta', text };
    yield { type: 'finish', done: true };
  })(),
});

/* ---------------- §10 / §11.9 F7：不得无限等待 ---------------- */

test('F7: 源码里确实有超时机制（旧实现全程没有 setTimeout）', async () => {
  const source = await readFile(new URL('../src/host/llm.ts', import.meta.url), 'utf8');
  assert.match(source, /totalTimeoutMs/, '必须有总超时');
  assert.match(source, /idleTimeoutMs/, '必须有空闲超时');
  assert.match(source, /setTimeout/, '必须有实际计时器');
});

test('F7 真实运行: 模型永不返回时，总超时到点返回 complete=false + timeout=true', async () => {
  const started = Date.now();
  const result = await llm.runAssistant(
    { llm: neverEnding(), model: { provider: 'p', model: 'm' }, totalTimeoutMs: 120, idleTimeoutMs: 10_000 },
    [{ role: 'user', content: [{ type: 'text', text: '问' }] }],
  );
  const elapsed = Date.now() - started;
  assert.equal(result.complete, false, '必须停下，不能无限等');
  assert.equal(result.timeout, true, '必须标记为超时');
  assert.ok(elapsed < 3000, '必须在超时窗口附近就返回，实际 ' + elapsed + 'ms');
});

test('F7 真实运行: 连上但一直不吐字时，空闲超时先触发', async () => {
  const started = Date.now();
  const result = await llm.runAssistant(
    { llm: neverEnding(), model: { provider: 'p', model: 'm' }, totalTimeoutMs: 10_000, idleTimeoutMs: 120 },
    [{ role: 'user', content: [{ type: 'text', text: '问' }] }],
  );
  const elapsed = Date.now() - started;
  assert.equal(result.complete, false);
  assert.equal(result.timeout, true, '空闲超时也要标记 timeout');
  assert.ok(elapsed < 3000, '空闲超时应早于总超时触发，实际 ' + elapsed + 'ms');
});

test('F7 反例: 正常返回不受超时影响（不得误杀正常请求）', async () => {
  const result = await llm.runAssistant(
    { llm: slow(30, '正常回答'), model: { provider: 'p', model: 'm' }, totalTimeoutMs: 5000, idleTimeoutMs: 5000 },
    [{ role: 'user', content: [{ type: 'text', text: '问' }] }],
  );
  assert.equal(result.complete, true, '正常请求必须完成');
  assert.equal(result.text, '正常回答');
  assert.notEqual(result.timeout, true, '正常请求不得被标成超时');
});

test('F7 反例: 用户主动停止仍按中断处理，不冒充超时', async () => {
  const controller = new AbortController();
  const p = llm.runAssistant(
    { llm: neverEnding(), model: { provider: 'p', model: 'm' }, signal: controller.signal, totalTimeoutMs: 10_000, idleTimeoutMs: 10_000 },
    [{ role: 'user', content: [{ type: 'text', text: '问' }] }],
  );
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(p, '主动停止必须抛出中断，而不是静默返回超时');
});

/* ---------------- 超时在 SSE 上必须给中文原因 ---------------- */

function sseRequest(operation, payload) {
  return new Request('http://local/api/explain-assistant/' + operation, {
    method: 'POST', headers: { 'content-type': 'application/json' },
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

test('F7 真实运行: 超时在 SSE 上是 aborted + 中文原因，且与「触及上限」区分开', async () => {
  const routes = routesModule.createExplainAssistantRoutes({
    service: {
      isSessionAllowed: async () => true, isArchived: async () => false,
      buildMessages: async () => [{ role: 'user', content: [{ type: 'text', text: '问' }] }],
      resolveModel: async () => ({ selection: { provider: 'p', model: 'm' } }),
      llm: neverEnding(),
      llmTimeouts: { totalTimeoutMs: 200, idleTimeoutMs: 150 },
      saveRecord: async () => {}, markUnread: async () => {},
    },
  });
  const response = await routes.get('/explain-assistant/ask')(sseRequest('ask', { question: '问' }));
  const events = await readSse(response);
  const aborted = events.find(e => e.type === 'aborted');
  assert.ok(aborted, '必须有终态事件');
  assert.ok(aborted.data.payload.message.includes('等太久'), '超时原因必须中文且可区分：' + JSON.stringify(aborted.data.payload));
});

test('F7: 超时提示与安全上限提示是两句不同的话（用户要能分辨该做什么）', async () => {
  // 文案已抽到 src/shared/record-reason.ts 作为**唯一来源**（D1：宿主事件与界面记录重建共用同一份，
  // 避免本项目吃过的「同一件事两处文案不一致」）。所以这条断言相应地从「routes.ts 里有字面量」
  // 改为「两条文案确实存在且互不相同，并且 routes.ts 是**引用**它们而不是自己再写一份」——
  // 比原来更严：原写法只证明「某处有这句话」，现在同时钉住「不重复」。
  const shared = await readFile(new URL('../src/shared/record-reason.ts', import.meta.url), 'utf8');
  assert.match(shared, /等太久了/, '必须有超时专用提示');
  assert.match(shared, /触及了安全上限/, '必须保留上限提示');
  const timeoutLine = shared.match(/timeout: '([^']+)'/)?.[1];
  const limitLine = shared.match(/limit: '([^']+)'/)?.[1];
  assert.ok(timeoutLine && limitLine, '两种文案都必须能取到');
  assert.notEqual(timeoutLine, limitLine, '超时与上限必须是两句不同的话（用户要能分辨该做什么）');

  const source = await readFile(new URL('../src/host/routes.ts', import.meta.url), 'utf8');
  assert.match(source, /timeout/, '必须按 timeout 标志分流');
  assert.match(source, /RECORD_REASON_TEXT\.timeout/, '超时文案必须引用共享常量');
  assert.match(source, /RECORD_REASON_TEXT\.limit/, '上限文案必须引用共享常量');
  assert.equal(/等太久了/.test(source), false, 'routes.ts 不得再留字面量（否则就是第二份文案）');
});
