import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fakeDom, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 使用教程页（用户要求：「增加一个使用教程页面，内容编排精心设计」）。
 *
 * 测试不追求"页面上有几个字"，而是钉住编排本身：
 * 三条边界 → 三步上手 → 依据分级 → 按钮表 → 键盘 → 上下文 → 问答。
 * 少一节就等于告诉用户"这功能不存在"，所以逐节断言。
 */

const base = {
  sessionId: 's', open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
  tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [],
  occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: true, stateReady: true,
};

async function render(state = base) {
  const submitted = [];
  const plugin = { registry: { update() {}, get: () => state, close() {} }, api: {}, cancel() {}, loadEarlier() {}, submit: q => { submitted.push(q); return Promise.resolve() } };
  const overlay = await moduleFromSource('src/client/overlay.tsx');
  const root = overlay.renderOverlay({ ...state, open: true }, plugin);
  return { root, submitted, overlay, plugin };
}

function byClass(root, cls) { return root.querySelector('.' + cls); }
function texts(root) { return root.textContent.replace(/\s+/g, ' ') }

test('标题栏「?」按钮打开教程页（data-view 切到 tutorial）', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render();
    const trigger = byClass(root, 'ea-tutorial-trigger');
    assert.ok(trigger, '标题栏必须有「?」教程入口');
    assert.equal(trigger.textContent, '?', '图标就是问号，不占文字宽度（标题栏已经挤满）');
    assert.equal(root.getAttribute('data-view'), 'chat');
    trigger.emit('click');
    assert.equal(root.getAttribute('data-view'), 'tutorial', '点开必须切到教程页');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.ok(byClass(root, 'ea-tutorial-panel'), '教程页必须真的渲染出来');
  } finally { dom.restore(); }
});

test('教程内容九节齐全（不是一段占位文字）', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render();
    byClass(root, 'ea-tutorial-trigger').emit('click');
    const all = texts(root);
    const must = [
      ['先说三条边界', '只读', '不独立干活', '信息不足'],
      ['三步上手', '选择主对话内容', 'Ctrl', 'Enter 发送'],
      ['依据分级', '已观察到', '仅据汇报'],
      ['标题栏那几颗按钮', '模型', '/compact', '关闭（Esc）'],
      ['键盘', 'Shift', 'Esc', '⌘'],
      ['上下文与占用', '估算', '圆环'],
      ['常见问题', '会不会动我的文件或命令', '会不会花我很多 token'],
      ['v0.3.0', '回到对话'],
    ];
    for (const group of must) {
      for (const needle of group) {
        assert.ok(all.includes(needle), '教程里缺少「' + needle + '」这一节/这句');
      }
    }
  } finally { dom.restore(); }
});

test('常见问答每条都有「问它一句」，点了就真的把问题发出去并回到对话', async () => {
  const dom = fakeDom();
  try {
    const { root, submitted } = await render();
    byClass(root, 'ea-tutorial-trigger').emit('click');
    const asks = root.querySelectorAll('.ea-tut-ask');
    assert.ok(asks.length >= 4, '每条常见问答都要带「问它一句」，实际：' + asks.length);
    asks[0].emit('click');
    assert.equal(submitted.length, 1, '点「问它一句」必须真的把问题提交出去');
    assert.match(submitted[0], /信息不足/, '提交的应当就是这一条问题本身');
    assert.equal(root.getAttribute('data-view'), 'chat', '问完必须回到对话页（不然看不到回答）');
  } finally { dom.restore(); }
});

test('返回按钮与 Esc 都能回对话页', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render();
    byClass(root, 'ea-tutorial-trigger').emit('click');
    byClass(root, 'ea-tut-back').emit('click');
    assert.equal(root.getAttribute('data-view'), 'chat', '「返回对话」必须回得去');
    byClass(root, 'ea-tutorial-trigger').emit('click');
    root.emit('keydown', { key: 'Escape' });
    assert.equal(root.getAttribute('data-view'), 'chat', 'Esc 必须先关教程页（不是直接关浮窗）');
  } finally { dom.restore(); }
});

test('首次引导里也有教程入口（第一次用的人不会去点标题栏那排按钮）', async () => {
  const dom = fakeDom();
  try {
    const { root } = await render();
    const entry = byClass(root, 'ea-hero-tutorial');
    assert.ok(entry, '空会话的引导里必须有教程入口');
    assert.match(entry.textContent, /教程/);
    entry.emit('click');
    assert.equal(root.getAttribute('data-view'), 'tutorial');
  } finally { dom.restore(); }
});

test('样式契约：教程页复用同一套翻页动效，且输入区在教程页隐藏', async () => {
  const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.ea-overlay\[data-view=tutorial\] \.ea-composer\{visibility:hidden\}/, '教程页必须把输入区藏起来（否则用户会对着一个看不见的输入框打字）');
  assert.match(css, /\.ea-overlay\[data-view=tutorial\] \.ea-tutorial-panel\{animation:ea-page-in/, '必须复用同一套翻页动效，别做成另一套语言');
  assert.match(css, /\.ea-tutorial-panel\[data-closing=true\]\{animation:ea-page-out/, '退场同样要先播完再摘');
});
