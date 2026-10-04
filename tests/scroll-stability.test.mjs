import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * §9（浮窗滚动与可操作性）：**重画不得与滚动位置打架** —— 用户实测缺陷的防复发闸。
 *
 * 用户原话：「小助手页面滚轮滑动出现了bug，一滚就抽搐」。
 *
 * 已定位的成因（静态分析，见 src/client/overlay.tsx）：
 * - 流式回答期间，宿主每来一个分片就发一个 SSE 事件，客户端每个事件都 registry.update
 *   → 每次渲染都调 updateOverlay。一次回答会重画**几十到几百次**。
 * - updateOverlay 一进来 `const scrollTop = ctx.body.scrollTop`（:737），把各 slot 全部
 *   fill()/replaceChildren（:740-751），最后 `ctx.body.scrollTop = scrollTop`（:781）
 *   **把最开始读到的旧值无条件写回去**。
 * - 浏览器在内容重排时会自己做**滚动锚定**（CSS Scroll Anchoring，Chrome 默认开启；
 *   本插件 styles.css 没有关掉它）。于是「浏览器已把 scrollTop 调整到新位置」与
 *   「插件把旧值写回去」两套机制同时改同一个位置 → 就是肉眼看到的抽搐/回跳。
 *
 * 关于假 DOM 的能力边界（如实说明，不夸大）：
 * FakeElement 的 scrollTop 是普通属性，**没有**真实浏览器的钳制与滚动锚定行为。
 * 所以本文件在**被测元素上**装一个最小滚动模型，明确模拟两件真实浏览器行为：
 *   1. 写入 scrollTop 会被钳制到 [0, max]；
 *   2. 内容重排时浏览器可能自主调整 scrollTop（滚动锚定）——用 `browserAdjust()` 显式触发。
 * 这模拟的是**已标准化的浏览器行为**，不是为了让断言通过而编的规则。
 * 真实布局与像素级观感仍须由人在 3082 页面上验证（那一步不归本文件，也不归我）。
 */

const overlay = await moduleFromSource('src/client/overlay.tsx');

function state(extra) {
  return Object.assign({
    sessionId: 's1', open: true, phase: 'idle', draft: '', reasoning: '', text: '', tools: [], records: [],
    hasEarlier: false, loadingEarlier: false, evidence: [], unread: false, occupancyKnown: false,
    quickQuestionsDismissed: true, catalog: { groups: [], failures: [] },
  }, extra || {});
}

function pluginSpy() {
  return {
    registry: { update() {}, close() {}, get: () => undefined },
    api: { selectModel: async () => ({}), models: async () => ({ payload: {} }) },
    submit: async () => {}, loadEarlier: async () => {}, cancel() {},
  };
}

function withDom(run) {
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  return run(dom).finally(async () => { await new Promise(r => setTimeout(r, 20)); dom.restore(); });
}

/**
 * 在被测滚动容器上装一个最小滚动模型。
 *
 * - `writes`：记录**每一次** scrollTop 写入及写入值 —— 「没有必要时不碰 scrollTop」靠它断言。
 * - `browserAdjust(delta)`：模拟浏览器自己的滚动锚定调整（不算插件的写入）。
 * - 写入会钳制到 [0, contentHeight - clientHeight]，与真实滚动容器一致。
 */
function installScrollModel(body, { contentHeight = 2000, clientHeight = 600 } = {}) {
  let value = 0;
  let height = contentHeight;
  const writes = [];
  const model = {
    writes,
    get value() { return value; },
    set contentHeight(next) { height = next; },
    /** 模拟浏览器自主调整（滚动锚定）：不记入 writes，因为这不是插件干的。 */
    browserAdjust(delta) { value = Math.max(0, Math.min(value + delta, Math.max(0, height - clientHeight))); },
    max() { return Math.max(0, height - clientHeight); },
  };
  Object.defineProperty(body, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next) => {
      const clamped = Math.max(0, Math.min(Number(next) || 0, model.max()));
      writes.push(clamped);
      value = clamped;
    },
  });
  return model;
}

/** 取出正文滚动区（ctx.body）。 */
function bodyOf(root) {
  const body = root.querySelectorAll('.dsh-explain-assistant-content')[0];
  assert.ok(body, '必须有正文滚动区 .dsh-explain-assistant-content');
  return body;
}

/**
 * 让该容器里的 slot 在被 replaceChildren 时，模拟浏览器做一次滚动锚定调整。
 * 这就是真实时序里的交错点：插件读完 scrollTop（:737）→ 重排内容（浏览器调整 scrollTop）
 * → 插件把旧值写回（:781）。
 */
function anchorOnRebuild(body, model, delta) {
  const slots = body.querySelectorAll('.ea-slot');
  assert.ok(slots.length, '正文区里应有 slot');
  // 一次重画会重建多个 slot，但浏览器只在**重排完成**后做一次锚定调整，
  // 所以这里保证 delta 在一次重画里只施加一次。
  let applied = false;
  for (const slot of slots) {
    const original = slot.replaceChildren.bind(slot);
    slot.replaceChildren = (...nodes) => {
      original(...nodes);
      if (applied) return;
      applied = true;
      // 内容重排后，浏览器自己做滚动锚定调整（不是插件写的）
      model.browserAdjust(delta);
    };
  }
}

