import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * t11：修 t8 在真实页面上抓到的两条 finding。
 *
 * ── F-A【high】加载页用默认几何绘制，数据到位后跳位 ──────────────────────
 * 「浮窗已可见 → 切到未就绪会话」时，entry.ts 的 effect（依赖含 sessionId）会
 * 清空并重建整棵浮窗 DOM；新会话此刻还没有几何，renderOverlay 只能退回
 * window.ts 的默认值 → 用户看到浮窗**先跳回 1004,264 420x620、过一会再跳到
 * 该会话真实几何**（t8 实测：停留约 8 秒后跳到 605,43 509x506）。
 *
 * 修法：重建**之前**把旧浮窗的实际几何读出来（window.ts 的 readAppliedGeometry），
 * 作为新元素的首帧几何传给 renderOverlay。
 *
 * ── F-B【medium】加载页上「发送」可提交 ────────────────────────────────
 * loading 分支提前 return，所以末尾那句「send.disabled = busy」在加载期从不执行；
 * 按钮停在「发送」且可用，而 form 的 submit 只判 !isBusy → 加载页打字后点发送，
 * **真的发出了** /api/explain-assistant/ask（t8 实测 askFired=true，命中 t1 清单 L15）。
 *
 * 修法：按钮文案/禁用按档位决定（sendLabel + canSubmit），
 * 且**真正的拦截**落在 form 的 submit 监听里 —— 按钮 disabled 只是视觉挡板，
 * requestSubmit() 与回车都能绕过它。
 */

const overlay = await moduleFromSource('src/client/overlay.tsx');
const windowModule = await moduleFromSource('src/client/window.ts');

/** window.ts 的默认几何（1004,264 420x620 就在这一档），用作「没读到任何位置」的对照组。 */
const DEFAULT_GEOMETRY = { x: 1004, y: 264, width: 420, height: 620 };

function plugin(overrides = {}) {
  return {
    registry: { get: () => undefined, update: () => {}, subscribe: () => () => {} },
    api: {},
    cancel() {},
    submit: async () => {},
    loadEarlier: async () => {},
    ...overrides,
  };
}

/** 一个「未就绪」的会话状态：gate 会是 loading。 */
function loadingState(overrides = {}) {
  return {
    sessionId: 'switching', open: true, stateReady: false, stateError: undefined,
    records: [], text: '', tools: [], evidence: [], hasEarlier: false, draft: '',
    occupancyKnown: false, occupancyEstimated: false, phase: 'idle',
    quickQuestionsDismissed: false, compactState: { status: 'idle' },
    ...overrides,
  };
}

/** 一个已就绪的状态（gate=ready）。 */
function readyState(overrides = {}) {
  return loadingState({ stateReady: true, records: [{ id: 'r1', question: 'q', answer: 'a', createdAt: '' }], ...overrides });
}

/** 读一个浮窗根元素当前生效的几何（与实现同一份真值来源）。 */
function geometryOf(root) {
  return {
    x: Number.parseFloat(root.style.left), y: Number.parseFloat(root.style.top),
    width: Number.parseFloat(root.style.width), height: Number.parseFloat(root.style.height),
  };
}

async function withDom(fn) {
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  try { return await fn(dom); } finally { await new Promise(r => setTimeout(r, 0)); dom.restore(); }
}

/* ================================================================== *
 * A1 / F-A：切会话重建时，加载页首帧几何 == 重建前的实际几何
 * ================================================================== */

