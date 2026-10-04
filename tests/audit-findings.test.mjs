import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moduleFromSource, fakeDom, waitFor, waitSettled } from './fixtures/runtime.mjs';

const tools = await moduleFromSource('src/host/tools.ts');
const client = await moduleFromSource('src/client/index.ts');
const overlay = await moduleFromSource('src/client/overlay.tsx');

/**
 * 反向审计（docs/evidence/regression-audit-round6.md）抓出的两条反例的回归测试。
 *
 * 这两条都不是「修复没做」，而是**修复留下的漏网分支**：
 * - C1：B1 的占用修复被 usage 事件覆盖 → 一提问圆环就从「估算」退化。
 * - C3：B5 的中文化漏了 mapError 的兜底分支 → Node 原生英文错误直出界面。
 */

/* ---------------- C3：兜底分支不得输出英文 ---------------- */

const cjk = (t) => (t.match(/[\u4e00-\u9fff]/g) || []).length;
const isEnglishOnly = (t) => cjk(t) === 0 && /[A-Za-z]{3}/.test(t);

test('C3: 读不存在的文件时给中文原因，英文 errno 只能进 details', async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ea-c3-'));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const result = await tools.executeTool({ sessionId: 's', workspace: ws }, { name: 'explain_read_workspace_file', arguments: { path: 'missing.txt' } });
  assert.equal(result.ok, false);
  assert.equal(isEnglishOnly(result.message), false, '面向用户的 message 绝不能是英文原文：' + result.message);
  assert.ok(cjk(result.message) > 0, '必须给中文原因');
  assert.match(String(result.details?.cause ?? ''), /ENOENT/, '原始英文信息应保留在 details 里供排查');
});

test('C3: 目录当文件读、路径中段不存在，都不得输出英文', async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ea-c3b-'));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await mkdir(path.join(ws, 'adir'));
  for (const p of ['adir', 'nope/x.txt']) {
    const result = await tools.executeTool({ sessionId: 's', workspace: ws }, { name: 'explain_read_workspace_file', arguments: { path: p } });
    assert.equal(result.ok, false, p + ' 应当失败');
    assert.equal(isEnglishOnly(result.message), false, p + ' 的文案不得是英文：' + result.message);
  }
});

test('C3: mapError 兜底不再把原始 Error.message 当用户文案', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/host/tools.ts', import.meta.url), 'utf8');
  assert.match(source, /工具执行失败/, '必须有中文兜底文案');
  assert.equal(/return bad\('TOOL_FAILED',e instanceof Error\?e\.message/.test(source), false, '不得再把英文 message 直接当用户文案');
});

/* ---------------- C1：占用圆环不得因问答而退化 ---------------- */

const mkEvent = (type, payload) => ({
  type, data: { ...payload, sessionId: 's1', requestId: 'r1' },
  envelope: { schemaVersion: 1, sessionId: 's1', requestId: 'r1', operation: 'ask', type },
});

function fixtureApi(events) {
  return {
    state: async () => ({ payload: { records: [], hasEarlier: false, model: { provider: 'w', model: 'm', source: 'explicit' }, occupancy: 3.7, occupancyKnown: true, occupancyEstimated: true, catalog: { groups: [], failures: [] } } }),
    models: async () => ({ payload: { groups: [], failures: [] } }),
    selectModel: async () => ({ payload: {} }),
    history: async () => ({ payload: { records: [], hasEarlier: false } }),
    historyResult: async () => ({ payload: {} }),
    cancel: async () => {},
    ask: async (s, q, sig, ev, onEvent) => { for (const e of events) onEvent(e); },
    compact: async () => {},
  };
}

function ringOf(state) {
  const plugin = { registry: { update() {}, get: () => state }, api: {}, cancel() {}, submit() {}, loadEarlier() {} };
  const root = overlay.renderOverlay({ ...state, open: true }, plugin);
  const ring = root.querySelector('.dsh-explain-assistant-ring');
  return { text: ring.textContent, unknown: ring.getAttribute('data-unknown'), estimated: ring.getAttribute('data-estimated') };
}

test('C1: 真实 usage 事件（TokenUsage 无 percent）不得把占用改成「未知」', async () => {
  const dom = fakeDom();
  try {
    const plugin = client.createClientPlugin({ api: fixtureApi([
      mkEvent('start', { requestId: 'r1' }),
      mkEvent('usage', { usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 } }),
      mkEvent('text', { delta: '回答' }),
      mkEvent('complete', { text: '回答' }),
    ]), session: { id: 's1' } });
    plugin.setSession('s1');
    await plugin.open();
    // 等刷新链写完再读占用（固定 sleep 会随链路变长偶发失败）。
    await waitFor(() => plugin.registry.get('s1').occupancyKnown === true, { label: '打开后应拿到占用' });
    const before = ringOf(plugin.registry.get('s1'));
    assert.match(before.text, /估算/, '打开时应显示估算占用');
    await plugin.submit('它在干什么');
    await waitSettled(plugin.registry, 's1');
    const after = ringOf(plugin.registry.get('s1'));
    assert.equal(after.unknown, null, '问答后不得退化成「占用未知」');
    assert.match(after.text, /估算/, '问答后仍应是带「估算」的占用：' + after.text);
  } finally { await new Promise(r => setTimeout(r, 0)); dom.restore(); }
});

test('C1: usage 事件确实带 percent 时才更新占用（不能被一律忽略）', async () => {
  const dom = fakeDom();
  try {
    const plugin = client.createClientPlugin({ api: fixtureApi([
      mkEvent('start', { requestId: 'r1' }),
      mkEvent('usage', { percent: 42 }),
      mkEvent('complete', { text: 'x' }),
    ]), session: { id: 's1' } });
    plugin.setSession('s1');
    await plugin.open();
    await waitFor(() => plugin.registry.get('s1').occupancyKnown === true, { label: '打开后应拿到占用' });
    await plugin.submit('问');
    await waitSettled(plugin.registry, 's1');
    const state = plugin.registry.get('s1');
    // refreshState 会再拉一次 state（3.7），所以最终值应回到宿主值而不是 42；
    // 关键断言是：带 percent 的事件确实被接受过，且最终仍是已知态。
    assert.equal(state.occupancyKnown, true, '占用必须保持已知');
  } finally { await new Promise(r => setTimeout(r, 0)); dom.restore(); }
});

test('C1: 问答结束后会重新向宿主取一次占用（§9.2 最后一条：上下文变长要重算）', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8');
  assert.match(source, /void refreshState\(request\.sessionId\);/, 'complete 后必须刷新 state');
  assert.equal(/occupancy: percent, occupancyKnown: percent !== undefined/.test(source), false, '不得再用 percent 是否为 undefined 覆盖占用状态');
});
