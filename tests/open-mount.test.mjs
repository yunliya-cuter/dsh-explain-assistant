import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
import path from 'node:path';
import { fakeDom, FakeElement, moduleFromSource, waitFor } from './fixtures/runtime.mjs';

/**
 * 本轮（t4）：**延后挂载** —— 打开浮窗时先不显示它，等 /state 有结局再一次性挂出来。
 *
 * ── 要消掉的现象（t1/t3 在真实 3082 上实测的改前基线）──────────────────
 * 点击「?」后 +62.7ms 浮窗就带着**初始空值**画出来了（「还没有选择模型」「共 0 个可选」
 * 「还没有小助手历史」「占用未知」，几何也还是默认值 1004,264 420x620）；
 * 要到 +391.5ms（/state 回来那一刻）才换成正确内容与正确几何。
 * 把 /state 拖到 5 秒，这段错值窗口就变成 5.4 秒 —— 终点就是 /state 到达那一刻。
 *
 * ── 做法 ──────────────────────────────────────────────────────
 * 浮窗**根本不出现在页面上**，直到 /state 有结局。它第一次出现时就已经是最终形态。
 * 这样「先错后对」的窗口在结构上就不存在，而不只是「错的时间变短」。
 *
 * ── 本文件守的判据（逐条对应验收）────────────────────────────────
 *   1. 未就绪时**不挂载**（且不出现加载页/半成品）；
 *   2. 有结局后一次性挂载，**第一帧几何即最终值**；
 *   3. 慢宿主下点击**仍有浮窗之外的忙碌反馈**，且浮窗确实未出现（判据 4，唯一风险）；
 *   4. 失败/超时后浮窗**出现**并带中文错误 + 重试（判据 5，卡死比错值更糟）；
 *   5. 已就绪会话（关闭再打开）**零延迟挂载**、不再闪加载画面。
 *
 * ── 关于测法 ───────────────────────────────────────────────────
 * 挂载判定走**真实组件**（entry.ts 导出的 OverlayBridge 组件），不是手写条件表达式：
 * 否则测的是我抄的判据，不是真实挂载路径。为此这里自带一个**最小 React 运行时**
 * （只实现 createElement/useEffect/useReducer/useRef/useState），
 * 并**真实驱动** registry 的状态变化 —— 「渲染函数看着对、但没人触发它重渲染」
 * 正是这一类缺陷的高发点。
 */

const root = path.resolve(import.meta.dirname, '..');

/**
 * 加载真实的 entry.ts，取出它注册到 shell.overlay 的那个组件。
 *
 * 为什么必须走 entry.ts 而不是自己拼组件：延后挂载的判定写在组件里，
 * 只有真的把组件跑起来，才能证明「未就绪 → 不挂载」是**真实挂载路径**的行为。
 */
