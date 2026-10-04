import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * §10/D1：**记录为什么没完成**必须留在磁盘上，并能被界面与追问上下文读到。
 *
 * ── 缺口是什么（Lead 在 F7 页面实测后查磁盘发现，我已独立复核）────────────
 * 超时那条记录的**全部字段**是：
 *   id / kind / status=interrupted / complete=false / question / answerText="" /
 *   reasoningText="" / evidence=[] / tools=[] / images=[] / startedAt / updatedAt
 * **没有任何字段说明「为什么没完成」**（超时/等太久/TIMEOUT/reason/error/message 逐一查过，全无）。
 * 后果：整页重载后记录还在（显示「此记录未完成或未验证」），但**用户不知道为什么**；
 * 追问时模型也拿不到原因 —— 而这正是 §10「不静默失败」要避免的。
 *
 * ── 本文件守什么 ────────────────────────────────────────────────────
 * 1. 原因能落库、能读回，且三种原因可区分；
 * 2. **向后兼容**：老记录没有该字段 → 行为与现在完全一样（不报错、不渲染成空白）；
 * 3. **文案唯一来源**：宿主 SSE 事件与界面记录重建用的是同一份常量（本项目吃过两处不一致的亏）。
 */

const reason = await moduleFromSource('src/shared/record-reason.ts');

/* ================================================================== *
 * 1) 原因推导：与 routes.ts 的分支一一对应
 * ================================================================== */

test('D1 原因推导: 超时/模型失败/触及上限三种可区分，且与 routes.ts 分支顺序一致', () => {
  assert.equal(reason.deriveRecordReason({ complete: false, timeout: true }), 'timeout', '超时 → timeout');
  assert.equal(reason.deriveRecordReason({ complete: false, failure: { code: 'LLM_FAILED' } }), 'model_failed', '模型失败 → model_failed');
  assert.equal(reason.deriveRecordReason({ complete: false, failure: { code: 'MODEL_UNAVAILABLE' } }), 'model_failed', '模型不可用同样是模型失败');
  assert.equal(reason.deriveRecordReason({ complete: false }), 'limit', '未完成且非超时 → 触及上限');
  // 优先级：模型失败高于超时（与 routes.ts 一致：failure 分支在前）
  assert.equal(reason.deriveRecordReason({ complete: false, timeout: true, failure: { code: 'X' } }), 'model_failed',
    '同时具备时，模型失败优先（与 routes.ts 的分支顺序一致）');
  // 正常完成不标注原因
  assert.equal(reason.deriveRecordReason({ complete: true }), undefined, '完成的记录不标注原因');
  // 提供方侧中断不算「失败」：按既有语义不标注（routes.ts 走『已停止』分支）
  assert.equal(reason.deriveRecordReason({ complete: false, failure: { code: 'ABORTED' } }), undefined,
    '提供方侧中断按既有语义不标注原因');
  assert.equal(reason.deriveRecordReason(undefined), undefined, '没有结果时不标注');
});

test('D1 原因归一: 认不出的值一律 undefined（不猜，向后兼容）', () => {
  for (const bad of [undefined, null, '', 'TIMEOUT', 'Timeout', 0, 1, true, {}, [], 'unknown']) {
    assert.equal(reason.normalizeRecordReason(bad), undefined, '认不出的值必须回退为「无原因」：' + JSON.stringify(bad));
    assert.equal(reason.recordReasonText(bad), undefined, '无原因时不得给出文案：' + JSON.stringify(bad));
  }
  // 三个合法值必须被认出
  for (const good of ['timeout', 'model_failed', 'limit']) {
    assert.equal(reason.normalizeRecordReason(good), good);
    assert.equal(typeof reason.recordReasonText(good), 'string');
  }
});

/* ================================================================== *
 * 2) 文案唯一来源：宿主事件与界面重建必须用同一份
 * ================================================================== */

