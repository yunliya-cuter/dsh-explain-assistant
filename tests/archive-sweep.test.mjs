import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * §4/§8 F6 归档处理的**轻量周期检查**（实施文档 implementation-plan.md §8 三条腿的中间那条）。
 *
 * 这是**删用户数据**的功能，所以本文件的断言重心**不是**「归档的有没有被删掉」，
 * 而是**「不该删的有没有被保住」**：
 * - 会话还活着 → 必须原样保留；
 * - sessions 服务不可用/抛异常 → 必须保留，且不能抛出去。
 * 删对了只是功能，删错了是用户数据损失。
 */

const archive = await moduleFromSource('src/host/archive.ts');
const persistence = await moduleFromSource('src/host/persistence.ts');

/** 起一个真实的 store + 一个可控的假 sessions 服务。 */
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'ea-archive-'));
  const store = new persistence.JsonSessionStore({ rootDir });
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  t.after(() => store.close());
  return { rootDir, store };
}

async function seedSession(store, id) {
  await store.update(id, state => {
    state.records = [{ id: id + '-r1', kind: 'ask', status: 'complete', complete: true, question: '问', answerText: '答', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }];
  });
}

const fileFor = (rootDir, id) => join(rootDir, 'sessions', id + '.json');

function deps(rootDir, store, lookupSession, extra = {}) {
  return {
    listSessionIds: () => store.listSessionIds(),
    lookupSession,
    removeSession: id => store.remove(id),
    ...extra,
  };
}

/* ================================================================== *
 * 1) 会话仍然活着 → 必须原样保留（防误删主力断言）
 * ================================================================== */

test('防误删: 会话仍然活着时，记录必须原样保留', async (t) => {
  const { rootDir, store } = fixture(t);
  await seedSession(store, 'alive-session');
  const before = readFileSync(fileFor(rootDir, 'alive-session'), 'utf8');

  const result = await archive.sweepArchivedSessions(deps(rootDir, store, () => ({ id: 'alive-session', header: { cwd: '/tmp' }, records: [] })));

  assert.equal(result.removed, 0, '活着的会话绝不能被删');
  assert.equal(result.alive, 1, '必须被计入「还活着」');
  assert.ok(existsSync(fileFor(rootDir, 'alive-session')), '记录文件必须还在');
  assert.equal(readFileSync(fileFor(rootDir, 'alive-session'), 'utf8'), before, '内容必须一字不改');
});

test('防误删: 查不到会话（undefined）时也必须保留 —— 不能把「查不到」当「已归档」', async (t) => {
  const { rootDir, store } = fixture(t);
  await seedSession(store, 'missing-session');

  // 这是本任务最关键的一条：session 查不到的原因至少有三种（真被删 / 服务不可用 / 时机不对），
  // 从返回值上无法区分，所以一律判「拿不准」 → 保留。
  const result = await archive.sweepArchivedSessions(deps(rootDir, store, () => undefined));

  assert.equal(result.removed, 0, 'undefined 绝不能被当成已归档（否则服务抖一下就会清空用户记录）');
  assert.equal(result.unknown, 1, '必须计入「拿不准」');
  assert.ok(existsSync(fileFor(rootDir, 'missing-session')), '记录必须保留');
});

/* ================================================================== *
 * 2) sessions 服务不可用 / 抛异常 → 必须保留且不抛
 * ================================================================== */

test('防误删: sessions 服务抛异常时，记录必须保留且不抛给调用方', async (t) => {
  const { rootDir, store } = fixture(t);
  await seedSession(store, 'boom-session');
  await seedSession(store, 'ok-session');

  // 一个抛异常、一个正常，确保单个会话出错不会打断整轮扫描。
  const result = await archive.sweepArchivedSessions(deps(rootDir, store, (id) => {
    if (id === 'boom-session') throw new Error('sessions service down');
    return { id, header: {} };
  }));

  assert.equal(result.removed, 0, '服务异常时绝不允许删任何东西');
  assert.ok(existsSync(fileFor(rootDir, 'boom-session')), '抛异常的那个必须保留');
  assert.ok(existsSync(fileFor(rootDir, 'ok-session')), '另一个也必须保留（不能被连累）');
  assert.equal(result.examined, 2, '两个都看过');
  assert.equal(result.unknown, 1, '抛异常的算拿不准');
  assert.equal(result.alive, 1);
});

test('防误删: sessions 服务整体不可用（get 返回 undefined）时不删、不抛', async (t) => {
  const { rootDir, store } = fixture(t);
  await seedSession(store, 'no-service-1');
  await seedSession(store, 'no-service-2');

  // 模拟 ctx.get('sessions') 拿不到服务：lookup 恒 undefined
  const result = await archive.sweepArchivedSessions(deps(rootDir, store, () => undefined));
  assert.equal(result.removed, 0);
  assert.equal(result.unknown, 2);
  assert.ok(existsSync(fileFor(rootDir, 'no-service-1')));
  assert.ok(existsSync(fileFor(rootDir, 'no-service-2')));
});