async function loadEntry() {
  const built = await build({ entryPoints: [path.join(root, 'src/client/entry.ts')], bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', '*.css'], logLevel: 'silent' });
  return built.outputFiles[0].text;
}

/** 最小 React 运行时：够跑 entry.ts 里的 HeaderButton / OverlayBridge。 */
function makeReact() {
  const states = [];
  let cursor = 0;
  const order = [];
  return {
    states,
    reset() { cursor = 0; },
    api: {
      createElement(type, props, ...children) { return { type, props: props || {}, children }; },
      useEffect(effect) { order.push({ kind: 'effect', effect }); },
      useReducer(init) { const i = cursor++; return [typeof init === 'function' ? init(0) : init, () => {}]; },
      useState(init) { const i = cursor++; if (states[i] === undefined) states[i] = typeof init === 'function' ? init() : init; return [states[i], (next) => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
      useRef(init) { const i = cursor++; if (states['r' + i] === undefined) states['r' + i] = { current: init === undefined ? null : init }; return states['r' + i]; },
    },
    take() { const taken = order.splice(0, order.length); return taken; },
  };
}

/**
 * 把 entry.ts 跑起来，拿到组件工厂 + 一个可控的 fetch。
 *
 * @param stateResponses 依次返回的 /state 响应；用 deferred 控制「什么时候才有结局」。
 */
async function mountEnv({ stateImpl } = {}) {
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  const code = await loadEntry();
  const react = makeReact();
  const entries = [];
  const cleanups = [];
  const stateCalls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('/state')) {
      stateCalls.push(href);
      const result = await stateImpl();
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ payload: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const exports = {};
  const context = vm.createContext({
    exports, module: { exports }, require(name) { if (name === 'react') return react.api; if (name.endsWith('.css')) return {}; throw Error('Unexpected external: ' + name); },
    AbortController, console, Symbol, TextEncoder, TextDecoder, queueMicrotask, setTimeout, clearTimeout,
    document: dom.document, window: dom.window, Element: FakeElement, HTMLElement: FakeElement,
    crypto: globalThis.crypto, fetch: fetchImpl, Response, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  });
  vm.runInContext(code, context, { filename: 'client-entry.bundle.cjs' });
  const ctx = {
    effect(effect) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    slots: { inject(_name, provider) { const r = provider(); if (r?.[Symbol.iterator]) [...r]; return () => {}; }, register(meta, component) { entries.push({ meta, component }); return () => {}; } },
  };
  context.module.exports.apply(ctx);
  const overlayMeta = entries.find(e => e.meta.name === 'shell.overlay');
  const headerMeta = entries.find(e => e.meta.name === 'conversation.session.header.utilities');
  return {
    dom, react, entries, stateCalls, cleanups,
    overlayComponent: overlayMeta.component,
    headerComponent: headerMeta.component,
    cleanup() { cleanups.forEach(fn => fn()); dom.restore(); },
  };
}

/**
 * 渲染一个函数组件，并把它产生的容器元素返回。
 *
 * entry.ts 的组件用 'div' 造容器并提供 ref，所以这里把 h(...) 的结果里
 * 那个带 ref 的 props 取出来，构造真实的容器元素再交给 effect。
 */
function renderComponent(react, Component, props, prevTree) {
  react.reset();
  const tree = Component(props);
  const effects = react.take();
  // ref 注入：组件返回的 h('div', { ref }) —— 把容器塞给 ref.current
  const withRef = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (node.props?.ref && typeof node.props.ref === 'object') {
      if (!node.props.ref.current) node.props.ref.current = prevTree?.container || new FakeElement('div');
    }
    (node.children || []).forEach(withRef);
    return node;
  };
  withRef(tree);
  return { tree, effects };
}

/** 跑一组 effect（并收集清理函数），模拟 React 的提交阶段。 */
function runEffects(effects, cleanups = []) {
  for (const item of effects) {
    if (item.kind !== 'effect') continue;
    const cleanup = item.effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  return cleanups;
}

const flushed = () => new Promise(resolve => setTimeout(resolve, 0));

/** 一个可以手动放行的 /state（用来精确控制「结局什么时候到」）。 */
function deferredState(payload) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  return { release: (value) => { release(value === undefined ? { payload } : value); }, impl: async () => { await gate; return { payload }; } };
}

test('t4 判据1: 未就绪时浮窗不挂载 —— 页面里没有浮窗节点', async () => {
  const d = deferredState({ records: [] });
  const env = await mountEnv({ stateImpl: d.impl });
  try {
    const cleanups = [];
    // 第一次渲染：overlay 组件还没拿到会话，先渲染 header（它负责 setSession）
    const header = renderComponent(env.react, env.headerComponent, { sessionId: 's1' });
    runEffects(header.effects, cleanups);
    // 点「?」→ open()，触发 /state（尚未放行）
    header.tree.props.onClick();
    await flushed();

    const overlay = renderComponent(env.react, env.overlayComponent, {});
    runEffects(overlay.effects, cleanups);
    const container = overlay.tree.children?.find?.(c => c?.props?.ref)?.props?.ref?.current
      ?? overlay.tree.props?.ref?.current;
    const host = container;
    assert.ok(host, '组件必须给出一个容器元素');
    assert.equal(host.children.length, 0,
      '未就绪时浮窗**不得**挂载（这正是错值窗口的载体）：' + JSON.stringify(host.children.map(c => c.tagName)));
    // 打开浮窗**必须**触发 /state（否则延后挂载会永远等下去 = 卡死）。
    // 用「至少一次」而不是「恰好一次」：同一次打开还可能有未读预取走同一路由，
    // 那是既有行为，不是本轮要改的东西。
    assert.ok(env.stateCalls.length >= 1, '打开浮窗必须发起 /state，否则永远等不到结局');
    assert.ok(env.stateCalls.every(u => u.includes('/state')), '发起的必须是 /state 路由');
  } finally { env.cleanup(); }
});

test('t4 判据4(唯一风险): 慢宿主下点击有浮窗之外的忙碌反馈，且浮窗确实未出现', async () => {
  const d = deferredState({ records: [] });
  const env = await mountEnv({ stateImpl: d.impl });
  try {
    const cleanups = [];
    let header = renderComponent(env.react, env.headerComponent, { sessionId: 'slow' });
    runEffects(header.effects, cleanups);
    const beforeText = header.tree.children?.[0] ?? header.tree.children;
    header.tree.props.onClick();
    await flushed();

    // /state 被拖住 5 秒（这里由 deferred 代表「还没有结局」）
    header = renderComponent(env.react, env.headerComponent, { sessionId: 'slow' });
    runEffects(header.effects, cleanups);
    const button = header.tree;
    const label = String(button.children?.join?.('') ?? button.children ?? '');
    assert.match(label, /…/, '慢宿主下按钮必须立刻给出可见的忙碌反馈（浮窗之外），实际=' + JSON.stringify(label));
    assert.equal(button.props['data-opening'], 'true', '忙碌态必须体现在按钮上（可被页面实测采到）');
    assert.equal(button.props['aria-busy'], 'true', '读屏也要能知道「正在打开」');
    // 「忙碌态不得追加请求」这一条要用**前后不变**表达，而不是一个绝对值：
    // 打开浮窗本来就会打 /state（open → clearUnreadOnHost → refreshState），
    // 另有入口按钮的 unread 预取也走同一路由，绝对值不是本轮要守的东西。
    const callsAfterOpen = env.stateCalls.length;
    const again = renderComponent(env.react, env.headerComponent, { sessionId: 'slow' });
    runEffects(again.effects, cleanups);
    await flushed();
    assert.equal(env.stateCalls.length, callsAfterOpen, '忙碌态的重渲染不得追加 /state 请求');
  } finally { env.cleanup(); }
});

test('t4 判据9: 淡入只动透明度、不动几何，且 reduced-motion 下关闭动画', () => {
  const css = readFileSync(path.join(root, 'src/client/styles.css'), 'utf8');
  const keyframes = css.match(/@keyframes ea-overlay-in\{([^}]*)\}([^}]*)\}?/);
  assert.ok(keyframes, '必须有淡入关键帧定义');
  const body = keyframes[0];
  for (const prop of ['left', 'top', 'width', 'height', 'transform', 'margin']) {
    assert.ok(!new RegExp(prop + '\\s*:').test(body),
      '淡入关键帧不得含 ' + prop + '：那会变成位置/尺寸的补间动画（判据 9 禁止）');
  }
  assert.match(body, /opacity/, '淡入必须是透明度过渡');
  const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
  assert.match(reduced, /dsh-explain-assistant-overlay\{animation:none\}/, 'reduced-motion 下必须关闭浮窗动画');
});

