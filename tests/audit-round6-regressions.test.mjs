import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleFromSource, fakeDom, FakeElement, waitFor, waitSettled } from './fixtures/runtime.mjs';

/**
 * 反向审计第二轮（docs/evidence/regression-audit-round6.md）抓出的三条反例的回归测试。
 *
 * 审计员的提醒很重要：「测试全绿」当时不能作为这几条已通过的证据——
 * 因为既有断言恰好都在盲区里：C4 用 mock 不校验字段名、C5 只测单次点击、C2 只 grep 文案不跑最终态。
 * 所以这里刻意**打在这些盲区上**：真实字段名、第二次点击、最终态渲染。
 */

/* ---------------- C4：发给宿主的字段名必须是契约里的名字 ---------------- */

test('C4: searchEvents 必须传 limit，不能传 pageSize（后者被静默忽略）', async () => {
  const source = await readFile(new URL('../src/host/tools.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/pageSize\s*:/.test(code), false, '代码里不得再出现 pageSize 字段');
  assert.match(code, /limit\s*:\s*lv/, '必须把用户给的条数按契约名 limit 传下去');
});

test('C4: 用户的 limit 真的会被传到宿主（用假宿主抓实际收到的请求）', async () => {
  const tools = await moduleFromSource('src/host/tools.ts');
  const seen = [];
  const ctx = {
    sessionId: 's',
    sessionQuery: {
      searchEvents: async (request) => { seen.push(request); return { hits: [], total: 0 }; },
      readEvent: async () => ({}),
    },
  };
  const result = await tools.executeTool(ctx, { name: 'explain_search_session', arguments: { query: 'x', limit: 7 } });
  assert.equal(result.ok, true, '搜索应当成功：' + JSON.stringify(result));
  assert.equal(seen.length, 1, '必须真的调了 searchEvents');
  assert.equal(seen[0].limit, 7, '用户设的 7 必须出现在 limit 字段上，实际：' + JSON.stringify(seen[0]));
  assert.equal(seen[0].pageSize, undefined, '不得出现 pageSize 字段');
});

test('C4: 取消信号按契约作为第二个参数传给 searchEvents', async () => {
  const tools = await moduleFromSource('src/host/tools.ts');
  let secondArg;
  const ctx = {
    sessionId: 's',
    sessionQuery: { searchEvents: async (request, exec) => { secondArg = exec; return { hits: [] }; }, readEvent: async () => ({}) },
  };
  await tools.executeTool(ctx, { name: 'explain_search_session', arguments: { query: 'x' } });
  assert.ok(secondArg && typeof secondArg === 'object', '第二个参数（exec）必须存在');
  assert.ok(secondArg.signal instanceof AbortSignal, 'exec.signal 必须是 AbortSignal，实际：' + typeof secondArg?.signal);
});

/* ---------------- C5：选择模式必须能退出 ---------------- */

function overlayFixture(state) {
  const plugin = { registry: { update() {}, get: () => state, close() {} }, api: {}, cancel() {}, submit() {}, loadEarlier() {} };
  return moduleFromSource('src/client/overlay.tsx').then(overlay => overlay.renderOverlay({ ...state, open: true }, plugin));
}

const baseState = {
  sessionId: 's', open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
  tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [],
  occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: true,
};

test('C5: 再点一次「选择主对话内容」必须退出选择模式', async () => {
  const dom = fakeDom();
  try {
    const root = await overlayFixture(baseState);
    const selectBtn = Array.from(root.querySelectorAll('button')).find(b => /选择主对话内容|退出选择模式/.test(b.textContent || ''));
    assert.ok(selectBtn, '必须存在选择按钮');
    selectBtn.emit('click');
    assert.equal(root.hasAttribute('data-selection-mode'), true, '第一次点击应进入选择模式');
    selectBtn.emit('click');
    assert.equal(root.hasAttribute('data-selection-mode'), false, '第二次点击必须退出（C5 反例）');
  } finally { await new Promise(r => setTimeout(r, 0)); dom.restore(); }
});

test('C5: 选中一条依据后自动退出选择模式', async () => {
  const dom = fakeDom();
  try {
    const root = await overlayFixture(baseState);
    const selectBtn = Array.from(root.querySelectorAll('button')).find(b => /选择主对话内容|退出选择模式/.test(b.textContent || ''));
    selectBtn.emit('click');
    assert.equal(root.hasAttribute('data-selection-mode'), true);
    // 模拟用户点中主对话里的一条依据
    dom.document.emit('dsh-explain-assistant:evidence-selected', { detail: { sessionId: 's', item: { id: 'e1' } } });
    assert.equal(root.hasAttribute('data-selection-mode'), false, '选中后必须自动退出，否则后续点击被持续吞掉');
  } finally { await new Promise(r => setTimeout(r, 0)); dom.restore(); }
});

test('C5: 其他会话的选中事件不得误退本窗口的选择模式', async () => {
  const dom = fakeDom();
  try {
    const root = await overlayFixture(baseState);
    const selectBtn = Array.from(root.querySelectorAll('button')).find(b => /选择主对话内容|退出选择模式/.test(b.textContent || ''));
    selectBtn.emit('click');
    dom.document.emit('dsh-explain-assistant:evidence-selected', { detail: { sessionId: 'other-session', item: { id: 'e1' } } });
    assert.equal(root.hasAttribute('data-selection-mode'), true, '别的会话的事件不该影响本窗口');
  } finally { await new Promise(r => setTimeout(r, 0)); dom.restore(); }
});

test('C5: 源码里确实有清除选择模式的路径（不再是只进不出）', async () => {
  const source = await readFile(new URL('../src/client/overlay.tsx', import.meta.url), 'utf8');
  assert.match(source, /removeAttribute\('data-selection-mode'\)/, '必须有清除代码');
  assert.match(source, /leaveSelectionMode/, '必须有统一的退出入口');
});

/* ---------------- C2：本次压缩失败不得被旧摘要盖成成功 ---------------- */

test('C2: refreshState 不得用旧摘要覆盖本次失败态', async () => {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8');
  // C2 的不变式：**只要本地是本次刚发生的非成功态，就必须保留**，不能被宿主落库的旧摘要盖成成功。
  // S1 修复把「非 complete 一律保留（含 idle）」收窄成「running/error/interrupted 保留」——
  // 因为 idle 只代表「这个会话还没开始过」，此时必须采用宿主下发的摘要，否则刷新页面摘要就丢了。
  assert.match(source, /status === 'running' \|\| current\.compactState\.status === 'error' \|\| current\.compactState\.status === 'interrupted'/, '进行中或失败态必须保留本地状态');
  // 同时确认 idle 已不在保留集合里（否则 S1 会复发）。
  assert.equal(/current\.compactState\.status !== 'complete'/.test(source), false, '不得再用「非 complete 一律保留」，那会把 idle 也挡掉');
});

test('C2 真实最终态: 已有历史摘要 + 本次摘要为空 → 界面必须显示失败，不是「已压缩」', async () => {
  const dom = fakeDom();
  try {
    const client = await moduleFromSource('src/client/index.ts');
    const overlay = await moduleFromSource('src/client/overlay.tsx');
    const OLD = '上一次成功压缩留下的旧摘要';
    let stateCalls = 0;                                   // 用于条件等待刷新链，而不是固定 sleep
    const api = {
      // 宿主落库的仍是上一次成功的摘要（§9.1：只有成功才落库）
      state: async () => { stateCalls++; return { payload: { records: [], hasEarlier: false, compactState: { version: 1, summary: OLD, createdAt: '2026-01-01T00:00:00.000Z' } } }; },
      models: async () => ({ payload: {} }), selectModel: async () => ({ payload: {} }),
      history: async () => ({ payload: {} }), historyResult: async () => ({ payload: {} }),
      cancel: async () => {},
      ask: async () => {},
      // 压缩「完成」但模型没返回正文
      compact: async (s, sig, onEvent) => {
        onEvent({ type: 'start', data: { requestId: 'r1', sessionId: 's1' }, envelope: { schemaVersion: 1, sessionId: 's1', requestId: 'r1', operation: 'compact', type: 'start' } });
        onEvent({ type: 'complete', data: { text: '', summary: '', requestId: 'r1', sessionId: 's1' }, envelope: { schemaVersion: 1, sessionId: 's1', requestId: 'r1', operation: 'compact', type: 'complete' } });
      },
    };
    const plugin = client.createClientPlugin({ api, session: { id: 's1' } });
    plugin.setSession('s1');
    await plugin.open();
    // 等 open() 引发的那次 /state 真的返回（按调用计数，而不是赌固定时间）。
    await waitFor(() => stateCalls >= 1, { label: 'open() 引发的刷新应完成' });
    await plugin.submit('/compact');
    // 等压缩链路彻底结束：它的 complete 之后还会再触发一次 refreshState。
    // 压缩链路彻底结束：complete 之后 index.ts 还会 fire-and-forget 一次 refreshState
    // （那次刷新会带回宿主的「上一次成功摘要」，正是本条要验证「它不得盖掉失败态」的那一步）。
    // 用「/state 至少被调用 2 次」代替固定 sleep：第 1 次来自 open()，第 2 次来自压缩完成。
    await waitFor(() => stateCalls >= 2, { label: '压缩后的刷新应完成（/state 累计 ≥2 次）' });
    await waitFor(() => plugin.registry.get('s1').compactState?.status === 'error', { label: '压缩失败态应保留' });
    const state = plugin.registry.get('s1');
    assert.equal(state.compactState?.status, 'error', '本次压缩没拿到摘要，状态必须是失败：' + JSON.stringify(state.compactState));
    const rendered = overlay.renderOverlay({ ...state, open: true }, { registry: { update() {}, get: () => state }, api: {}, cancel() {}, submit() {}, loadEarlier() {} });
    const text = rendered.textContent || '';
    assert.match(text, /压缩失败/, '界面必须显示失败');
    assert.equal(/^已压缩/.test(text.trim()) || /已压缩：/.test(text), false, '不得显示成「已压缩」（C2 反例）');
  } finally { await new Promise(r => setTimeout(r, 0)); dom.restore(); }
});