test('D1 文案唯一来源: routes.ts 的三句与 shared 常量是同一份（不是第二份拷贝）', async () => {
  const routes = readFileSync(new URL('../src/host/routes.ts', import.meta.url), 'utf8');
  // 三句文案必须**从常量取**，不得再出现字面量
  assert.match(routes, /RECORD_REASON_TEXT\.model_failed/, '模型失败文案必须取自 shared 常量');
  assert.match(routes, /RECORD_REASON_TEXT\.timeout/, '超时文案必须取自 shared 常量');
  assert.match(routes, /RECORD_REASON_TEXT\.limit/, '上限文案必须取自 shared 常量');
  // 反例：旧的字面量不得残留（否则就是两份文案，迟早不一致）
  assert.equal(/这次解释等太久了/.test(routes), false, 'routes.ts 里不得再留超时文案的字面量（应改为引用常量）');
  assert.equal(/这次解释触及了安全上限/.test(routes), false, 'routes.ts 里不得再留上限文案的字面量');
  assert.equal(/这次解释没有成功：模型那边返回了错误/.test(routes), false, 'routes.ts 里不得再留模型失败文案的字面量');

  const overlay = readFileSync(new URL('../src/client/overlay.tsx', import.meta.url), 'utf8');
  assert.match(overlay, /recordReasonText\(/, '界面重建必须走同一个取文案函数');
  assert.match(overlay, /from '\.\.\/shared\/record-reason\.js'/, '界面必须 import shared 模块（而不是自己抄一份）');
  // 界面里不得内联重复那三句
  assert.equal(/这次解释等太久了/.test(overlay), false, 'overlay.tsx 里不得内联超时文案');
});

test('D1 文案: 三种原因各自的文案互不相同，且都给可操作建议', () => {
  const texts = ['timeout', 'model_failed', 'limit'].map(k => reason.recordReasonText(k));
  assert.equal(new Set(texts).size, 3, '三种原因的文案必须互不相同（否则用户分不出是哪种）');
  for (const t of texts) {
    assert.match(t, /[\u4e00-\u9fff]/, '必须中文（§10 面向用户）');
    assert.match(t, /你/, '必须给出对用户可操作的建议（「你可以…」）');
  }
});

/* ================================================================== *
 * 3) 向后兼容：老记录没有该字段时行为不变
 * ================================================================== */

test('D1 向后兼容: 老记录（无 reason 字段）不报错，且退回既有的「未完成」提示', () => {
  // 老记录的字段形状（Lead 查到的真实形状，没有 reason）
  const legacy = { id: 'r1', kind: 'ask', status: 'interrupted', complete: false, question: 'q', answerText: '', reasoningText: '' };
  assert.equal(('reason' in legacy), false, '前置：老记录确实没有 reason 字段');
  assert.equal(reason.recordReasonText(legacy.reason), undefined, '老记录取不到原因文案 → 调用方走原有兜底');
  assert.equal(reason.RECORD_INCOMPLETE_TEXT, '此记录未完成或未验证', '兜底文案必须与既有实现一致（行为不变）');
  // 归一函数对 undefined 必须安全
  assert.doesNotThrow(() => reason.normalizeRecordReason(undefined));
  assert.doesNotThrow(() => reason.recordReasonContextLine(undefined));
  assert.equal(reason.recordReasonContextLine(undefined), undefined, '老记录不得往追问上下文里塞东西');
});

/* ================================================================== *
 * 4) 追问上下文：没完成的那条以前被静默丢掉
 * ================================================================== */

test('D1 追问上下文: 没完成的记录要带原因进去（以前 answer 为空会被整条丢掉）', async () => {
  const prompts = await moduleFromSource('src/host/prompts.ts');
  const messages = prompts.buildMessages('它为什么没答完', {}, {
    history: [
      { question: '上一次的问题', answer: '', reason: 'timeout' },
      { question: '正常的一轮', answer: '正常回答' },
    ],
  });
  const all = JSON.stringify(messages);
  assert.match(all, /没有完成/, '必须把「没完成」带进上下文（以前 answer 为空会整条被丢）');
  assert.match(all, /超时/, '必须说明具体原因（超时），模型才知道该建议「缩小范围」还是「换模型」');
  assert.match(all, /上一次的问题/, '那次的问题本身也要在');
  assert.match(all, /正常回答/, '正常的一轮不受影响');
});

/* ================================================================== *
 * 5) 端到端：超时落库后能从磁盘读回原因
 * ================================================================== */

test('D1 端到端: 真的超时一次，磁盘上的记录必须能读回 reason=timeout', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // llm.ts 的定时器是 unref 的：测试进程需保活，否则定时器触发前进程就退出了。
  const keepAlive = setInterval(() => {}, 50);
  const envKey = 'DSH_EXPLAIN_ASSISTANT_TOTAL_TIMEOUT_MS';
  const previousEnv = process.env[envKey];
  const previousHome = process.env.DSH_HOME;
  process.env[envKey] = '300';                       // 压到 300ms，让超时真的发生
  const home = mkdtempSync(join(tmpdir(), 'ea-d1-e2e-'));
  process.env.DSH_HOME = home;
  try {
    const persistence = await moduleFromSource('src/host/persistence.ts');
    const store = new persistence.JsonSessionStore({ rootDir: join(home, 'explain-assistant') });
    await store.update('d1e', s => { s.explicitModel = { provider: 'p', model: 'm' }; s.records = []; });
    await store.close();

    const index = await moduleFromSource('src/index.ts');
    const routes = new Map();
    index.apply({
      llm: {
        listProviders: async () => ['p'], listModels: async () => [{ id: 'm', provider: 'p' }],
        stream: () => (async function* () { await new Promise(() => {}); })()   // 永不产出 → 总超时
      },
      sessionQuery: {},
      connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
      effect: () => {}, get: () => undefined,
    });
    const entry = routes.get('/api/explain-assistant/ask');
    const handler = typeof entry === 'function' ? entry : entry.fetch;
    await (await handler(new Request('http://h/api/explain-assistant/ask?sessionId=d1e', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, sessionId: 'd1e', operation: 'ask', payload: { question: '测试超时' } }),
    }))).text();

    // 直接读磁盘（不看内存），这正是 Lead 发现问题的方式
    const saved = JSON.parse(readFileSync(join(home, 'explain-assistant', 'sessions', 'd1e.json'), 'utf8')).records[0];
    assert.equal(saved.status, 'interrupted', '前置：确实落库了一条未完成的记录');
    assert.equal(saved.reason, 'timeout', '磁盘上必须写明原因，而不是只留一个「未完成」（实际：' + JSON.stringify(saved.reason) + '）');
    // 界面据此能显示出对应中文
    assert.equal(reason.recordReasonText(saved.reason), reason.RECORD_REASON_TEXT.timeout, '界面取到的必须是超时那句');
  } finally {
    clearInterval(keepAlive);
    if (previousEnv === undefined) delete process.env[envKey]; else process.env[envKey] = previousEnv;
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('D1 端到端 兼容: 老记录（磁盘上没有 reason 字段）读回时不报错', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'ea-d1-legacy-'));
  try {
    const persistence = await moduleFromSource('src/host/persistence.ts');
    const store = new persistence.JsonSessionStore({ rootDir: join(home, 'explain-assistant') });
    // 造一条**老形状**的未完成记录（没有 reason）
    await store.update('legacy', s => {
      s.records = [{ id: 'r-old', kind: 'ask', status: 'interrupted', complete: false, question: '老问题',
        answerText: '', reasoningText: '', evidence: [], tools: [], images: [],
        startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }];
    });
    await store.close();
    const loaded = new persistence.JsonSessionStore({ rootDir: join(home, 'explain-assistant') });
    const record = (await loaded.load('legacy')).state.records[0];
    await loaded.close();
    assert.equal(record.reason, undefined, '老记录读回时 reason 是 undefined（不得报错、不得凭空造一个）');
    assert.equal(reason.recordReasonText(record.reason), undefined, '取不到文案 → 界面走原有兜底「此记录未完成或未验证」');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('D1 追问上下文 兼容: 没带 reason 的未完成记录行为与以前一致（不额外塞内容）', async () => {
  const prompts = await moduleFromSource('src/host/prompts.ts');
  const messages = prompts.buildMessages('问题', {}, {
    history: [{ question: '老记录的问题', answer: '' }],
  });
  const all = JSON.stringify(messages);
  assert.match(all, /老记录的问题/, '问题仍在');
  assert.equal(/没有完成/.test(all), false, '没有原因时不附加任何说明（行为与以前完全一样）');
});