test('t11 A1: 加载页首帧几何沿用重建前的实际几何，不退回默认值', async () => {
  await withDom(async () => {
    // 目标会话存储的几何（t8 实测那组：605,43 509x506）。
    // 注意 605 在 1024 宽的视口里会被 clamp 到 515 —— 那是**正确**的钳制结果，
    // 所以「实际几何」要按钳制后的值算（用真实的 clampGeometry，不手写期望值）。
    const stored = { x: 605, y: 43, width: 509, height: 506 };
    const actual = windowModule.clampGeometry(stored, 1024, 768);
    assert.equal(actual.x, 515, '前提：605 在 1024 宽视口里被钳到 515');

    // ① 先渲染一个真实浮窗，让它带上这个几何（走真实路径，不是手写 style）。
    const first = overlay.renderOverlay(readyState({ sessionId: 'ready-session', geometry: stored }), plugin());
    assert.deepEqual(geometryOf(first), actual, '前提：第一个浮窗确实落在该会话的几何上');

    // ② 模拟 entry.ts 的重建：**先读旧元素几何**，再清空、再用新会话渲染。
    const host = new FakeElement('div');
    host.appendChild(first);
    const carried = windowModule.readAppliedGeometry(host.firstElementChild);
    assert.deepEqual(carried, actual, 'readAppliedGeometry 必须读回四个值');

    host.replaceChildren();
    const switched = overlay.renderOverlay(loadingState(), plugin(), carried);

    // ③ 判定：加载页首帧 == 重建前的实际几何。
    assert.deepEqual(geometryOf(switched), actual,
      '加载页首帧几何必须等于重建前的实际几何（不得退回默认值）');
    assert.notDeepEqual(geometryOf(switched), windowModule.clampGeometry(undefined, 1024, 768),
      '尤其不得等于 window.ts 的默认值 —— 那正是 t8 抓到的跳位');
    assert.equal(switched.getAttribute('data-surface'), 'loading', '前提：这一帧确实是加载页');
    // 站内所有 resize 热区都跟着这个几何走，位置一致才算真的没动。
    assert.equal(switched.style.left, actual.x + 'px');
    assert.equal(switched.style.width, actual.width + 'px');
  });
});

test('t11 A1: 已有会话几何优先于「重建前几何」（内容到位那一刻允许一次性归位）', async () => {
  await withDom(async () => {
    const previous = { x: 605, y: 43, width: 509, height: 506 };
    const stored = { x: 220, y: 32, width: 620, height: 526 };
    // 目标会话的 /state 已经回来并带回**不同的**存储几何：这时应当用存储值
    // （允许「内容到位那一刻」归位），而不是把上一个会话的位置硬套过来。
    const root = overlay.renderOverlay(readyState({ sessionId: 'target', geometry: stored }), plugin(), previous);
    assert.deepEqual(geometryOf(root), stored, '本会话已知几何优先级最高');
  });
});

/* ================================================================== *
 * A2：默认值只服务「第一次打开、且没有任何已知位置」
 * ================================================================== */

test('t11 A2: 没有已知几何的新会话仍落在默认值（默认值只服务这一种情形）', async () => {
  await withDom(async () => {
    const root = overlay.renderOverlay(loadingState({ sessionId: 'brand-new' }), plugin(), undefined);
    const expected = windowModule.clampGeometry(undefined, 1024, 768);
    assert.deepEqual(geometryOf(root), expected,
      '从未有过浮窗位置时（第一次打开）应当落在默认值');
    assert.deepEqual(expected, { x: 1024 - 420 - 16, y: 768 - 620 - 16, width: 420, height: 620 },
      '默认值应当是 window.ts 那一档（右下角 420x620）');
  });
});

test('t11 A2: readAppliedGeometry 只在四个值齐全时才返回（半个几何宁可不要）', () => {
  const half = new FakeElement('section');
  half.style.left = '10px'; half.style.top = '20px'; half.style.width = '300px';
  assert.equal(windowModule.readAppliedGeometry(half), undefined, '缺 height 时必须返回 undefined');
  assert.equal(windowModule.readAppliedGeometry(null), undefined, '没有元素时返回 undefined');
  const empty = new FakeElement('section');
  assert.equal(windowModule.readAppliedGeometry(empty), undefined, '一个值都没有时返回 undefined');
  const full = new FakeElement('section');
  Object.assign(full.style, { left: '1px', top: '2px', width: '3px', height: '4px' });
  assert.deepEqual(windowModule.readAppliedGeometry(full), { x: 1, y: 2, width: 3, height: 4 });
});

/* ================================================================== *
 * A3 / F-B：加载期与失败页不得提交
 * ================================================================== */

