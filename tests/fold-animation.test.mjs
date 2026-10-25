import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 「展开全文 / 收起」的高度动画（用户 2026-10-25：「优化展开全文和收起的动画，一定要精心制作」）。
 *
 * 要解决的是旧行为：点一下，整轮节点被重画、正文在一帧之内从 220px 变成整段高度
 * （或反过来）——看起来像被人猛拽一把，还夹着一次「展开全文 / 收起」的文字突变。
 *
 * 现在的做法：点击时先量下此刻的高度存进 ctx.foldAnim，重画之后由 playFoldAnimation
 * 从这一高度补间到目标高度，同时把底部渐隐化开、把按钮淡入。
 *
 * 本文件钉的是**这条链真的接通了**（点一下 → 真的调用了一次 height 补间，方向与起止值都对），
 * 以及两条不能破的边界：无关重画不许播动画、用户要减少动效时一律不补间。
 * 曲线好不好看、快慢是否合适，只有真机截图/录像能判断，不在本文件的射程内。
 */

const overlay = await moduleFromSource('src/client/overlay.tsx');
const longAnswer = '很长的回答，用来触发折叠。'.repeat(40);

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

/** 给假 DOM 补上「高度」与 WAAPI：折叠态 220px、展开态 900px，补间调用全部记下来。 */
function installAnimationProbe() {
  const calls = [];
  Object.defineProperty(FakeElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return String(this.className || '').split(' ').includes('ea-turn-a') ? (this.getAttribute('data-folded') === 'true' ? 220 : 900) : 0 },
  });
  Object.defineProperty(FakeElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return String(this.className || '').split(' ').includes('ea-turn-a') ? 900 : 0 },
  });
  FakeElement.prototype.animate = function animate(frames, options) {
    calls.push({ node: this, frames, options });
    return { finished: Promise.resolve(), cancel() {} };
  };
  return calls;
}

function records() {
  return [
    { id: 'r1', question: '第一个问题', answerText: longAnswer, status: 'complete', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'r2', question: '第二个问题', answerText: '短回答', status: 'complete', createdAt: '2026-01-01T00:01:00.000Z' },
  ];
}

/** 只关心那一次 height 补间（按钮淡入也是一次 animate 调用，别混进来）。 */
function heightCalls(calls) {
  return calls.filter(call => call.frames && call.frames[0] && typeof call.frames[0].height === 'string');
}

test('展开全文: 从折叠高度补间到整段高度，方向与起止值都对', () => withDom(async () => {
  const calls = installAnimationProbe();
  const plugin = pluginSpy();
  const base = state({ records: records() });
  const root = overlay.renderOverlay(base, plugin);
  const toggle = root.querySelector('.ea-turn-more');
  assert.ok(toggle, '长回答必须给出「展开全文」');
  assert.equal(toggle.textContent, '展开全文');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', '收起状态下 aria-expanded 必须是 false');
  toggle.click();
  const anims = heightCalls(calls);
  assert.equal(anims.length, 1, '点一次只该有一次高度补间');
  assert.deepEqual(anims[0].frames, [{ height: '220px' }, { height: '900px' }], '必须从折叠高度补间到整段高度');
  assert.equal(anims[0].options.easing, 'cubic-bezier(.16,1,.3,1)', '展开用 emphasized-decelerate（快起慢收）');
  assert.ok(anims[0].options.duration >= 220 && anims[0].options.duration <= 640, '时长必须落在 220–640ms：' + anims[0].options.duration);
  assert.equal(anims[0].options.fill, 'none', 'fill:none：动画结束就交还给 CSS，不留内联高度');
}));

test('收起: 从整段高度补间回折叠高度，且遮罩最后才收拢', () => withDom(async () => {
  const calls = installAnimationProbe();
  const plugin = pluginSpy();
  const base = state({ records: records() });
  const root = overlay.renderOverlay(base, plugin);
  root.querySelector('.ea-turn-more').click();       // 先展开
  calls.length = 0;
  const collapse = root.querySelector('.ea-turn-more');
  assert.equal(collapse.textContent, '收起');
  assert.equal(collapse.getAttribute('aria-expanded'), 'true', '展开之后 aria-expanded 必须变成 true（读屏用户看不到高度变化）');
  collapse.click();
  const anims = heightCalls(calls);
  assert.equal(anims.length, 1, '收起同样只该有一次高度补间');
  assert.deepEqual(anims[0].frames, [{ height: '900px' }, { height: '220px' }], '必须从整段高度收回到折叠高度');
  assert.equal(anims[0].options.easing, 'cubic-bezier(.4,0,.2,1)', '收起用 emphasized-accelerate（慢起快收）');
}));

