import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * §10/D1-c：**异常与取消路径也必须留痕**。
 *
 * ── 缺口是什么（Lead 写探针实测，不是推断）────────────────────────────
 * `routes.ts` 的 `run()` 里，落库那一段在 try 内；凡是**不走正常返回 result** 的路径
 * （适配器抛异常、用户点停止）都直接落到 catch，而 catch 只发事件、**不落库**。
 * 实测四种情形磁盘记录数**都是 0**：
 *   适配器迭代时抛 / llm.stream() 同步抛 / 迭代到一半抛 / 用户点停止。
 *
 * 后果：用户**当场**看得到反馈（界面显示「出错」或「已停止」），但**重载后那次提问彻底消失**，
 * 追问时模型也不知道「上次试过但挂了」。这是 D1 家族的第三个程度：
 *   a 有记录没原因 → b 有记录但记成成功 → c 连记录都没有。
 *
 * ── 本文件守什么 ────────────────────────────────────────────────────
 * 1. 抛异常也要落一条记录，且写明原因（model_failed）；
 * 2. **用户主动停止不是失败**，原因必须是 stopped，文案也不得写成「没有成功」；
 * 3. 抛出前**已经吐出的文本**要保留（否则重载后与用户当时的所见不符）；
 * 4. 正常完成路径**不受影响**（仍 complete、无 reason）。
 */

const reason = await moduleFromSource('src/shared/record-reason.ts');

/** 起一个只注册路由的宿主，返回 {handler, readRecords}。 */
async function host(streamFactory, home, sessionId) {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const store = new persistence.JsonSessionStore({ rootDir: join(home, 'explain-assistant') });
  await store.update(sessionId, s => { s.explicitModel = { provider: 'p', model: 'm' }; s.records = []; });
  await store.close();
  const index = await moduleFromSource('src/index.ts');
  const routes = new Map();
  index.apply({
    llm: { listProviders: async () => ['p'], listModels: async () => [{ id: 'm', provider: 'p' }], stream: streamFactory },
    sessionQuery: {},
    connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
    effect: () => {}, get: () => undefined,
  });
  const entry = routes.get('/api/explain-assistant/ask');
  const handler = typeof entry === 'function' ? entry : entry.fetch;
  const readRecords = () => {
    try { return JSON.parse(readFileSync(join(home, 'explain-assistant', 'sessions', sessionId + '.json'), 'utf8')).records; }
    catch { return []; }
  };
  return { handler, readRecords };
}

function askRequest(sessionId, question, signal) {
  return new Request('http://h/api/explain-assistant/ask?sessionId=' + sessionId, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ schemaVersion: 1, sessionId, operation: 'ask', payload: { question } }),
  });
}

async function withHome(label, fn) {
  const home = mkdtempSync(join(tmpdir(), 'ea-' + label + '-'));
  const keepAlive = setInterval(() => {}, 50);   // llm.ts 的定时器是 unref 的，测试需保活
  // **必须设 DSH_HOME**：src/index.ts 自己按它建落库目录；不设的话记录会写到真实 home，
  // 而本测试读的是临时目录 —— 看起来就像「一条记录都没落」。
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { await fn(home); } finally {
    clearInterval(keepAlive);
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test('D1-c 异常落库: 适配器在迭代时抛异常，磁盘上必须留下一条带原因的记录', async () => {
  await withHome('excp', async home => {
    const { handler, readRecords } = await host(
      () => (async function* () { throw Object.assign(new Error('401 invalid api key'), { code: 'INVALID_CREDENTIAL' }); })(),
      home, 'e1');
    const text = await (await handler(askRequest('e1', '适配器抛异常的问题'))).text();
    assert.match(text, /event: error/, '前置：确实发了 error 事件');
    const records = readRecords();
    assert.equal(records.length, 1, '异常路径必须落一条记录（原先这里是 0 条 —— 用户重载后连问过什么都看不到）');
    assert.equal(records[0].status, 'interrupted');
    assert.equal(records[0].complete, false);
    assert.equal(records[0].question, '适配器抛异常的问题', '问题本身要留下');
    assert.equal(records[0].reason, 'model_failed', '必须写明原因（异常 = 模型失败，不是用户停的）');
  });
});

test('D1-c 取消落库: 用户点停止时，原因必须是 stopped 而不是 model_failed', async () => {
  await withHome('canc', async home => {
    const { handler, readRecords } = await host(
      () => (async function* () { yield { type: 'text-delta', text: '开头几个字' }; await new Promise(() => {}); })(),
      home, 'e2');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    let text = '';
    try { text = await (await handler(askRequest('e2', '被用户停掉的问题', controller.signal))).text(); }
    catch { /* 中断本身可能让读取抛出，记录仍应已落库 */ }
    assert.match(text, /event: aborted/, '前置：确实发了 aborted 事件');
    const records = readRecords();
    assert.equal(records.length, 1, '用户点停止也要留痕（原先 0 条）');
    assert.equal(records[0].reason, 'stopped', '用户主动停止 ≠ 失败：必须给 stopped，否则等于把用户的决定说成系统出错');
    assert.notEqual(records[0].reason, 'model_failed', '不得与「模型失败」混为一谈');
    // 文案也不得把用户自己的决定写成失败
    assert.doesNotMatch(reason.RECORD_REASON_TEXT.stopped, /没有成功/, '「停止」的文案不得写成「没有成功」');
    assert.match(reason.RECORD_REASON_TEXT.stopped, /按你的要求停止/, '要说明是用户自己停的');
  });
});

test('D1-c 部分回答保留: 抛出之前已经吐出的文本必须落库（否则与用户所见不符）', async () => {
  await withHome('part', async home => {
    const { handler, readRecords } = await host(
      () => (async function* () { yield { type: 'text-delta', text: '已经说了一半' }; throw new Error('boom midway'); })(),
      home, 'e3');
    await (await handler(askRequest('e3', '吐了一半才断的问题'))).text();
    const records = readRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].answerText, '已经说了一半',
      '用户当时屏幕上看到的字必须留下来（原先这条记录根本不存在）');
  });
});

test('D1-c 正常路径不受影响: 正常完成仍是 complete 且不标注原因', async () => {
  await withHome('ok', async home => {
    const { handler, readRecords } = await host(
      () => (async function* () { yield { type: 'text-delta', text: '正常回答' }; })(),
      home, 'e4');
    await (await handler(askRequest('e4', '正常的问题'))).text();
    const records = readRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'complete');
    assert.equal(records[0].complete, true);
    assert.equal('reason' in records[0], false, '正常完成不得写 reason（老形状不变）');
    assert.equal(records[0].answerText, '正常回答');
  });
});

test('D1-c 文案唯一来源: stopped 的中文只在 shared 里，routes.ts 不得内联', async () => {
  const routes = readFileSync(new URL('../src/host/routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /deriveErrorReason/, 'routes.ts 必须用共用函数推导原因');
  assert.equal(/这次解释是按你的要求停止的/.test(routes), false, 'routes.ts 不得内联 stopped 文案');
  const texts = ['timeout', 'model_failed', 'limit', 'empty_result', 'stopped'].map(k => reason.recordReasonText(k));
  assert.equal(new Set(texts).size, 5, '五种原因的文案必须互不相同（否则用户分不出是哪种）');
});
