import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeDom, moduleFromSource, FakeElement, waitFor } from './fixtures/runtime.mjs';

/**
 * 2026-10-31 审计后修复的**逐条验证**（用户要求：「每个修复都要进行一次验证」）。
 *
 * 对应关系（编号沿用审计报告）：
 *   U6 发送位在忙时变成「停止」，点一下真的取消
 *   U1 贴底时自动跟随（2026-11-07 改：一跟到底，只有用户自己上滚才停）
 *   U2 属于「当前这一问」的失败原因贴到那一问下面，不再只挂在几十屏之上的顶部
 *   B3 压缩日志（kind:'compact'）不进历史（宿主下发 + 客户端渲染两层都要挡）
 *   U4 历史条数只数问答记录
 *   B5 saveRecord 必须走 store.update（串行读改写），不能自己 load→push→save
 *   B6 浮窗开着时完成的回答不点亮未读；关窗时把已读补落到宿主
 *   B8 markRead 不为"点开看一眼"的会话新建空文件
 *   B4 更早的历史 / 展开单条 这两条读路径必须有超时（挂住要变成失败，不是永远转圈）
 */

const base = {
  sessionId: 's', open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
  tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [],
  occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: true, stateReady: true,
  compactState: { status: 'idle' },
};

async function render(state, overrides = {}) {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const plugin = {
    registry: { update() {}, get: () => state, close() {} },
    api: {}, cancel() {}, loadEarlier() {}, submit() {}, saveGeometry() {},
    ...overrides,
  };
  return { overlay, plugin, root: overlay.renderOverlay({ ...base, ...state, open: true }, plugin) };
}

/* ================================================================== *
 * U6：同一颗按钮，忙的时候是「停止」
 * ================================================================== */

test('U6: 忙时发送位变「停止」且可点，点一下真的取消', async () => {
  const dom = fakeDom();
  try {
    let cancelled = 0;
    const { root } = await render({ phase: 'running', text: '正在写第一段', question: '它现在在干什么' }, { cancel: () => { cancelled += 1; } });
    const send = root.querySelector('.ea-send');
    assert.ok(send, '必须存在发送按钮');
    assert.equal(send.textContent, '停止', '忙的时候按钮文案必须是动作「停止」，不是状态「处理中」');
    assert.equal(send.getAttribute('data-stop'), 'true');
    assert.equal(send.disabled, false, '忙的时候这颗按钮必须可点 —— 它是唯一的中止出口');
    send.emit('click');
    assert.equal(cancelled, 1, '点它必须真的取消这次回答');
  } finally { dom.restore(); }
});

test('U6 反例: 空闲时仍是「发送」，不会被误做成停止', async () => {
  const dom = fakeDom();
  try {
    let cancelled = 0;
    const { root } = await render({ phase: 'idle' }, { cancel: () => { cancelled += 1; } });
    const send = root.querySelector('.ea-send');
    assert.equal(send.textContent, '发送');
    assert.equal(send.getAttribute('data-stop'), 'false');
  } finally { dom.restore(); }
});

/* ================================================================== *
 * U1：流式跟随（2026-11-07 按用户实测重定契约）
 *
 * 用户原话：「小助手插件的内容生成时的自动跟随有点问题，不知道是bug还是设计的
 * 不符合使用直觉」。实测根因有两条：
 *   ① 旧规则「问句顶到正文区顶端就停」——正文区实测只有 348px 高，一屏之后
 *      跟随就永久停住，而回答普遍 1300~2900 字（三到八屏）；
 *   ② 那条规则**不可恢复**：用户滚回底部，下一帧又被同一条规则置成暂停。
 * 新契约只有一条：**跟不跟，由用户是否贴着底决定**。
 * ================================================================== */

/**
 * 给假 DOM 补一套「可调」的布局：
 *   · 正文区 0..400（高 400）
 *   · 这一问的气泡矩形由 liveQuestionRect 决定
 * body 的 scrollHeight / clientHeight / scrollTop 是普通属性，直接赋值即可。
 */
async function withLayout(liveQuestionRect, run) {
  const original = FakeElement.prototype.getBoundingClientRect;
  FakeElement.prototype.getBoundingClientRect = function () {
    const cls = String(this.className || '');
    if (cls.includes('ea-body')) return { top: 0, bottom: 400, height: 400, left: 0, right: 900, width: 900 };
    if (cls.includes('ea-live-q')) return { top: 0, bottom: 0, height: 0, left: 0, right: 900, width: 900, ...liveQuestionRect };
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
  };
  try { return await run(); } finally { FakeElement.prototype.getBoundingClientRect = original; }
}

