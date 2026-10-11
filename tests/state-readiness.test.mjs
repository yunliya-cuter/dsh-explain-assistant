import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDom, FakeElement, moduleFromSource, waitFor } from './fixtures/runtime.mjs';

/**
 * 本轮：打开浮窗的「错值窗口」——**加载页地基**（就绪标记 + 加载态的终止条件）。
 *
 * ── 要解决的问题 ────────────────────────────────────────────────
 * /state 回来之前，store 里全是**初始空值**（records 空、catalog 未定义、occupancyKnown=false）。
 * 旧实现照常把各区块渲染出来，用户第一眼看到的是「暂时没有可用的模型」「还没有小助手历史」
 * 「占用未知」—— 这些在**读法**上都是**结论**，不是「正在加载」。
 *
 * ── 本文件守的四条（对应验收判据，逐条都有断言）──────────────
 *   1. 就绪标记在 store 的 initial() 里有明确初值（未就绪），且**按会话独立**；
 *   2. /state 成功后就绪；**失败或超时后也就绪**，并走到明确的中文错误；
 *   3. 失败路径不得把初始空值当真实数据展示（不得显示各区块的空态文案）；
 *   4. **不得用定时器把未就绪伪装成已就绪后放行空值**：超时只能导向错误提示。
 *
 * ── 关于「未就绪时界面渲染成什么」的测法 ────────────────────────
 * 渲染层刻意**兼容**手工构造的状态字面量（既有几十条测试依赖它），
 * 所以「未就绪 → 加载页」这条断言必须走**真实 registry**（plugin.registry.get(id)），
 * 而不是手写一个 { stateReady: false } 的对象——否则测的是我自己的字面量，不是真实路径。
 * 「失败态不得露空态文案」这一条同理：走真实 registry + 会失败的 state。
 */

const client = await moduleFromSource('src/client/index.ts');
const store = await moduleFromSource('src/client/store.ts');

/** 造一个**会失败**的 state（复现「宿主不可达 / 路由报错」）。 */
const failingApi = (overrides = {}) => ({
  state: async () => { throw new Error('ECONNREFUSED 127.0.0.1:3082'); },
  models: async () => ({ payload: { groups: [] } }),
  selectModel: async () => ({}),
  history: async () => ({ payload: { records: [] } }),
  historyResult: async () => ({ payload: {} }),
  ask: async () => {},
  compact: async () => {},
  cancel: async () => {},
  markRead: async () => ({}),
  forget: async () => ({}),
  geometry: async () => ({}),
  ...overrides,
});

/** 成功的 state：宿主确实下发了内容（用来证明「成功后就绪」不是碰巧）。 */
const healthyApi = (payload = {}) => failingApi({
  state: async () => ({ payload: { records: [], hasEarlier: false, catalog: { groups: [{ provider: 'p', models: [{ provider: 'p', id: 'm', name: 'M' }] }], failures: [] }, occupancy: 42, ...payload } }),
});

/**
 * 把某个自定义的 state 实现接到上面那套完整 api 上。
 *
 * ⚠️ 别用 `healthyApi({ state })` 来覆盖：那个形参是**下发的 payload**，
 * 把 state 放进去只会往 payload 里多塞一个字段，`api.state` 本身**不会**被替换
 * （我第一版就是这么写的，于是「调用计数」恒为 0，测的根本不是我想测的方法）。
 */
const apiWith = (state) => failingApi({ state });

/** 渲染真实 registry 里的那个状态，返回浮窗的可见文本。 */
async function renderLive(plugin, sessionId) {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  const state = plugin.registry.get(sessionId);
  const live = { registry: plugin.registry, api: plugin.api, cancel: () => {}, submit: async () => {}, loadEarlier: async () => {}, retryState: (id) => plugin.retryState(id) };
  try {
    const root = overlay.renderOverlay(state, live);
    return { text: root.textContent || '', root };
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.restore();
  }
}

/* ================================================================== *
 * 判据 1：初值必须是「未就绪」，且按会话独立
 * ================================================================== */

test('就绪标记 初值: store 的 initial() 必须是「未就绪」（stateReady === false）', () => {
  const registry = new store.AssistantRegistry();
  const fresh = registry.get('s-fresh');
  assert.equal(fresh.stateReady, false, '没读过 /state 之前必须明确是「未就绪」，不能是 undefined 或 true');
  // 反向：不能靠「有字段就算就绪」——它必须是一个显式布尔值。
  assert.equal(typeof fresh.stateReady, 'boolean', 'stateReady 必须是显式布尔值，不能靠字段存在与否推断');
});