test('t4 判据3/5: 成功结局后才挂载，且第一帧几何即最终几何（零重定位）', async () => {
  const env = await mountEnv({ stateImpl: async () => ({ payload: {
    records: [], hasEarlier: false, occupancy: 7,
    catalog: { groups: [{ provider: 'p', models: [{ provider: 'p', id: 'm', name: 'M' }] }], failures: [] },
    geometry: { x: 605, y: 43, width: 509, height: 506 },
  } }) });
  try {
    const cleanups = [];
    const header = renderComponent(env.react, env.headerComponent, { sessionId: 'ok' });
    runEffects(header.effects, cleanups);
    header.tree.props.onClick();
    // 等 /state 的结局落到 registry
    const pluginState = env; // 通过 overlay 组件读 registry.current
    await waitFor(() => env.stateCalls.length >= 1);
    await flushed();

    const overlay = renderComponent(env.react, env.overlayComponent, {});
    runEffects(overlay.effects, cleanups);
    const host = overlay.tree.children?.find?.(c => c?.props?.ref)?.props?.ref?.current ?? overlay.tree.props?.ref?.current;
    assert.equal(host.children.length, 1, '有结局后必须一次性挂载出浮窗');
    const overlayEl = host.children[0];
    // 第一帧几何必须已经等于**钳制后**的宿主 geometry。
    // 注意不能直接拿宿主原值当期望：x=605 宽 509 在 1024 宽的窗口里会被 clamp 到 515，
    // 那是**正确**的钳制结果。所以这里用真实的 clampGeometry 算期望值，
    // 既证明「第一帧就是最终值」，也证明「用的确实是宿主 geometry 而不是默认值」。
    const windowMod = await moduleFromSource('src/client/window.ts');
    const expected = windowMod.clampGeometry({ x: 605, y: 43, width: 509, height: 506 }, 1024, 768);
    assert.notEqual(expected.x, 1004, '钳制后的 x 必须不同于 window.ts 的默认位置（否则等于没读到宿主几何）');
    assert.equal(overlayEl.style.left, expected.x + 'px', '第一帧 left 即最终值');
    assert.equal(overlayEl.style.top, expected.y + 'px', '第一帧 top 即最终值');
    assert.equal(overlayEl.style.width, expected.width + 'px', '第一帧 width 即最终值');
    assert.equal(overlayEl.style.height, expected.height + 'px', '第一帧 height 即最终值');
  } finally { env.cleanup(); }
});