function bodyOf(root) {
  const body = root.querySelector('.ea-body');
  body.clientHeight = 400;
  return body;
}

test('U1: 贴底时跟随（内容变长就跟到底）', async () => {
  const dom = fakeDom();
  try {
    await withLayout({ top: 120, height: 40 }, async () => {
      const state = { ...base, phase: 'running', question: '它现在在干什么', text: '第一段' };
      const { root, plugin } = await render(state);
      const body = bodyOf(root);
      body.scrollHeight = 2000;
      body.scrollTop = 1600;                       // 正好贴底：max = 2000 - 400
      plugin.registry.get = () => state;
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      updateOverlay(root, { ...state, text: '第一段，多几个字' }, plugin);
      assert.equal(body.scrollTop, 1600, '贴底时必须自动跟到底（= scrollHeight - clientHeight）');
    });
  } finally { dom.restore(); }
});

test('U1: 问句顶到视野顶端后仍然跟随（不再"一屏就永久停"）', async () => {
  const dom = fakeDom();
  try {
    const rect = { top: 120, height: 40 };
    await withLayout(rect, async () => {
      const state = { ...base, phase: 'running', question: '它现在在干什么', text: '第一段' };
      const { root, plugin } = await render(state);
      const body = bodyOf(root);
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      body.scrollHeight = 2000;
      body.scrollTop = 1600;
      updateOverlay(root, { ...state, text: '第一段' }, plugin);
      assert.equal(body.scrollTop, 1600, '先跟到底（= 2000 - 400）');

      // 回答长到把问句顶出视野：旧版从这一帧起就永久停住（一屏就停、且恢复不了）
      rect.top = -30;
      body.scrollHeight = 2600;
      body.scrollTop = 2200;                      // 仍贴底（max = 2200）
      updateOverlay(root, { ...state, text: '第一段 + 第二段' }, plugin);
      assert.equal(body.scrollTop, 2200, '问句到顶不影响跟随：仍然贴底');

      body.scrollHeight = 3000;
      body.scrollTop = 2600;
      updateOverlay(root, { ...state, text: '第一段 + 第二段 + 第三段' }, plugin);
      assert.equal(body.scrollTop, 2600, '继续跟到这一条写完（max = 3000 - 400）');
    });
  } finally { dom.restore(); }
});

test('U1: 用户自己往上滚之后必须停手（不抢滚动条）', async () => {
  const dom = fakeDom();
  try {
    await withLayout({ top: 120, height: 40 }, async () => {
      const state = { ...base, phase: 'running', question: '它现在在干什么', text: '第一段' };
      const { root, plugin } = await render(state);
      const body = bodyOf(root);
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      body.scrollHeight = 2000;
      body.scrollTop = 1600;
      updateOverlay(root, { ...state, text: '第一段' }, plugin);
      assert.equal(body.scrollTop, 1600);

      // 用户往上滚（离开底部超过容差）
      body.scrollTop = 600;
      body.emit('scroll');
      body.scrollHeight = 2600;
      body.scrollTop = 600;                       // 用户停在原处，内容继续长
      updateOverlay(root, { ...state, text: '第一段 + 第二段' }, plugin);
      assert.equal(body.scrollTop, 600, '用户上滚之后不得再自动跟随');
    });
  } finally { dom.restore(); }
});

test('U1: 上滚之后又滚回底部 → 立刻恢复跟随（旧版到这里就永远跟不上了）', async () => {
  const dom = fakeDom();
  try {
    await withLayout({ top: 120, height: 40 }, async () => {
      const state = { ...base, phase: 'running', question: '它现在在干什么', text: '第一段' };
      const { root, plugin } = await render(state);
      const body = bodyOf(root);
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      body.scrollHeight = 2000;
      body.scrollTop = 1600;
      updateOverlay(root, { ...state, text: '第一段' }, plugin);

      body.scrollTop = 600;
      body.emit('scroll');                        // 用户上滚 → 暂停
      body.scrollHeight = 2600;
      updateOverlay(root, { ...state, text: '第一段 + 第二段' }, plugin);
      assert.equal(body.scrollTop, 600, '暂停期间不跟');

      body.scrollTop = 2200;                      // 用户自己滚回底部（= 2600 - 400）
      body.emit('scroll');
      body.scrollHeight = 3000;
      updateOverlay(root, { ...state, text: '第一段 + 第二段 + 第三段' }, plugin);
      assert.equal(body.scrollTop, 2600, '滚回底部后必须恢复跟随（max = 3000 - 400）');
    });
  } finally { dom.restore(); }
});

