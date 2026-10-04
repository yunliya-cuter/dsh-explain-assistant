import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource, waitFor } from './fixtures/runtime.mjs';

/**
 * §7/§9.2/§10/§5.1：「**宿主响应不得覆盖更新的本地状态**」同类排查的回归闸。
 *
 * ── 这里守的是一条通用模式 ─────────────────────────────────────────
 * F2 分页缺陷的根因不是分页独有的：客户端**整份照抄**宿主下发的一个「视角受限」字段
 * （宿主 state 恒按「首屏 = 最近一页」算），于是宿主「这一页」的结论被当成「全部」的结论，
 * 一次刷新就把已经翻到底的状态改回去。
 *
 * 本次把 src/client/ 下所有「用宿主响应覆盖本地」的位置过了一遍，实测出**四处**同类风险：
 *   1. §7 model      —— 宿主没下发 model 时，用户刚选的模型从界面消失
 *   2. §9.2 占用      —— 回答进行中，本地从 usage 事件学到的占用被刷新改回「未知」（圆环熄灭）
 *   3. §5.1 展开续读  —— 同一页取回两次，展开区的依据重复显示
 *   4. §10 未读       —— 冷启动预取响应晚于「打开浮窗」返回，把已清除的未读重新点亮
 *
 * 已确认**安全**的入口（未改动，列为对照）：
 *   · refreshState 的 records 合并（保留「本地已有、这一页没有」的更早记录）
 *   · refreshState 的 hasEarlier/historyCursor（上一轮已改为客户端自算）
 *   · compactState（仅 running/error/interrupted 时保留本地，其余采纳宿主）
 *   · catalog（宿主没给时保留本地：...(catalog ? { catalog } : {})）
 *   · openHistoryDetail（有「记录 id 变了就丢弃迟到回包」的守卫）
 */

function baseApi(overrides = {}) {
  return {
    state: async () => ({ payload: {} }),
    models: async () => ({ payload: {} }),
    selectModel: async () => ({}),
    history: async () => ({ payload: {} }),
    historyResult: async () => ({ payload: {} }),
    ask: async () => {}, compact: async () => {}, cancel: async () => {},
    forget: async () => ({}), markRead: async () => ({}),
    ...overrides,
  };
}

async function newPlugin(id, overrides) {
  const client = await moduleFromSource('src/client/index.ts');
  const plugin = client.createClientPlugin({ api: baseApi(overrides), session: { id } });
  plugin.setSession(id);
  return plugin;
}

/* ================================================================== *
 * 1) §7 model：宿主没下发 ≠ 用户没选
 * ================================================================== */

test('同类排查 model: 宿主这次没下发 model 时，不得把用户刚选的模型抹掉', async () => {
  // 宿主响应里**没有** model 字段（例如用户刚点选、宿主尚未落库，或这次读取拿不到）
  const plugin = await newPlugin('m1', { state: async () => ({ payload: { records: [], hasEarlier: false } }) });
  try {
    // 用户刚选了模型（界面乐观更新，显示「本对话已选」）
    plugin.registry.update('m1', { model: { provider: 'p', model: 'm', source: 'explicit' } });
    assert.equal(plugin.registry.get('m1').model?.model, 'm', '前置：本地已选模型');

    plugin.open();
    await waitFor(() => plugin.registry.get('m1').records !== undefined, { label: '刷新应完成' });
    await new Promise(r => setTimeout(r, 40));   // 让刷新写回

    assert.equal(plugin.registry.get('m1').model?.model, 'm',
      '宿主没给 model 时不得抹掉本地已选模型（否则用户会觉得「我明明选了却没了」）');
  } finally { plugin.dispose(); }
});

test('同类排查 model 不回归: 宿主确实下发了 model 时必须采纳（不能变成永不更新）', async () => {
  const plugin = await newPlugin('m2', {
    state: async () => ({ payload: { records: [], hasEarlier: false, model: { provider: 'host', model: 'host-m', source: 'explicit' } } }),
  });
  try {
    plugin.open();
    await waitFor(() => plugin.registry.get('m2').model?.model === 'host-m', { label: '宿主下发的 model 必须被采纳' });
    assert.equal(plugin.registry.get('m2').model.model, 'host-m');
  } finally { plugin.dispose(); }
});

/* ================================================================== *
 * 2) §9.2 占用：回答进行中不得被刷新改回「未知」
 * ================================================================== */

test('同类排查 占用: 回答进行中，本地从 usage 学到的占用不得被刷新改回「未知」', async () => {
  let releaseAsk;
  const gate = new Promise(r => { releaseAsk = r; });
  const plugin = await newPlugin('o1', {
    // 宿主此刻「不知道占用」（没有 occupancy 字段）
    state: async () => ({ payload: { records: [], hasEarlier: false } }),
    ask: async (sid, q, sig, ev, onEvent) => {
      onEvent({ type: 'start', data: { sessionId: sid, requestId: 'r1', payload: {} } });
      onEvent({ type: 'usage', data: { percent: 42 } });
      await gate;
    },
  });
  try {
    plugin.submit('问').catch(() => undefined);
    await waitFor(() => plugin.registry.get('o1').occupancy === 42, { label: 'usage 事件应写入占用' });
    assert.equal(plugin.registry.get('o1').occupancyKnown, true, '前置：本地已知占用');

    plugin.open();                                   // 回答进行中，用户又打开了一次
    await new Promise(r => setTimeout(r, 60));

    const st = plugin.registry.get('o1');
    assert.equal(st.occupancyKnown, true,
      '回答进行中不得把已知占用改回「未知」（否则界面圆环在回答过程中熄灭，用户以为统计坏了）');
    assert.equal(st.occupancy, 42, '占用值也必须是本地更新的那个');
  } finally { releaseAsk(); plugin.dispose(); }
});

