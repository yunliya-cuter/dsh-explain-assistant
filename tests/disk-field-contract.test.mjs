import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 落库字段的「写—读往返契约」。
 *
 * ── 为什么要建这个文件（本轮两条缺陷的共同根因）──────────────────────
 * 缺陷2：磁盘上写的是 `answerText`，occupancy 读的是 `answer` —— **字段名对不上**，
 *        于是回答正文一个字都没算进占用，450 条测试全绿却没人发现。
 * 缺陷4：浮窗位置写进了宿主（saveGeometry），**却没人读回客户端** —— **只写不读**，
 *        用户拖动位置、整页重载后照样回默认，功能等于不存在。
 * 两条都是「**写/读不成对**」。本文件把这个类堵住：用**真 store 真写盘、真读回**，
 * 逐一断言每个字段「写得进、读得回、名字一致」，并额外用**自动发现**保证
 * 「将来新增字段却忘了接线」时闸会响，而不是靠人记得。
 *
 * 与 real-shape-replay.test.mjs 的分工：
 *   · 那个文件用**磁盘上已有的历史数据**回放（防「假数据与真数据不同形」）；
 *   · 本文件**主动写入再读回**（防「写了没人读」），两者互补。
 */

const ROOT = new URL('../src/', import.meta.url);

/** 起一个真宿主（真路由 + 真 JsonSessionStore）。 */
async function startHost() {
  const home = mkdtempSync(join(tmpdir(), 'ea-contract-'));
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
    home, rootDir,
    call,
    recordPath: id => join(rootDir, 'sessions', id + '.json'),
    /** **直接读磁盘文件**（绕过内存与返回值，这才是「真的写进去了」）。 */
    readDisk(id) {
      const path = join(rootDir, 'sessions', id + '.json');
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    },
    allDiskStates() {
      const dir = join(rootDir, 'sessions');
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(dir, n), 'utf8')));
    },
    restore() { rmSync(home, { recursive: true, force: true }); },
  };
}

async function seed(rootDir, id, mutate = () => {}) {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const store = new persistence.JsonSessionStore({ rootDir });
  try { await store.update(id, mutate); } finally { await store.close(); }
}

/**
 * 契约表：磁盘字段 → 谁写 → 谁读。
 *
 * 每一条都对应一个**真实的写点**与**真实的读点**（读点写在 notes 里，便于以后核对）。
 * 新增落库字段时，这张表必须同步加一行；否则下面的「自动发现」用例会失败。
 */