test('U1: 连接阶段（一个字还没吐）上滚也算接管，第一个分片来了不许拽回去', async () => {
  const dom = fakeDom();
  try {
    await withLayout({ top: 120, height: 40 }, async () => {
      const state = { ...base, phase: 'connecting', question: '它现在在干什么', text: '' };
      const { root, plugin } = await render(state);
      const body = bodyOf(root);
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      body.scrollHeight = 2000;
      body.scrollTop = 1600;
      updateOverlay(root, { ...state, text: '' }, plugin);
      assert.equal(body.scrollTop, 1600, '刚开始这一问：贴底');

      // 模型还在想（实测常常十几秒），用户趁机往上翻
      body.scrollTop = 1200;
      body.emit('scroll');
      body.scrollHeight = 2400;
      body.scrollTop = 1200;
      updateOverlay(root, { ...state, phase: 'running', text: '第一段' }, plugin);
      assert.equal(body.scrollTop, 1200, '连接阶段的上滚也是接管：第一个分片来了不得把他拽回底部');
    });
  } finally { dom.restore(); }
});

test('U1: 暂停时出现「回到最新」，点它恢复跟随并贴底', async () => {
  const dom = fakeDom();
  try {
    await withLayout({ top: 120, height: 40 }, async () => {
      const state = { ...base, phase: 'running', question: '它现在在干什么', text: '第一段' };
      const { root, plugin } = await render(state);
      const body = bodyOf(root);
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      body.scrollHeight = 2000;
      body.scrollTop = 1600;
      updateOverlay(root, { ...state, text: '第一段' }, plugin);
      const jump = root.querySelector('.ea-body-jump');
      assert.ok(jump, '必须有「回到最新」这颗按钮');
      assert.equal(jump.hidden, true, '跟随时它不该出现');

      body.scrollTop = 600;
      body.emit('scroll');
      assert.equal(jump.hidden, false, '用户上滚之后它必须出现 —— 否则界面上没有任何"还在长"的提示');

      body.scrollHeight = 2600;
      updateOverlay(root, { ...state, text: '第一段 + 第二段' }, plugin);
      assert.equal(body.scrollTop, 600, '暂停期间不跟');
      jump.emit('click');
      assert.equal(body.scrollTop, 2200, '点「回到最新」必须贴到当前底部（max = 2600 - 400）');
      assert.equal(jump.hidden, true, '恢复跟随后按钮应该收起来');
    });
  } finally { dom.restore(); }
});

test('U1: 刚发出一问就把它带进视野（模型思考那十几秒里问句也在屏幕上）', async () => {
  const dom = fakeDom();
  try {
    await withLayout({ top: 120, height: 40 }, async () => {
      const state = { ...base, phase: 'idle', question: '', text: '' };
      const { root, plugin } = await render(state);
      const body = bodyOf(root);
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      body.scrollHeight = 2000;
      body.scrollTop = 400;                       // 用户原本翻在上面
      updateOverlay(root, { ...state, phase: 'connecting', question: '它现在在干什么', text: '', liveRecordId: 'r9' }, plugin);
      assert.equal(body.scrollTop, 2000, '问句一发出就必须贴到底（问句在视野里），不能等第一个分片');
    });
  } finally { dom.restore(); }
});

test('U1: 没贴底时上方内容变短，正在读的那一段不被顶走（落地不跳）', async () => {
  const dom = fakeDom();
  try {
    const rects = new Map();
    const original = FakeElement.prototype.getBoundingClientRect;
    FakeElement.prototype.getBoundingClientRect = function () {
      const cls = String(this.className || '');
      const id = this.getAttribute && this.getAttribute('data-record-id');
      if (cls.includes('ea-body')) return { top: 0, bottom: 400, height: 400, left: 0, right: 900, width: 900 };
      if (cls.includes('ea-conv-live')) return { top: 260, bottom: 360, height: 100, left: 0, right: 900, width: 900 };
      if (id && rects.has(id)) return { top: rects.get(id), bottom: rects.get(id) + 100, height: 100, left: 0, right: 900, width: 900 };
      return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
    };
    try {
      const state = { ...base, phase: 'running', question: '它现在在干什么', text: '正在写的这一条', liveRecordId: 'r7', records: [] };
      const { root, plugin } = await render(state);
      const body = bodyOf(root);
      body.scrollHeight = 3000;
      body.scrollTop = 1000;                      // 用户没贴底（max = 2600）
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      // 落地：r7 从活体块变成历史里的一轮；同时历史窗口把最上面一轮摘掉，
      // 整段内容向上抽 300px（真实现场是 -311 的窗口裁剪 + -612 的上一轮折叠）
      rects.set('r7', -40);
      const landed = { ...state, phase: 'idle', text: '正在写的这一条', records: [{ id: 'r7', question: '它现在在干什么', answerText: '正在写的这一条' }] };
      updateOverlay(root, landed, plugin);
      assert.equal(body.scrollTop, 700, '内容整体上移 300px，滚动位置必须补 -300（否则正在读的那一段被换掉）');
    } finally { FakeElement.prototype.getBoundingClientRect = original; }
  } finally { dom.restore(); }
});

