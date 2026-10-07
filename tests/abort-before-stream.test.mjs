import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * task-25 缺陷1：**用户点「停止」被误报成「模型失败」**。
 *
 * ── 根因（Lead 已实测复现，我独立复核）────────────────────────────────
 * llm.ts 里 abortByParent 的定义**早于** timedOut/aborted 的声明，而紧接着就有
 * `if(parent?.aborted)abortByParent()` —— 命中暂时性死区，抛
 * `ReferenceError: Cannot access 'aborted' before initialization`。
 * 该异常被路由转成 event: error / INTERNAL_ERROR，并被判成 model_failed：
 * 用户点「停止」，界面却显示「模型那边返回了错误」（实测复现过）。
 *
 * 修了三处：
 *   1. 声明提到 abortByParent 之前（消除 TDZ）；
 *   2. catch 分支的中止判定放宽为「aborted 标志 / 父信号已中止 / AbortError / code=ABORTED」；
 *   3. 中止用 ExplainAssistantError 抛，让路由给出 code=ABORTED 与中文原因
 *      （否则事件类型虽是 aborted，payload 里却是 INTERNAL_ERROR「没能完成这次操作」）。
 */

async function askOnce({ warmCache = true, midStream = false, abortBefore = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ea-abort-'));
  process.env.DSH_HOME = home;
  try {
    const persistence = await moduleFromSource('src/host/persistence.ts');
    const rootDir = join(home, 'explain-assistant');
    const store = new persistence.JsonSessionStore({ rootDir });
    await store.update('s', s => { s.explicitModel = { provider: 'p', model: 'm' }; s.records = []; });
    await store.close();

    const index = await moduleFromSource('src/index.ts');
    const routes = new Map();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let streamCalls = 0;
    index.apply({
      llm: {
        listProviders: async () => ['p'], listModels: async () => [{ id: 'm', provider: 'p' }],
        stream: () => {
          streamCalls++;
          return (async function* () {
            if (midStream) { yield { type: 'text-delta', text: '部分内容' }; await gate; }
            yield { type: 'finish' };
          })();
        },
      },
      sessionQuery: {},
      connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
      effect: () => {}, get: () => undefined,
    });
    const pick = (path) => { const entry = routes.get(path); return typeof entry === 'function' ? entry : entry.fetch; };
    // 先把模型目录「热」起来，否则已中止的请求会停在目录发现阶段，
    // 测不到 runAssistant 里的中止判定（那是另一个阶段的事）。
    if (warmCache) await (await pick('/api/explain-assistant/state')(new Request('http://h/api/explain-assistant/state?sessionId=s'))).json();

    const controller = new AbortController();
    if (abortBefore) controller.abort();
    const response = await pick('/api/explain-assistant/ask')(new Request('http://h/api/explain-assistant/ask?sessionId=s', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ schemaVersion: 1, sessionId: 's', operation: 'ask', payload: { question: '测试停止' } }),
    }));
    if (midStream) { await new Promise(r => setTimeout(r, 80)); controller.abort(); release(); }
    const text = await response.text();
    const records = JSON.parse(readFileSync(join(rootDir, 'sessions', 's.json'), 'utf8')).records;
    return {
      text,
      events: (text.match(/event: (\w+)/g) || []).map(s => s.replace('event: ', '')),
      records,
      streamCalls,
    };
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

/* ================================================================== *
 * 1) 父信号在模型调用之前就已中止
 * ================================================================== */

test('停止: 父信号已中止 → aborted 事件 + reason=stopped，不得出现 INTERNAL_ERROR', async () => {
  const result = await askOnce({ abortBefore: true });
  assert.ok(result.events.includes('aborted'), '必须是 aborted 事件，实际：' + result.events.join(','));
  assert.equal(/INTERNAL_ERROR/.test(result.text), false, '不得出现 INTERNAL_ERROR（那是 TDZ 异常被误转的结果）');
  assert.match(result.text, /按你的要求停止/, '必须给出中文原因「按你的要求停止」');
  assert.equal(result.records[0]?.reason, 'stopped', '落库原因必须是 stopped，而不是 model_failed');
  assert.equal(/model_failed/.test(JSON.stringify(result.records)), false, '不得被判成 model_failed');
});

test('停止: 父信号已中止时**不得**再调用模型 stream', async () => {
  const result = await askOnce({ abortBefore: true });
  assert.equal(result.streamCalls, 0, '已经知道要停止，就不该再去连模型');
});

/* ================================================================== *
 * 2) 中途点停止（已吐部分内容）—— 真实用户路径
 * ================================================================== */

test('停止: 中途点停止 → aborted + stopped，且已产出的部分内容要落库', async () => {
  const result = await askOnce({ midStream: true });
  assert.ok(result.events.includes('aborted'), '中途停止也必须是 aborted，实际：' + result.events.join(','));
  assert.equal(/INTERNAL_ERROR/.test(result.text), false, '不得出现 INTERNAL_ERROR');
  assert.match(result.text, /按你的要求停止/);
  assert.equal(result.records[0]?.reason, 'stopped');
  assert.equal(result.records[0]?.answerText, '部分内容', '用户当时已经看到的内容不能丢（§8「关闭再打开能查看」）');
});