test('边界: 无关重画不许播动画（只有点了展开/收起才补间）', () => withDom(async () => {
  const calls = installAnimationProbe();
  const plugin = pluginSpy();
  const base = state({ records: records() });
  const root = overlay.renderOverlay(base, plugin);
  calls.length = 0;
  // 流式回答期间的那种重画：与折叠无关
  overlay.updateOverlay(root, state({ records: records(), text: '正在写…' }), plugin);
  overlay.updateOverlay(root, state({ records: records(), text: '写完了' }), plugin);
  assert.deepEqual(heightCalls(calls), [], '没人点按钮就不许自作主张播高度动画');
}));

test('边界: 用户要求减少动效时不补间（直接落到终态）', () => withDom(async () => {
  const calls = installAnimationProbe();
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  try {
    const plugin = pluginSpy();
    const base = state({ records: records() });
    const root = overlay.renderOverlay(base, plugin);
    root.querySelector('.ea-turn-more').click();
    assert.deepEqual(heightCalls(calls), [], 'prefers-reduced-motion: reduce 时不许播高度动画');
    const turn = root.querySelectorAll('.ea-turn').find(node => node.getAttribute('data-record-id') === 'r1');
    const answer = turn.querySelector('.ea-turn-a');
    assert.equal(answer.getAttribute('data-folded'), 'false', '不补间也要落到正确的终态');
  } finally {
    if (previous === undefined) delete globalThis.matchMedia; else globalThis.matchMedia = previous;
  }
}));

test('样式: 渐隐宽度必须可过渡（@property 注册），动画期间要放开 max-height', () => {
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  assert.match(css, /@property --ea-fold-fade\{syntax:'<length>'/, '--ea-fold-fade 必须注册成 <length>，否则过渡不会发生');
  const folded = /\.ea-turn-a\[data-folded="true"\]\{[^}]*\}/.exec(css);
  assert.ok(folded, '折叠规则必须还在');
  assert.match(folded[0], /max-height:var\(--ea-fold-height/, '折叠高度走变量，JS 才不会和 CSS 各写一个 220');
  assert.match(folded[0], /var\(--ea-fold-fade\)/, '折叠时的渐隐宽度必须走变量，才能和展开动画接上');
  const anim = /\.ea-turn-a\[data-fold-anim\]\{[^}]*\}/.exec(css);
  assert.ok(anim, '必须有一条专门给动画期间用的规则');
  assert.match(anim[0], /max-height:none/, '动画期间必须放开 max-height，否则收起时高度被 220 压住、画面不动');
  assert.match(anim[0], /transition:--ea-fold-fade/, '动画期间要过渡渐隐宽度');
});

test('就地展开: 之后的无关重画不得把这一轮重挂（动画不能被换掉、滚动锚点也不能丢）', () => withDom(async () => {
  installAnimationProbe();
  const plugin = pluginSpy();
  const base = state({ records: records() });
  const root = overlay.renderOverlay(base, plugin);
  const turnOf = () => root.querySelectorAll('.ea-turn').find(node => node.getAttribute('data-record-id') === 'r1');
  const before = turnOf().querySelector('.ea-turn-a');
  root.querySelector('.ea-turn-more').click();
  const after = turnOf().querySelector('.ea-turn-a');
  assert.equal(after, before, '就地切换不该换节点（换了就没有补间，也没有滚动锚点）');
  assert.equal(after.getAttribute('data-folded'), 'false');
  // 模拟流式期间的一次无关重画：签名已经同步过，历史区必须原地不动
  overlay.updateOverlay(root, state({ records: records(), text: '正在写…' }), plugin);
  assert.equal(turnOf().querySelector('.ea-turn-a'), before, '无关重画不得重挂这一轮');
  assert.equal(turnOf().querySelector('.ea-turn-a').getAttribute('data-folded'), 'false', '展开态必须留着');
  assert.equal(turnOf().querySelector('.ea-turn-more').textContent, '收起', '按钮文字必须还是「收起」');
}));