/* ================================================================== *
 * U2：失败原因贴到当前这一问下面
 * ================================================================== */

test('U2: 这一问失败时，原因出现在底部（当前这一问下面），不在顶部', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render({ phase: 'error', question: '它现在在干什么', error: '请求失败：模型超时了' });
    const tail = root.querySelector('.ea-error-tail-slot');
    assert.ok(tail, '必须有"贴在这一问下面"的错误槽位');
    assert.match(tail.textContent, /请求失败：模型超时了/);
    const body = root.querySelector('.ea-body');
    // body 的子节点顺序：stateError → loading → catalogNote → detail → error(顶部) → …
    const topErrorSlot = body.children[4];
    assert.equal(topErrorSlot.textContent, '', '这一问的失败原因不应再挂在顶部（长历史时用户根本看不见）');
  } finally { dom.restore(); }
});

test('U2 反例: 与当前这一问无关的错误仍留在顶部', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render({ phase: 'idle', error: '读取更早的历史失败' });
    const tail = root.querySelector('.ea-error-tail-slot');
    assert.equal(tail.textContent, '', '非"这一问"的错误不进底部槽位');
    const body = root.querySelector('.ea-body');
    assert.match(body.children[4].textContent, /读取更早的历史失败/);
  } finally { dom.restore(); }
});

/* ================================================================== *
 * B3 / U4：压缩日志不进历史
 * ================================================================== */

const rec = (id, at, extra = {}) => ({ id, kind: 'ask', question: '问：' + id, answerText: '答：' + id, status: 'complete', startedAt: at, ...extra });

test('B3/U4: 压缩日志（kind:compact）不画成一轮，历史条数也不数它', async () => {
  const dom = fakeDom();
  try {
    const records = [
      rec('r1', '2026-10-20T00:00:00.000Z'),
      { id: 'c1', kind: 'compact', question: '', answerText: '这是压缩摘要正文，不该出现在历史里', status: 'complete', startedAt: '2026-10-21T00:00:00.000Z' },
      rec('r2', '2026-10-22T00:00:00.000Z'),
    ];
    const { root } = await render({ records });
    // 注意：必须限定在历史区里数 —— 正文底部还有一个 .ea-turn（当前这一问的活体轮），
    // 它不属于历史，混着数会把这条断言变成假的。
    const turns = root.querySelector('.ea-conv').querySelectorAll('.ea-turn');
    assert.equal(turns.length, 2, '两条问答 → 两轮；压缩日志不能占一轮');
    const conv = root.querySelector('.ea-conv');
    assert.doesNotMatch(conv.textContent, /这是压缩摘要正文/, '摘要不能以"没有问句的回答"形式再出现一次');
    assert.match(conv.textContent, /2 条/, '历史条数只能数问答记录');
  } finally { dom.restore(); }
});

/* ================================================================== *
 * 宿主侧：起一个真插件 + 真磁盘
 * ================================================================== */

async function startHost(llmOverrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ea-fixes-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  try {
    const index = await moduleFromSource('src/index.ts');
    index.apply({
      llm: {
        listProviders: async () => ['p'],
        listModels: async () => [{ id: 'm', provider: 'p' }],
        resolveModelInfo: async () => ({ context: { contextWindow: 128000 } }),
        stream: async function* () { yield { type: 'text-delta', index: 0, text: '回答正文' }; },
        ...llmOverrides,
      },
      sessionQuery: {},
      connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
      effect: () => {},
      get: () => undefined,
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
  const rootDir = join(home, 'explain-assistant');
  const request = async (path, init) => {
    const target = new URL(path, 'http://host');
    const entry = routes.get(target.pathname);
    if (!entry) return new Response(JSON.stringify({ error: { code: 'NO_ROUTE' } }), { status: 404 });
    return entry(new Request(target.toString(), init));
  };
  return {
    rootDir,
    request,
    state: async id => (await (await request('/api/explain-assistant/state?sessionId=' + id)).json()).payload,
    markRead: id => request('/api/explain-assistant/mark-read?sessionId=' + id, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, sessionId: id, operation: 'mark-read', payload: {} }),
    }),
    filePath: id => join(rootDir, 'sessions', id + '.json'),
    readFile(id) { return JSON.parse(readFileSync(join(rootDir, 'sessions', id + '.json'), 'utf8')); },
    seed: async (id, mutate) => {
      const persistence = await moduleFromSource('src/host/persistence.ts');
      const store = new persistence.JsonSessionStore({ rootDir });
      await store.update(id, mutate);
    },
    restore() { rmSync(home, { recursive: true, force: true }); },
  };
}

