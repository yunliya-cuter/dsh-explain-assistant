import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import path from 'node:path';
import { fakeDom, FakeElement } from './fixtures/runtime.mjs';

/**
 * 2026-11-07 焦点专项的回归闸。
 *
 * 用户原话：
 *   「我希望点开小助手后默认焦点在输入框来直接输入。另外输入框似乎有一些bug，
 *     会出现焦点不在输入框无法输入却光标仍在闪动或者有光圈等不符合直觉的问题。」
 *
 * 这两句各对应一组判据，下面分开钉：
 *  A. 打开即聚焦：要有明确的一条路径（等挂载 + 就绪 → 投递 → 下一帧校验 → 一次重试），
 *     并且只给「用户自己开的」浮窗 —— 后台切会话把浮窗带过来时不许抢主对话的焦点。
 *  B. 焦点态视觉只认真实焦点：自绘光标、选区块、焦点环三者共用同一个判据
 *     （document.activeElement === input），任何一次刷新都不得把失焦后的它们重新点亮。
 *
 * 只查字符串是不够的 —— 判据写反时字符串照样在。所以 B 的关键一条（deliverFocus）
 * 用真实构建产物跑行为测试；其余用**结构性**断言（顺序、有无、调用点）。
 */

const read = relative => readFile(new URL('../' + relative, import.meta.url), 'utf8');
const ROOT = path.resolve(import.meta.dirname, '..');

/* ================= A. 焦点归属：唯一判据 ================= */

