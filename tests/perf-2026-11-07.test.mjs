import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * 2026-11-07 卡顿专项的回归闸。
 *
 * 用户原话：「小助手在拉伸、选中文字和输入文字时会有卡顿」。
 * 三条各自独立归因（实测数字见 README 的「性能」一节），这里钉的是
 * **改回旧写法就必然变红**的那几句判据 —— 不是「改了一行」本身。
 */

const read = relative => readFile(new URL('../' + relative, import.meta.url), 'utf8');

/* ============ 输入：一次刷新只准强制一次布局 ============ */

test('输入: 三个高频事件必须合并到一帧一次（input/selectionchange/keyup 不得各刷一次）', async () => {
  const src = await read('src/client/text-field.ts');
  assert.match(src, /function scheduleRefresh\(\): void/, '必须有「合并到 rAF」的入口');
  // 旧写法：input / keyup / compositionend 直接挂 refresh —— 打一个字刷新 3 次，每次 2~4 次强制布局。
  assert.equal(/\[input, 'input', refresh as EventListener\]/.test(src), false, 'input 不得直连 refresh');
  assert.match(src, /\[input, 'input', scheduleRefresh as EventListener\]/, 'input 必须走 scheduleRefresh');
  assert.match(src, /\[document, 'selectionchange', onSelectionChange as EventListener\]/, 'selectionchange 仍要监听');
  assert.match(src, /if \(document\.activeElement === input\) scheduleRefresh\(\)/, 'selectionchange 也必须合并');
});

test('输入: 读阶段先写一次镜面、再一次性量完（不许边写边读）', async () => {
  const src = await read('src/client/text-field.ts');
  const snap = src.match(/function snapshot\(\)[\s\S]{0,600}?\n  \}/);
  assert.ok(snap, '必须有 snapshot（读阶段）');
  const body = snap[0];
  const iWrite = body.indexOf('syncMirrorText()');
  const iHeight = body.indexOf('measureHeight()');
  const iFrame = body.indexOf('root.getBoundingClientRect()');
  assert.ok(iWrite >= 0 && iHeight > iWrite && iFrame > iHeight, '顺序必须是：写镜面 → 量高度 → 量根矩形（都在同一份干净布局上）');
});

test('输入: 光标/选区块走 transform，不再每帧改 left/top（布局属性）', async () => {
  const src = await read('src/client/text-field.ts');
  assert.equal(/writeStyle\(caret, 'left'/.test(src), false, '光标不得再写 left');
  assert.match(src, /writeStyle\(caret, 'transform', 'translate3d\(/, '光标位置必须走 transform');
  assert.match(src, /writeStyle\(box\.el, 'transform'/, '选区块位置必须走 transform');
});

test('输入: 草稿走 updateDraft 快通道，且它不通知渲染', async () => {
  const store = await read('src/client/store.ts');
  const m = store.match(/updateDraft\(sessionId: SessionId, draft: string\): void \{[\s\S]{0,400}?\n  \}/);
  assert.ok(m, '必须有 updateDraft');
  assert.equal(/this\.emit\(\)/.test(m[0]), false, 'updateDraft 不得触发重画（草稿不进渲染树）');
  const overlay = await read('src/client/overlay.tsx');
  assert.match(overlay, /registry\.updateDraft\(current\.state\.sessionId, input\.value\)/, '输入框必须走快通道');
});

test('输入: 支持 field-sizing 的浏览器不再用 JS 量高度', async () => {
  const src = await read('src/client/text-field.ts');
  assert.match(src, /CSS\.supports\('field-sizing', 'content'\)/, '必须特性探测');
  assert.match(src, /function measureHeight\(\): number \{\s*if \(fieldSizing\) return 0/, '支持时一个字都不量');
  const css = await read('src/client/styles.css');
  assert.match(css, /\.ea-input\{[\s\S]{0,400}?field-sizing:content/, '.ea-input 必须声明 field-sizing');
});

/* ============ 选中：贵读缓存 + 打字时不醒 ============ */

test('选中: 沿祖先链的贵读必须缓存（clipRectOf / coveredByPaint / 原点）', async () => {
  const src = await read('src/client/page-selection.ts');
  assert.match(src, /function clipRectOfUncached/, 'clipRectOf 必须是「缓存 + 未缓存」两段');
  assert.match(src, /clipCache && clipCache\.key === key/, 'clipRectOf 必须命中缓存');
  assert.match(src, /function coveredByPaintUncached/, 'coveredByPaint 必须缓存');
  assert.match(src, /let originCache/, '高亮层原点必须缓存（每帧 getBoundingClientRect 等于每帧一次强制布局）');
  assert.match(src, /if \(snap\) \{\s*pendingSnap = true[\s\S]{0,300}?originCache = null/, '滚动/缩放必须让几何缓存失效');
});

test('选中: 在输入框里打字不得唤醒正文高亮引擎', async () => {
  const src = await read('src/client/page-selection.ts');
  const m = src.match(/const onSelectionChange = \(\) => \{[\s\S]{0,400}?\n  \}/);
  assert.ok(m, '必须有 onSelectionChange');
  assert.match(m[0], /closest\?\.\('\.ea-field'\)/, '必须先判 activeElement 是否在输入框里');
  assert.match(m[0], /return/, '在输入框里要直接返回');
});

test('选中: 块样式只在值变化时写（拖选时绝大多数块是静止的）', async () => {
  const src = await read('src/client/page-selection.ts');
  assert.match(src, /if \(block\.lx !== tx \|\| block\.lw !== tw\)/, 'transform/宽度必须比对后再写');
  assert.match(src, /if \(block\.lo !== op\)/, '不透明度必须比对后再写');
});

/* ============ 拉伸：拖动期间给绘制让路 ============ */

test('拉伸: 拖动期间关掉毛玻璃与大投影（每一帧都要重新栅格化它们）', async () => {
  const css = await read('src/client/styles.css');
  const rule = css.match(/\.dsh-explain-assistant-overlay\[data-resizing=true\]\{[\s\S]{0,600}?\n\}/);
  assert.ok(rule, '必须有 [data-resizing=true] 的降级规则');
  assert.match(rule[0], /backdrop-filter:none!important/, '必须真的关掉毛玻璃（深色主题那条特异性更高，不加 !important 关不掉）');
  assert.match(rule[0], /box-shadow:0 8px 20px/, '投影必须降级成小半径');
  assert.match(rule[0], /background:var\(--ea-glass-pane\)/, '关掉模糊后要给实底，否则背后的字会清晰地透上来');
});

test('拉伸: 拖动期间不量正文高度、不重算镜面（尺寸稳定后再补一次）', async () => {
  const overlay = await read('src/client/overlay.tsx');
  assert.match(overlay, /scheduleBodyMeasure/, '正文高度必须合并到一帧一次');
  assert.match(overlay, /root\.getAttribute\('data-resizing'\) === 'true'/, '拖动中必须跳过');
  const tf = await read('src/client/text-field.ts');
  assert.match(tf, /function whenResizeSettled/, '输入框必须等尺寸稳定再量');
  assert.match(tf, /whenResizeSettled\(scheduleRefresh\)/, 'ResizeObserver 必须走 whenResizeSettled');
});