test('就绪标记 按会话独立: A 已就绪不得让 B 被放行（B 仍是未就绪）', () => {
  const registry = new store.AssistantRegistry();
  registry.get('session-a');
  registry.get('session-b');
  registry.update('session-a', { stateReady: true });
  assert.equal(registry.get('session-a').stateReady, true, '前置：A 已就绪');
  assert.equal(registry.get('session-b').stateReady, false,
    'B 从未读过 /state，必须仍是未就绪 —— 会话之间不得串用就绪值');
});

test('就绪标记 按会话独立: 切会话不得把未就绪的会话当成已就绪放行（真插件链路）', async () => {
  const plugin = client.createClientPlugin({ api: healthyApi(), session: { id: 'iso-a' } });
  try {
    plugin.setSession('iso-a');
    await plugin.open();
    await waitFor(() => plugin.registry.get('iso-a').stateReady === true, { label: 'A 应先就绪' });

    // 切到 B：B 还没读过 /state
    plugin.setSession('iso-b');
    assert.equal(plugin.registry.get('iso-b').stateReady, false,
      '切到 B 之后，B 必须仍是「未就绪」（A 的就绪不得被 B 继承）');

    // B 的真实界面必须是加载页，而不是 A 的内容
    const b = await renderLive(plugin, 'iso-b');
    assert.match(b.text, /正在读取小助手的当前状态/, 'B 未就绪时必须显示加载页');
    assert.equal(/Kimi|模型/.test(b.text.replace(/正在读取小助手的当前状态[\s\S]*/, '')), false,
      'B 未就绪时不得显示模型列表（那属于 A 的内容）');
  } finally { plugin.dispose(); plugin.registry.remove('iso-a'); plugin.registry.remove('iso-b'); }
});

/* ================================================================== *
 * 判据 2：/state 成功后就绪；失败或超时后**也**就绪
 * ================================================================== */

test('/state 成功: 状态到位后就绪，且加载页随之消失、真实内容出现（一次到位）', async () => {
  const plugin = client.createClientPlugin({ api: healthyApi(), session: { id: 'ok-1' } });
  try {
    plugin.setSession('ok-1');
    // 未就绪：真实界面是加载页
    const before = await renderLive(plugin, 'ok-1');
    assert.match(before.text, /正在读取小助手的当前状态/, '数据未到位前必须是明确的加载页');
    assert.equal(plugin.registry.get('ok-1').stateReady, false, '前置：还没读到状态');

    await plugin.open();
    await waitFor(() => plugin.registry.get('ok-1').stateReady === true, { label: '/state 成功后应就绪' });

    const state = plugin.registry.get('ok-1');
    assert.equal(state.stateReady, true, '成功结局必须置为已就绪');
    assert.equal(state.stateError, undefined, '成功时不得留下失败原因');
    assert.equal(state.catalog.groups.length, 1, '宿主下发的目录必须真的写进 store（就绪与数据同一次原子更新）');

    const after = await renderLive(plugin, 'ok-1');
    assert.equal(/正在读取小助手的当前状态/.test(after.text), false, '就绪之后不得再显示加载页');
    // 真实内容到位：目录里有 1 个模型（模型列表默认折叠，所以断言的是折叠摘要里的真实计数，
    // 它直接来自 catalog —— 证明展示的是宿主下发的数据，而不是初始空态）。
    assert.match(after.text, /共 1 个可选/, '就绪之后必须显示真实内容（来自宿主的模型目录）');
    assert.equal(after.root.getAttribute('data-surface'), 'ready', '就绪后档位标记必须切到 ready');
  } finally { plugin.dispose(); plugin.registry.remove('ok-1'); }
});

test('/state 失败: **也**就绪，并落明确的中文错误（不得无限期停在加载态）', async () => {
  const plugin = client.createClientPlugin({ api: failingApi(), session: { id: 'fail-1' } });
  try {
    plugin.setSession('fail-1');
    await plugin.open();
    await waitFor(() => plugin.registry.get('fail-1').stateReady === true, { label: '失败结局也必须就绪' });

    const state = plugin.registry.get('fail-1');
    assert.equal(state.stateReady, true, '失败**也是**一次结局：必须置为已就绪，否则界面永远停在加载态');
    assert.equal(typeof state.stateError, 'string', '必须留下明确的失败原因');
    assert.match(state.stateError, /[\u4e00-\u9fff]/, '失败原因是中文（面向非程序员）: ' + state.stateError);
    assert.match(state.stateError, /没有读到/, '文案必须说清是「没读到」，而不是含糊的「出错」');
  } finally { plugin.dispose(); plugin.registry.remove('fail-1'); }
});