const DISK_FIELD_CONTRACT = [
  { field: 'schemaVersion', writer: 'persistence.ts 建文件时写入', reader: '（版本字段，读侧不解释）', notes: '磁盘形状版本号' },
  { field: 'sessionId', writer: 'persistence.ts', reader: 'loadState 原样带出', notes: '会话标识' },
  { field: 'historyRevision', writer: 'persistence.ts / 记录变更时自增', reader: '客户端用于判断历史是否需要重取', notes: '' },
  { field: 'createdAt', writer: 'persistence.ts 建文件时写入', reader: '（无读点：记录时间是 records[].startedAt）', notes: '文件创建时间，仅留档' },
  { field: 'updatedAt', writer: 'persistence.ts 每次保存更新', reader: '（无读点，仅留档）', notes: '文件最后写入时间；目前界面不显示它，保留是为了排查「什么时候被改过」' },
  { field: 'records', writer: 'src/host/routes.ts saveRecord（追加）', reader: 'src/index.ts loadState / loadHistory', notes: '记录数组本体' },
  { field: 'records[].usage', writer: 'routes.ts saveRecord', reader: '（无读点：仅落库备查）', notes: 'token 用量' },
  { field: 'records[].id', writer: 'routes.ts: requestId', reader: 'loadHistoryResult 按 id 查找 / 客户端去重', notes: '' },
  { field: 'records[].answerText', writer: 'routes.ts saveRecord', reader: 'src/index.ts:413 history 归一、occupancy.answerTextOf、overlay 详情', notes: '**缺陷2 就在这条**：磁盘是 answerText，曾被读成 answer' },
  { field: 'records[].reasoningText', writer: 'routes.ts saveRecord', reader: 'overlay.tsx:399/470（reasoningText ?? reasoning）', notes: '' },
  { field: 'records[].question', writer: 'routes.ts saveRecord', reader: 'src/index.ts 归一、占用计算、overlay 渲染', notes: '' },
  { field: 'records[].status', writer: 'routes.ts saveRecord', reader: 'overlay.tsx:417 判断是否为未完成', notes: '' },
  { field: 'records[].complete', writer: 'routes.ts saveRecord', reader: 'overlay.tsx:417 / occupancy 不读', notes: '' },
  { field: 'records[].kind', writer: 'routes.ts saveRecord（op）', reader: 'src/index.ts:410 只取 ask 作为历史', notes: '' },
  { field: 'records[].reason', writer: 'routes.ts saveRecord（deriveRecordReason）', reader: 'src/index.ts:413 透传 / prompts 上下文 / overlay 渲染原因', notes: '本轮 D1 新增' },
  { field: 'records[].startedAt', writer: 'routes.ts saveRecord', reader: 'index.ts:411 压缩时间线对比、occupancy.carriedRecords、overlay 时间', notes: '' },
  { field: 'records[].updatedAt', writer: 'routes.ts saveRecord', reader: '（仅落库，无读点）', notes: '记录最后更新时间；排序与「更早历史」用的是 startedAt，所以读侧不解释它' },
  { field: 'records[].evidence', writer: 'routes.ts saveRecord（buildRecordContent）', reader: 'overlay historyDetailNodes、loadHistoryResult 分页', notes: '' },
  { field: 'records[].tools', writer: 'routes.ts saveRecord', reader: '同上', notes: '' },
  { field: 'records[].images', writer: 'routes.ts saveRecord', reader: '同上', notes: '' },
  { field: 'geometry', writer: 'src/index.ts saveGeometry（POST /geometry）', reader: '**客户端 src/client/index.ts:340-347 读回**', notes: '**缺陷4 就在这条**：写了没人读，重载后位置丢失' },
  { field: 'unread', writer: 'src/index.ts markUnread / markRead', reader: 'loadState 下发 → 客户端 unread 徽标', notes: '' },
  { field: 'compactState', writer: 'src/index.ts saveCompact', reader: 'loadState 下发 → 客户端 compactState 合并渲染', notes: '' },
  { field: 'explicitModel', writer: 'src/index.ts selectModel', reader: 'loadState 读回 model 下发', notes: '' },
  { field: 'archived', writer: 'src/index.ts forget（归档）', reader: '归档判定 / 写入侧 isForgotten', notes: '' },
];

/* ================================================================== *
 * 1) 真实写盘 → 真实读回：逐字段往返
 * ================================================================== */

test('字段契约: records 写入后真落盘，且每个字段读回来名字一致（answerText 不是 answer）', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'c1', s => { s.explicitModel = { provider: 'p', model: 'm' }; s.records = []; });
    // 造一条真实记录（走 service.saveRecord，即生产路径）
    const persistence = await moduleFromSource('src/host/persistence.ts');
    const store = new persistence.JsonSessionStore({ rootDir: host.rootDir });
    await store.update('c1', s => {
      s.records = [{
        id: 'r1', kind: 'ask', status: 'complete', complete: true, question: '问题正文',
        answerText: '回答正文', reasoningText: '推理正文', usage: { inputTokens: 1 }, evidence: [], tools: [], images: [],
        startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z', reason: 'timeout',
      }];
    });
    await store.close();

    const onDisk = host.readDisk('c1').records[0];
    // 写得进
    assert.equal(onDisk.answerText, '回答正文', '磁盘上必须是 answerText');
    assert.equal(onDisk.reasoningText, '推理正文');
    assert.equal(onDisk.question, '问题正文');
    assert.equal(onDisk.reason, 'timeout');
    // 名字一致（缺陷2 的那一跳）
    assert.equal('answer' in onDisk, false, '磁盘上不该出现 answer（那是客户端本地形状）');
    assert.equal('reasoning' in onDisk, false);
    // 读得回：走 host 的 history 归一
    const history = await (await host.call('/api/explain-assistant/history?sessionId=c1', undefined, 'GET')).json();
    assert.equal(history.payload.records.length, 1, '读回的记录数必须为 1');
    assert.equal(history.payload.records[0].answerText, '回答正文', '读回时仍是 answerText');
  } finally { host.restore(); }
});