test('B3 宿主侧: /state 只下发问答记录，totalRecords 也按同一口径', async () => {
  const host = await startHost();
  try {
    await host.seed('b3', s => {
      s.records = [
        rec('a1', '2026-10-20T00:00:00.000Z'),
        { id: 'c1', kind: 'compact', question: '', answerText: '摘要', status: 'complete', startedAt: '2026-10-21T00:00:00.000Z' },
        rec('a2', '2026-10-22T00:00:00.000Z'),
      ];
    });
    const payload = await host.state('b3');
    assert.deepEqual(payload.records.map(r => r.id), ['a1', 'a2'], '压缩日志不得随 /state 下发');
    assert.equal(payload.totalRecords, 2, 'totalRecords 必须与下发口径一致，否则"更早的 N 条"会一直挂着');
  } finally { host.restore(); }
});

/* ================================================================== *
 * B5：saveRecord 不能再绕过 store.update
 * ================================================================== */

test('B5: saveRecord 走 store.update（单一写路径），不再自己 load→push→save', async () => {
  const { readFileSync } = await import('node:fs');
  const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const saveRecord = indexSource.slice(indexSource.indexOf('saveRecord: async'), indexSource.indexOf('saveBestEffort') > 0 ? indexSource.indexOf('saveBestEffort') : indexSource.indexOf('saveRecord: async') + 1200);
  assert.match(saveRecord, /store\.update\(id/, 'saveRecord 必须走 store.update 的串行读改写');
  assert.doesNotMatch(saveRecord, /current\.records\.push\(record as any\); current\.historyRevision\+\+/, '旧的 load→push→save 写法会与并发写入互相覆盖，必须已经被删掉');
});

test('B5 行为: 并发写入（另一条 update 插在中间）不会把刚写的记录盖掉', async () => {
  const host = await startHost();
  try {
    const persistence = await moduleFromSource('src/host/persistence.ts');
    const store = new persistence.JsonSessionStore({ rootDir: host.rootDir });
    await store.update('b5', s => { s.records = []; });
    // 两条并发写：一条加记录、一条写几何。串行化之后两者都必须留在文件里。
    await Promise.all([
      store.update('b5', s => { s.records.push(rec('r1', '2026-10-20T00:00:00.000Z')); }),
      store.update('b5', s => { s.geometry = { x: 1, y: 2, width: 300, height: 400 }; }),
    ]);
    const file = host.readFile('b5');
    assert.equal(file.records.length, 1, '记录不能被并发的几何写入盖掉');
    assert.deepEqual(file.geometry, { x: 1, y: 2, width: 300, height: 400 }, '几何也不能被盖掉');
  } finally { host.restore(); }
});

/* ================================================================== *
 * B6：浮窗开着时完成的回答不点亮未读；关窗补 markRead
 * ================================================================== */

test('B6: 浮窗开着时完成的回答不点亮未读', async () => {
  const host = await startHost();
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url), 'http://host');
    return host.request(target.pathname + target.search, init);
  };
  try {
    const client = await moduleFromSource('src/client/index.ts');
    const plugin = client.createClientPlugin({ session: { id: 'b6' } });
    try {
      plugin.open();
      await plugin.api.selectModel('b6', { provider: 'p', model: 'm' });
      await plugin.submit('它在干什么');
      await waitFor(() => plugin.registry.get('b6').phase === 'complete', { label: '回答应完成' });
      assert.equal(plugin.registry.get('b6').unread, false, '浮窗开着时，刚完成的回答不该点亮未读');
      // 宿主仍然会记 unread（它不知道浮窗开没开）—— 关窗时必须把它补成已读
      plugin.close();
      await waitFor(() => host.readFile('b6').unread === false, { label: '关窗后宿主应被标为已读' });
      assert.equal(host.readFile('b6').unread, false, '关窗必须把「已读」补落到宿主');
    } finally { plugin.dispose(); }
  } finally { globalThis.fetch = previous; host.restore(); }
});

/* ================================================================== *
 * B8：markRead 不为"点开看一眼"的会话新建文件
 * ================================================================== */

