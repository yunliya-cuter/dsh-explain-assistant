import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * §9.1/§10：**compact 失败的原因也必须留在磁盘上**（D1 的同类跟进）。
 *
 * ── 我先做了判断，事实与预期不完全一样（如实记录）────────────────────
 * 任务假设是「compact 失败的原因只活在内存里，重载后没了，和 D1 一模一样」。
 * 我实测了四种形态，结论是**一半成立**：
 *
 *   | 形态 | 落库情况 | 原因留得住吗 |
 *   | 模型返回 failure（AUTH 等） | status=interrupted, reason=model_failed | 留得住（D1 已覆盖） |
 *   | 超时 / 触及上限（complete:false） | reason=timeout / limit | 留得住（D1 已覆盖） |
 *   | **模型正常结束但摘要为空** | 原先写 complete=true、**无 reason** | **丢失 ← 真正的缺口** |
 *   | 适配器直接抛异常 | 不产生记录（走 catch 事件） | 无记录 |
 *
 * 所以「compact 的原因全丢」不成立（D1 的通用推导已经覆盖了前两种），
 * 但**第三种确有缺口**：模型正常结束（complete=true）却没吐出摘要时，
 * 记录被写成 status=complete/complete=true —— 整页重载后**看起来像压缩成功了**，
 * 而界面上当时的「压缩失败」只活在内存里。这正是 §9.1「失败清楚提示」在重载路径上的漏洞。
 */

const reason = await moduleFromSource('src/shared/record-reason.ts');

/* ================================================================== *
 * 1) 原因推导：compact 独有的空摘要形态
 * ================================================================== */

test('compact 原因: 正常结束但摘要为空 → empty_result（原先完全不落痕迹）', () => {
  assert.equal(reason.deriveCompactReason({ complete: true, summary: '' }), 'empty_result', '空字符串摘要');
  assert.equal(reason.deriveCompactReason({ complete: true, summary: '   ' }), 'empty_result', '纯空白摘要（与 routes.ts 的 trim 判据一致）');
  assert.equal(reason.deriveCompactReason({ complete: true }), 'empty_result', '完全没有 summary 字段');
  // 有摘要 = 真的成功，不标注
  assert.equal(reason.deriveCompactReason({ complete: true, summary: '有效摘要' }), undefined, '有摘要不得标注原因');
});

test('compact 原因: 通用三分支仍然优先（不能被 empty_result 抢走）', () => {
  assert.equal(reason.deriveCompactReason({ complete: false, timeout: true }), 'timeout');
  assert.equal(reason.deriveCompactReason({ complete: false, failure: { code: 'AUTH' } }), 'model_failed');
  assert.equal(reason.deriveCompactReason({ complete: false }), 'limit');
  // 失败且摘要是空 → 仍按失败归类，不是 empty_result
  assert.equal(reason.deriveCompactReason({ complete: false, failure: { code: 'AUTH' }, summary: '' }), 'model_failed',
    '失败优先于「空摘要」：用户更需要知道是模型坏了');
});

test('compact 原因 兼容: 认不出/老数据一律 undefined', () => {
  for (const bad of [undefined, null, '', 'EMPTY_RESULT', 0, {}, []]) {
    assert.equal(reason.normalizeRecordReason(bad), undefined, '认不出的值必须回退：' + JSON.stringify(bad));
    assert.equal(reason.recordReasonText(bad), undefined, '无原因时不得给出文案');
  }
  assert.equal(reason.normalizeRecordReason('empty_result'), 'empty_result', '新原因必须被认出');
  assert.equal(typeof reason.recordReasonText('empty_result'), 'string', '新原因必须有文案');
});

/* ================================================================== *
 * 2) 端到端：四种形态落库后的真实形状
 * ================================================================== */