test('/state 超时: **也**就绪，并走一次失败结局（不是放行空值，也不是永远转圈）', async () => {
  // 宿主挂起：永远不返回。超时压到 30ms 才可能在单测里真触发。
  const plugin = client.createClientPlugin({
    api: failingApi({ state: () => new Promise(() => {}) }),
    session: { id: 'timeout-1' },
    stateTimeoutMs: 30,
  });
  try {
    plugin.setSession('timeout-1');
    void plugin.open();
    await waitFor(() => plugin.registry.get('timeout-1').stateReady === true, { label: '超时后也必须就绪', timeoutMs: 3000 });

    const state = plugin.registry.get('timeout-1');
    assert.equal(state.stateReady, true, '超时后必须就绪，不得无限期停在加载态');
    assert.match(String(state.stateError), /超时/, '必须明确说是超时：' + state.stateError);
    assert.match(String(state.stateError), /[\u4e00-\u9fff]/, '超时文案必须是中文');
  } finally { plugin.dispose(); plugin.registry.remove('timeout-1'); }
});

/* ================================================================== *
 * 判据 3：失败路径不得把初始空值当真实数据展示
 * ================================================================== */

test('失败路径 不得露空态: 首次打开就失败时，不得显示「暂时没有可用的模型」「还没有小助手历史」', async () => {
  const plugin = client.createClientPlugin({ api: failingApi(), session: { id: 'empty-1' } });
  try {
    plugin.setSession('empty-1');
    await plugin.open();
    await waitFor(() => plugin.registry.get('empty-1').stateReady === true, { label: '失败结局应就绪' });

    const { text } = await renderLive(plugin, 'empty-1');
    // 这两句是 store 初始空值（records=[]、catalog 未定义）的产物。失败时把它们当结论显示，
    // 等于把「没读到」说成「真的没有」—— 正是契约判据 3 禁止的第二类错值窗口。
    assert.equal(/暂时没有可用的模型/.test(text), false,
      '失败时不得显示「暂时没有可用的模型」——那是「真的没有」，与「没读到」是两件事');
    assert.equal(/还没有小助手历史/.test(text), false,
      '失败时不得显示「还没有小助手历史」——同样是拿初始空值当结论');
    assert.equal(/占用未知/.test(text), false, '失败时不得显示「占用未知」');
    // 必须给出正确的读法：明确的中文错误 + 重试
    assert.match(text, /没有读到小助手的当前状态/, '必须显示明确的中文错误');
    assert.match(text, /这不是「没有内容」/, '必须明说「不是你没有数据」，堵住错误读法');
    assert.match(text, /重试/, '失败结局必须有出路（重试入口）');
  } finally { plugin.dispose(); plugin.registry.remove('empty-1'); }
});

test('失败路径 反例: 没有失败时不得出现「状态没读到」的错误页（证明上一条不是恒真）', async () => {
  const plugin = client.createClientPlugin({ api: healthyApi(), session: { id: 'ok-rev' } });
  try {
    plugin.setSession('ok-rev');
    await plugin.open();
    await waitFor(() => plugin.registry.get('ok-rev').stateReady === true, { label: '成功应就绪' });
    const { text } = await renderLive(plugin, 'ok-rev');
    assert.equal(/没有读到小助手的当前状态/.test(text), false, '正常成功时不得冒出失败页');
  } finally { plugin.dispose(); plugin.registry.remove('ok-rev'); }
});

test('失败路径 旧内容: 已经有正确旧内容时，刷新失败不得把它抹掉（契约的另一条出路）', async () => {
  let fail = false;
  // 一个可控的 api：先成功一次（拿到真实记录与目录），随后让 /state 开始失败。
  const api = apiWith(async () => {
    if (fail) throw new Error('网络断了');
    return { payload: { records: [{ id: 'r1', question: '以前问过什么', answerText: '以前的回答', startedAt: '2026-01-01T00:00:00.000Z' }], hasEarlier: false, catalog: { groups: [{ provider: 'p', models: [{ provider: 'p', id: 'm', name: 'M' }] }], failures: [] } } };
  });
  const second = client.createClientPlugin({ api, session: { id: 'keep-old' } });
  try {
    second.setSession('keep-old');
    await second.open();
    await waitFor(() => second.registry.get('keep-old').stateReady === true, { label: '首次应成功就绪' });
    const good = second.registry.get('keep-old');
    assert.equal(good.records.length, 1, '前置：已经有真实内容');

    fail = true;
    await second.retryState('keep-old');
    await waitFor(() => typeof second.registry.get('keep-old').stateError === 'string', { label: '第二次刷新应失败' });

    const after = second.registry.get('keep-old');
    assert.equal(after.stateReady, true, '失败结局仍是已就绪');
    assert.equal(after.records.length, 1, '刷新失败不得把已经正确的旧记录抹掉（§8「关掉再打开能查看」）');
    const { text } = await renderLive(second, 'keep-old');
    assert.match(text, /以前的回答/, '旧内容必须继续展示（契约允许的「继续展示已经正确的旧内容」这条出路）');
    assert.match(String(after.stateError), /没有读到/, '同时必须把失败原因如实说出来');
  } finally { second.dispose(); second.registry.remove('keep-old'); }
});