/* ================================================================== *
 * 3) 反向：真超时仍必须是 timeout，不能被中止判定吞掉
 * ================================================================== */

test('停止 反例: 真超时仍必须是 timeout 原因，不得被中止判定吞成 stopped', async () => {
  const llm = await moduleFromSource('src/host/llm.ts');
  // 定时器是 unref 的：测试进程需保活
  const keepAlive = setInterval(() => {}, 50);
  try {
    const controller = new AbortController();   // **不**中止：这是真超时
    const result = await llm.runAssistant({
      llm: { stream: () => (async function* () { await new Promise(() => {}); })() },
      model: { provider: 'p', model: 'm' }, signal: controller.signal,
      totalTimeoutMs: 300, idleTimeoutMs: 300,
    }, [{ role: 'user', content: 'x' }]);
    assert.equal(result.complete, false, '超时必须未完成');
    assert.equal(result.timeout, true, '必须保留 timeout 标志（否则界面不知道是「等太久」）');
  } finally { clearInterval(keepAlive); }
});

test('停止 反例: 真超时不得被当成 ABORTED 抛出（否则界面显示「已停止」而不是「等太久」）', async () => {
  const llm = await moduleFromSource('src/host/llm.ts');
  const keepAlive = setInterval(() => {}, 50);
  try {
    const controller = new AbortController();
    let threw = null;
    try {
      await llm.runAssistant({
        llm: { stream: () => (async function* () { await new Promise(() => {}); })() },
        model: { provider: 'p', model: 'm' }, signal: controller.signal,
        totalTimeoutMs: 250, idleTimeoutMs: 250,
      }, [{ role: 'user', content: 'x' }]);
    } catch (error) { threw = error; }
    assert.equal(threw, null, '超时应当是「返回 complete:false + timeout」而不是抛 ABORTED，实际抛出：' + (threw && threw.message));
  } finally { clearInterval(keepAlive); }
});

/* ================================================================== *
 * 4) deriveErrorReason 对 AbortError 返回 stopped
 * ================================================================== */

test('停止: 适配器在 abort 后抛 AbortError（而非我们的标志）时，runAssistant 仍须抛 ABORTED', async () => {
  // 这条为什么必须存在：父信号**一开始就中止**的场景会被 llm.ts 里「race 之前」的
  // 前置守卫拦下，根本走不到 catch 里的中止判定 —— 于是如果把判定收窄回「只认 aborted 标志」，
  // 那些用例**照样全绿**（证伪实验抓出来的覆盖缺口，我第一版就是这样）。
  // 这里走**真实形态**：父信号中途 abort，底层 stream 对 abort 的响应是**抛 AbortError**
  // （DOMException，实测 discoverCatalog 抛的正是这个），而不是走我们的标志。
  const llm = await moduleFromSource('src/host/llm.ts');
  // 关键：**父信号不中止**，由适配器自己抛 AbortError（上游取消 / 适配器内部超时）。
  // 这种形态下 aborted 标志是 false、parent.aborted 也是 false，
  // **只有** catch 里「name === 'AbortError'」这一条能把它认成「已停止」。
  // （我第一版让父信号中止，结果 pre-race 守卫先命中，收窄判定测试照样绿 —— 白测。）
  const controller = new AbortController();   // 永不 abort
  const stream = () => (async function* () {
    yield { type: 'text-delta', text: '部分' };
    throw new DOMException('This operation was aborted', 'AbortError');
  })();
  let threw = null;
  try {
    await llm.runAssistant({
      llm: { stream },
      model: { provider: 'p', model: 'm' }, signal: controller.signal,
      totalTimeoutMs: 60_000, idleTimeoutMs: 60_000,
    }, [{ role: 'user', content: 'x' }]);
  } catch (error) { threw = error; }
  assert.ok(threw, '适配器抛 AbortError 时必须抛出，而不是当成模型失败或正常结束');
  assert.equal(threw.code, 'ABORTED', '必须认成「已停止」（AbortError 不是模型失败），实际：' + threw.code);
  assert.equal(threw.name, 'ExplainAssistantError', '必须是 ExplainAssistantError，路由才能给出正确文案（实际 ' + threw.name + '）');
});

test('停止: deriveErrorReason 对 AbortError（DOMException）也返回 stopped', async () => {
  const reason = await moduleFromSource('src/shared/record-reason.ts');
  assert.equal(reason.deriveErrorReason(Object.assign(new Error('x'), { code: 'ABORTED' })), 'stopped', 'code=ABORTED');
  // 实测 discoverCatalog 在 abort 时抛的正是 AbortError（DOMException，name='AbortError'，code=20）
  const abortError = new DOMException('This operation was aborted', 'AbortError');
  assert.equal(reason.deriveErrorReason(abortError), 'stopped', 'AbortError 必须算「已停止」');
  // 其它错误仍是模型失败
  assert.equal(reason.deriveErrorReason(Object.assign(new Error('boom'), { code: 'LLM_FAILED' })), 'model_failed');
  assert.equal(reason.deriveErrorReason(new Error('plain')), 'model_failed');
  assert.equal(reason.deriveErrorReason(undefined), 'model_failed');
});