test('防误删: lookupSession 返回垃圾值（null / 字符串 / 数字 / 数组）一律判拿不准并保留', async (t) => {
  const { rootDir, store } = fixture(t);
  const junk = [null, undefined, 'archived', 0, false, [], 'true', { archived: 'true' }, { archived: 1 }, { archived: null }];
  for (const [index, value] of junk.entries()) await seedSession(store, 'junk-' + index);

  const result = await archive.sweepArchivedSessions(deps(rootDir, store, (id) => junk[Number(id.split('-')[1])]));
  assert.equal(result.removed, 0, '垃圾值绝不能被当成已归档：' + JSON.stringify(junk));
  // 全部都必须判「拿不准」：字段存在但读不懂含义时，既不删也不能假装"活着"。
  assert.equal(result.unknown, junk.length, '读不懂的一律 unknown：' + JSON.stringify({ unknown: result.unknown, alive: result.alive }));
  for (const index of junk.keys()) assert.ok(existsSync(fileFor(rootDir, 'junk-' + index)), '记录必须保留：' + index);
});

test('防误删: 枚举自己的目录失败时，什么都不做且不抛', async (t) => {
  const { store } = fixture(t);
  const result = await archive.sweepArchivedSessions({
    listSessionIds: () => { throw new Error('readdir failed'); },
    lookupSession: () => ({ archived: true }),
    removeSession: () => { throw new Error('must not be called'); },
  });
  assert.equal(result.examined, 0);
  assert.equal(result.removed, 0, '连目录都列不出来时绝不能删任何东西');
});

test('防误删: 本地标记了 archived 但会话服务说它还活着 → 仍以「活着」为准，不删', async (t) => {
  const { rootDir, store } = fixture(t);
  await seedSession(store, 'flip-session');
  await store.update('flip-session', state => { state.archived = true; });
  const result = await archive.sweepArchivedSessions(deps(rootDir, store, () => ({ id: 'flip-session', header: { archived: false } })));
  assert.equal(result.removed, 0, '会话服务说活着就不能删');
  assert.ok(existsSync(fileFor(rootDir, 'flip-session')));
});

/* ================================================================== *
 * 3) 明确已归档 → 允许清理（功能本身）
 * ================================================================== */

test('明确判定已归档时才清理，且只删本插件自己的记录', async (t) => {
  const { rootDir, store } = fixture(t);
  await seedSession(store, 'archived-session');
  await seedSession(store, 'alive-session');

  const result = await archive.sweepArchivedSessions(deps(rootDir, store, (id) => (
    id === 'archived-session' ? { id, archived: true } : { id, header: {} }
  )));

  assert.equal(result.removed, 1, '明确已归档的应当被清理');
  assert.equal(result.alive, 1, '另一个保留');
  assert.equal(existsSync(fileFor(rootDir, 'archived-session')), false, '已归档的记录文件应被删除');
  assert.ok(existsSync(fileFor(rootDir, 'alive-session')), '活着的必须留着');
});

test('header.archived === true 与 status==="archived" 都算明确已归档', async (t) => {
  const { rootDir, store } = fixture(t);
  await seedSession(store, 'h1');
  await seedSession(store, 'h2');
  const result = await archive.sweepArchivedSessions(deps(rootDir, store, (id) => (
    id === 'h1' ? { id, header: { archived: true } } : { id, status: 'archived' }
  )));
  assert.equal(result.removed, 2);
});

test('只删本插件自己的 JSON 与图片快照，绝不碰工作区文件或共享附件', async (t) => {
  const { rootDir, store } = fixture(t);
  await seedSession(store, 'sweep-me');
  // 造一个「工作区」目录和一个「共享附件」目录，放文件进去
  const workspace = mkdtempSync(join(tmpdir(), 'ea-workspace-'));
  const sharedAttachments = mkdtempSync(join(tmpdir(), 'ea-attachments-'));
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(sharedAttachments, { recursive: true, force: true }); });
  writeFileSync(join(workspace, 'important.ts'), 'do not delete');
  writeFileSync(join(sharedAttachments, 'user-upload.png'), 'do not delete');
  // 本插件自己的图片快照
  const imageDir = join(rootDir, 'sessions', 'sweep-me', 'images');
  mkdirSync(imageDir, { recursive: true });
  writeFileSync(join(imageDir, 'snap.png'), 'plugin own snapshot');

  const result = await archive.sweepArchivedSessions(deps(rootDir, store, () => ({ id: 'sweep-me', archived: true })));

  assert.equal(result.removed, 1);
  assert.equal(existsSync(fileFor(rootDir, 'sweep-me')), false, '本插件 JSON 应被删');
  assert.equal(existsSync(imageDir), false, '本插件图片快照应随会话一起删');
  assert.ok(existsSync(join(workspace, 'important.ts')), '工作区文件绝不能动');
  assert.ok(existsSync(join(sharedAttachments, 'user-upload.png')), 'DSH 共享附件绝不能动');
});