/* ================================================================== *
 * 判据 4：不得用定时器把「未就绪」伪装成「已就绪」后放行空值
 * ================================================================== */

test('反伪装 定时器: 超时走的是**失败结局**，不是「等到点就把空值当数据渲染」', async () => {
  // 这条是本轮最容易做错的地方：把超时实现成「到点置 stateReady=true 并照常渲染」，
  // 界面上就会出现一个「看起来正常、其实全是初始空值」的界面 —— 与旧缺陷一模一样。
  const plugin = client.createClientPlugin({
    api: failingApi({ state: () => new Promise(() => {}) }),
    session: { id: 'fake-1' },
    stateTimeoutMs: 30,
  });
  try {
    plugin.setSession('fake-1');
    void plugin.open();
    await waitFor(() => plugin.registry.get('fake-1').stateReady === true, { label: '超时应就绪', timeoutMs: 3000 });

    const state = plugin.registry.get('fake-1');
    // 如果超时被实现成「伪装就绪」，stateError 会是 undefined，而界面会去渲染空态。
    assert.equal(state.stateError === undefined, false,
      '超时必须留下失败原因；若 stateError 为空，说明超时被当成「正常就绪」放行了');
    const { text } = await renderLive(plugin, 'fake-1');
    assert.equal(/暂时没有可用的模型|还没有小助手历史|占用未知/.test(text), false,
      '超时后绝不得把初始空值当真实数据渲染（那正是要消掉的错值窗口）');
    assert.match(text, /超时/, '超时只能导向错误提示');
  } finally { plugin.dispose(); plugin.registry.remove('fake-1'); }
});

test('反伪装 源码: 不得在「未就绪」时用定时器直接置 stateReady', () => {
  // 源码级守卫：唯一允许把 stateReady 置 true 的地方是 /state 的两种结局
  // （成功合并里、以及失败处理 applyStateFailure 里）。
  // 这条防止将来有人为了让加载页「别停太久」而加一个「到点就算就绪」的定时器。
  const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8');
  const assignments = [...source.matchAll(/stateReady:\s*true/g)];
  assert.equal(assignments.length, 2,
    'stateReady 只应在两处置位：/state 成功的合并、以及失败结局（applyStateFailure）。实际 ' + assignments.length + ' 处');
  // 定时器只允许出现在超时包装里（withStateTimeout），不得有「定时器 → 置就绪」的组合。
  assert.match(source, /读取小助手状态超时/, '超时必须转成一次失败（中文原因），而不是静默放行');
});

/* ================================================================== *
 * 判据 2 补充：ensureState 兜底读取（否则浮窗会永远停在加载页）
 * ================================================================== */

test('ensureState: 未就绪时才发请求；已就绪时不发（不改变既有链路的时机）', async () => {
  let calls = 0;
  const plugin = client.createClientPlugin({
    api: apiWith(async () => { calls++; return { payload: { records: [], hasEarlier: false } }; }),
    session: { id: 'ensure-1' },
  });
  try {
    plugin.setSession('ensure-1');
    await plugin.ensureState('ensure-1');
    assert.equal(calls, 1, '未就绪时必须真的问一次 /state');
    assert.equal(plugin.registry.get('ensure-1').stateReady, true);
    await plugin.ensureState('ensure-1');
    assert.equal(calls, 1, '已就绪后不得再打接口（不得改变既有链路的请求次数）');
  } finally { plugin.dispose(); plugin.registry.remove('ensure-1'); }
});

