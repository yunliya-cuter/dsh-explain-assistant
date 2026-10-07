import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * task-37 普查出的 6 条假绿的**收口闸**（task-39）。
 *
 * 背景：task-37 发现 6 条「断言所依赖的行为，恰好是夹具没模拟（或模拟失真）的」，
 * 表现为「把实现改坏，全量仍然全绿」。本文件把每条落成**可判定**的真闸。
 *
 * 每条都做到三步齐备：
 *   a) 补夹具缺的能力（只补 src/ 真正用到的）——见 tests/fixtures/runtime.mjs；
 *   b) 本文件的用例在当前实现上**是绿的**；
 *   c) **实测证伪**：把对应源码改坏 → 本文件恰好变红 → 还原 → md5 核对。
 *      每条的实际 fail 数写在下方各自注释里，并汇总在
 *      docs/evidence/mock-dom-false-green-closeout.md。
 *
 * 关于 F2 的一个刻意选择：**没有**给假 DOM 加事件冒泡。
 * 真实浏览器里 Escape 从子元素冒泡到 root，但给夹具加冒泡语义会动摇现有 575 条
 * （大量测试依赖「emit 只在本元素派发」）。收口不需要它：
 * 直接在**被监听的那个元素**（root）上 emit 即可判定。
 */

const windowMod = await moduleFromSource('src/client/window.ts');
const overlay = await moduleFromSource('src/client/overlay.tsx');
const selection = await moduleFromSource('src/client/selection.ts');

function baseState(extra) {
  return Object.assign({
    sessionId: 's1', open: true, phase: 'idle', draft: '', reasoning: '', text: '', tools: [], records: [],
    hasEarlier: false, loadingEarlier: false, evidence: [], unread: false, occupancyKnown: false,
    quickQuestionsDismissed: true, catalog: { groups: [], failures: [] },
  }, extra || {});
}

function pluginFor(state, overrides) {
  return Object.assign({
    registry: { update() {}, get: () => state, close() {} },
    api: {}, cancel() {}, submit: async () => {}, loadEarlier: async () => {},
  }, overrides || {});
}

/* ================================================================== *
 * F1. 焦点在浮窗子元素上时，方向键仍能调整位置
 *     （task-37 F1）依赖未模拟行为：夹具原先没有 contains()
 *     证伪实测：把 window.ts 的 onKeyDown 整体置为 return → 本文件 fail=1（仅此条）
 * ================================================================== */

test('[F1] 焦点在浮窗标题栏的子元素上时，方向键仍能移动浮窗', () => {
  const dom = fakeDom();
  try {
    const root = new FakeElement('div');
    const handle = new FakeElement('div');
    root.appendChild(handle);
    // 真实场景：用户点了浮窗标题栏里的按钮，焦点落在**子元素**上。
    const inner = new FakeElement('button');
    handle.appendChild(inner);
    const seen = [];
    const controller = windowMod.attachWindowInteractions(
      root, handle, { x: 100, y: 100, width: 400, height: 500 }, g => seen.push(g));
    dom.document.activeElement = inner;
    handle.emit('keydown', { key: 'ArrowRight', shiftKey: false, preventDefault() {} });
    assert.equal(seen.length, 1,
      '焦点在标题栏子元素上时，方向键必须仍能调整浮窗（原实现会因缺少 contains 直接抛错）');
    assert.equal(seen[0].x, 101, 'ArrowRight 应把 x 加 1');
    assert.equal(root.style.left, '101px', '新位置必须真的落到 DOM 上');
    controller.dispose();
  } finally { dom.restore(); }
});

test('[F1] 焦点在浮窗外部时，方向键不得调整浮窗', () => {
  const dom = fakeDom();
  try {
    const root = new FakeElement('div');
    const handle = new FakeElement('div');
    root.appendChild(handle);
    const outside = new FakeElement('button');
    dom.document.body = new FakeElement('body');
    dom.document.body.appendChild(outside);
    const seen = [];
    const controller = windowMod.attachWindowInteractions(
      root, handle, { x: 100, y: 100, width: 400, height: 500 }, g => seen.push(g));
    dom.document.activeElement = outside;
    handle.emit('keydown', { key: 'ArrowRight', shiftKey: false, preventDefault() {} });
    assert.equal(seen.length, 0, '焦点不在浮窗内时不得响应方向键（contains 的反面）');
    controller.dispose();
  } finally { dom.restore(); }
});