test('焦点: 自绘光标/选区块只在真的持有焦点时绘制（失焦一律收起）', async () => {
  const src = await read('src/client/text-field.ts');
  assert.match(src, /function focused\(\): boolean/, '必须有唯一的焦点判据 focused()');
  assert.match(src, /return document\.activeElement === input/, '判据必须读 document.activeElement（不是缓存的布尔位）');
  assert.match(src, /if \(dead \|\| !hasFocus\) return false/, 'blur 之后必须立刻为假（不等 activeElement 更新）');

  const refresh = src.match(/function refresh\(\) \{[\s\S]*?\n  \}/);
  assert.ok(refresh, '必须有 refresh()');
  const body = refresh[0];
  assert.match(body, /if \(!focused\(\)\) \{ hideCaret\(\); hideSelectionBoxes\(\); return \}/, 'refresh 必须先过焦点闸再画');
  const iGate = body.indexOf('if (!focused())');
  const iBlink = body.indexOf('restartBlink()');
  assert.ok(iGate >= 0 && iBlink > iGate, 'restartBlink 必须在焦点闸**之后**：旧写法失焦后随便一次刷新就把光标点亮');
  assert.match(src, /function paintCaret\(snap: Snapshot\): void \{\s*\n\s*\/\/[^\n]*\n\s*if \(!focused\(\)\)/, 'paintCaret 自己也要有闸（双保险）');
  assert.match(src, /function paintSelection\(snap: Snapshot\): void \{\s*\n\s*if \(!focused\(\)\)/, '选区块同样只在有焦点时画');
});

test('焦点: blur 必须把 caretVisible 一起置假（否则下一次刷新会重启闪烁）', async () => {
  const src = await read('src/client/text-field.ts');
  const blur = src.match(/function onBlur\(\)[\s\S]*?\n  \}/);
  assert.ok(blur, '必须有 onBlur()');
  const body = blur[0];
  assert.match(body, /hasFocus = false/, 'blur 必须清掉焦点位');
  assert.match(body, /root\.removeAttribute\('data-focus'\)/, 'blur 必须摘掉焦点环开关');
  assert.match(body, /caretVisible = false/, 'caretVisible 不置假 → 下一次 refresh 认为「光标本来就该在」并把它点亮（用户报的那条）');
  assert.match(body, /hideSelectionBoxes\(\)/, '选区块必须一起收');
});

test('焦点: 焦点环只给键盘焦点，由 data-focus 属性驱动（不再用 :has(:focus-visible)）', async () => {
  const css = await read('src/client/styles.css');
  assert.equal(/:has\(\.ea-input:focus-visible\)/.test(css), false,
    '不得再用 :has(:focus-visible)：文本输入框在 Chrome 里鼠标点一下也算 focus-visible，点进去就常驻一圈亮环');
  assert.match(css, /\.ea-field\[data-focus="keyboard"\]/, '焦点环必须由 data-focus="keyboard" 触发');
  assert.match(css, /\.ea-field \.ea-input:focus-visible\{\s*outline:none/, '输入框自身不得再画第二圈 outline');

  const src = await read('src/client/text-field.ts');
  assert.match(src, /root\.setAttribute\('data-focus', lastKeyAt > lastPointerAt \? 'keyboard' : 'on'\)/,
    '只有「上一次是键盘」才给环，鼠标点进来不给');
  assert.match(src, /\[document, 'pointerdown', onPointerIntent as EventListener\]/, '要记指针意图');
  assert.match(src, /\[document, 'keydown', onKeyIntent as EventListener\]/, '要记键盘意图');
});

test('焦点: 焦点归属的监听与动效解耦（reduced-motion 下也要有焦点提示）', async () => {
  const src = await read('src/client/text-field.ts');
  assert.match(src, /const focusListeners: Array<\[EventTarget, string, EventListener\]>/, '焦点监听必须单独一组');
  assert.match(src, /focusListeners\.forEach\(\(\[target, name, fn\]\) => target\.addEventListener\(name, fn, true\)\)/,
    '焦点监听必须在 if (active) 之外挂载：减少动态效果时自绘光标不接管，但焦点环仍要工作');
});

/* ================= B. 打开即聚焦 ================= */

test('焦点: 打开即聚焦是一条明确路径（等挂载+就绪 → 投递 → 校验 → 重试）', async () => {
  const overlay = await read('src/client/overlay.tsx');
  const fn = overlay.match(/export function deliverFocus\(ctx: OverlayContext, attempt = 0\): void \{[\s\S]*?\n\}/);
  assert.ok(fn, '必须有 deliverFocus（不是分散在各处的 focus() 调用）');
  const body = fn[0];
  assert.match(body, /root\.getAttribute\('data-surface'\) === 'ready'/, '必须等就绪档（加载页上输入区是收起的）');
  assert.match(body, /input\.isConnected/, '必须等挂进文档');
  assert.match(body, /if \(doFocus\(true\)\) return/, '第一次投递必须无条件（用户点了「?」，焦点通常还在主对话里）');
  assert.match(body, /retry\(2\)/, '失败要有一帧后校验 + 一次明确重试');
  assert.match(body, /console\.warn\('\[dsh-explain-assistant\] 输入框没能拿到焦点/, '重试仍失败要留一条日志（否则又是一次静默失败）');
  assert.match(overlay, /deliverFocus\(ctx\)\n  return root/, 'renderOverlay 建完就要投递一次');
  assert.match(overlay, /deliverFocus\(ctx\)\n  \/\/ 注意：这里\*\*不再回写 scrollTop/, '从加载页切到就绪档的那次重画也要投递');
  assert.match(body, /const pageSelection = \(/, '聚焦前要记下页面选区（聚焦会清掉它）');
  assert.match(body, /selection\.addRange\(pageSelection\)/, '聚焦后要把选区还回去');
  assert.match(overlay, /pendingFocus: options\.autoFocus !== false/, '缺省是「要聚焦」；后台重建由调用方显式传 false');
});

test('焦点: 点「发送/停止」之后把焦点交回输入框（鼠标点按钮不该把输入弄丢）', async () => {
  const overlay = await read('src/client/overlay.tsx');
  assert.match(overlay, /const returnFocus = \(\): void => \{/, '必须有 returnFocus');
  assert.match(overlay, /if \(current && isBusy\(current\.state\)\) \{ current\.plugin\.cancel\?\.\(\); returnFocus\(\); return \}/, '停止之后也要交回');
  assert.match(overlay, /form\.requestSubmit\(\)\n    \/\/[^\n]*\n    \/\/[^\n]*\n    returnFocus\(\)/, '发送之后要交回');
});

test('焦点: 只有「用户自己开的」浮窗才抢焦点，且每个会话只抢一次', async () => {
  const entry = await read('src/client/entry.ts');
  assert.match(entry, /const autoFocus = Boolean\(/, 'autoFocus 必须是一处明确的判定');
  assert.match(entry, /current\?\.openedByUser === true/, '必须是用户开的（后台切会话带过来的浮窗 openedByUser=false）');
  assert.match(entry, /focusedSessionRef\.current !== current\.sessionId/, '同一个会话只许自动聚焦一次');
  assert.match(entry, /if \(!current\?\.open\) focusedSessionRef\.current = null/, '关窗要清掉标记，下次打开才能再聚焦');
  assert.match(entry, /renderOverlay\(current, plugin, previousGeometry, \{ autoFocus: autoFocus \|\| restoreFocus \}\)/, '判定必须真的传给 renderOverlay');
  assert.match(entry, /const restoreFocus = mounting && hadFocusRef\.current === true/, '切会话重建时要把「原来正在这里打字」的焦点还回来');
});

/* ================= B 的行为测试：deliverFocus 真的会聚焦 ================= */

async function loadOverlayModule() {
  const built = await build({
    entryPoints: [path.join(ROOT, 'src/client/overlay.tsx')],
    bundle: true, format: 'cjs', platform: 'browser', write: false,
    external: ['react', '*.css'], loader: { '.css': 'text' }, logLevel: 'silent',
  });
  const dom = fakeDom();
  const exports = {};
  const context = vm.createContext({
    exports, module: { exports }, require(name) { if (name === 'react') return { createElement: () => ({}) }; if (name.endsWith('.css')) return {}; throw Error('Unexpected external: ' + name); },
    console, setTimeout, clearTimeout, queueMicrotask,
    document: dom.document, window: dom.window, Element: FakeElement, HTMLElement: FakeElement,
  });
  vm.runInContext(built.outputFiles[0].text, context, { filename: 'overlay.cjs' });
  return { mod: context.module.exports, dom };
}

test('焦点: deliverFocus —— 未挂载不投递、就绪后投递、只投一次', async () => {
  const { mod, dom } = await loadOverlayModule();
  try {
    const root = new FakeElement('section');
    root.setAttribute('data-surface', 'ready');
    const input = new FakeElement('textarea');
    // 未挂载：isConnected 为假，不得聚焦，也别把 pendingFocus 丢掉
    Object.defineProperty(input, 'isConnected', { configurable: true, get: () => false });
    const ctx = { pendingFocus: true, input, root };
    mod.deliverFocus(ctx, 0);
    assert.equal(dom.document.activeElement, null, '还没挂进文档时不该聚焦（会聚焦到一个未来的节点上）');
    assert.equal(ctx.pendingFocus, true, '没投递成功就不能把标记吃掉');
    // 挂上了：投递
    Object.defineProperty(input, 'isConnected', { configurable: true, get: () => true });
    mod.deliverFocus(ctx, 0);
    assert.equal(dom.document.activeElement, input, '挂载 + 就绪之后焦点必须落在输入框');
    assert.equal(ctx.pendingFocus, false, '投递成功要清标记（否则每次重画都抢一次焦点）');
    // 再调一次：pendingFocus 已清，不得再抢
    dom.document.activeElement = null;
    mod.deliverFocus(ctx, 0);
    assert.equal(dom.document.activeElement, null, '一次打开只投递一次');
  } finally { dom.restore(); }
});

test('焦点: 聚焦不会把主对话里已选中的那段文字"吃掉"', async () => {
  // 用户的典型动作：在主对话里拖选一段 → 点 ? 问小助手。Chrome 里焦点进文本控件会
  // **整体作废文档选区**，于是那段橙色高亮凭空消失。deliverFocus 要在聚焦后把选区还回去。
  const { mod, dom } = await loadOverlayModule();
  try {
    const root = new FakeElement('section');
    root.setAttribute('data-surface', 'ready');
    const input = new FakeElement('textarea');
    let focusedYet = false;
    let restoredRange = null;
    input.focus = () => { focusedYet = true; dom.document.activeElement = input; };
    dom.document.getSelection = () => (focusedYet
      ? { rangeCount: 0, isCollapsed: true, removeAllRanges() {}, addRange(range) { restoredRange = range } }
      : { rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ cloneRange: () => 'RANGE-BEFORE-FOCUS' }) });
    const ctx = { pendingFocus: true, input, root };
    mod.deliverFocus(ctx, 0);
    assert.equal(dom.document.activeElement, input, '焦点仍要落在输入框');
    assert.equal(restoredRange, 'RANGE-BEFORE-FOCUS', '聚焦前的那段选区必须原样还回去（否则橙色高亮会消失）');
  } finally { dom.restore(); }
});

test('焦点: deliverFocus 在「用户已经点去别处打字」时不抢（只在补救阶段让位）', async () => {
  const { mod, dom } = await loadOverlayModule();
  try {
    const root = new FakeElement('section');
    root.setAttribute('data-surface', 'ready');
    const input = new FakeElement('textarea');
    const ctx = { pendingFocus: true, input, root };
    // 第一次投递是强制的：用户点了「?」，宿主的焦点通常还停在主对话里 —— 必须拿过来
    const composer = new FakeElement('div');
    composer.isContentEditable = true;
    dom.document.activeElement = composer;
    mod.deliverFocus(ctx, 0);
    assert.equal(dom.document.activeElement, input, '打开这一刻必须无条件拿到焦点（否则「点开就能输入」永远不成立）');
    assert.equal(ctx.pendingFocus, false);
  } finally { dom.restore(); }
});