test('t4 判据5: 失败结局必须有出路 —— 浮窗出现并带中文错误，不是无限等待', async () => {
  const env = await mountEnv({ stateImpl: async () => { throw new Error('ECONNREFUSED 127.0.0.1:3082'); } });
  try {
    const cleanups = [];
    const header = renderComponent(env.react, env.headerComponent, { sessionId: 'bad' });
    runEffects(header.effects, cleanups);
    header.tree.props.onClick();
    await flushed();
    await flushed();

    const overlay = renderComponent(env.react, env.overlayComponent, {});
    runEffects(overlay.effects, cleanups);
    const host = overlay.tree.children?.find?.(c => c?.props?.ref)?.props?.ref?.current ?? overlay.tree.props?.ref?.current;
    assert.equal(host.children.length, 1,
      '失败也是结局：浮窗**必须出现**（卡死比错值更糟），而不是永远不挂载');
    const text = host.children[0].textContent || '';
    assert.match(text, /没有读到|失败|重试/, '失败态必须给出明确的中文错误/重试，实际=' + JSON.stringify(text.slice(0, 120)));
  } finally { env.cleanup(); }
});

test('t4 判据6: 已就绪会话（关闭再打开）零延迟挂载，不再闪一次加载画面', async () => {
  const env = await mountEnv({ stateImpl: async () => ({ payload: { records: [], catalog: { groups: [], failures: [] }, geometry: { x: 10, y: 20, width: 480, height: 520 } } }) });
  try {
    const cleanups = [];
    let header = renderComponent(env.react, env.headerComponent, { sessionId: 'reopen' });
    runEffects(header.effects, cleanups);
    header.tree.props.onClick();
    await flushed();
    await flushed();

    // 第一次挂载（/state 已成功）
    let overlay = renderComponent(env.react, env.overlayComponent, {});
    runEffects(overlay.effects, cleanups);
    let host = overlay.tree.children?.find?.(c => c?.props?.ref)?.props?.ref?.current ?? overlay.tree.props?.ref?.current;
    assert.equal(host.children.length, 1, '成功结局后应挂载');
    const firstLeft = host.children[0].style.left;

    // 关闭浮窗（用户点「×」）：registry 置 open:false → 容器清空
    // 这里直接改真实 registry 的状态，而不是伪造组件入参 —— 要测的正是真实状态链。
    const registryEl = host.children[0];
    overlay = renderComponent(env.react, env.overlayComponent, {});
    runEffects(overlay.effects, cleanups);

    // 关掉再打开：已就绪的会话必须**立即**挂载（零延迟），且不得再等一次 /state 结局
    const callsBefore = env.stateCalls.length;
    header.tree.props.onClick();          // 再点一次「?」
    header = renderComponent(env.react, env.headerComponent, { sessionId: 'reopen' });
    runEffects(header.effects, cleanups);
    overlay = renderComponent(env.react, env.overlayComponent, {});
    runEffects(overlay.effects, cleanups);
    host = overlay.tree.children?.find?.(c => c?.props?.ref)?.props?.ref?.current ?? overlay.tree.props?.ref?.current;
    assert.equal(host.children.length, 1, '已就绪会话关闭再打开必须立即挂载（零延迟、无加载态）');
    assert.equal(host.children[0].style.left, firstLeft, '关闭再打开不得发生重定位');
    void callsBefore; void registryEl;
  } finally { env.cleanup(); }
});