test('同类排查 占用 不回归: 没有活动请求时，仍必须采纳宿主下发的占用', async () => {
  const plugin = await newPlugin('o2', {
    state: async () => ({ payload: { records: [], hasEarlier: false, occupancy: 77, occupancyKnown: true, occupancyEstimated: true } }),
  });
  try {
    plugin.open();
    await waitFor(() => plugin.registry.get('o2').occupancy === 77, { label: '宿主下发的占用必须被采纳' });
    assert.equal(plugin.registry.get('o2').occupancyKnown, true);
  } finally { plugin.dispose(); }
});

/* ================================================================== *
 * 3) §5.1 展开续读：同一页取回两次不得重复显示依据
 * ================================================================== */

test('同类排查 展开续读: 同一页被取回两次时，依据不得重复显示（按 id 去重）', async () => {
  const page = {
    sessionId: 'd1', recordId: 'r1', counts: { evidence: 6, tools: 0, images: 0 },
    record: { id: 'r1', question: 'q', evidence: [{ id: 'e0' }, { id: 'e1' }, { id: 'e2' }], tools: [], images: [] },
    cursor: '3', hasEarlier: true,
  };
  const plugin = await newPlugin('d1', { historyResult: async () => ({ payload: { ...page } }) });
  try {
    await plugin.openHistoryDetail('r1');
    assert.deepEqual(plugin.registry.get('d1').historyDetail.record.evidence.map(e => e.id), ['e0', 'e1', 'e2'], '前置：第一页');

    // 强制再取一次「同一页」（模拟游标陈旧 / 宿主索引位移 / 用户连点）
    plugin.registry.update('d1', current => {
      current.historyDetail = { ...current.historyDetail, hasEarlier: true, cursor: '3', loadingMore: false };
    });
    await plugin.loadMoreHistoryDetail();

    const ids = plugin.registry.get('d1').historyDetail.record.evidence.map(e => e.id);
    assert.deepEqual(ids, ['e0', 'e1', 'e2'], '同一页取回两次不得重复显示依据，实际：' + JSON.stringify(ids));
  } finally { plugin.dispose(); }
});

test('同类排查 展开续读 不回归: 真正的新一页必须接上（去重不能把新内容也挡掉）', async () => {
  let call = 0;
  const plugin = await newPlugin('d2', {
    historyResult: async () => {
      call++;
      return call === 1
        ? { payload: { sessionId: 'd2', recordId: 'r1', record: { id: 'r1', evidence: [{ id: 'e0' }, { id: 'e1' }] }, cursor: '2', hasEarlier: true } }
        : { payload: { sessionId: 'd2', recordId: 'r1', record: { id: 'r1', evidence: [{ id: 'e2' }, { id: 'e3' }] }, cursor: null, hasEarlier: false } };
    },
  });
  try {
    await plugin.openHistoryDetail('r1');
    await plugin.loadMoreHistoryDetail();
    const ids = plugin.registry.get('d2').historyDetail.record.evidence.map(e => e.id);
    assert.deepEqual(ids, ['e0', 'e1', 'e2', 'e3'], '新一页必须接上（去重不得把新内容也挡掉）');
  } finally { plugin.dispose(); }
});

/* ================================================================== *
 * 4) §10 未读：过期的预取响应不得把已清除的未读重新点亮
 * ================================================================== */

test('同类排查 未读: 冷启动预取响应晚于「打开浮窗」返回时，不得把已清除的未读重新点亮', async () => {
  let releaseState;
  const gate = new Promise(r => { releaseState = r; });
  const plugin = await newPlugin('u1', {
    // 宿主说「未读」——但这份响应是在用户打开浮窗**之前**发起的
    state: async () => { await gate; return { payload: { unread: true, records: [], hasEarlier: false } }; },
  });
  try {
    const priming = plugin.primeUnread('u1');        // 冷启动预取（挂起中）
    plugin.open();                                   // 用户立刻打开浮窗 → 本地清除未读
    assert.equal(plugin.registry.get('u1').unread, false, '前置：打开浮窗后本地已清除');

    releaseState();                                  // 预取的宿主响应现在才到
    await priming;
    await new Promise(r => setTimeout(r, 40));

    assert.equal(plugin.registry.get('u1').unread, false,
      '过期的预取响应不得把已清除的未读重新点亮（否则徽标清除后自己又亮 = 用户看到闪烁）');
  } finally { plugin.dispose(); }
});

test('同类排查 未读 不回归: 打开过之后来的**新**未读仍必须点亮', async () => {
  // 防止上面那道守卫写得太宽：打开过 → 关掉 → 来了新回答 → 冷启动预取读到 true，这是合法未读。
  const plugin = await newPlugin('u2', {
    state: async () => ({ payload: { unread: true, records: [], hasEarlier: false } }),
  });
  try {
    plugin.open();                                   // 打开一次（清除未读）
    await new Promise(r => setTimeout(r, 40));
    assert.equal(plugin.registry.get('u2').unread, false, '前置：已清除');

    // 之后发起的一次**新**预取（晚于上次打开）读到未读 → 必须采纳
    plugin.registry.remove?.('u2');                  // 清掉去重缓存，让这次真的重新请求
    await plugin.primeUnread('u2');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(plugin.registry.get('u2').unread, true,
      '打开之后才发起的预取读到未读时必须点亮（守卫不得把合法未读一起压掉）');
  } finally { plugin.dispose(); }
});
