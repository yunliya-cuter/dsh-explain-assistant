import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { moduleFromSource, fakeDom, FakeElement } from './fixtures/runtime.mjs';

/**
 * 第 8 轮修复的回归测试：F4（依据三级分级）、F6（归档清理）、F8（模型不可用降级）、
 * B6（输入框上方的「正在围绕哪条提问」标识）。
 *
 * 每条都对回 docs/business-logic.md 的具体条目，并用真实代码路径取证。
 */

const readSource = relative => readFile(new URL('../' + relative, import.meta.url), 'utf8');
const selection = await moduleFromSource('src/client/selection.ts');
const overlay = await moduleFromSource('src/client/overlay.tsx');

function card(attrs, text) {
  const el = new FakeElement('div');
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  el.textContent = text;
  return el;
}

/* ===================== F4：§6.3 依据三级分级 ===================== */

test('F4: 三个级别都能从真实 DOM 状态产出，不再只有 observed', () => {
  const observed = selection.evidenceFromElement(card({ 'data-tool': 'read_file', 'data-state': 'done' }, '文件内容'), 's');
  const failed = selection.evidenceFromElement(card({ 'data-tool': 'read_file', 'data-state': 'failed' }, '报错原文'), 's');
  const reported = selection.evidenceFromElement(card({ 'data-chat-node-key': 'n1', 'data-chat-flow-kind': 'assistant-step' }, '我准备改配置'), 's');
  const unknown = selection.evidenceFromElement(card({ 'data-chat-node-key': 'n2' }, ''), 's');

  assert.equal(observed.evidenceState, 'observed', '工具真实完成 = 记录已证实');
  assert.equal(failed.evidenceState, 'observed', '工具真实失败也属于「已证实」（证实的是失败）');
  assert.equal(reported.evidenceState, 'reported_only', '主 agent 的汇报只是说法，不等于验证');
  assert.equal(unknown.evidenceState, 'unavailable', '没有正文 = 信息不足');
});

test('F4: 运行中的卡片既标 incomplete，也不冒充已证实', () => {
  const running = selection.evidenceFromElement(card({ 'data-tool': 't', 'data-state': 'ongoing' }, '还没结束'), 's');
  assert.equal(running.incomplete, true, '运行中必须标 incomplete');
  assert.equal(running.evidenceState, 'unavailable', '还没定论的步骤不能当成已证实');
});

test('F4: 分级结果与提示词消费端对得上（拼得出中文分级名）', async () => {
  const prompts = await moduleFromSource('src/host/prompts.ts');
  for (const [state, expected] of [['observed', '已观察到'], ['reported_only', '仅据汇报'], ['unavailable', '无从得知']]) {
    assert.equal(prompts.evidenceTier({ evidenceState: state }), expected);
  }
  // 生产端必须真的产出这三种，而不是只有类型定义。
  const source = await readSource('src/client/selection.ts');
  for (const tier of ['observed', 'reported_only', 'unavailable']) {
    assert.ok(source.includes("'" + tier + "'"), 'selection.ts 必须能产出 ' + tier);
  }
});

/* ===================== F8：§7 §10 模型不可用降级 ===================== */

const baseState = {
  sessionId: 's', open: true, unread: false, draft: '', phase: 'error', reasoning: '', text: '',
  records: [], hasEarlier: false, loadingEarlier: false, evidence: [],
  occupancyKnown: false, occupancyEstimated: false, tools: [],
};

function render(state) {
  const dom = fakeDom();
  const plugin = { registry: { update() {}, close() {}, get: () => state }, submit: async () => {}, loadEarlier: async () => {}, cancel() {} };
  const root = overlay.renderOverlay(state, plugin);
  return { text: root.textContent || '', settle: async () => { await new Promise(r => setTimeout(r, 20)); dom.restore(); } };
}

test('F8: 模型不可用时，仍给出依据、基本说明，并声明这不是模型回答', async () => {
  const state = {
    ...baseState,
    evidence: [{ id: 'e1', title: 'read_file', summary: '读到了配置文件的真实内容', source: 'selected_frozen' }],
    tools: [{ id: 't1', name: 'read_file', status: 'ok' }, { id: 't2', name: 'search', status: 'error' }],
    records: [{ id: 'r1', question: '之前问过什么', answer: '之前的回答' }],
  };
  const r = render(state);
  try {
    assert.match(r.text, /这些依据仍然可以查看/, '依据必须照常可见（不依赖模型）');
    assert.match(r.text, /读到了配置文件的真实内容/, '依据正文必须真的渲染出来');
    assert.match(r.text, /现在能告诉你的基本说明/, '必须有基本说明');
    assert.match(r.text, /2 个步骤/, '必须说明记录到几个步骤');
    assert.match(r.text, /1 个是失败的/, '必须指出有失败步骤');
    assert.match(r.text, /历史问答记录仍然完整保留/, '必须告诉用户记录没丢');
    // §7 最后一条：基本说明不能冒充完整智能回答。
    assert.match(r.text, /不是模型对你想问的问题给出的解释/, '必须声明这不是模型回答');
  } finally { await r.settle(); }
});

test('F8: 降级层只在出错/中断时出现，正常完成时不打扰', async () => {
  const ok = render({ ...baseState, phase: 'complete', text: '模型的正常回答' });
  try {
    assert.equal(/现在能告诉你的基本说明/.test(ok.text), false, '正常完成时不得插入降级说明');
  } finally { await ok.settle(); }
  const idle = render({ ...baseState, phase: 'idle' });
  try {
    assert.equal(/这些依据仍然可以查看/.test(idle.text), false, '空闲时不得插入降级说明');
  } finally { await idle.settle(); }
});

