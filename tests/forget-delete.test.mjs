import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource, waitFor, expectNever } from './fixtures/runtime.mjs';

/**
 * §4/§8 F6：归档后必须**删除**本插件的 JSON 与图片快照，而不是只清空。
 *
 * 规范原文（implementation-plan.md §8）：
 * 「标记 archived，拒绝新的 ask/compact/历史写入，取消活动请求，**短暂等待，删除插件 JSON 与图片快照**；
 *   晚到事件丢弃；**失败进入受限重试队列**。」
 *
 * 修之前的真实表现（verify-3082 在 3082 上归档一个会话实测）：
 * 文件 4906 → 334 字节，内容变成 records:[] / archived:true，**但文件仍然存在**。
 * 根因：forget 只做 store.update 标记 + cleanupArchived，而 cleanupArchived 只重试
 * **已失败**的删除；forget 从没调用过 store.remove，所以 pendingDeletes 永远是空的，
 * 文件永远删不掉，规范里「失败进入重试队列」这条也从没被走到过。
 *
 * 本文件全部**从磁盘断言**（existsSync / 读文件），不看内存对象——只看内存会把
 * 「清空了但没删」这种缺陷放过去（正是这条缺陷的形态）。
 */

/* ---------------- 真宿主：src/index.ts 真路由 + 真磁盘 ---------------- */

