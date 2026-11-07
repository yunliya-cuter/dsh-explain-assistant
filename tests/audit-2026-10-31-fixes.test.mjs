import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 2026-10-31 全量审计的修复回归。
 *
 * 每条都对应一个**用户能看见的症状**，而不是"改了一行"这件事本身：
 * 写断言时刻意选的是「改回旧写法就必然变红」的那句判据（见每条的注释）。
 * 用户裁定的 E-1（空输入点发送无反应）**不在**这里：那是既不修、也不锁行为的一条。
 */

const readSource = relative => readFile(new URL('../' + relative, import.meta.url), 'utf8');

/* ============ I-1 光标错位：镜面宽度必须与输入框内容盒同宽 ============ */

test('I-1: 镜面宽度取 clientWidth（不含滚动条），不是 offsetWidth', async () => {
  const source = await readSource('src/client/text-field.ts');
  // 旧写法 mirror.style.width = input.offsetWidth —— 输入框滚起来后右侧 15px 是滚动条，
  // 镜面却按含滚动条的宽度排版 → 换行点不同 → 实测 6.9%–12.5% 的插入点落到错误的行（最大偏差一整行）。
  assert.match(source, /mirror\.style\.width = input\.clientWidth/, '镜面宽度必须是 clientWidth');
  assert.equal(/mirror\.style\.width = input\.offsetWidth/.test(source), false, '不得再用 offsetWidth（那会把滚动条也算进可用宽度）');
});

test('I-1: 输入框/浮窗尺寸变化必须重算镜面（拖边改宽不会触发 window.resize）', async () => {
  const source = await readSource('src/client/text-field.ts');
  assert.match(source, /ResizeObserver/, '必须观察输入框尺寸变化');
  assert.match(source, /sizeObserver\?\.observe\(input\)/, '观察目标必须是输入框本身');
  assert.match(source, /fonts\?\.ready/, '字体晚到会改变换行点，必须再量一次');
});

/* ============ I-2 / I-3 光标：有选区时藏起来；移动后重置闪烁 ============ */