test('B8: markRead 对不存在的会话不建文件；对已读的会话不写盘', async () => {
  const host = await startHost();
  try {
    const store = new (await moduleFromSource('src/host/persistence.ts')).JsonSessionStore({ rootDir: host.rootDir });
    await store.markRead('never-used');
    assert.equal(existsSync(host.filePath('never-used')), false, '只是打开看一眼的会话不能在磁盘上留下文件');

    await store.update('read-already', s => { s.records = []; s.unread = false; });
    const before = readFileSync(host.filePath('read-already'), 'utf8');
    await store.markRead('read-already');
    assert.equal(readFileSync(host.filePath('read-already'), 'utf8'), before, '已经是已读就不该再写一次盘');

    await store.update('was-unread', s => { s.records = []; s.unread = true; });
    await store.markRead('was-unread');
    assert.equal(host.readFile('was-unread').unread, false, '真的未读时必须清掉');
  } finally { host.restore(); }
});

/* ================================================================== *
 * B4：读路径必须有超时（挂住 → 失败结局，而不是永远转圈）
 * ================================================================== */

test('B4: 「更早的历史」挂住时会在超时后失败并复位，不会永远显示正在加载', async () => {
  const client = await moduleFromSource('src/client/index.ts');
  const api = {
    state: async () => ({ payload: {} }),
    history: () => new Promise(() => {}),          // 永不返回
  };
  const plugin = client.createClientPlugin({ session: { id: 'b4' }, api, readTimeoutMs: 30 });
  try {
    plugin.registry.update('b4', { stateReady: true });
    await plugin.loadEarlier();
    const state = plugin.registry.get('b4');
    assert.equal(state.loadingEarlier, false, '超时后必须复位 loadingEarlier（否则按钮永远转圈）');
    assert.match(String(state.error), /超时/, '必须给出中文超时原因');
  } finally { plugin.dispose(); }
});

test('B4: 「展开某条记录的完整内容」挂住时同样会超时失败', async () => {
  const client = await moduleFromSource('src/client/index.ts');
  const api = {
    state: async () => ({ payload: {} }),
    historyResult: () => new Promise(() => {}),
  };
  const plugin = client.createClientPlugin({ session: { id: 'b4b' }, api, readTimeoutMs: 30 });
  try {
    plugin.registry.update('b4b', { stateReady: true });
    await plugin.openHistoryDetail('r1');
    const detail = plugin.registry.get('b4b').historyDetail;
    assert.equal(detail.status, 'error', '挂住的展开请求必须落到失败结局');
    assert.match(String(detail.error), /超时/);
  } finally { plugin.dispose(); }
});


/* ================================================================== *
 * 落地不跳（用户 2026-10-31 报：「当内容生成完后，会自动跳转到最下面」）
 * ================================================================== */

/**
 * 落地那一帧的真实形态：活体块（.ea-conv-live）隐藏，同一条回答作为历史里的一条记录重新挂上。
 * 这里把两块的屏幕矩形分别钉住，才能断言"按元素位移补回去"这件事真的发生了。
 */
async function withHandoffLayout(run) {
  const original = FakeElement.prototype.getBoundingClientRect;
  FakeElement.prototype.getBoundingClientRect = function () {
    const cls = String(this.className || '');
    if (cls.includes('ea-body')) return { top: 0, bottom: 400, height: 400, left: 0, right: 900, width: 900 };
    if (cls.includes('ea-conv-live')) return { top: 250, bottom: 1150, height: 900, left: 0, right: 900, width: 900 };
    // 历史容器也要有真实高度：否则"首开定位"那条路径量不到布局，永远不会滚，
    // 下面那条"空会话第一条回答"的用例就成了假绿（实测证伪时正是这样漏过去的）。
    if (cls.includes('ea-conv-slot')) return { top: 0, bottom: 1500, height: 1500, left: 0, right: 900, width: 900 };
    if (this.getAttribute && this.getAttribute('data-record-id') === 'new') return { top: 1300, bottom: 2200, height: 900, left: 0, right: 900, width: 900 };
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
  };
  try { return await run(); } finally { FakeElement.prototype.getBoundingClientRect = original; }
}

test('落地不跳: 用户没贴底时，回答从"当前这一问"搬进历史后位置不动', async () => {
  const dom = fakeDom();
  try {
    await withHandoffLayout(async () => {
      const before = { ...base, phase: 'running', question: '它现在在干什么', text: '答：一整段回答' };
      const { root, plugin } = await render(before);
      const body = bodyOf(root);
      body.scrollHeight = 4000;
      body.scrollTop = 500;                       // 用户正在上面读，没贴底（max = 3600）
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      const landedRecord = { id: 'new', kind: 'ask', question: '它现在在干什么', answerText: '答：一整段回答', status: 'complete', startedAt: '2026-10-30T00:00:00.000Z' };
      updateOverlay(root, { ...before, phase: 'complete', liveRecordId: 'new', records: [landedRecord] }, plugin);
      // 这一轮在屏幕上的位置从 250 变到 1300，位移 1050 → scrollTop 必须同步补 1050
      assert.equal(body.scrollTop, 1550, '落地后必须按位移把阅读位置补回去（否则就是"一生成完就跳到底"）');
    });
  } finally { dom.restore(); }
});