test('t11 A3: gate=loading 时发送按钮 disabled 且文案不是「发送」', async () => {
  await withDom(async () => {
    const root = overlay.renderOverlay(loadingState(), plugin());
    const send = root.querySelector('.ea-send');
    assert.ok(send, '必须有发送按钮');
    assert.equal(send.hasAttribute('disabled'), true, 'loading 档发送按钮必须 disabled');
    assert.notEqual((send.textContent || '').trim(), '发送', 'loading 档按钮文案不得仍是「发送」');
  });
});

test('t11 A3: 加载页上 requestSubmit() 不得发出 /ask（断言请求真的没发出）', async () => {
  await withDom(async () => {
    const submitted = [];
    const root = overlay.renderOverlay(loadingState({ draft: '加载页里打的字' }), plugin({ submit: async q => { submitted.push(q); } }));
    const form = root.querySelector('.ea-composer');
    assert.ok(form, '必须有表单');
    // 走真实用户路径：按钮点了会 requestSubmit()；即便绕过 button 直接提交也要被拦住。
    const send = root.querySelector('.ea-send');
    send.click();
    form.requestSubmit();
    form.emit('submit', { preventDefault() {} });
    assert.deepEqual(submitted, [],
      '加载页上不得发出任何提问请求（t8 实测旧实现会真的发出 /ask）');
  });
});

test('t11 A3: gate=failed 时同样不得提交，且回到 ready 后恢复可用', async () => {
  await withDom(async () => {
    const submitted = [];
    const p = plugin({ submit: async q => { submitted.push(q); } });
    // 失败 + 无旧内容 → gate=failed
    const failed = overlay.renderOverlay(loadingState({ stateReady: true, stateError: '没有读到小助手的当前状态：boom' }), p);
    assert.equal(failed.getAttribute('data-surface'), 'failed', '前提：这一帧确实是失败档');
    const failedSend = failed.querySelector('.ea-send');
    assert.equal(failedSend.hasAttribute('disabled'), true, '失败档发送按钮必须 disabled');
    failed.querySelector('.ea-composer').requestSubmit();
    assert.deepEqual(submitted, [], '失败档不得发出提问请求');

    // 回到 ready：同一个按钮组件状态下必须恢复可用。
    const ready = overlay.renderOverlay(readyState({ draft: 'ok' }), p);
    assert.equal(ready.getAttribute('data-surface'), 'ready');
    const send = ready.querySelector('.ea-send');
    assert.equal(send.hasAttribute('disabled'), false, 'ready 档必须恢复可用');
    assert.equal((send.textContent || '').trim(), '发送', 'ready 档文案必须回到「发送」');
    ready.querySelector('.ea-composer').requestSubmit();
    assert.deepEqual(submitted, ['ok'], 'ready 档必须真的能提交');
  });
});

test('t11 A3: canSubmit 与 sendLabel 逐档对应（纯函数，防两处真相漂移）', () => {
  assert.equal(overlay.canSubmit(loadingState()), false, 'loading 不得提交');
  assert.equal(overlay.canSubmit(loadingState({ stateReady: true, stateError: 'x' })), false, 'failed 不得提交');
  assert.equal(overlay.canSubmit(readyState()), true, 'ready 可以提交');
  assert.equal(overlay.canSubmit(readyState({ phase: 'running' })), false, '回答进行中不得重复提交');
  assert.equal(overlay.sendLabel(loadingState(), 'loading'), '读取中…');
  assert.equal(overlay.sendLabel(loadingState(), 'failed'), '暂时不可用');
  assert.equal(overlay.sendLabel(readyState(), 'ready'), '发送');
  assert.equal(overlay.sendLabel(readyState({ phase: 'running' }), 'ready'), '处理中');
});

/* ================================================================== *
 * A4：loading / failed 分支必须清空 hero 与 quick（F1 的前置条件）
 * ================================================================== */