test('删除失败时计入 failed 并继续处理下一个，不中断、不抛出', async (t) => {
  const { rootDir, store } = fixture(t);
  await seedSession(store, 'fail-del');
  await seedSession(store, 'ok-del');
  const result = await archive.sweepArchivedSessions({
    listSessionIds: () => store.listSessionIds(),
    lookupSession: () => ({ archived: true }),
    removeSession: async (id) => { if (id === 'fail-del') throw new Error('disk busy'); },
  });
  assert.equal(result.removed, 1, '成功的那个照删');
  assert.equal(result.failed, 1, '失败的计入 failed（真实实现里进入重试队列）');
  assert.ok(existsSync(fileFor(rootDir, 'fail-del')), '删除失败的记录仍在磁盘上，等重试');
});

/* ================================================================== *
 * 4) 轻量：不会被反复触发
 * ================================================================== */

test('轻量: 距上次扫描不足最小间隔时，后续触发被跳过', async () => {
  let clock = 1_000_000;
  let scans = 0;
  const sweeper = archive.createArchiveSweeper({
    listSessionIds: () => [], lookupSession: () => undefined, removeSession: async () => {},
    now: () => clock, intervalMs: archive.ARCHIVE_SWEEP_INTERVAL_MS,
  });
  const first = await sweeper.run('测试');
  assert.ok(first.result, '第一次应当真的扫描');
  scans++;
  // 时间只往前走了 1 秒 → 必须跳过
  clock += 1000;
  const second = await sweeper.run('测试');
  assert.equal(second.skipped, 'too-soon', '短时间内不得反复触发');
  // 走满间隔后才允许再扫
  clock += archive.ARCHIVE_SWEEP_INTERVAL_MS;
  const third = await sweeper.run('测试');
  assert.ok(third.result, '间隔够了才允许再扫');
});

test('轻量: 最小间隔不得短于 5 分钟', () => {
  const sweeper = archive.createArchiveSweeper({
    listSessionIds: () => [], lookupSession: () => undefined, removeSession: async () => {}, intervalMs: 1000,
  });
  assert.equal(sweeper.intervalMs, archive.ARCHIVE_SWEEP_INTERVAL_MS, '传更短的间隔也必须被抬到 5 分钟');
  assert.equal(archive.ARCHIVE_SWEEP_INTERVAL_MS, 5 * 60 * 1000);
});

test('轻量: 上一轮还没跑完时，新的触发被跳过（不并发堆积）', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sweeper = archive.createArchiveSweeper({
    listSessionIds: async () => { await gate; return []; },
    lookupSession: () => undefined, removeSession: async () => {},
  });
  const running = sweeper.run('测试');
  const concurrent = await sweeper.run('测试');
  assert.equal(concurrent.skipped, 'busy', '上一轮未结束时必须跳过');
  release();
  assert.ok((await running).result !== undefined);
});

test('轻量: stop() 之后不再触发', async () => {
  const sweeper = archive.createArchiveSweeper({ listSessionIds: () => [], lookupSession: () => undefined, removeSession: async () => {} });
  sweeper.start();
  sweeper.stop();
  const after = await sweeper.run('测试');
  assert.equal(after.skipped, 'too-soon', '已停止的扫描器不应再扫');
});

/* ================================================================== *
 * 5) store.listSessionIds 自身
 * ================================================================== */

test('store.listSessionIds 只枚举本插件目录下的会话文件，且忽略损坏备份', async (t) => {
  const { rootDir, store } = fixture(t);
  await seedSession(store, 'aaa');
  await seedSession(store, 'bbb');
  // 隔离损坏文件留下的备份（真实命名：<id>.json.corrupt.<ts>）不能被当成会话
  writeFileSync(join(rootDir, 'sessions', 'ccc.json.corrupt.123456'), '{}');
  const ids = (await store.listSessionIds()).sort();
  assert.deepEqual(ids, ['aaa', 'bbb'], '只应列出真实的会话文件：' + JSON.stringify(ids));
});

test('store.listSessionIds 在目录不存在时回空数组，不抛异常', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ea-noexist-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const store = new persistence.JsonSessionStore({ rootDir: join(rootDir, 'never-created') });
  t.after(() => store.close());
  assert.deepEqual(await store.listSessionIds(), []);
});

/* ================================================================== *
 * 6) 接线：src/index.ts 真的用了它，且用的是已有的删除通道
 * ================================================================== */

test('接线: index.ts 启动周期检查、停止时清定时器、复用 store.remove（不另写删除）', async () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /createArchiveSweeper/, '必须真的构造周期检查');
  assert.match(source, /archiveSweeper\?\.start\(\)/, '必须启动它');
  assert.match(source, /archiveSweeper\?\.stop\(\)/, '插件停止时必须清掉定时器');
  assert.match(source, /removeSession: \(id: string\) => store\.remove\(id\)/, '删除必须走已有的 store.remove（复用 retryPendingDeletes 机制）');
  assert.match(source, /store\.listSessionIds\(\)/, '枚举必须来自我们自己的存储目录');
  // 不硬造归档事件监听
  assert.equal(/ctx\.on\(['"]archive/.test(source), false, '不得硬造不存在的归档事件监听');
});