test('字段契约: geometry 真写盘、真读回（缺陷4：只写不读等于没做）', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'c2');
    const good = { x: 10, y: 20, width: 300, height: 400 };
    const response = await host.call('/api/explain-assistant/geometry?sessionId=c2', {
      schemaVersion: 1, sessionId: 'c2', operation: 'geometry', payload: { geometry: good },
    });
    assert.equal(response.status, 200, '保存位置必须成功');
    assert.deepEqual(host.readDisk('c2').geometry, good, '必须真的写进磁盘');

    // **读回**：state 路由必须把 geometry 下发（否则客户端拿不到 = 缺陷4 原形）
    const state = await (await host.call('/api/explain-assistant/state?sessionId=c2', undefined, 'GET')).json();
    assert.deepEqual(state.payload.geometry, good, 'state 必须把 geometry 下发回客户端');
  } finally { host.restore(); }
});

test('字段契约: unread / compactState / explicitModel 都真写盘且能读回', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'c3');
    const persistence = await moduleFromSource('src/host/persistence.ts');
    const store = new persistence.JsonSessionStore({ rootDir: host.rootDir });
    await store.update('c3', s => {
      s.unread = true;
      s.compactState = { status: 'complete', summary: '摘要正文', createdAt: '2026-01-01T00:00:00.000Z' };
      s.explicitModel = { provider: 'syn', model: 'syn-model' };
    });
    await store.close();

    const disk = host.readDisk('c3');
    assert.equal(disk.unread, true, 'unread 必须落盘');
    assert.equal(disk.compactState.summary, '摘要正文', 'compactState 必须落盘');
    assert.equal(disk.explicitModel.model, 'syn-model', 'explicitModel 必须落盘');

    const state = await (await host.call('/api/explain-assistant/state?sessionId=c3', undefined, 'GET')).json();
    assert.equal(state.payload.unread, true, '读回 unread');
    assert.equal(state.payload.compactState.summary, '摘要正文', '读回 compactState');
    assert.equal(state.payload.model?.model, 'syn-model', '读回 model（由 explicitModel 归一）');
  } finally { host.restore(); }
});

test('字段契约: state 下发的 records 用 answerText，客户端消费它（名字一致）', async () => {
  const host = await startHost();
  try {
    await seed(host.rootDir, 'c4', s => {
      s.records = [{ id: 'r', kind: 'ask', status: 'complete', complete: true, question: 'q', answerText: '正文', reasoningText: '', evidence: [], tools: [], images: [], startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }];
    });
    const state = await (await host.call('/api/explain-assistant/state?sessionId=c4', undefined, 'GET')).json();
    const record = state.payload.records[0];
    assert.equal(record.answerText, '正文', 'state 下发的记录必须带 answerText');

    // 客户端消费点：overlay 的判定是 answerText ?? answer（两个来源都认）。
    // 这条断言把「客户端读的字段名」与「磁盘字段名」钉在一起 —— 就是缺陷2 的那一跳。
    const overlay = readFileSync(new URL('client/overlay.tsx', ROOT), 'utf8');
    assert.match(overlay, /record\.answerText === 'string' && record\.answerText\s*\? record\.answerText : record\.answer/,
      'overlay 必须优先读 answerText（磁盘字段名）');
    // occupancy 读侧的唯一判定处
    const occupancy = readFileSync(new URL('host/occupancy.ts', ROOT), 'utf8');
    assert.match(occupancy, /if \(typeof record\.answerText === 'string'\) return record\.answerText;/,
      'occupancy 必须先读 answerText');
  } finally { host.restore(); }
});

/* ================================================================== *
 * 2) 自动发现：磁盘上出现的字段必须在契约表里登记
 * ================================================================== */

