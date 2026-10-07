import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * task-27 独立交付：**浮窗位置保存**（POST /api/explain-assistant/geometry）的持久化集成测试。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * contracts 里一直有 `AssistantState.geometry` 字段、磁盘上也留着它，
 * 但**从未有任何写入方** —— 用户拖好位置、关掉浮窗再打开又回到默认位置。
 * 本轮补上了写入路径（index.ts 的 saveGeometry + routes.ts 的 geometry 分支）。
 *
 * ── 本文件的硬要求：用**真实 JsonSessionStore**，不用 stub ────────────
 * 「写盘」这种事只有真读文件才算验过：stub 会把「有没有真的落盘」「重启后还在不在」
 * 「已删文件会不会被重建」这三件事全部掩盖掉（这正是本项目反复踩过的坑）。
 *
 * 四条断言（与任务一一对应）：
 *   1. 写入后 **state.geometry 真的落到磁盘文件里**（读文件核对，不只看返回值）
 *   2. **重新构造一个 store 再读**（模拟重启）→ 位置还在
 *   3. **已归档会话**调用它 → 不写盘、且不得把已删文件重建出来
 *   4. 四个数里有一个**不是有限数** → 不写盘（服务层也要挡住，不能只靠路由挡）
 */

const GEOMETRY_PATH = '/api/explain-assistant/geometry';

/** 起一个真宿主（src/index.ts 真路由 + 真 JsonSessionStore）。 */
async function startHost() {
  const home = mkdtempSync(join(tmpdir(), 'ea-geom-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  try {
    const index = await moduleFromSource('src/index.ts');
    index.apply({
      llm: { listProviders: async () => [], listModels: async () => [] },
      sessionQuery: {},
      connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
      effect: () => {}, get: () => undefined,
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
  const rootDir = join(home, 'explain-assistant');
  const call = (path, body, method = 'POST') => {
    const entry = routes.get(path.split('?')[0]);
    assert.ok(entry, '路由未注册：' + path);
    const handler = typeof entry === 'function' ? entry : entry.fetch;
    return handler(new Request('http://h' + path, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  };
  return {
    home, rootDir, routes,
    recordPath: (id) => join(rootDir, 'sessions', id + '.json'),
    /** 直接读磁盘上的 state（不看内存、不看返回值）。 */
    readDisk(id) {
      const path = join(rootDir, 'sessions', id + '.json');
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    },
    saveGeometry: (id, geometry) => call(GEOMETRY_PATH + '?sessionId=' + id, {
      schemaVersion: 1, sessionId: id, operation: 'geometry', payload: { geometry },
    }),
    restore() { rmSync(home, { recursive: true, force: true }); },
  };
}

/** 用真 store 造一个会话（可指定 archived）。 */
async function seed(rootDir, id, mutate = () => {}) {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const store = new persistence.JsonSessionStore({ rootDir });
  try { await store.update(id, mutate); } finally { await store.close(); }
}

const GOOD = { x: 120, y: 64, width: 480, height: 600 };

/* ================================================================== *
 * 1) 写入后真的落到磁盘文件里
 * ================================================================== */

test('geometry 持久化: 写入后 state.geometry 真的落到磁盘文件里（读文件核对，不只看返回值）', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'g1');
    assert.equal(host.readDisk('g1').geometry, undefined, '前置：一开始没有位置');

    const response = await host.saveGeometry('g1', GOOD);
    assert.equal(response.status, 200, '保存位置必须成功');

    // 关键：从**文件**里读，而不是看 response 或内存
    const onDisk = host.readDisk('g1');
    assert.deepEqual(onDisk.geometry, GOOD, '磁盘上必须真的写下了位置，实际：' + JSON.stringify(onDisk.geometry));
  } finally { host.restore(); }
});

/* ================================================================== *
 * 2) 重启后仍在
 * ================================================================== */

test('geometry 持久化: 重新构造 store 再读（模拟重启）→ 位置还在', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'g2');
    await host.saveGeometry('g2', GOOD);

    // 模拟「进程重启」：全新的 store 实例（不共享任何内存缓存），只从磁盘读
    const persistence = await moduleFromSource('src/host/persistence.ts');
    const fresh = new persistence.JsonSessionStore({ rootDir: host.rootDir });
    const loaded = await fresh.load('g2');
    await fresh.close();

    assert.deepEqual(loaded.state.geometry, GOOD, '重启后重新读磁盘，位置必须还在（这正是本功能的全部意义）');
  } finally { host.restore(); }
});

test('geometry 持久化: 二次保存会覆盖旧位置（而不是叠加或忽略）', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'g3');
    await host.saveGeometry('g3', GOOD);
    const moved = { x: 10, y: 20, width: 300, height: 400 };
    await host.saveGeometry('g3', moved);
    assert.deepEqual(host.readDisk('g3').geometry, moved, '第二次保存必须覆盖第一次');
  } finally { host.restore(); }
});