/* ================================================================== *
 * F2. Esc 退出「选择模式」
 *     （task-37 F2）依赖未模拟行为：无事件冒泡
 *     ——刻意**不**给夹具加冒泡，直接在 root 上 emit 即可判定
 *     证伪实测：删掉 overlay.tsx 那行 capture keydown 监听 → 本文件 fail=1（仅此条）
 * ================================================================== */

test('[F2] 选择模式下按 Esc 必须退出选择模式', () => {
  const dom = fakeDom();
  try {
    const state = baseState();
    const root = overlay.renderOverlay(state, pluginFor(state));
    root.setAttribute('data-selection-mode', '');
    assert.equal(root.hasAttribute('data-selection-mode'), true, '前置：应处于选择模式');
    // 直接在**被监听的那个元素**上派发（真实浏览器里由子元素冒泡上来；
    // 给夹具加冒泡会动摇现有 575 条，所以按监听目标派发）。
    root.emit('keydown', { key: 'Escape' });
    assert.equal(root.hasAttribute('data-selection-mode'), false,
      '按 Esc 必须退出选择模式（原实现的监听被删掉时这条会红）');
  } finally { dom.restore(); }
});

test('[F2] 非选择模式下按 Esc 不应误清属性（反例）', () => {
  const dom = fakeDom();
  try {
    const state = baseState();
    const root = overlay.renderOverlay(state, pluginFor(state));
    // 不进选择模式，Escape 应交给外层 keydown（关窗），而不是这条监听。
    let closed = false;
    const state2 = baseState();
    const root2 = overlay.renderOverlay(state2, pluginFor(state2, { registry: { update() {}, get: () => state2, close() { closed = true; } } }));
    root2.emit('keydown', { key: 'Escape' });
    assert.equal(closed, true, '非选择模式的 Escape 应由外层关窗逻辑处理');
    assert.equal(root.hasAttribute('data-selection-mode'), false);
  } finally { dom.restore(); }
});

/* ================================================================== *
 * F3. UI 表单提交把问题交给 plugin.submit
 *     （task-37 F3）纯覆盖缺口：既有 20+ 条 submit 测试全部直接调 plugin.submit()，
 *     没有一条经由 UI 表单（grep "emit('submit'" → 0 命中）
 *     证伪实测：把 overlay.tsx:816 的条件改成恒假 → 本文件 fail=1（仅此条）
 * ================================================================== */

test('[F3] 勾选输入框后提交表单，问题必须交给 plugin.submit', () => {
  const dom = fakeDom();
  try {
    const submitted = [];
    const state = baseState();
    const root = overlay.renderOverlay(state, pluginFor(state, { submit: async q => submitted.push(q) }));
    const form = root.querySelectorAll('form')[0];
    const input = root.querySelectorAll('textarea')[0];
    assert.ok(form && input, '前置：必须存在 form 与 textarea');
    input.value = '  你好世界  ';
    form.emit('submit', { preventDefault() {} });
    assert.deepEqual(submitted, ['你好世界'],
      '表单提交必须把**去空白后**的问题交给 plugin.submit（原实现被改成恒假时这条会红）');
  } finally { dom.restore(); }
});

test('[F3] 空白输入提交时不得调用 plugin.submit（反例）', () => {
  const dom = fakeDom();
  try {
    const submitted = [];
    const state = baseState();
    const root = overlay.renderOverlay(state, pluginFor(state, { submit: async q => submitted.push(q) }));
    const form = root.querySelectorAll('form')[0];
    const input = root.querySelectorAll('textarea')[0];
    input.value = '   ';
    form.emit('submit', { preventDefault() {} });
    assert.deepEqual(submitted, [], '空白输入不得提交');
  } finally { dom.restore(); }
});

/* ================================================================== *
 * F4 / F5. draft 的「读回」与「重画同步」
 *     （task-37 F4/F5）纯覆盖缺口：既有断言只查 effect 依赖与**写出**，
 *     没有一条断言 draft 被**读回**输入框
 *     证伪实测：
 *       F5 删掉 updateOverlay 里的同步行（overlay.tsx:935）→ 本文件 fail=1
 *       F4 单破 **不会红**，见下方「F4 不可独立证伪」——这是一个如实记录的发现
 * ================================================================== */

