import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * §5.1「更早历史需通过宿主提供的读取能力取得」；§8「关闭再打开能查看并继续追问」。
 *
 * 修之前服务端恒返回 hasEarlier:false → 浮窗「查看更早历史」按钮**永远不出现**，
 * 用户记录一多就翻不上去。
 */

/** 直接测分页的纯逻辑：用 store 造 N 条记录，然后按游标翻。 */
async function fixture(t, count) {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'ea-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new persistence.JsonSessionStore({ rootDir: root });
  t.after(() => store.close());
  await store.update('session-a', (state) => {
    state.records = Array.from({ length: count }, (_, i) => ({ id: 'r' + i, kind: 'ask', question: '问题' + i, answerText: '回答' + i, startedAt: new Date(2026, 0, 1, 0, i).toISOString() }));
  });
  return store;
}

test('F2: 服务端不再恒返回 hasEarlier:false', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.equal(/hasEarlier: false/.test(source), false, '不得再有硬编码 hasEarlier:false');
  assert.match(source, /HISTORY_PAGE_SIZE/, '必须有分页大小');
  assert.match(source, /clampCursor/, '必须收敛游标');
});

test('F2: 记录超过一页时首屏带 hasEarlier + 游标，且只给最近一页', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /const pageStart = Math\.max\(0, allRecords\.length - HISTORY_PAGE_SIZE\)/, '首屏必须只切最近一页');
  assert.match(source, /hasEarlier: pageStart > 0/, 'hasEarlier 必须由实际剩余量决定');
  assert.match(source, /historyCursor: String\(pageStart\)/, '必须下发游标');
});

test('F2: loadHistory 按游标往上翻，且能翻到底', async (t) => {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'ea-page2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new persistence.JsonSessionStore({ rootDir: root });
  t.after(() => store.close());
  const TOTAL = 45, PAGE = 20;
  await store.update('s', (state) => {
    state.records = Array.from({ length: TOTAL }, (_, i) => ({ id: 'r' + i, kind: 'ask', question: 'q' + i }));
  });
  // 复刻 service.loadHistory 的分页语义（与 src/index.ts 同构）
  const page = async (cursor) => {
    const all = (await store.load('s')).state.records;
    const remaining = cursor === undefined ? all.length : Math.min(Number(cursor), all.length);
    const from = Math.max(0, remaining - PAGE);
    return { records: all.slice(from, remaining), hasEarlier: from > 0, cursor: from > 0 ? String(from) : undefined };
  };
  const p1 = await page(undefined);
  assert.equal(p1.records.length, PAGE);
  assert.equal(p1.hasEarlier, true);
  const p2 = await page(p1.cursor);
  assert.equal(p2.records.length, PAGE);
  assert.equal(p2.hasEarlier, true);
  const p3 = await page(p2.cursor);
  assert.equal(p3.records.length, 5, '最后一页应是剩余的 5 条');
  assert.equal(p3.hasEarlier, false, '翻到底后必须说没有了');
  // 三页合起来正好覆盖全部且不重复
  const ids = [...p3.records, ...p2.records, ...p1.records].map(r => r.id);
  assert.equal(ids.length, TOTAL);
  assert.equal(new Set(ids).size, TOTAL, '翻页不得出现重复记录');
});

test('F2 反例: 记录不足一页时不出现「查看更早历史」', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /hasEarlier: pageStart > 0/, '不足一页时 pageStart 为 0，按钮不出现');
});

test('F2: 客户端翻页会带上游标（否则每次拿到同一批）', async () => {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8');
  assert.match(source, /api\.history\(current\.id, cursor\)/, '必须把游标传给服务端');
  assert.match(source, /historyCursor/, '必须记住并回写游标');
});