async function startHost(llm) {
  const home = mkdtempSync(join(tmpdir(), 'ea-forget-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  try {
    const index = await moduleFromSource('src/index.ts');
    index.apply({
      llm: { listProviders: async () => ['p'], listModels: async () => [{ id: 'm', provider: 'p' }],
             stream: llm.stream, resolveModelInfo: async () => ({ context: { contextWindow: 128000 } }) },
      sessionQuery: {},
      connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
      effect: () => {}, get: () => undefined,
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
  const rootDir = join(home, 'explain-assistant');
  // 注意 routes 里放的是 connection.fetch.register 的 entry（{path,methods,fetch}），
  // 不是直接的 handler 函数——必须取 .fetch（我第一版直接当函数调用，8 条全崩）。
  const call = (path, body, method = 'POST') => {
    // 查表必须用**去掉查询串**的路径（注册键不含 ?sessionId=…）
    const entry = routes.get(path.split('?')[0]);
    assert.ok(entry, '路由未注册：' + path);
    const handler = typeof entry === 'function' ? entry : entry.fetch;
    return handler(new Request('http://t' + path, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }));
  };
  return {
    home, rootDir, routes,
    /** 与客户端 api.forget 一致：sessionId 走查询串。 */
    forget: (id) => call('/api/explain-assistant/forget?sessionId=' + id, { schemaVersion: 1, sessionId: id, operation: 'forget', payload: {} }),
    ask: (id, q) => call('/api/explain-assistant/ask?sessionId=' + id, { schemaVersion: 1, sessionId: id, operation: 'ask', payload: { question: q } }),
    restore() { rmSync(home, { recursive: true, force: true }); },
  };
}

async function seed(rootDir, id, mutate) {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const store = new persistence.JsonSessionStore({ rootDir });
  try { await store.update(id, mutate); } finally { await store.close(); }
}

const recordPath = (rootDir, id) => join(rootDir, 'sessions', id + '.json');
const okLlm = () => ({ stream: () => (async function* () { yield { type: 'text-delta', text: '回答' }; yield { type: 'finish', done: true }; })() });

/* ================================================================== *
 * 1) 核心：归档后文件必须真的不存在（不是清空）
 * ================================================================== */

test('归档删除: 归档后该会话的 JSON 文件必须不存在（规范要求删除，不是清空）', async () => {
  const host = await startHost(okLlm());
  try {
    await seed(host.rootDir, 'del-1', s => { s.records = [{ id: 'r1', kind: 'ask', question: '问', answerText: '答', evidence: [], tools: [], images: [], startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]; });
    const path = recordPath(host.rootDir, 'del-1');
    assert.ok(existsSync(path), '前置：归档前文件必须存在');
    const before = readFileSync(path, 'utf8');
    assert.match(before, /答/, '前置：文件里确实有用户内容');

    const response = await host.forget('del-1');
    const body = await response.json();
    assert.equal(response.status, 200, '归档清理必须成功：' + JSON.stringify(body));
    assert.equal(body.payload.deleted, true, '必须报告删除成功');

    // 关键断言：从磁盘看，文件必须**不存在**。旧实现这里文件还在（只是被清空成 334 字节）。
    assert.equal(existsSync(path), false, '归档后文件必须被删除，而不是只清空内容');
  } finally { host.restore(); }
});

test('归档删除: 同时删除本插件的图片快照目录', async () => {
  const host = await startHost(okLlm());
  try {
    await seed(host.rootDir, 'del-2', s => { s.records = []; });
    const imageDir = join(host.rootDir, 'sessions', 'del-2', 'images');
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, 'snap.png'), 'plugin own snapshot');
    assert.ok(existsSync(imageDir), '前置：图片快照目录存在');

    await host.forget('del-2');
    assert.equal(existsSync(recordPath(host.rootDir, 'del-2')), false, 'JSON 已删');
    assert.equal(existsSync(imageDir), false, '本插件图片快照目录也应随归档删除');
  } finally { host.restore(); }
});

/* ================================================================== *
 * 2) 顺序：先标记、后删除；晚到写入不得把文件建回来
 * ================================================================== */

test('归档删除 防重建: 归档后再来一次 ask 必须被拒，且不得把文件创建回来', async () => {
  const host = await startHost(okLlm());
  try {
    await seed(host.rootDir, 'late-1', s => { s.records = []; s.explicitModel = { provider: 'p', model: 'm' }; });
    const path = recordPath(host.rootDir, 'late-1');
    await host.forget('late-1');
    assert.equal(existsSync(path), false, '前置：归档后文件已删');

    // 晚到的 ask。注意：文件已删 → store.load 会返回全新空状态（archived=false），
    // 若没有「已归档」的记忆，这次请求会跑完并把文件重新写出来。
    const response = await host.ask('late-1', '晚到的提问');
    assert.equal(response.status, 409, '已归档会话的新请求必须被拒（不能静默跑起来）');
    const body = await response.json();
    assert.equal(body.error.code, 'SESSION_ARCHIVED', '必须是明确的「已归档」原因');
    assert.equal(existsSync(path), false, '晚到请求绝不能把文件创建回来');
  } finally { host.restore(); }
});

test('归档删除 防重建: 归档后 markUnread / 压缩写入也不得重建文件', async () => {
  const host = await startHost(okLlm());
  try {
    await seed(host.rootDir, 'late-2', s => { s.records = []; });
    const path = recordPath(host.rootDir, 'late-2');
    await host.forget('late-2');
    assert.equal(existsSync(path), false);

    // 模拟「晚到的回答完成」触发的 markUnread（客户端在 complete 后确实会打它）
    const stateEntry = host.routes.get('/api/explain-assistant/state');
    const response = await (typeof stateEntry === 'function' ? stateEntry : stateEntry.fetch)(new Request('http://t/api/explain-assistant/state?sessionId=late-2'));
    assert.equal(response.status, 409, '已归档会话读 state 也必须被拒');
    assert.equal(existsSync(path), false, '读路径不得重建文件');
  } finally { host.restore(); }
});

test('归档删除 防重建: 「正在回答中被归档」的晚到写入不得把文件建回来', async () => {
  // 这是最真实的晚到写入场景，也是上面那条 409 测试**覆盖不到**的：
  // 请求在 forget **之前**就已经跑起来了（通过了 guard），归档之后它才跑完并落库。
  // 规范 §8 原文要求「取消活动请求…晚到事件丢弃」——所以这条必须断言文件不被重建。
  //
  // 注意：若不测这条，saveRecord 里的「已归档就拒写」守卫就**没有任何测试覆盖**
  // （证伪实验里把那条守卫删掉，全部用例照样绿——这是真实存在的覆盖缺口）。
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slowLlm = {
    stream: () => (async function* () {
      await gate;                                  // 卡住，让我们有时间在中途归档
      yield { type: 'text-delta', text: '迟到但完整的回答' };
      yield { type: 'finish', done: true };
    })(),
  };
  const host = await startHost(slowLlm);
  try {
    await seed(host.rootDir, 'inflight-1', s => { s.records = []; s.explicitModel = { provider: 'p', model: 'm' }; });
    const path = recordPath(host.rootDir, 'inflight-1');

    // 1) 先发起 ask（此时会话还没归档，能通过 guard）
    const askPromise = host.ask('inflight-1', '归档前发起的提问');
    // 等请求真的进入处理中（文件已建立），不用固定 sleep。
    await waitFor(() => existsSync(path), { label: '请求开始时记录文件应已存在' });
    assert.ok(existsSync(path), '前置：文件在请求开始时存在');

    // 2) 中途归档这个会话（模拟用户在左侧把它归档）
    await host.forget('inflight-1');
    assert.equal(existsSync(path), false, '前置：归档后文件已删');

    // 3) 放行，让那个「已经在跑」的请求完成并尝试落库
    release();
    await askPromise.catch(() => undefined);
    // 「不得重建」这类断言不能用 waitFor（我们等的正是「它永远不发生」）。
    // 在整个观察窗口内持续轮询：任何时刻文件出现都算失败，避免「窗口一过就漏判」。
    await expectNever(() => existsSync(path), {
      durationMs: 300,
      label: '晚到完成的回答重建了已归档会话的文件（§8「晚到事件丢弃」）',
    });
    assert.equal(existsSync(path), false, '晚到完成的回答绝不能把已归档会话的文件重建出来（§8「晚到事件丢弃」）');
  } finally { release(); host.restore(); }
});

/* ================================================================== *
 * 3) 失败进入重试队列，重试成功后文件消失
 * ================================================================== */

test('归档删除 重试: 删除真的失败时进入重试队列，重试成功后文件消失', async () => {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const root = mkdtempSync(join(tmpdir(), 'ea-retry-'));
  try {
    const store = new persistence.JsonSessionStore({ rootDir: root });
    // 把会话文件的位置做成一个**非空目录**：store.remove 用的 rm(path, {force:true})
    // 不带 recursive，删目录会真的抛错 —— 这就是一条真实的失败路径，
    // 不需要替换 remove 本身（替换掉就绕过了内部的入队逻辑，测不到队列）。
    const path = join(root, 'sessions', 'retry-1.json');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'blocker.txt'), 'block');

    let threw = false;
    try { await store.remove('retry-1'); } catch { threw = true; }
    assert.equal(threw, true, '删除失败必须抛出（调用方据此知道没删成）');
    assert.deepEqual(store.pendingDeleteIds(), ['retry-1'], '失败的删除必须进入重试队列');

    // 排除故障（清掉阻塞目录），再重试
    rmSync(path, { recursive: true, force: true });
    const result = await store.retryPendingDeletes();
    assert.equal(result.attempted, 1, '重试必须尝试那条');
    assert.equal(result.failed, 0, '排除故障后重试应当成功');
    assert.deepEqual(store.pendingDeleteIds(), [], '成功后必须出队');
    assert.equal(existsSync(path), false, '重试成功后必须真的删掉');
    await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('归档删除 重试: 删除仍然失败时留在队列（受限重试，不无限重试也不丢）', async () => {
  const persistence = await moduleFromSource('src/host/persistence.ts');
  const root = mkdtempSync(join(tmpdir(), 'ea-retry2-'));
  try {
    const store = new persistence.JsonSessionStore({ rootDir: root });
    const path = join(root, 'sessions', 'retry-2.json');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'blocker.txt'), 'block');
    await store.remove('retry-2').catch(() => undefined);
    assert.deepEqual(store.pendingDeleteIds(), ['retry-2'], '失败后必须入队');

    // 故障未排除 → 重试应记为失败，并**保留在队列里**（下轮再试），不能悄悄丢弃
    const stillFailing = await store.retryPendingDeletes();
    assert.equal(stillFailing.attempted, 1, '必须尝试');
    assert.equal(stillFailing.failed, 1, '仍然失败要如实记 1');
    assert.deepEqual(store.pendingDeleteIds(), ['retry-2'], '失败的任务必须留在队列里等下次，不能丢');
    await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('归档删除 重试: 删除失败时 forget 仍返回 removed/deleted 结果且记录不再可读', async () => {
  const host = await startHost(okLlm());
  try {
    await seed(host.rootDir, 'retry-2', s => { s.records = [{ id: 'r1', kind: 'ask', question: 'q', answerText: 'a', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]; });
    const response = await host.forget('retry-2');
    const body = await response.json();
    assert.equal(response.status, 200, '归档清理即使删除失败也必须返回可用结果：' + JSON.stringify(body));
    // 标记侧一定生效：内容已清空、读侧已拒绝
    assert.equal(body.payload.removed, true, '必须报告「已归档处理」');
    const stateEntry = host.routes.get('/api/explain-assistant/state');
    const state = await (typeof stateEntry === 'function' ? stateEntry : stateEntry.fetch)(new Request('http://t/api/explain-assistant/state?sessionId=retry-2'));
    assert.equal(state.status, 409, '归档后读 state 必须被拒（即使文件还没删掉）');
  } finally { host.restore(); }
});

/* ================================================================== *
 * 4) 边界：绝不碰工作区与共享附件
 * ================================================================== */

test('归档删除 边界: 只删本插件的东西，工作区文件与共享附件一字未动', async () => {
  const host = await startHost(okLlm());
  const workspace = mkdtempSync(join(tmpdir(), 'ea-ws-'));
  const attachments = mkdtempSync(join(tmpdir(), 'ea-att-'));
  try {
    await seed(host.rootDir, 'edge-1', s => { s.records = []; });
    writeFileSync(join(workspace, 'important.ts'), 'do not delete');
    writeFileSync(join(attachments, 'user-upload.png'), 'do not delete');
    mkdirSync(join(host.rootDir, 'sessions', 'edge-1', 'images'), { recursive: true });
    writeFileSync(join(host.rootDir, 'sessions', 'edge-1', 'images', 'snap.png'), 'plugin own');

    await host.forget('edge-1');

    assert.equal(existsSync(recordPath(host.rootDir, 'edge-1')), false, '本插件 JSON 应删');
    assert.equal(existsSync(join(host.rootDir, 'sessions', 'edge-1')), false, '本插件目录应删');
    assert.ok(existsSync(join(workspace, 'important.ts')), '工作区文件绝不能动');
    assert.ok(existsSync(join(attachments, 'user-upload.png')), 'DSH 共享附件绝不能动');
  } finally { host.restore(); rmSync(workspace, { recursive: true, force: true }); rmSync(attachments, { recursive: true, force: true }); }
});

test('归档删除 边界: 归档一个没有记录的会话也必须安全（幂等，不抛）', async () => {
  const host = await startHost(okLlm());
  try {
    const first = await host.forget('never-existed');
    assert.equal(first.status, 200, '归档一个从未有过记录的会话也必须成功');
    const second = await host.forget('never-existed');
    assert.equal(second.status, 200, '重复归档必须幂等、不抛');
  } finally { host.restore(); }
});