test('I-2: 有选区时必须把光标藏起来（原件 hasSelection → hideInstant）', async () => {
  const source = await readSource('src/client/text-field.ts');
  assert.match(source, /if \(hasSelection\(\)\) \{\s*hideCaret\(\)/, '有选区时 paintCaret 必须先 hideCaret 再返回');
  assert.match(source, /function hideCaret\(\): void {[\s\S]{0,200}caret\.style\.opacity = '0'/, 'hideCaret 必须把不透明度归零');
});

test('I-3: 每次移动都要重置闪烁静默期（否则打字时一直在闪）', async () => {
  const source = await readSource('src/client/text-field.ts');
  assert.match(source, /restartBlink\(\)/, '必须存在「重新计时」的入口');
  assert.match(source, /if \(caretVisible && !hasSelection\(\)\) restartBlink\(\)/, 'refresh 里每次都要重置');
  assert.equal(/scheduleBlink\(\)\n/.test(source), false, '旧的一次性 scheduleBlink 不得留在首次出现分支里');
});

/* ============ S-1 / S-3 选区：画不了就交还原生 ============ */

test('S-1: 矩形数超过上限时必须退回原生选中色，不能只画前 24 个', async () => {
  const source = await readSource('src/client/page-selection.ts');
  // 2026-11-07：高亮层改挂进滚动容器后要覆盖「屏内 + 上下各一屏」的预取窗口，
  // 块数上限随之上调到 160（见 page-selection.ts 的说明）。这里断言的是「有上限且会切原生」。
  assert.match(source, /const MAX_BLOCKS = 160/, '块数上限必须是有限值（160）：超了要退回原生选中色');
  assert.match(source, /if \(overflowed \|\| covered\) \{\s*setNative\(true\)/, '撞上上限（或高亮被底色盖住）必须切原生');
  assert.match(source, /root\.removeAttribute\('data-page-selection'\)/, '切原生时要摘掉自检属性，让浏览器原生选中色回来');
});

test('S-3: 选区被不透明底色盖住时必须退回原生（否则一个像素都看不见）', async () => {
  const source = await readSource('src/client/page-selection.ts');
  assert.match(source, /function coveredByPaint/, '必须有"被底色盖住"的判据');
  // 判据必须沿着**落在浮窗里面**的那一端往上找：跨出浮窗的选区 commonAncestor 是 body，
  // 而 body 必然有自己的底色 —— 拿它判断会把"从内到外拖选"整段判成被遮挡。
  assert.match(source, /inside\(range\.startContainer\)/, '锚点必须落在浮窗里面');
  assert.match(source, /const covered = ranges\.some\(range => coveredByPaint\(range\)\)/, '逐 range 判断');
});

test('S-2: 跨出浮窗边界的选区必须继续画（只裁剪，不整段丢弃）', async () => {
  const source = await readSource('src/client/page-selection.ts');
  assert.match(source, /range\.intersectsNode\(root\)/, '判定必须是"相交"而不是"包含"');
  assert.equal(/if \(!root\.contains\(elNode\)\) continue/.test(source), false, '不得再整段丢弃');
});

/* ============ S-4 减少动态：运行中切换两个方向都要生效 ============ */

test('S-4: prefers-reduced-motion 必须监听 change（两个方向都切回对应的一套）', async () => {
  for (const file of ['src/client/text-field.ts', 'src/client/page-selection.ts']) {
    const source = await readSource(file);
    assert.match(source, /addEventListener\?\.\('change', onMotionChange\)/, file + ' 必须监听 change');
    assert.match(source, /removeEventListener\?\.\('change', onMotionChange\)/, file + ' 必须在 destroy 里解绑');
  }
});

/* ============ R-1 跟随：判据是位置，不是 160ms 时间窗 ============ */

test('R-1: 「自己滚的」判据必须是位置，不能是最近 160ms 有过写入', async () => {
  const source = await readSource('src/client/overlay.tsx');
  assert.match(source, /ctx\.programmaticTop = ctx\.followPos/, '写 scrollTop 时必须记下写出去的位置');
  assert.match(source, /Math\.abs\(\(node\.scrollTop \?\? 0\) - current\.programmaticTop\) <= 2/, 'scroll 事件必须按位置比对');
  assert.equal(/programmaticScrollAt/.test(source), false, '时间窗判据必须彻底删掉（流式期间它永远不空）');
});

/* ============ R-2 模型页与教程页互斥 ============ */

test('R-2: 两个整页必须互斥，关闭时 data-view 按仍打开的那一页决定', async () => {
  const source = await readSource('src/client/overlay.tsx');
  assert.match(source, /function openModelPanel[\s\S]{0,400}?if \(ctx\.tutorialOpen\) closeTutorial/, '打开模型页必须先关教程页');
  assert.match(source, /function openTutorial[\s\S]{0,400}?if \(ctx\.modelOpen\) closeModelPanel/, '打开教程页必须先关模型页');
  assert.match(source, /setAttribute\('data-view', ctx\.tutorialOpen \? 'tutorial' : 'chat'\)/, '关模型页时不能无条件写 chat');
});

/* ============ I-6 组字时 Esc 不得关窗 ============ */

test('I-6: 输入法组字时的 Esc 是取消候选词，不得关窗', async () => {
  const source = await readSource('src/client/overlay.tsx');
  // 2026-11-07：Esc 处理器从 root 移到 document（B4），判据形态不变。
  assert.match(source, /const onDocumentKeyDown = \(event: KeyboardEvent\)[\s\S]{0,800}?if \(composing \|\| event\.isComposing \|\| legacyIme\) return/, 'Esc 分支必须判 IME 状态');
});

/* ============ H-8 证据截断要留痕 ============ */

test('H-8: 摘要被截到 4000 字时 truncated 必须是 true', async () => {
  const selection = await moduleFromSource('src/client/selection.ts');
  const { FakeElement } = await import('./fixtures/runtime.mjs');
  const node = new FakeElement('div');
  node.setAttribute('data-chat-node-key', 'n1');
  node.textContent = 'x'.repeat(5000);
  const item = selection.evidenceFromElement(node, 's');
  assert.equal(item.summary.length, 4000, '摘要仍截到 4000');
  assert.equal(item.truncated, true, '截断必须留痕（以前写死 false，用户和模型都以为依据完整）');

  const short = new FakeElement('div');
  short.setAttribute('data-chat-node-key', 'n2');
  short.textContent = 'short';
  assert.equal(selection.evidenceFromElement(short, 's').truncated, false, '没截断时不得误报');
});

/* ============ M-1 登录失效：中文、可操作、不吐 HTML ============ */

test('M-1: 401 + HTML 登录页 → 中文提示，不把 HTML 塞进界面', async () => {
  const api = await moduleFromSource('src/client/api.ts');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html><body>login</body></html>', { status: 401, headers: { 'content-type': 'text/html' } });
  try {
    const client = api.createAssistantApi();
    await assert.rejects(() => client.state('s'), error => {
      assert.equal(error.code, 'UNAUTHORIZED', '错误码必须是 UNAUTHORIZED');
      assert.match(error.message, /登录状态已失效/, '必须是中文、可操作');
      assert.equal(/<html>/.test(error.message), false, '不得把 HTML 原文塞进用户文案');
      return true;
    });
  } finally { globalThis.fetch = original; }
});

/* ============ W-1 切会话：浮窗跟着当前会话走 ============ */

test('W-1: 切主对话时浮窗状态迁移（不消失，也不留旧会话的 open）', async () => {
  const client = await moduleFromSource('src/client/index.ts');
  const api = { state: async () => ({ payload: {} }), markRead: async () => ({}), forget: async () => ({}) };
  const plugin = client.createClientPlugin({ api, session: { id: 'a' } });
  try {
    plugin.setSession('a');
    plugin.open();
    assert.equal(plugin.registry.get('a').open, true, '前置：A 打开');
    plugin.setSession('b');
    assert.equal(plugin.registry.get('a').open, false, '切走后 A 必须关掉（否则切回来会自己冒出来）');
    assert.equal(plugin.registry.get('b').open, true, 'B 必须接着开（否则切走浮窗就消失了）');
    plugin.setSession('a');
    assert.equal(plugin.registry.get('a').open, true, '切回来仍然开着');
    assert.equal(plugin.registry.get('b').open, false, 'B 必须关掉');
  } finally { plugin.dispose(); }
});

/* ============ H-1 占用补取：必须有次数上限 ============ */

test('H-1: occupancyPending 常为 true 时，自动补取必须有上限（不能每 3 秒无限轮询）', async () => {
  const source = await readSource('src/client/index.ts');
  assert.match(source, /occupancyRetryMax/, '必须有次数上限的配置');
  assert.match(source, /const used = occupancyRefreshAttempts\.get\(sessionId\) \?\? 0;\s*if \(used >= \(options\.occupancyRetryMax \?\? 2\)\) return;/, '超过上限必须直接返回');
});

/* ============ H-4 归档是终态 ============ */

test('H-4: 归档后迟到的 /state 与 SSE 事件都不得把记录写回来', async () => {
  const source = await readSource('src/client/index.ts');
  assert.match(source, /if \(assistantRegistry\.get\(sessionId\)\.archived === true\) return;/, 'refreshState 必须挡归档会话');
  assert.match(source, /if \(state\.archived === true\) return;/, 'applyEvent 必须挡归档会话');
  assert.match(source, /const running = active\.get\(sessionId\);\s*if \(running\) \{\s*running\.stoppedByUser = true;/, 'forget 必须掐掉在途请求');
});

/* ============ 可读性：对比度与焦点环 ============ */

test('P-1/P-2: 低对比度的宿主 token 不得直接用于小字号正文', async () => {
  const css = await readSource('src/client/styles.css');
  assert.equal(/var\(--dsw-alias-state-warn-primary/.test(css), false, '警告色不得直接用宿主 token（浅色 2.06:1）');
  assert.equal(/var\(--dsw-alias-label-tertiary/.test(css), false, '三级文字不得直接用宿主 token（浅色 3.59:1）');
  assert.match(css, /--ea-warn:#a15c00/, '浅色警告色必须是算过的深色版');
  assert.match(css, /--ea-text-tertiary:#6b7075/, '浅色三级文字必须是算过的深色版');
});

test('P-3: 焦点环要有 3:1 以上的对比度，且 :has() 不支持时仍要看得见焦点', async () => {
  const css = await readSource('src/client/styles.css');
  assert.match(css, /@supports selector\(:has\(\*\)\)/, 'outline:none 必须包在 @supports 里');
  assert.match(css, /inset 0 0 0 2px var\(--dsw-alias-button-primary-fill/, '焦点环必须是品牌色 2px（旧的 rgba(0,0,0,.18) 只有 1.53:1）');
});