test('ensureState: 并发调用同一会话只打一次接口（in-flight 去重）', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const plugin = client.createClientPlugin({
    api: apiWith(async () => { calls++; await gate; return { payload: { records: [], hasEarlier: false } }; }),
    session: { id: 'ensure-2' },
  });
  try {
    plugin.setSession('ensure-2');
    const all = Promise.all([plugin.ensureState('ensure-2'), plugin.ensureState('ensure-2'), plugin.ensureState('ensure-2')]);
    release();
    await all;
    assert.equal(calls, 1, '并发三次只应打一次接口（与 primeUnread 同一套去重思路），实际 ' + calls);
  } finally { plugin.dispose(); plugin.registry.remove('ensure-2'); }
});

test('retryState: 失败后点重试必须真的再问一次（不能复用那次已经失败的结果）', async () => {
  let calls = 0;
  let fail = true;
  const plugin = client.createClientPlugin({
    api: apiWith(async () => { calls++; if (fail) throw new Error('断了'); return { payload: { records: [], hasEarlier: false } }; }),
    session: { id: 'retry-1' },
  });
  try {
    plugin.setSession('retry-1');
    await plugin.retryState('retry-1');
    assert.equal(plugin.registry.get('retry-1').stateReady, true, '失败也应是「已就绪的失败结局」');
    assert.match(String(plugin.registry.get('retry-1').stateError), /没有读到/);

    fail = false;
    const before = calls;
    await plugin.retryState('retry-1');
    assert.equal(calls, before + 1, '重试必须真的再发一次请求');
    await waitFor(() => plugin.registry.get('retry-1').stateError === undefined, { label: '重试成功后失败原因应被清掉' });

    const { text } = await renderLive(plugin, 'retry-1');
    assert.equal(/没有读到小助手的当前状态/.test(text), false, '重试成功后不得再显示失败页');
  } finally { plugin.dispose(); plugin.registry.remove('retry-1'); }
});

/* ================================================================== *
 * 判据 1 补充：真实 registry 的未就绪界面（而不是手写字面量）
 * ================================================================== */

test('未就绪 真实 registry: 界面是加载页，且**一个空态文案都没有**', async () => {
  const plugin = client.createClientPlugin({ api: failingApi(), session: { id: 'loading-1' } });
  try {
    plugin.setSession('loading-1');
    // 刻意**不**调 open()/retryState()：此刻就是「浮窗刚打开、/state 还在飞」的那一刻。
    const state = plugin.registry.get('loading-1');
    assert.equal(state.stateReady, false, '前置：确实还没读过 /state');

    const { text, root } = await renderLive(plugin, 'loading-1');
    assert.match(text, /正在读取小助手的当前状态/, '未就绪必须显示明确的加载信号');
    assert.equal(root.getAttribute('data-surface'), 'loading', '根元素必须标出当前档位（供样式与页面实测定位）');
    // 这一段就是「错值窗口」的定义：未就绪期间**不许**出现任何会被当成结论的空值/默认值。
    const forbidden = ['暂时没有可用的模型', '还没有小助手历史', '占用未知', '还没有选择模型'];
    const leaked = forbidden.filter(word => text.includes(word));
    assert.deepEqual(leaked, [], '未就绪期间不得出现任何空态结论：' + JSON.stringify(leaked));
  } finally { plugin.dispose(); plugin.registry.remove('loading-1'); }
});

test('一次到位: 从加载页到正常界面是**同一个浮窗元素**，不是重建（位置与大小不变）', async () => {
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  const plugin = client.createClientPlugin({ api: healthyApi(), session: { id: 'one-shot' } });
  try {
    plugin.setSession('one-shot');
    plugin.registry.update('one-shot', { geometry: { x: 220, y: 32, width: 620, height: 526 } });
    const live = { registry: plugin.registry, cancel: () => {}, submit: async () => {}, loadEarlier: async () => {} };
    const root = overlay.renderOverlay(plugin.registry.get('one-shot'), live);
    const before = { left: root.style.left, top: root.style.top, width: root.style.width, height: root.style.height };
    assert.deepEqual(before, { left: '220px', top: '32px', width: '620px', height: '526px' }, '前置：加载页就在用户摆放的位置上');

    await plugin.open();
    await waitFor(() => plugin.registry.get('one-shot').stateReady === true, { label: '应就绪' });
    // 数据到位：复用**同一个** root 原地重画（这正是 entry.ts 的做法）
    overlay.updateOverlay(root, plugin.registry.get('one-shot'), live);

    assert.deepEqual({ left: root.style.left, top: root.style.top, width: root.style.width, height: root.style.height }, before,
      '从加载页切到正常界面时，浮窗的位置与大小必须不变（同一次过渡，不跳位）');
    assert.equal(plugin.registry.get('one-shot').stateReady, true);
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.restore();
    plugin.dispose();
    plugin.registry.remove('one-shot');
  }
});
