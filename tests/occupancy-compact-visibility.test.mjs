import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleFromSource } from './fixtures/runtime.mjs';

const occupancy = await moduleFromSource('src/host/occupancy.ts');
const indexPath = new URL('../src/index.ts', import.meta.url);
const overlayPath = new URL('../src/client/overlay.tsx', import.meta.url);
const clientPath = new URL('../src/client/index.ts', import.meta.url);

const readSource = (url) => readFile(url, 'utf8');

/* ---------------- §9.2 B1：占用必须是「小助手自身」 ---------------- */

/** 去掉注释，只对可执行代码做断言：注释里说明「旧实现曾用 measure」是允许的。 */
const codeOnly = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 截出 readOccupancy 函数体：占用这件事只允许在这里取值，别处用 sessions 是别的用途。 */
function occupancyBody(source) {
  const start = source.indexOf('async function readOccupancy');
  assert.ok(start >= 0, '必须存在 readOccupancy');
  const end = source.indexOf('\n}', start);
  return source.slice(start, end < 0 ? undefined : end);
}

test('B1: 占用函数不再触碰主会话 sessions/tokenMeter.measure', async () => {
  const source = await readSource(indexPath);
  const body = occupancyBody(codeOnly(source));
  assert.equal(/tokenMeter\.measure\s*\(/.test(body), false, '不得再用 tokenMeter.measure（它只能量主会话，正是 B1 的根因）');
  assert.equal(/sessions/.test(body), false, '占用函数不得触碰主会话对象');
  assert.equal(/ctx\.get\(['"]sessions['"]\)/.test(body), false, '不得取主会话对象来算小助手占用');
  assert.match(body, /measureAssistantOccupancy/, '必须改用小助手自身的估算入口');
});

test('B1: 容量取自适配器自报的 resolveModelInfo().context.contextWindow', async () => {
  const source = await readSource(indexPath);
  assert.match(source, /resolveModelInfo/, '容量必须来自 llm.resolveModelInfo');
  assert.match(source, /contextWindow/, '必须读取 contextWindow');
});

test('B1: 有容量时给出百分比且恒标估算', () => {
  const result = occupancy.measureAssistantOccupancy({ systemPrompt: '你是解释小助手。', contextWindow: 1000 });
  assert.ok(result, '有容量时必须给出占用');
  assert.equal(result.estimated, true, '启发式结果必须标估算');
  assert.ok(result.percent >= 0 && result.percent <= 100, '百分比必须在 0..100');
  assert.ok(result.usedTokens > 0);
});

test('B1: 没有容量时返回 undefined，界面才能显示「占用未知」而不是编造', () => {
  assert.equal(occupancy.measureAssistantOccupancy({ systemPrompt: 'x' }), undefined);
  assert.equal(occupancy.measureAssistantOccupancy({ systemPrompt: 'x', contextWindow: 0 }), undefined);
  assert.equal(occupancy.measureAssistantOccupancy({ systemPrompt: 'x', contextWindow: Number.NaN }), undefined);
});

test('B1: 占用随小助手自身内容增长，与主 agent 无关', () => {
  const small = occupancy.measureAssistantOccupancy({ systemPrompt: '提示词', contextWindow: 100000 });
  const big = occupancy.measureAssistantOccupancy({
    systemPrompt: '提示词',
    records: [{ question: '问题'.repeat(500), answer: '回答'.repeat(500) }],
    contextWindow: 100000,
  });
  assert.ok(big.usedTokens > small.usedTokens, '小助手自己的问答越多，占用必须越大');
});

test('B1: 压缩前的记录不再计入上下文，只算压缩之后的（§9.2 最后一条）', () => {
  const records = [
    { question: '旧的', answer: '旧的', startedAt: '2026-01-01T00:00:00.000Z' },
    { question: '新的', answer: '新的', startedAt: '2026-02-01T00:00:00.000Z' },
  ];
  const carried = occupancy.carriedRecords(records, '2026-01-15T00:00:00.000Z');
  assert.equal(carried.length, 1, '压缩后只应保留压缩之后的记录');
  assert.equal(carried[0].question, '新的');
  assert.equal(occupancy.carriedRecords(records, undefined).length, 2, '没压缩过时全部计入');
});

/* ---------------- §9.1 F1/F9：/compact 结果必须可见 ---------------- */

test('F1: loadState 必须把 compactState 随状态下发', async () => {
  const source = await readSource(indexPath);
  assert.match(source, /compactState:\s*state\.compactState/, 'loadState 必须回传 compactState');
});

test('F1: 客户端 open/refresh 必须回写 compactState', async () => {
  const source = await readSource(clientPath);
  assert.match(source, /payload\.compactState/, '客户端必须读取 payload.compactState');
  assert.match(source, /compactState = isObject\(payload\.compactState\)/, '必须回写到 registry');
});

test('F9: 浮窗必须渲染压缩结果（不再是 grep compactState = 0）', async () => {
  const source = await readSource(overlayPath);
  assert.match(source, /compactNodes/, '必须存在压缩结果区块');
  assert.match(source, /state\.compactState/, '必须读 state.compactState');
  assert.match(source, /compactSlot/, '必须挂进骨架并参与重画');
  assert.match(source, /fill\(ctx\.compactSlot, compactNodes\(state\)\)/, 'updateOverlay 必须重画该区块');
});

test('F9: 压缩四种状态都有中文反馈，且失败明确保留上一份摘要', async () => {
  const source = await readSource(overlayPath);
  assert.match(source, /正在整理小助手自己的上下文/, '压缩中要有提示');
  assert.match(source, /已压缩/, '成功要有提示');
  assert.match(source, /压缩失败/, '失败要有提示');
  assert.match(source, /压缩已中断/, '中断要有提示');
  assert.match(source, /仍然可用|上一次成功压缩/, '失败时必须说明上一份摘要仍可用（§9.1）');
});

test('F9: 压缩失败/中断不得清掉已有摘要正文', async () => {
  const source = await readSource(clientPath);
  assert.match(source, /compactState = \{ \.\.\.current\.compactState, status/, '失败路径必须展开保留旧摘要，而不是整体替换');
});

test('§9.1: 压缩成功但模型没返回摘要时必须给出可见错误，而不是静默', async () => {
  const source = await readSource(clientPath);
  assert.match(source, /模型没有返回可用的摘要内容/, '空摘要必须有中文提示');
});

/* ---------------- 回归：宿主的落库结构没有 status，不得把成功渲染成中断 ---------------- */

test('回归: 宿主 compactState 无 status 字段时，客户端必须补成 complete 而不是原样覆盖', async () => {
  const source = await readSource(clientPath);
  assert.match(source, /status: typeof compactState\.summary === 'string'/, '必须按 summary 判定 status');
  // C2 的不变式保留：本次刚发生的 running / error / interrupted 不得被落库值盖掉。
  assert.match(source, /status === 'running' \|\| current\.compactState\.status === 'error' \|\| current\.compactState\.status === 'interrupted'/, '本次的非成功态不得被落库值盖掉');
  // S1：idle 必须被排除在保留集合外 —— 它只表示「本次还没开始过」，
  // 此时要采用宿主下发的摘要，否则刷新页面后摘要会丢。
  assert.equal(/current\.compactState\.status !== 'complete'/.test(source), false, 'idle 不得被当成需要保留的本地状态');
});

test('回归: 浮窗渲染层有兜底，缺 status 但有摘要时按成功渲染', async () => {
  const source = await readSource(overlayPath);
  assert.match(source, /const status = compact\.status \?\? \(compact\.summary \? 'complete' : 'error'\)/, '渲染层必须有兜底判定');
  assert.equal(/compact\.status === 'complete'/.test(source), false, '分支不得再直接读可能为 undefined 的 status');
  assert.equal(/compact\.status === 'running'/.test(source), false, '分支不得再直接读可能为 undefined 的 status');
});

test('回归: 有摘要却缺 status 时，渲染出的是成功文案而不是「压缩已中断」', async () => {
  const runtime = await import('./fixtures/runtime.mjs');
  const overlay = await runtime.moduleFromSource('src/client/overlay.tsx');
  const state = {
    sessionId: 's', open: true, unread: false, draft: '', phase: 'complete', reasoning: '', text: '',
    tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [],
    occupancyKnown: false, occupancyEstimated: false,
    // 宿主的落库结构：有 summary、没有 status
    compactState: { version: 1, summary: '这是压缩后的摘要正文', sourceRecordIds: [], createdAt: '2026-10-03T00:00:00.000Z' },
  };
  const dom = runtime.fakeDom();
  try {
    const plugin = { registry: { update() {}, get: () => state }, api: {}, cancel() {}, submit() {}, loadEarlier() {} };
    const root = overlay.renderOverlay(state, plugin);
    const text = root.textContent || '';
    assert.match(text, /已压缩/, '有摘要时必须显示「已压缩」');
    assert.match(text, /这是压缩后的摘要正文/, '摘要正文必须渲染出来');
    assert.equal(/压缩已中断/.test(text), false, '绝不能把成功显示成「压缩已中断」');
  } finally {
    // renderOverlay 内部有 queueMicrotask(focus)：等它跑完再还原假 DOM，
    // 否则还原后那次 focus 会写 globalThis.document.activeElement 并抛错。
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.restore();
  }
});

/* ---------------- 不倒退：原判符合项仍在 ---------------- */

test('不倒退: 圆环仍区分已知/未知，且估算仍打标', async () => {
  const source = await readSource(overlayPath);
  assert.match(source, /占用未知/, '未知态文案必须保留');
  assert.match(source, /估算/, '估算标识必须保留');
  assert.match(source, /stroke-dasharray/, '圆环仍是 SVG stroke-dasharray 表达');
});

test('不倒退: 压缩成功才落库的规则没被改动（写侧仍在 routes）', async () => {
  const routes = await readSource(new URL('../src/host/routes.ts', import.meta.url));
  assert.match(routes, /op === 'compact' && result\.complete && service\.saveCompact/, '仍只在成功时落库');
});