async function compactOnce(stream, label) {
  const home = mkdtempSync(join(tmpdir(), 'ea-cr-'));
  process.env.DSH_HOME = home;
  try {
    const persistence = await moduleFromSource('src/host/persistence.ts');
    const rootDir = join(home, 'explain-assistant');
    const store = new persistence.JsonSessionStore({ rootDir });
    await store.update('c', s => { s.explicitModel = { provider: 'p', model: 'm' }; s.records = []; });
    await store.close();
    const index = await moduleFromSource('src/index.ts');
    const routes = new Map();
    index.apply({
      llm: { listProviders: async () => ['p'], listModels: async () => [{ id: 'm', provider: 'p' }], stream },
      sessionQuery: {}, connection: { fetch: { register: e => routes.set(e.path, e.fetch) } },
      effect: () => {}, get: () => undefined,
    });
    const entry = routes.get('/api/explain-assistant/compact');
    const handler = typeof entry === 'function' ? entry : entry.fetch;
    await (await handler(new Request('http://h/api/explain-assistant/compact?sessionId=c', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, sessionId: 'c', operation: 'compact', payload: {} }),
    }))).text();
    return JSON.parse(readFileSync(join(rootDir, 'sessions', 'c.json'), 'utf8')).records[0];
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

test('compact 端到端: 空摘要失败必须落库为「未完成 + empty_result」，而不是看起来成功', async () => {
  const record = await compactOnce(() => (async function* () { yield { type: 'finish' }; })());
  assert.equal(record.reason, 'empty_result', '磁盘上必须写明原因（原先这里是 undefined，重载后看起来像成功）');
  assert.equal(record.status, 'interrupted', '既然没压出摘要，就不能记成 complete（否则重载后界面显示成功，说假话）');
  assert.equal(record.complete, false, 'complete 必须与 status 一致');
});

test('compact 端到端 不回归: 真正成功时仍记 complete 且不带原因', async () => {
  const record = await compactOnce(() => (async function* () { yield { type: 'text-delta', text: '有效摘要正文' }; yield { type: 'finish', done: true }; })());
  assert.equal(record.reason, undefined, '成功的记录不得带原因（老形状不变）');
  assert.equal(record.status, 'complete', '成功仍记 complete');
  assert.equal(record.complete, true);
});

test('compact 端到端: 模型失败仍按 model_failed（通用路径不受影响）', async () => {
  const record = await compactOnce(() => (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad' } } }; })());
  assert.equal(record.reason, 'model_failed');
  assert.equal(record.status, 'interrupted');
});

/* ================================================================== *
 * 3) 向后兼容：老数据（无 reason）行为不变
 * ================================================================== */

test('compact 兼容: 老记录没有 reason 字段时，判定与以前完全一样', () => {
  // 老记录的形状：status=complete、complete=true、没有 reason（本轮之前空摘要就是这个形状）
  const legacy = { id: 'r1', kind: 'compact', status: 'complete', complete: true, question: '', answerText: '' };
  assert.equal('reason' in legacy, false, '前置：老记录确实没有 reason');
  assert.equal(reason.recordReasonText(legacy.reason), undefined, '取不到文案 → 界面走原有逻辑（不显示失败提示）');
  assert.equal(reason.normalizeRecordReason(undefined), undefined, '不得凭空造一个原因');
});

/* ================================================================== *
 * 4) 文案唯一来源（与 D1 同一条规矩）
 * ================================================================== */

test('compact 文案: 新原因的文案也来自同一份常量，且与其它原因不同', async () => {
  const { readFileSync } = await import('node:fs');
  const shared = readFileSync(new URL('../src/shared/record-reason.ts', import.meta.url), 'utf8');
  assert.match(shared, /empty_result: '/, '新原因的文案必须在 shared 里定义');
  const texts = ['timeout', 'model_failed', 'limit', 'empty_result'].map(k => reason.recordReasonText(k));
  assert.equal(new Set(texts).size, 4, '四种原因的文案必须互不相同（用户要能分辨该做什么）');
  // routes.ts 不得内联复制这句
  const routes = readFileSync(new URL('../src/host/routes.ts', import.meta.url), 'utf8');
  assert.equal(/这次整理没有拿到可用的摘要内容/.test(routes), false, 'routes.ts 不得内联该文案（应引用常量）');
});