test('t11 A4: 同一棵 DOM 从 ready 原地切到 loading 时，hero 与快捷问题必须被清掉', async () => {
  await withDom(async () => {
    const p = plugin();
    // 先渲染一个 ready 的「空会话」：它会画出 hero 三句 + 4 个快捷问题。
    const root = overlay.renderOverlay(readyState({ sessionId: 'prev', records: [] }), p);
    const hasHero = () => Boolean(root.querySelector('.ea-hero'));
    const quickCount = () => root.querySelectorAll('.ea-chip').length;
    assert.equal(hasHero(), true, '前提：ready 档确实画了使用说明');
    assert.ok(quickCount() >= 4, '前提：ready 档确实画了 4 个快捷问题，实际=' + quickCount());

    // 原地切到 loading（不重建 DOM —— 这正是 F1 担心的那条路径）。
    overlay.updateOverlay(root, loadingState({ sessionId: 'next' }), p);
    assert.equal(root.getAttribute('data-surface'), 'loading', '前提：确实切到了加载页');
    assert.equal(hasHero(), false, '加载页不得残留上一会话的使用说明（F1 的前置条件）');
    assert.equal(quickCount(), 0, '加载页不得残留上一会话的快捷问题（F1 的前置条件）');
    assert.ok(root.querySelector('.ea-loading'), '加载页本身必须在');
  });
});

test('t11 A4: 同一棵 DOM 从 ready 原地切到 failed 时同样清掉 hero/quick', async () => {
  await withDom(async () => {
    const p = plugin();
    const root = overlay.renderOverlay(readyState({ sessionId: 'prev', records: [] }), p);
    assert.equal(Boolean(root.querySelector('.ea-hero')), true);
    overlay.updateOverlay(root, loadingState({ sessionId: 'next', stateReady: true, stateError: '没有读到：boom' }), p);
    assert.equal(root.getAttribute('data-surface'), 'failed');
    assert.equal(Boolean(root.querySelector('.ea-hero')), false, '失败页不得残留使用说明');
    assert.equal(root.querySelectorAll('.ea-chip').length, 0, '失败页不得残留快捷问题');
  });
});

/* ================================================================== *
 * A1/A3 端到端：走**真实的 entry.ts 组件**，复刻 t8 的「切会话」路径
 * ================================================================== *
 *
 * 为什么要这一组：上面那些用例是把 readAppliedGeometry 的结果手工喂进
 * renderOverlay 的，所以它们只证明「renderOverlay 认这个参数」——
 * **证明不了 entry.ts 真的把参数传进去了**。
 * 把 entry.ts 里的第三参数去掉（正是 A5 要求还原的那种变异），上面全部照绿。
 * 这一组从真实组件出发，因此对那条变异有感。
 *
 * 真实路径（t8 实测的那条）：
 *   ① 会话 A：点「?」→ /state 有结局 → 已就绪 → 浮窗可见，带 A 的几何；
 *   ② 切到会话 B（未就绪、/state 一直挂着）：B 的入口按钮 onClick 会 setSession(B)+open(B)，
 *      而浮窗**此刻仍然可见**（shouldMountOverlay 的 currentlyVisible 分支）→ 走加载页；
 *   ③ 判定：这一帧的几何必须还是 A 的几何。
 */

const REPO = path.resolve(import.meta.dirname, '..');