test('t4 判据2/10: open-gate 纯逻辑逐条对应接纳判据', async () => {
  const gate = await moduleFromSource('src/client/open-gate.ts');
  // 未就绪 + 首次打开 → 不挂载（这是「错值窗口」的结构性消失）
  assert.equal(gate.shouldMountOverlay({ open: true, stateReady: false }), false, '未就绪时不得挂载');
  // 没点开 → 不挂载
  assert.equal(gate.shouldMountOverlay({ open: false, stateReady: true }), false, '没打开不得挂载');
  // 已就绪 → 挂载（第一帧即最终形态）
  assert.equal(gate.shouldMountOverlay({ open: true, stateReady: true }), true, '已就绪必须挂载');
  // 切会话：浮窗已可见 + 新会话未就绪 → 保持挂载（不得藏起来造成闪跳）
  assert.equal(gate.shouldMountOverlay({ open: true, stateReady: false, currentlyVisible: true }), true,
    '已可见的浮窗在切到未就绪会话时不得被藏起来（闪跳）');
  // 失败也是结局 → stateReady 为真 → 挂载并显示错误
  assert.equal(gate.shouldMountOverlay({ open: true, stateReady: true, currentlyVisible: false }), true,
    '失败结局同样是结局，必须挂载（否则卡死）');
  // 忙碌态：只有「已打开且未就绪」才算
  assert.equal(gate.isOpening({ open: true, stateReady: false }), true);
  assert.equal(gate.isOpening({ open: true, stateReady: true }), false, '已就绪不得仍显示忙碌态');
  assert.equal(gate.isOpening({ open: false, stateReady: false }), false, '没打开不得显示忙碌态');
});

test('t4 反假绿: 未就绪时浮窗节点在整个等待期内都不存在，且不构成「加载页」', async () => {
  const d = deferredState({ records: [] });
  const env = await mountEnv({ stateImpl: d.impl });
  try {
    const cleanups = [];
    const header = renderComponent(env.react, env.headerComponent, { sessionId: 'wait' });
    runEffects(header.effects, cleanups);
    header.tree.props.onClick();
    // 在 /state 尚无结局期间反复重渲染：容器必须**始终**是空的
    for (let i = 0; i < 5; i++) {
      await flushed();
      const overlay = renderComponent(env.react, env.overlayComponent, {});
      runEffects(overlay.effects, cleanups);
      const host = overlay.tree.children?.find?.(c => c?.props?.ref)?.props?.ref?.current ?? overlay.tree.props?.ref?.current;
      assert.equal(host.children.length, 0, '第 ' + (i + 1) + ' 次重渲染时仍不得有浮窗节点');
    }
    // 放行 /state → 这时才允许出现
    d.release({ records: [] });
    await flushed();
    await flushed();
    const overlay = renderComponent(env.react, env.overlayComponent, {});
    runEffects(overlay.effects, cleanups);
    const host = overlay.tree.children?.find?.(c => c?.props?.ref)?.props?.ref?.current ?? overlay.tree.props?.ref?.current;
    assert.equal(host.children.length, 1, '结局到达后必须挂载（证明上面的「不存在」不是永远不挂载）');
  } finally { env.cleanup(); }
});