/* ================================================================== *
 * 3) 已归档会话：不写盘，且不得重建已删文件
 * ================================================================== */

test('geometry 持久化: 已归档会话调用它 → 不写盘，且不得把已删文件重建出来', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'g4');
    const path = host.recordPath('g4');
    assert.ok(existsSync(path), '前置：文件存在');

    // 归档：文件被删除（forget 会真的删）
    const forgetEntry = host.routes.get('/api/explain-assistant/forget');
    const forgetHandler = typeof forgetEntry === 'function' ? forgetEntry : forgetEntry.fetch;
    await forgetHandler(new Request('http://h/api/explain-assistant/forget?sessionId=g4', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, sessionId: 'g4', operation: 'forget', payload: {} }),
    }));
    assert.equal(existsSync(path), false, '前置：归档后文件已被删除');

    // 迟到的位置保存（浮窗还开着 / 用户在拖动）不得把文件重建出来
    await host.saveGeometry('g4', GOOD).catch(() => undefined);
    assert.equal(existsSync(path), false,
      '已归档会话的位置保存绝不能把已删除的记录文件重建出来（store.update 对不存在的文件会 load→save 重建）');
    assert.equal(host.readDisk('g4'), undefined, '磁盘上不该出现这个文件');
  } finally { host.restore(); }
});

test('geometry 持久化: 已归档（archived=true 但文件仍在）时不写盘', async () => {
  const host = await startHost();
  try {
    // 造一个「标记了 archived 但文件还在」的会话：归档标记本身就是拒绝写入的依据
    await seed(host.rootDir, 'g5', s => { s.archived = true; });
    const before = host.readDisk('g5');
    assert.equal(before.archived, true, '前置：已标记归档');

    await host.saveGeometry('g5', GOOD).catch(() => undefined);
    const after = host.readDisk('g5');
    assert.equal(after.geometry, undefined, '已归档会话不得被写入位置');
  } finally { host.restore(); }
});

/* ================================================================== *
 * 4) 非有限数：路由与服务层都要挡住
 * ================================================================== */

test('geometry 持久化: 四个数里有一个不是有限数 → 不写盘（四个字段逐一试）', async () => {
  const host = await startHost();
  try {
    const badValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '120', null, undefined];
    for (const key of ['x', 'y', 'width', 'height']) {
      for (const bad of badValues) {
        const id = 'g6-' + key + '-' + String(bad);
        await seed(host.rootDir, id);
        const geometry = { ...GOOD, [key]: bad };
        const response = await host.saveGeometry(id, geometry).catch(() => undefined);
        if (response) assert.notEqual(response.status, 200, '非法位置必须被拒绝：' + key + '=' + String(bad));
        assert.equal(host.readDisk(id).geometry, undefined,
          '非法位置绝不能写盘：' + key + '=' + String(bad) + '，实际写入了 ' + JSON.stringify(host.readDisk(id).geometry));
      }
    }
  } finally { host.restore(); }
});

test('geometry 持久化: 缺字段 / 非对象 一律不写盘', async () => {
  const host = await startHost();
  try {
    const cases = [
      ['缺 height', { x: 1, y: 2, width: 3 }],
      ['缺全部', {}],
      ['null', null],
      ['数组', [1, 2, 3, 4]],
      ['字符串', 'x=1'],
    ];
    for (const [label, geometry] of cases) {
      const id = 'g7-' + label.replace(/[^a-z0-9]/gi, '');
      await seed(host.rootDir, id);
      await host.saveGeometry(id, geometry).catch(() => undefined);
      assert.equal(host.readDisk(id).geometry, undefined, '非法输入不得写盘（' + label + '）');
    }
  } finally { host.restore(); }
});

test('geometry 持久化: 服务层有自己的有限数校验（源码断言 —— 该分支经公开路由**不可达**，如实说明）', async () => {
  // 诚实说明这条测试的档位：**仅读码断言，不是行为实测**。
  //
  // 为什么测不到行为：routes.ts 在调用 service.saveGeometry **之前**就先校验了四个有限数，
  // 非法值在那里就被 400 拒掉，根本到不了服务层。而 service 是 index.ts 里的闭包，
  // 外部拿不到实例。所以「服务层自己也挡」这件事，目前**只能靠源码断言**证明存在。
  //
  // （我没有为了测它去改 src/ —— 本轮写作用域禁止改 src/，而且为一个不可达分支加测试钩子
  //   反而会扩大公开面。这条如实标注为「仅读码推断」。）
  const { readFileSync } = await import('node:fs');
  const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(indexSource, /Number\.isFinite/, '服务层必须自己校验有限数（不能只信路由）');
  assert.match(indexSource, /if \(!valid\) return geometry;/, '服务层校验失败必须直接返回、不写盘');
  assert.match(indexSource, /if \(await isForgotten\(id\)\) return geometry;/, '服务层必须过 isForgotten（防重建已删文件）');
});