/** 最小 React 运行时（够跑 entry.ts 的两个组件）。 */
function makeReact() {
  const slots = [];
  let cursor = 0;
  const order = [];
  return {
    reset() { cursor = 0; },
    api: {
      createElement(type, props, ...children) { return { type, props: props || {}, children }; },
      useEffect(effect) { order.push(effect); },
      useReducer(init) { const i = cursor++; return [typeof init === 'function' ? init(0) : init, () => {}]; },
      useState(init) { const i = cursor++; if (slots[i] === undefined) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
      useRef(init) { const i = cursor++; if (slots['r' + i] === undefined) slots['r' + i] = { current: init === undefined ? null : init }; return slots['r' + i]; },
    },
    take() { return order.splice(0, order.length); },
  };
}

/** 起一套真实 entry 环境。A 会话的 /state 立刻成功；B 会话的 /state 一直挂着（停在加载页）。 */
async function entryEnv() {
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  const built = await build({ entryPoints: [path.join(REPO, 'src/client/entry.ts')], bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', '*.css'], logLevel: 'silent' });
  const react = makeReact();
  const entries = [];
  const cleanups = [];
  const asks = [];
  let releaseB = () => {};
  const bGate = new Promise(resolve => { releaseB = resolve; });
  const json = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('explain-assistant/state')) {
      const sid = /sessionId=([^&]+)/.exec(href)?.[1] ?? '';
      if (sid.startsWith('session-A')) {
        return json({ payload: { records: [], hasEarlier: false, geometry: { x: 605, y: 43, width: 509, height: 506 }, catalog: { groups: [{ provider: 'p', models: [{ provider: 'p', id: 'm', name: 'M' }] }], failures: [] } } });
      }
      await bGate;   // 会话 B：永不返回 → 客户端停在加载页
      return json({ payload: { records: [], hasEarlier: false } });
    }
    if (href.includes('explain-assistant/ask')) { asks.push(href); return json({ payload: {} }); }
    return json({ payload: {} });
  };
  const exports = {};
  const context = vm.createContext({
    exports, module: { exports },
    require(name) { if (name === 'react') return react.api; if (name.endsWith('.css')) return {}; throw Error('Unexpected external: ' + name); },
    AbortController, console, Symbol, TextEncoder, TextDecoder, queueMicrotask, setTimeout, clearTimeout,
    document: dom.document, window: dom.window, Element: FakeElement, HTMLElement: FakeElement,
    crypto: globalThis.crypto, fetch: fetchImpl, Response,
    // entry.ts 的 dispose 会 new Event(...) 派发；VM 上下文不共享宿主的 Event。
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  });
  vm.runInContext(built.outputFiles[0].text, context, { filename: 'client-entry.bundle.cjs' });
  const ctx = {
    effect(effect) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    slots: { inject(_n, provider) { const r = provider(); if (r?.[Symbol.iterator]) [...r]; return () => {}; }, register(meta, component) { entries.push({ meta, component }); return () => {}; } },
  };
  context.module.exports.apply(ctx);
  const container = new FakeElement('div');
  /**
   * 渲染一个组件并把它的容器 ref 指到同一个 container（= 同一个挂载点，真实行为）。
   *
   * ⚠️ **必须复刻 React 的「先清理、再执行」顺序**：依赖变化时，React 先跑
   * **上一个 effect 的清理函数**，然后才跑新的 effect 函数体。
   *
   * 这一点是本文件最关键的一处保真度：我第一版把清理函数只收集起来、从不执行，
   * 于是 entry.ts 里那句「在清理函数中、摘除之前读几何」根本没被跑到 ——
   * 结果是**实现坏着也全绿**（真实页面上 t8 的装置照样抓到 1004,264,420x620）。
   * 修正后这个假绿就消失了：把修复还原，下面的用例会真的变红。
   */
  const render = (Component, props) => {
    react.reset();
    const tree = Component(props);
    const effects = react.take();
    const withRef = (node) => {
      if (!node || typeof node !== 'object') return node;
      if (node.props?.ref && typeof node.props.ref === 'object') node.props.ref.current = container;
      (node.children || []).forEach(withRef);
      return node;
    };
    withRef(tree);
    // ↓ React 顺序：先跑「**同一个组件**上一轮 effect」的清理函数，再跑本轮 effect。
    //   必须按组件分别记账：HeaderButton 与 OverlayBridge 是两棵独立的树，
    //   混在一起会把 HeaderButton 的清理（setCurrent(undefined)）在渲染浮窗时误跑，
    //   于是会话状态被清掉、浮窗根本不挂载（我第一版就是这么红的）。
    const pending = (cleanupsByComponent.get(Component) || []).splice(0);
    cleanupsByComponent.set(Component, []);
    for (const cleanup of pending) cleanup();
    const mine = cleanupsByComponent.get(Component);
    for (const effect of effects) {
      const cleanup = effect();
      if (typeof cleanup === 'function') mine.push(cleanup);
    }
    return tree;
  };
  const cleanupsByComponent = new Map();
  return {
    container, asks, releaseB,
    overlayComponent: entries.find(e => e.meta.name === 'shell.overlay').component,
    headerComponent: entries.find(e => e.meta.name === 'conversation.session.header.utilities').component,
    render,
    cleanup() { cleanups.forEach(fn => fn()); for (const list of cleanupsByComponent.values()) list.splice(0).forEach(fn => fn()); dom.restore(); },
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));

test('t11 A1 端到端: 真实 entry 组件切会话时，加载页几何原地不动（不经过默认值）', async () => {
  const env = await entryEnv();
  try {
    // ① 会话 A：点「?」→ 等 /state 有结局 → 浮窗可见且带 A 的几何。
    let header = env.render(env.headerComponent, { sessionId: 'session-A' });
    header.props.onClick();
    await flush(); await flush(); await flush();
    env.render(env.overlayComponent, {});
    const before = env.container.children[0];
    assert.ok(before, '前提：会话 A 上浮窗应当挂出来');
    const beforeGeometry = geometryOf(before);
    const expected = windowModule.clampGeometry({ x: 605, y: 43, width: 509, height: 506 }, 1024, 768);
    assert.deepEqual(beforeGeometry, expected, '前提：A 的浮窗落在它的真实几何上');

    // ② 切到会话 B（未就绪、/state 一直挂着）：B 的按钮 onClick 会 setSession(B)+open(B)。
    header = env.render(env.headerComponent, { sessionId: 'session-B' });
    header.props.onClick();
    await flush();
    env.render(env.overlayComponent, {});
    const after = env.container.children[0];
    assert.ok(after, '切到未就绪的 B 时浮窗不得被藏起来（那是闪跳）');
    assert.equal(after.getAttribute('data-surface'), 'loading', '前提：这一帧确实是加载页');

    // ③ 判定：加载页几何 == 重建前的实际几何。
    assert.deepEqual(geometryOf(after), beforeGeometry,
      '切会话后加载页首帧几何必须等于重建前的实际几何');
    assert.notDeepEqual(geometryOf(after), windowModule.clampGeometry(undefined, 1024, 768),
      '尤其不得退回 window.ts 的默认值（1004,264 420x620）—— 那正是 t8 抓到的跳位');

    // ④ 数据到位（放行 B 的 /state）后不得再发生几何变化。
    env.releaseB();
    await flush(); await flush(); await flush();
    env.render(env.overlayComponent, {});
    const settled = env.container.children[0];
    assert.deepEqual(geometryOf(settled), beforeGeometry,
      '从浮窗可见到数据到位之间不得发生任何几何变化');
  } finally { env.cleanup(); }
});

test('t11 A3 端到端: 真实 entry 组件在加载页上提交不得发出 /ask', async () => {
  const env = await entryEnv();
  try {
    // 先把 A 打开（浮窗可见），再切到未就绪的 B → 停在加载页（t8 的路径）。
    let header = env.render(env.headerComponent, { sessionId: 'session-A' });
    header.props.onClick();
    await flush(); await flush(); await flush();
    env.render(env.overlayComponent, {});
    header = env.render(env.headerComponent, { sessionId: 'session-B' });
    header.props.onClick();
    await flush();
    env.render(env.overlayComponent, {});

    const overlayRoot = env.container.children[0];
    assert.equal(overlayRoot.getAttribute('data-surface'), 'loading', '前提：停在加载页');
    const input = overlayRoot.querySelector('.ea-input');
    input.value = '加载页里打的字';
    // 两条路径都试：点按钮（走 requestSubmit）与直接提交表单。
    overlayRoot.querySelector('.ea-send').click();
    overlayRoot.querySelector('.ea-composer').requestSubmit();
    await flush(); await flush();
    assert.deepEqual(env.asks, [], '/ask 必须一次都没发出（t8 实测旧实现会真的发出）');
  } finally { env.cleanup(); }
});