/* ================================================================== *
 * 1) 没有必要时不碰 scrollTop（无条件的「读→写」往返必须消失）
 * ================================================================== */

test('防抽搐: 重画时若滚动位置无需修正，就不得写 scrollTop', async () => withDom(async () => {
  const plugin = pluginSpy();
  const base = state({ text: '一段回答', records: [] });
  const root = overlay.renderOverlay(base, plugin);
  const body = bodyOf(root);
  const model = installScrollModel(body);
  model.browserAdjust(120);            // 用户先滚到 120
  assert.equal(model.value, 120, '前置条件：用户已滚到 120');
  model.writes.length = 0;             // 只关心重画期间有没有写

  // 重画同样内容：没有高度变化、没有钳低、没有换记录展开 —— 没有任何理由去动滚动位置。
  overlay.updateOverlay(root, state({ text: '一段回答', records: [] }), plugin);

  assert.deepEqual(model.writes, [], '没有必要时不得写 scrollTop（当前实现会无条件回写旧值，这正是抽搐来源）');
  assert.equal(model.value, 120, '滚动位置必须原样保持在 120');
}));

test('防抽搐: 连续多次重画（模拟流式回答）也不得反复写 scrollTop', async () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ text: '第一段' }), plugin);
  const body = bodyOf(root);
  const model = installScrollModel(body);
  model.browserAdjust(300);
  model.writes.length = 0;

  // 一次回答期间 updateOverlay 会被调用几十到几百次
  for (let i = 0; i < 120; i++) {
    overlay.updateOverlay(root, state({ text: '第一段回答持续增长中'.repeat(Math.min(i + 1, 30)) }), plugin);
  }

  assert.deepEqual(model.writes, [], '120 次重画期间一次都不该写 scrollTop，实际写了 ' + model.writes.length + ' 次');
  assert.equal(model.value, 300, '滚动位置必须稳住');
}));

/* ================================================================== *
 * 1b) 决定性断言：用户**正在滚动的那一刻**，重画一次都不许写 scrollTop
 *
 * 这是 Lead 明确要求能对着代码核的那一点：「用户正在往下滚（滚轮进行中）时，
 * 新逻辑会不会仍然在他滚动的那一瞬间去写 scrollTop？」
 * 如果有任何一次写入，那就是抽搐的直接触发点。这里用「滚动与重画交错」的方式钉死它。
 * ================================================================== */

test('防抽搐: 用户正在滚动的过程中，重画一次都不许写 scrollTop', async () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ text: '回答' }), plugin);
  const body = bodyOf(root);
  const model = installScrollModel(body, { contentHeight: 6000, clientHeight: 600 });
  model.browserAdjust(200);
  model.writes.length = 0;

  // 模拟「滚轮正在滚」：每滚一下紧接着一次重画（流式回答期间就是这个节奏）
  for (let step = 0; step < 10; step++) {
    model.browserAdjust(60);   // 用户这一下滚动的位移（浏览器侧，不是插件写的）
    overlay.updateOverlay(root, state({ text: '回答'.repeat(step + 1) }), plugin);
  }

  assert.deepEqual(model.writes, [],
    '用户滚动期间重画不得写 scrollTop，实际写了 ' + model.writes.length + ' 次：' + JSON.stringify(model.writes));
  assert.equal(model.value, 200 + 60 * 10, '用户的滚动位移必须完整保留，一次都不许被抹掉');
}));

test('防抽搐: 只有显式切换到另一条记录展开时才允许归零滚动位置', async () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ text: '回答' }), plugin);
  const body = bodyOf(root);
  const model = installScrollModel(body);
  model.browserAdjust(300);

  // 显式展开第一条记录 r1：这一次归零是**有意**的（用户点了「查看完整内容」，面板要滚到可见处）
  overlay.updateOverlay(root, state({ text: '回答2', historyDetail: { recordId: 'r1', status: 'ready', hasEarlier: false, loadingMore: false } }), plugin);
  assert.deepEqual(model.writes, [0], '首次展开一条记录时归零是允许的（这是有意的定位行为）');

  // 关键：同一条记录的**后续重画**（模拟续读、流式回答）——不许再动滚动位置
  model.writes.length = 0;
  overlay.updateOverlay(root, state({ text: '回答3', historyDetail: { recordId: 'r1', status: 'ready', hasEarlier: true, loadingMore: false } }), plugin);
  overlay.updateOverlay(root, state({ text: '回答4', historyDetail: { recordId: 'r1', status: 'ready', hasEarlier: false, loadingMore: false } }), plugin);
  assert.deepEqual(model.writes, [], '同一条记录的后续重画不得再动滚动位置');

  // 显式换成另一条记录 r2：又允许归零一次
  overlay.updateOverlay(root, state({ text: '回答4', historyDetail: { recordId: 'r2', status: 'ready', hasEarlier: false, loadingMore: false } }), plugin);
  assert.deepEqual(model.writes, [0], '只有换成另一条记录时才允许再归零一次');
}));