test('F8: 什么都没拿到时不编造，如实说还没有步骤', async () => {
  const r = render({ ...baseState, evidence: [], tools: [], records: [] });
  try {
    assert.match(r.text, /还没有拿到任何具体步骤/, '没有材料时必须如实说明');
    assert.equal(/个步骤/.test(r.text), false, '不得编造步骤数量');
  } finally { await r.settle(); }
});

/* ===================== B6：§5.2 正在围绕哪条提问 ===================== */

test('B6: 输入框上方有常驻标识，且写明正在围绕哪一条', async () => {
  const state = {
    ...baseState, phase: 'idle',
    evidence: [{ id: 'e1', title: 'read_file 步骤', summary: '这条是选中的依据正文', source: 'selected_frozen' }],
  };
  const r = render(state);
  try {
    assert.match(r.text, /正在围绕这条内容提问/, '必须有固定标识');
    assert.match(r.text, /read_file 步骤/, '标识里必须写出是哪一条');
  } finally { await r.settle(); }
});

test('B6: 没有选中依据时不留空条', async () => {
  const r = render({ ...baseState, phase: 'idle', evidence: [] });
  try {
    assert.equal(/正在围绕这条内容提问/.test(r.text), false, '没选依据时不得显示标识');
  } finally { await r.settle(); }
});

test('B6: 标识挂在 composer 内（输入框附近），不是只在正文末尾', async () => {
  const source = await readSource('src/client/overlay.tsx');
  assert.match(source, /form\.append\(targetBar, input/, 'targetBar 必须挂在输入框前面');
  assert.match(source, /targetBar/, '必须有 targetBar 元素');
});

/* ===================== F6：§4 §8 归档清理 ===================== */

test('F6: 启动时会收尾上次遗留的删除任务，且失败不拖垮启动', async () => {
  const source = await readSource('src/index.ts');
  assert.match(source, /retryPendingDeletes/, '启动时必须调用清理');
  assert.match(source, /cleanupArchived/, '必须有统一入口');
  assert.match(source, /void cleanupArchived\(/, '必须在加载时触发一次');
  // 清理失败必须被吞掉：插件启动不能因为清理失败而失败。
  assert.match(source, /清理遗留记录失败/, '失败要有诊断日志');
});

test('F6: 归档会把该会话的记录清空并置位 archived', async () => {
  const source = await readSource('src/index.ts');
  assert.match(source, /state\.archived = true/, '必须置位');
  assert.match(source, /state\.records = \[\]/, '必须清空记录');
  assert.match(source, /state\.compactState = undefined/, '必须清掉压缩摘要');
});

test('F6: 归档后路由确实拒绝读取（读侧行为保持）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ea-r8-f6-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const index = await moduleFromSource('src/index.ts');
    const routes = new Map();
    let service;
    index.apply({
      connection: { fetch: { register(entry) { routes.set(entry.path, entry.fetch); } } },
      llm: { listProviders: async () => [], listModels: async () => [] },
      effect: () => {}, get: () => undefined,
    });
    // 直接用持久化层把 archived 置位，再打真实路由。
    const persistence = await moduleFromSource('src/host/persistence.ts');
    const store = new persistence.JsonSessionStore({ rootDir: join(home, 'explain-assistant') });
    await store.update('archived-session', state => { state.archived = true; });
    await store.close();
    const handler = routes.get('/api/explain-assistant/state');
    const response = await handler(new Request('http://localhost/api/explain-assistant/state?sessionId=archived-session'));
    assert.equal(response.status, 409, '归档会话必须被拒绝');
    const body = await response.json();
    assert.equal(body.error.code, 'SESSION_ARCHIVED');
    assert.match(body.error.message, /[\u4e00-\u9fa5]/, '拒绝原因必须是中文');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
/* ===================== §6.3 分级必须在界面上看得见 ===================== */

test('§6.3: 依据分级会显示给用户看（不只是数据层）', async () => {
  const cases = [
    ['observed', '已观察到', /实际跑出来的结果/],
    ['reported_only', '仅据汇报', /只是主 agent 自己说它做了什么/],
    ['unavailable', '无从得知', /不能当作已验证/],
  ];
  for (const [state, label, hint] of cases) {
    const r = render({
      ...baseState, phase: 'idle',
      evidence: [{ id: 'e1', title: '某条依据', summary: '正文', source: 'selected_frozen', evidenceState: state }],
    });
    try {
      assert.match(r.text, new RegExp(label), state + ' 的分级文字必须显示出来');
      assert.match(r.text, hint, state + ' 必须附带一句白话解释');
    } finally { await r.settle(); }
  }
});

test('§6.3: 三级用词与提示词侧完全一致（同一件事不叫两个名字）', async () => {
  const prompts = await moduleFromSource('src/host/prompts.ts');
  // 提示词侧的三个标签
  const tiers = [prompts.evidenceTier({ evidenceState: 'observed' }), prompts.evidenceTier({ evidenceState: 'reported_only' }), prompts.evidenceTier({ evidenceState: 'unavailable' })];
  assert.deepEqual(tiers, ['已观察到', '仅据汇报', '无从得知']);
  const source = await readSource('src/client/overlay.tsx');
  for (const tier of tiers) {
    assert.ok(source.includes("'" + tier + "'"), '界面侧必须用同一个词：' + tier);
  }
});

test('§6.3: 没有分级信息的旧记录不冒充「已观察到」', async () => {
  const r = render({
    ...baseState, phase: 'idle',
    evidence: [{ id: 'e1', title: '老记录', summary: '正文', source: 'selected_frozen' }],
  });
  try {
    assert.match(r.text, /未分级/, '缺分级信息时必须如实标未分级');
    assert.equal(/已观察到/.test(r.text), false, '不得默认成「已观察到」');
  } finally { await r.settle(); }
});