test('字段契约 自动发现: 磁盘上出现的字段名必须登记在契约表里（新增字段忘了接线就会响）', async () => {
  const host = await startHost();
  try {
    // 用真实写入产生一份「全字段」文件，再枚举它出现的所有字段名
    await seed(host.rootDir, 'c5', s => {
      s.explicitModel = { provider: 'p', model: 'm' };
      s.unread = true;
      s.archived = false;
      s.compactState = { status: 'complete', summary: '摘要', createdAt: '2026-01-01T00:00:00.000Z' };
      s.records = [{
        id: 'r', kind: 'ask', status: 'interrupted', complete: false, question: 'q',
        answerText: 'a', reasoningText: 'r', usage: { inputTokens: 1 }, reason: 'timeout',
        evidence: [{ schemaVersion: 1, sessionId: 'c5', kind: 'workspace_file', title: 't', summary: 's', source: 'p', evidenceState: 'observed', capturedAt: '2026-01-01T00:00:00.000Z', truncated: false, incomplete: false }],
        tools: [{ callId: 'x', tool: 't', status: 'ok', arguments: {}, result: {}, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z' }],
        images: [{ sha256: 'x', relativePath: 'p.png' }],
        startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
      }];
    });
    await host.call('/api/explain-assistant/geometry?sessionId=c5', {
      schemaVersion: 1, sessionId: 'c5', operation: 'geometry', payload: { geometry: { x: 1, y: 2, width: 3, height: 4 } },
    });

    // **真的枚举磁盘**（不是写死一份名单当摆设）
    const disk = host.readDisk('c5');
    assert.ok(disk, '文件必须存在');
    const stateFields = Object.keys(disk);
    const recordFields = Object.keys(disk.records[0]);
    const nestedFields = [
      ...Object.keys(disk.records[0].evidence[0]).map(k => 'records[].evidence[].' + k),
      ...Object.keys(disk.records[0].tools[0]).map(k => 'records[].tools[].' + k),
      ...Object.keys(disk.records[0].images[0]).map(k => 'records[].images[].' + k),
    ];
    assert.ok(stateFields.length > 0 && recordFields.length > 0, '前置：必须真的枚举到字段');

    const registered = new Set(DISK_FIELD_CONTRACT.map(entry => entry.field));
    const missing = [];
    for (const key of stateFields) if (!registered.has(key)) missing.push(key);
    for (const key of recordFields) if (!registered.has('records[].' + key)) missing.push('records[].' + key);
    for (const key of nestedFields) {
      // 嵌套元素字段：登记到 records[].evidence / tools / images 这一层即可
      if (!registered.has('records[].evidence') && !registered.has('records[].tools') && !registered.has('records[].images')) missing.push(key);
    }
    assert.deepEqual(missing, [],
      '这些字段出现在磁盘上却没登记进契约表（新增字段请补 DISK_FIELD_CONTRACT，并确认读侧接线）：' + JSON.stringify(missing));
  } finally { host.restore(); }
});

test('字段契约 自动发现 反例: 新增一个未登记字段必须被这条闸抓到', async () => {
  // 证明「自动发现」不是空转：手动往磁盘塞一个契约表里没有的字段，枚举逻辑必须发现它。
  const host = await startHost();
  try {
    await seed(host.rootDir, 'c6', s => { s.brandNewField = 'x'; });
    const disk = host.readDisk('c6');
    const registered = new Set(DISK_FIELD_CONTRACT.map(e => e.field));
    const missing = Object.keys(disk).filter(k => !registered.has(k));
    assert.ok(missing.includes('brandNewField'),
      '未登记字段必须被枚举出来（否则这条闸是摆设）；实际 missing = ' + JSON.stringify(missing));
  } finally { host.restore(); }
});

/* ================================================================== *
 * 3) 契约表自身的一致性
 * ================================================================== */

test('字段契约 表自身: 每条登记项都写清了写点与读点，且无重复', () => {
  const seen = new Set();
  for (const entry of DISK_FIELD_CONTRACT) {
    assert.ok(entry.field && entry.writer && entry.reader, '每条契约必须写清 字段/写点/读点：' + JSON.stringify(entry));
    assert.equal(seen.has(entry.field), false, '契约表出现重复登记：' + entry.field);
    seen.add(entry.field);
  }
  // 「只写不读」的字段必须显式标注，防止悄悄多出一个没人读的字段
  const writeOnly = DISK_FIELD_CONTRACT.filter(e => e.reader.includes('无读点') || e.reader.includes('不解释') || e.notes.includes('仅留档'));
  for (const entry of writeOnly) {
    assert.ok(entry.notes.length > 0, '「只写不读」的字段必须写明原因：' + entry.field);
  }
});