/* ================================================================== *
 * 2) 浏览器调整过的滚动位置不得被旧值覆盖（抽搐的直接成因）
 * ================================================================== */

test('防抽搐: 浏览器滚动锚定调整后，重画不得把旧 scrollTop 覆盖回去', async () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ text: '回答' }), plugin);
  const body = bodyOf(root);
  const model = installScrollModel(body);
  model.browserAdjust(100);
  assert.equal(model.value, 100, '前置条件：用户滚到 100');

  // 真实时序：插件读 100 → 内容重排、浏览器把 scrollTop 锚定到 140 → 插件若回写旧值 100 就会反向跳 40
  anchorOnRebuild(body, model, 40);
  overlay.updateOverlay(root, state({ text: '回答变长了' }), plugin);

  assert.equal(model.value, 140, '必须保留浏览器锚定后的 140；若回写成 100 就是用户看到的反向抽搐');
}));

test('防抽搐: 内容变短被浏览器钳低后，不得把旧值再写回去', async () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ text: '很长的回答' }), plugin);
  const body = bodyOf(root);
  const model = installScrollModel(body, { contentHeight: 2000, clientHeight: 600 });
  model.browserAdjust(1200);
  assert.equal(model.value, 1200);

  // 内容变短 → 上限降到 400，浏览器把 scrollTop 钳到 400
  model.contentHeight = 1000;
  model.browserAdjust(0);
  assert.equal(model.value, 400, '前置条件：被钳到 400');

  overlay.updateOverlay(root, state({ text: '短' }), plugin);
  assert.equal(model.value, 400, '不得把钳制前的旧值 1200 写回去');
}));

/* ================================================================== *
 * 3) 滚动位置整体单调：不许来回跳
 * ================================================================== */

test('防抽搐: 用户连续滚动 + 穿插重画时，滚动位置不出现反向跳动', async () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ text: '回答' }), plugin);
  const body = bodyOf(root);
  const model = installScrollModel(body, { contentHeight: 4000, clientHeight: 600 });
  const body2 = body;

  // 模拟用户连续向下滚动，每滚一下穿插一次重画（流式回答期间的真实情形）
  const observed = [];
  for (let step = 1; step <= 12; step++) {
    model.browserAdjust(50);                       // 用户滚一格
    observed.push(model.value);
    overlay.updateOverlay(root, state({ text: '回答'.repeat(step) }), plugin);
    body2.scrollTop = model.value;                  // 记录重画后的位置
    observed.push(model.value);
  }

  for (let i = 1; i < observed.length; i++) {
    assert.ok(observed[i] >= observed[i - 1],
      '滚动位置不得反向跳动：第 ' + i + ' 步从 ' + observed[i - 1] + ' 掉到 ' + observed[i] + '（全部序列 ' + JSON.stringify(observed) + '）');
  }
}));

/* ================================================================== *
 * 4) 不能靠「禁止滚动」换平静
 * ================================================================== */

test('防抽搐: 不得用禁用滚动/拦截滚轮来换平静', async () => {
  const { readFileSync } = await import('node:fs');
  const overlaySource = readFileSync(new URL('../src/client/overlay.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  // 正文滚动区必须仍是可滚动的
  assert.match(css, /\.dsh-explain-assistant-content\{[^}]*overflow-y:auto/, '正文区必须保持可滚动（不得改成 hidden）');
  assert.match(css, /\.dsh-explain-assistant-overlay\{[^}]*overflow:hidden/, '浮窗外壳保持 overflow:hidden 是对的（裁剪圆角），这条只是确认它没被顺手动过');
  // 不得出现拦截滚轮 / 锁死触摸滚动
  assert.equal(/addEventListener\(\s*['"]wheel/.test(overlaySource), false, '不得监听 wheel 去 preventDefault');
  assert.equal(/touch-action\s*:\s*none/.test(css), false, '不得用 touch-action:none 锁死滚动');
  assert.equal(/overscroll-behavior\s*:\s*(none|contain)/.test(css), false, '不得用 overscroll-behavior 阻断滚动链');
});

/* ================================================================== *
 * 5) 既有正确要求必须继续成立
 * ================================================================== */

test('回归: 重画后滚动位置仍不得被重置回顶部', async () => withDom(async () => {
  const plugin = pluginSpy();
  const root = overlay.renderOverlay(state({ text: '第一段回答' }), plugin);
  const body = bodyOf(root);
  const model = installScrollModel(body);
  model.browserAdjust(120);
  assert.equal(model.value, 120);

  overlay.updateOverlay(root, state({ text: '第一段回答', phase: 'complete' }), plugin);
  assert.equal(model.value, 120, '重画不得把滚动位置重置回顶部（overlay-usability.test.mjs 的同一条要求）');
}));