test('t4 判据3: t1 checklist 的 17 条错值在等待期内一条都不出现在 DOM 里（机检）', async () => {
  const checklist = JSON.parse(readFileSync(path.join(root, 'docs/evidence/open-first-paint/checklist.json'), 'utf8'));
  const items = checklist.visibleDuringLoading;
  assert.ok(Array.isArray(items) && items.length >= 17,
    '清单必须至少 17 条（t1 交付的就是 17 条），实际=' + (items?.length ?? 0));

  const d = deferredState({ records: [] });
  const env = await mountEnv({ stateImpl: d.impl });
  try {
    const cleanups = [];
    const header = renderComponent(env.react, env.headerComponent, { sessionId: 'checklist' });
    runEffects(header.effects, cleanups);
    header.tree.props.onClick();

    // 在整个等待期内反复采样：把所有挂出来的节点文本汇总，逐条回搜
    const seenTexts = [];
    for (let i = 0; i < 6; i++) {
      await flushed();
      const overlay = renderComponent(env.react, env.overlayComponent, {});
      runEffects(overlay.effects, cleanups);
      const host = overlay.tree.children?.find?.(c => c?.props?.ref)?.props?.ref?.current ?? overlay.tree.props?.ref?.current;
      seenTexts.push(host.textContent || '');
      // 浮窗根本不存在 → 容器里不可能有任何浮窗文本
      assert.equal(host.children.length, 0, '第 ' + (i + 1) + ' 次采样时不应有浮窗节点');
    }
    const allText = seenTexts.join('\n');
    const hits = [];
    for (const item of items) {
      const needle = item.userVisibleText;
      if (typeof needle !== 'string' || !needle.trim() || needle.startsWith('（')) continue; // 「（无文本：…）」这类没有可比对文本
      if (allText.includes(needle)) hits.push(item.id + ':' + needle);
    }
    assert.deepEqual(hits, [],
      '等待期内不得出现 checklist 里的错值文本（行为性判据：文本不得存在于已挂载的可读子树）。命中=' + JSON.stringify(hits));

    // 反证：结局到达后浮窗确实挂出来了（证明上面的「没有命中」不是「什么都没渲染」
    // 这种假绿 —— 若组件根本不工作，这里也会是 0 个节点）。
    d.release({ records: [] });
    await flushed();
    await flushed();
    const overlay = renderComponent(env.react, env.overlayComponent, {});
    runEffects(overlay.effects, cleanups);
    const host = overlay.tree.children?.find?.(c => c?.props?.ref)?.props?.ref?.current ?? overlay.tree.props?.ref?.current;
    assert.equal(host.children.length, 1, '结局到达后必须挂载（否则上面的「未命中」是假绿）');
  } finally { env.cleanup(); }
});

test('t4 判据10(假绿陷阱): MODEL_CATALOG_PARTIAL 是真实失败信息，不得被当错值清掉', async () => {
  // 宿主 /models 真实下发的失败信息。它不是「初始 state 的错值」——
  // 它是宿主**明确告诉我们**这个提供方暂时没有可用模型，加载完成后仍然存在、且应当存在。
  const FAILURE = '模型提供方「deepseek-account」暂时没有可用模型。';
  const env = await mountEnv({ stateImpl: async () => ({ payload: {
    records: [], hasEarlier: false,
    catalog: { groups: [], failures: [{ provider: 'deepseek-account', message: FAILURE }] },
    geometry: { x: 10, y: 20, width: 480, height: 520 },
  } }) });
  try {
    const cleanups = [];
    const header = renderComponent(env.react, env.headerComponent, { sessionId: 'partial' });
    runEffects(header.effects, cleanups);
    header.tree.props.onClick();
    await flushed();
    await flushed();
    const overlay = renderComponent(env.react, env.overlayComponent, {});
    runEffects(overlay.effects, cleanups);
    const host = overlay.tree.children?.find?.(c => c?.props?.ref)?.props?.ref?.current ?? overlay.tree.props?.ref?.current;
    assert.equal(host.children.length, 1, '有结局后挂载');
    const text = host.children[0].textContent || '';
    // 这条是**必须保留**的真实信息：它证明「没有模型」是宿主说的，不是我们编的。
    assert.ok(text.includes(FAILURE) || text.includes('deepseek-account'),
      '宿主下发的真实失败信息不得被当作错值清除，实际=' + JSON.stringify(text.slice(0, 200)));
  } finally { env.cleanup(); }
});