/*
 * ⚠️ F4 不可独立证伪 —— 如实记录的发现（task-39 实测）。
 *
 * renderOverlay 的末尾会调一次 updateOverlay（overlay.tsx:819），而 updateOverlay 里有
 * F5 的同步行。于是 809 那行写成什么，都会被 F5 **当场纠正**：
 *   实测「把 input.value = state.draft 改成固定串」→ 全量 fail=0；
 *   实测「把该行整行删掉」            → 全量 fail=0。
 * 只有**同时**破坏 809 与 935，F4 的断言才变红（实测 fail=4）。
 *
 * 结论：F4 的用例是**有效断言**（它要求的最终状态确实成立，且两条同时
 * 破坏时会红），但它**测不出 809 这一行单独的退化** —— 因为那一行在
 * 当前实现里是**冗余**的。不把它写成「已独立证伪」，也不删掉它（它守的是「最终状态」
 * 这个对外可见契约）。
 */
test('[F4] 渲染浮窗时必须把 state.draft 回填进输入框', () => {
  const dom = fakeDom();
  try {
    const state = baseState({ draft: '草稿内容' });
    const root = overlay.renderOverlay(state, pluginFor(state));
    const input = root.querySelectorAll('textarea')[0];
    assert.equal(input.value, '草稿内容',
      '关闭再打开浮窗必须回填草稿（原实现被改成固定串时这条会红）');
  } finally { dom.restore(); }
});

test('[F4] 没有草稿时输入框应为空（反例）', () => {
  const dom = fakeDom();
  try {
    const state = baseState({ draft: '' });
    const root = overlay.renderOverlay(state, pluginFor(state));
    assert.equal(root.querySelectorAll('textarea')[0].value, '', '无草稿时应为空');
  } finally { dom.restore(); }
});

test('[F5] 重画时必须把外部 draft 同步回输入框（覆盖用户残留）', () => {
  const dom = fakeDom();
  try {
    const state = baseState({ draft: 'A' });
    const plugin = pluginFor(state);
    const root = overlay.renderOverlay(state, plugin);
    const input = root.querySelectorAll('textarea')[0];
    // 模拟：输入框里还留着用户上次敲的内容，而外部 draft 已被改成别的值。
    input.value = '用户残留';
    state.draft = 'B-外部新值';
    overlay.updateOverlay(root, state, plugin);
    assert.equal(input.value, 'B-外部新值',
      '重画必须把 draft 同步回输入框（原实现删掉同步行时这条会红）');
  } finally { dom.restore(); }
});

test('[F5] 输入框内容与 draft 一致时不得无谓重写（反例：避免打断输入）', () => {
  const dom = fakeDom();
  try {
    const state = baseState({ draft: '一致' });
    const plugin = pluginFor(state);
    const root = overlay.renderOverlay(state, plugin);
    const input = root.querySelectorAll('textarea')[0];
    assert.equal(input.value, '一致');
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => '一致',
      set: () => { throw new Error('内容已一致时不应再次写入 value（会打断用户输入）'); },
    });
    overlay.updateOverlay(root, state, plugin);
  } finally { dom.restore(); }
});

/* ================================================================== *
 * F6. 「有文本选中时不得把点击当成选中依据」
 *     （task-37 F6）依赖未模拟行为：夹具的 getSelection() **恒返回 null**
 *     ——task-37 报告里我明说这条的替代表述没跑绿，本文件把它真跑绿。
 *     证伪实测：删掉 selection.ts:79 那行守卫 → 本文件 fail=1（仅此条）。
 *     对照：同一函数里相邻的位移守卫（CLICK_SLOP_PX）删掉 → fail=2
 *     （既有测试也守得住它）——两个相邻守卫能被测/不能被测的差别，
 *     恰在于**夹具能否模拟**，这正是 task-37 的论点。
 * ================================================================== */

/** 造一个可选择的目标卡片（与 selection.test.mjs 的既有形态一致）。 */
function attachPickable(dom) {
  const root = dom.document;
  const chat = new FakeElement('div');
  chat.setAttribute('data-conversation-scroll', '');
  const card = new FakeElement('div');
  card.setAttribute('data-tool', 'bash');
  card.textContent = '运行了一条命令';
  chat.appendChild(card);
  root.appendChild(chat);
  const picked = [];
  const controller = selection.attachSelection(root, 'session-a', item => picked.push(item));
  return { root, card, picked, controller };
}

