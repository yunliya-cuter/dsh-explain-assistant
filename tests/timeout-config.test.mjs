import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * §10 F7：**超时提示**的可验证性。
 *
 * ── 为什么要有这个配置 ──────────────────────────────────────────────
 * F7「界面超时提示」的实现一直都在（routes.ts:160-162 发中文 aborted 事件；
 * llm.ts:98/102 有总超时与空闲超时两个定时器），但**从没在页面上触发过**：
 * 默认总超时 300s / 空闲 120s，靠干等不现实，所以这条一直是「没验证」。
 * 把预算做成可覆盖后，测试与页面验证可以压到几秒、真实触发一次超时、看到那句中文提示。
 *
 * ── 本文件守什么 ────────────────────────────────────────────────────
 * 1. **默认行为一丝不变**：不设配置 → 不覆盖任何字段（让 llm.ts 用自己的默认值）。
 *    注意这里断言的是「返回空对象」而不是「等于 300000」——默认值只有一个来源，
 *    将来改默认值不会出现两处不一致。
 * 2. **非法配置一律回退**：非数字/0/负数/小数/科学计数/带单位/超大/非字符串，
 *    统统不能生效。这是「可配置」最危险的地方 —— 一次误配可能让超时变 0（全部瞬间超时）
 *    或变成永久等待（保护形同虚设）。
 * 3. **真链路**：压到 300ms 后真的触发一次超时，并拿到 F7 那句中文提示。
 */

const cfg = await moduleFromSource('src/host/timeout-config.ts');

/* ================================================================== *
 * 1) 默认行为一丝不变
 * ================================================================== */

test('超时配置 默认: 不设环境变量时不覆盖任何字段（默认值仍由 llm.ts 提供，300s/120s）', async () => {
  assert.deepEqual(cfg.readConfiguredTimeouts({}), {}, '不设配置必须返回空对象（= 完全不覆盖）');
  assert.deepEqual(cfg.readConfiguredTimeouts(undefined), {}, '没有环境变量来源时同理');
  // 直读 llm.ts 的默认值，确认它们确实还是 300s / 120s —— 这条钉住「默认行为一丝不变」。
  const { readFileSync } = await import('node:fs');
  const llmSource = readFileSync(new URL('../src/host/llm.ts', import.meta.url), 'utf8');
  assert.match(llmSource, /totalTimeoutMs:\s*300_000/, '总超时默认必须仍是 300s');
  assert.match(llmSource, /idleTimeoutMs:\s*120_000/, '空闲超时默认必须仍是 120s');
  assert.match(llmSource, /ctx\.totalTimeoutMs\?\?DEFAULTS\.totalTimeoutMs/, '未配置时必须回退到 llm.ts 自己的默认值');
});

/* ================================================================== *
 * 2) 合法配置被采纳
 * ================================================================== */

test('超时配置 生效: 合法值被采纳，且两个字段可各自独立设置', () => {
  assert.deepEqual(cfg.readConfiguredTimeouts({
    [cfg.TIMEOUT_ENV_TOTAL]: '3000', [cfg.TIMEOUT_ENV_IDLE]: '1500',
  }), { totalTimeoutMs: 3000, idleTimeoutMs: 1500 });
  // 只设一个 → 另一个不出现（仍用默认）
  assert.deepEqual(cfg.readConfiguredTimeouts({ [cfg.TIMEOUT_ENV_TOTAL]: '3000' }), { totalTimeoutMs: 3000 });
  // 前后空格应被容忍（环境变量里带空格很常见）
  assert.deepEqual(cfg.readConfiguredTimeouts({ [cfg.TIMEOUT_ENV_TOTAL]: ' 2500 ' }), { totalTimeoutMs: 2500 });
});

/* ================================================================== *
 * 3) 非法配置一律回退（本文件的重点）
 * ================================================================== */