test('落地不跳 反例: 贴底时不做补偿（保持跟随到底）', async () => {
  const dom = fakeDom();
  try {
    await withHandoffLayout(async () => {
      const before = { ...base, phase: 'running', question: '它现在在干什么', text: '答：一整段回答' };
      const { root, plugin } = await render(before);
      const body = bodyOf(root);
      body.scrollHeight = 4000;
      body.scrollTop = 3600;                      // 贴底
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      const landedRecord = { id: 'new', kind: 'ask', question: '它现在在干什么', answerText: '答：一整段回答', status: 'complete', startedAt: '2026-10-30T00:00:00.000Z' };
      updateOverlay(root, { ...before, phase: 'complete', liveRecordId: 'new', records: [landedRecord] }, plugin);
      assert.equal(body.scrollTop, 3600, '本来就贴底的人不该被补偿逻辑再推走');
    });
  } finally { dom.restore(); }
});

test('首开空会话: 第一条回答落地时不得触发"首开定位"把画面拉到底', async () => {
  const dom = fakeDom();
  try {
    await withHandoffLayout(async () => {
      const empty = { ...base, phase: 'idle', records: [], text: '' };
      const { root, plugin } = await render(empty);
      const body = bodyOf(root);
      body.scrollHeight = 4000;
      body.scrollTop = 700;                       // 用户在中间读东西（没贴底）
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      // 第一次有记录：如果"首开定位"此刻才执行，就会把画面滚到底（旧的真实缺陷）
      const landedRecord = { id: 'new', kind: 'ask', question: '问', answerText: '答', status: 'complete', startedAt: '2026-10-30T00:00:00.000Z' };
      updateOverlay(root, { ...empty, phase: 'complete', question: '问', text: '答', liveRecordId: 'new', records: [landedRecord] }, plugin);
      await new Promise(r => setTimeout(r, 30));  // 旧实现是 setTimeout(...,0) 才滚，必须等它
      assert.equal(body.scrollTop, 700, '空会话的第一条回答落地时，绝不能把画面拉到底');
    });
  } finally { dom.restore(); }
});



/* ================================================================== *
 * 2026-10-31 用户实机反馈的四条（工具持久 / 不闪 / 跟随阈值 / 停止动画）
 * ================================================================== */

test('工具持久: 落库的 tools 必须画进历史，不能生成完就消失', async () => {
  const dom = fakeDom();
  try {
    const tools = [
      { id: 't1', name: 'bash', label: '读文件', status: 'ok', detail: 'cat a.ts' },
      { id: 't2', name: 'grep', label: '搜索', status: 'error', detail: '没找到' },
    ];
    const records = [{ id: 'r1', kind: 'ask', question: '问', answerText: '答', status: 'complete', startedAt: '2026-10-30T00:00:00.000Z', tools }];
    const { root } = await render({ records });
    const box = root.querySelector('.ea-turn-tools');
    assert.ok(box, '历史这一轮必须有「工具过程」入口（否则工具调用一落地就消失）');
    assert.match(box.textContent, /工具过程 · 2 步/, '要能看出有几轮工具调用');
    assert.match(box.textContent, /读文件/);
    assert.match(box.textContent, /搜索/);
    assert.match(box.textContent, /1 个失败/, '失败的数量要如实写出来');
  } finally { dom.restore(); }
});

test('不闪: 刚落地的这一条不播进场动画（它上一帧已经在屏幕上了）', async () => {
  const dom = fakeDom();
  try {
    // 必须**已经有历史**：否则 enteredTurnId 还是 undefined，进场动画本来就轮不到它，
    // 那样断言就会因为"压根没打算播"而假绿（证伪时实测踩到过）。
    const old = { id: 'r0', kind: 'ask', question: '旧问', answerText: '旧答', status: 'complete', startedAt: '2026-10-29T00:00:00.000Z' };
    const before = { ...base, records: [old], phase: 'running', question: '问', text: '答' };
    const { root, plugin } = await render(before);
    const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
    const rec = { id: 'new', kind: 'ask', question: '问', answerText: '答', status: 'complete', startedAt: '2026-10-30T00:00:00.000Z' };
    updateOverlay(root, { ...before, phase: 'complete', liveRecordId: 'new', records: [old, rec] }, plugin);
    const turn = root.querySelector('.ea-conv').querySelectorAll('.ea-turn').find(t => t.getAttribute('data-record-id') === 'new');
    assert.ok(turn, '落地后历史里应有这一条');
    assert.notEqual(turn.getAttribute('data-enter'), 'true', '刚从活体块变过来的这一条不该再播"淡入+上移"（那就是闪一下）');
  } finally { dom.restore(); }
});