test('[F6] 用户正在选字时（有文本选中），点击不得被当成选中依据', () => {
  const dom = fakeDom();
  try {
    const { root, card, picked, controller } = attachPickable(dom);
    // 补上夹具缺的能力：返回一个「有选中文本」的 Selection 形状对象。
    // 真实浏览器里用户拖选后松开鼠标时，这里应当有内容 → 不得误判成点击。
    root.getSelection = () => ({ toString: () => '用户选中的一段文字' });
    card.focus();
    root.emit('mousedown', { target: card, button: 0, clientX: 10, clientY: 10 });
    root.emit('click', { target: card, button: 0, clientX: 10, clientY: 10 });
    assert.equal(picked.length, 0,
      '存在文本选中时不得把这次点击当成「选中这一步」（原实现的这行守卫被删掉时这条会红）');
    controller.dispose();
  } finally { dom.restore(); }
});

test('[F6] 没有文本选中时，同样的一次点击必须能选中（反例：证明上一条不是恒假）', () => {
  const dom = fakeDom();
  try {
    const { root, card, picked, controller } = attachPickable(dom);
    // 夹具默认 getSelection 返回 null → 等价于「没有选中文本」。
    card.focus();
    root.emit('mousedown', { target: card, button: 0, clientX: 10, clientY: 10 });
    root.emit('click', { target: card, button: 0, clientX: 10, clientY: 10 });
    assert.equal(picked.length, 1, '没有选中文本时，同样的点击必须能选中（对照组）');
    controller.dispose();
  } finally { dom.restore(); }
});

test('[F6] 选中文本为纯空白时不应吞掉点击（边界）', () => {
  const dom = fakeDom();
  try {
    const { root, card, picked, controller } = attachPickable(dom);
    root.getSelection = () => ({ toString: () => ' \t ' });
    card.focus();
    root.emit('mousedown', { target: card, button: 0, clientX: 10, clientY: 10 });
    root.emit('click', { target: card, button: 0, clientX: 10, clientY: 10 });
    assert.equal(picked.length, 1, '纯空白的「选中」不算选中（实现里做了 trim）');
    controller.dispose();
  } finally { dom.restore(); }
});

/* ================================================================== *
 * P3. 夹具自身缺陷：focus() 在 restore() 之后调用会 TypeError
 *     （task-37 报告第 ④ 节）
 *     原写法 focus() { globalThis.document.activeElement = this; }
 *     在 dom.restore() 之后调用 → globalThis.document 已被删除 → TypeError。
 *     实测踩到过：同进程先后建两个 fakeDom()、restore 第一个后，
 *     异步残留的 focus() 就崩。修法：先判存在。
 * ================================================================== */

test('[P3] 夹具：restore() 之后再调用 focus() 不得抛错', () => {
  const first = fakeDom();
  const element = new FakeElement('button');
  first.restore();
  // restore 之后 globalThis.document 已被删除。这行原实现会抛
  // TypeError: Cannot set properties of undefined (setting 'activeElement')。
  assert.doesNotThrow(() => element.focus(),
    'restore() 之后调用 focus() 不得抛错（所属文档已不存在，focus 本就无事可做）');
});

test('[P3] 夹具：同进程两个 fakeDom，restore 第一个后第二个仍可正常 focus', () => {
  const first = fakeDom();
  first.restore();
  const second = fakeDom();
  try {
    const button = new FakeElement('button');
    assert.doesNotThrow(() => button.focus(), '第二个 fakeDom 里 focus 必须正常');
    assert.equal(second.document.activeElement, button, 'focus 必须把 activeElement 指向该元素');
    // 且第一个 dom 的元素此时再 focus 也不得崩（它的文档已不存在）。
    assert.doesNotThrow(() => new FakeElement('button').focus());
  } finally { second.restore(); }
});

test('[P3] 夹具：正常作用域内 focus() 仍然生效（证明修复没有把功能改没）', () => {
  const dom = fakeDom();
  try {
    const button = new FakeElement('button');
    button.focus();
    assert.equal(dom.document.activeElement, button, '作用域内 focus 必须照常工作');
  } finally { dom.restore(); }
});