test('超时配置 校验: 非法值一律回退默认，绝不让超时变成 0 或永久等待', () => {
  const illegal = [
    ['空串', ''],
    ['全空格', '   '],
    ['零（会让一切都瞬间超时）', '0'],
    ['负数', '-100'],
    ['小数', '1.5'],
    ['纯字母', 'abc'],
    ['科学计数法（含糊）', '5e3'],
    ['十六进制（含糊）', '0x10'],
    ['带单位', '5000px'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['超大（≈ 永久等待，视为误配）', String(99 * 60 * 60 * 1000)],
    ['非字符串（数字）', 5000],
    ['非字符串（布尔）', true],
    ['非字符串（对象）', {}],
    ['null', null],
  ];
  for (const [label, raw] of illegal) {
    assert.equal(cfg.parseTimeoutMs(raw), undefined, '非法值必须回退（' + label + '）');
  }
  // 上限本身应被接受（边界包含）
  assert.equal(cfg.parseTimeoutMs(String(cfg.MAX_CONFIGURABLE_TIMEOUT_MS)), cfg.MAX_CONFIGURABLE_TIMEOUT_MS, '上限值本身合法');
  // 一个合法 + 一个非法 → 只生效合法那个
  assert.deepEqual(cfg.readConfiguredTimeouts({
    [cfg.TIMEOUT_ENV_TOTAL]: '3000', [cfg.TIMEOUT_ENV_IDLE]: '-5',
  }), { totalTimeoutMs: 3000 }, '非法的那一项不得影响合法的那一项');
});

/* ================================================================== *
 * 4) 真链路：压到 300ms，真的触发一次超时并拿到 F7 中文提示
 * ================================================================== */

test('超时配置 真链路 F7: 压到 300ms 后真的触发超时，界面拿到那句中文提示', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // llm.ts 的定时器是 unref 的（避免拖住进程退出）。测试进程里没有别的 keep-alive 时，
  // 定时器触发前进程就可能退出 —— 所以这里显式保活（这不是被测行为，是测试脚手架的要求）。
  const keepAlive = setInterval(() => {}, 50);
  const previousEnv = process.env[cfg.TIMEOUT_ENV_TOTAL];
  const previousHome = process.env.DSH_HOME;
  process.env[cfg.TIMEOUT_ENV_TOTAL] = '300';
  const home = mkdtempSync(join(tmpdir(), 'ea-f7test-'));
  process.env.DSH_HOME = home;
  try {
    const persistence = await moduleFromSource('src/host/persistence.ts');
    const store = new persistence.JsonSessionStore({ rootDir: join(home, 'explain-assistant') });
    await store.update('t1', s => { s.explicitModel = { provider: 'p', model: 'm' }; s.records = []; });
    await store.close();

    const index = await moduleFromSource('src/index.ts');
    const routes = new Map();
    index.apply({
      llm: {
        listProviders: async () => ['p'], listModels: async () => [{ id: 'm', provider: 'p' }],
        // 模型「连上了但一直不吐字」——正是总超时要抓的情形
        stream: () => (async function* () { await new Promise(() => {}); })(),
      },
      sessionQuery: {},
      connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
      effect: () => {}, get: () => undefined,
    });
    const entry = routes.get('/api/explain-assistant/ask');
    const handler = typeof entry === 'function' ? entry : entry.fetch;
    const startedAt = Date.now();
    // **必须有硬超时**：若配置没接上，这里会等默认的 300s —— 那会让「配置失效」这种真故障
    // 表现为测试**挂 5 分钟**（我实测过：改坏接线后这条挂了 120s 才被外部超时打断），
    // 而不是快速变红。硬超时把它变成「几秒内明确失败」，也顺带钉住「配置确实生效了」。
    // 用 AbortController 包住请求：硬超时触发时**主动中断**它。
    // 只做 Promise.race 是不够的 —— 底层流会一直挂着，让整个测试进程无法退出
    // （我实测过：改坏接线后不是「快速变红」，而是挂住不动）。
    // 中断之后宿主会走 ABORTED 分支关掉流，事件循环得以收敛。
    const controller = new AbortController();
    const request = handler(new Request('http://h/api/explain-assistant/ask?sessionId=t1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ schemaVersion: 1, sessionId: 't1', operation: 'ask', payload: { question: '测试超时' } }),
    }));
    const response = await Promise.race([
      request,
      new Promise((_, reject) => setTimeout(() => {
        controller.abort();                                  // 先中断，避免留下挂起的流
        reject(new Error('超时配置未生效：请求在 5 秒内没有结束（若配置已压到 300ms，这里应当很快返回）'));
      }, 5000).unref()),
    ]).catch(error => { controller.abort(); throw error; });
    const text = await response.text();
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 5000, '压到 300ms 后必须在数秒内结束，而不是等默认的 300s（实际 ' + elapsed + 'ms）');
    assert.match(text, /event: aborted/, '超时必须发 aborted 事件');
    assert.match(text, /这次解释等太久了/, '必须带 F7 那句中文提示（用户看得懂「为什么停了」）');
    assert.match(text, /换一个更快的模型/, '提示里要给出可操作的建议（§10「不静默失败」）');
  } finally {
    clearInterval(keepAlive);
    if (previousEnv === undefined) delete process.env[cfg.TIMEOUT_ENV_TOTAL]; else process.env[cfg.TIMEOUT_ENV_TOTAL] = previousEnv;
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * 5) 接线：index.ts 必须真的把配置传给路由
 * ================================================================== */

test('超时配置 接线: index.ts 必须把读到的配置传给 service.llmTimeouts', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /llmTimeouts: readConfiguredTimeouts\(\)/, '必须把配置接进 service（否则配了也不生效）');
  assert.match(source, /readConfiguredTimeouts\b/, '必须引用配置读取函数');
});