test('跟随阈值: 贴着底 40px 以内要跟；离开 100px 就不跟（2026-11-07 从 120 收到 48）', async () => {
  const dom = fakeDom();
  try {
    await withLayout({ top: 120, height: 40 }, async () => {
      const state = { ...base, phase: 'running', question: '问', text: '第一段' };
      const { root, plugin } = await render(state);
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      const body = bodyOf(root);
      body.scrollHeight = 2000;                    // max = 1600
      body.scrollTop = 1560;                       // 距底 40px：几乎贴底，应跟随
      updateOverlay(root, { ...state, text: '第一段 + 更多' }, plugin);
      assert.equal(body.scrollTop, 1600, '距底 40px 属于"几乎贴着底"，应当跟随（= 2000 - 400）');

      // 同一条回答期间：用户往上滚到"距底 100px"（约六行），这个时候不该再跟
      body.scrollTop = 1500;
      body.emit('scroll');
      body.scrollHeight = 2400;
      updateOverlay(root, { ...state, text: '第一段 + 更多 + 再更多' }, plugin);
      assert.equal(body.scrollTop, 1500, '离底 100px（约六行）时不得把用户拽回去 —— 旧版 120px 容差会把他拽回去');
    });
  } finally { dom.restore(); }
});

test('停止动画: 停止后的那句原因只播一次进场，不会每帧重播', async () => {
  const dom = fakeDom();
  try {
    const state = { ...base, phase: 'interrupted', error: '已按你的要求停止本次解释', question: '问', text: '答了一半' };
    const { root, plugin } = await render(state);
    const tail = root.querySelector('.ea-error-tail-slot');
    const first = tail.querySelector('.ea-error');
    assert.ok(first, '停止后必须显示原因');
    assert.match(String(first.className), /ea-error-enter/, '刚出现时挂进场动画类（淡入，而不是"啪"地闪出来）');

    const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
    updateOverlay(root, { ...state }, plugin);
    const second = root.querySelector('.ea-error-tail-slot').querySelector('.ea-error');
    assert.doesNotMatch(String(second.className), /ea-error-enter/, '同一句错误在后续重画里不得重播动画（否则流式期间会一直闪）');
  } finally { dom.restore(); }
});


/* ================================================================== *
 * 跟随不再有整数台阶（用户 2026-10-31：「A. 一顿一顿，希望有平滑过渡」）
 * ================================================================== */

test('跟随不产生整数台阶: 剩余量很小时走亚像素步长（不是 2px 一跳）', async () => {
  const dom = fakeDom();
  const g = globalThis;
  const savedRaf = g.requestAnimationFrame;
  const savedCancel = g.cancelAnimationFrame;
  const queue = [];
  g.requestAnimationFrame = cb => { queue.push(cb); return queue.length };
  g.cancelAnimationFrame = () => {};
  try {
    await withLayout({ top: 120, height: 40 }, async () => {
      const state = { ...base, phase: 'running', question: '问', text: '第一段' };
      const { root, plugin } = await render(state);
      const body = bodyOf(root);
      body.scrollHeight = 1000;
      body.clientHeight = 400;
      body.scrollTop = 596;                     // 距底只剩 4px：正是"整数下限 2px"会暴露的区间
      const { updateOverlay } = await moduleFromSource('src/client/overlay.tsx');
      updateOverlay(root, { ...state, text: '第一段 + 再看几帧' }, plugin);
      const values = [];
      for (let i = 0; i < 6; i++) {
        const cb = queue.shift();
        if (!cb) break;
        cb(16 * (i + 1));
        values.push(body.scrollTop);
      }
      assert.ok(values.length >= 3, '跟随循环必须持续排帧（不能追平就退出）');
      for (let i = 1; i < values.length; i++) {
        assert.ok(values[i] > values[i - 1], '每一帧都应向前推进（不能停住）');
        assert.ok(values[i] - values[i - 1] < 2, '剩余 4px 时每帧位移必须小于 2px，否则就是"一跳一跳"：' + JSON.stringify(values));
      }
      assert.ok(values.some(v => !Number.isInteger(v)), '位移必须是亚像素（整数位移就是台阶）：' + JSON.stringify(values));
    });
  } finally {
    g.requestAnimationFrame = savedRaf;
    g.cancelAnimationFrame = savedCancel;
    dom.restore();
  }
});
