import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 入口按钮：**忙碌态的门控** + **动效只动该动的属性**。
 *
 * 为什么单独一个文件：
 * 1. 忙碌态在正常宿主下只持续几十毫秒。直接画出来就是"闪一下"——这一轮用户已经为
 *    三处同类的"闪"提过意见（生成完闪一下 / 停止突然闪出 / 切会话闪跳），所以
 *    「延迟 150ms 出现 + 出现后至少 300ms」是**产品约束**，必须有断言钉住；
 * 2. 动效一旦用了 width/height/top/left 或对 1px 描边做 scale，就会重排/发虚。
 *    CSS 里的这些约束在真实浏览器里肉眼才看得出，用文本断言先兜住底线。
 */

const gate = await moduleFromSource('src/client/busy-gate.ts');

/** 可推进的假时钟（按到期时间排序执行，同刻按创建顺序）。 */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const tasks = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; tasks.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    now() { return now; },
    get pending() { return tasks.size; },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((a, b) => (a[1].at - b[1].at) || (a[0] - b[0]))[0];
        if (!due) break;
        tasks.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

test('忙碌门控: /state 很快就回来（40ms）时，一个像素都不画', () => {
  const timers = fakeTimers();
  const seen = [];
  const g = gate.createBusyGate(timers, v => seen.push(v));
  g.set(true);
  timers.advance(40);          // 正常宿主：/state 已回来
  g.set(false);
  timers.advance(2000);
  assert.deepEqual(seen, [], '40ms 就结束的忙碌不得画出来（否则就是"闪一下"）');
  assert.equal(g.visible, false);
});

test('忙碌门控: 慢宿主下 150ms 后出现（不是立刻，也不是永不）', () => {
  const timers = fakeTimers();
  const seen = [];
  const g = gate.createBusyGate(timers, v => seen.push(v));
  g.set(true);
  timers.advance(149);
  assert.equal(g.visible, false, '149ms 时还不该出现');
  timers.advance(2);
  assert.equal(g.visible, true, '150ms 后必须出现（慢宿主需要持续的反馈）');
  assert.deepEqual(seen, [true]);
});

test('忙碌门控: 出现后至少停留 300ms，避免"刚画出来就被撤掉"', () => {
  const timers = fakeTimers();
  const seen = [];
  const g = gate.createBusyGate(timers, v => seen.push(v));
  g.set(true);
  timers.advance(150);          // 此刻出现（shownAt=150）
  assert.equal(g.visible, true);
  timers.advance(50);           // t=200，/state 回来了
  g.set(false);
  assert.equal(g.visible, true, 't=200 时还不到 300ms，不得立刻撤掉');
  timers.advance(249);          // t=449
  assert.equal(g.visible, true, 't=449 仍在最短停留窗口内');
  timers.advance(1);            // t=450 = 150 + 300
  assert.equal(g.visible, false, '满 300ms 后必须撤掉');
  assert.deepEqual(seen, [true, false]);
});

test('忙碌门控: 忙碌再次开始会取消待执行的撤下（不会中途抖一下）', () => {
  const timers = fakeTimers();
  const seen = [];
  const g = gate.createBusyGate(timers, v => seen.push(v));
  g.set(true);
  timers.advance(200);
  g.set(false);                 // 计划在 450 撤下
  timers.advance(100);
  g.set(true);                  // t=300 又忙了
  timers.advance(2000);
  assert.equal(g.visible, true, '重新变忙后必须保持可见');
  assert.deepEqual(seen, [true], '整个过程只应有一次"变为可见"');
});

test('忙碌门控: dispose 之后不再回调，也不留计时器', () => {
  const timers = fakeTimers();
  const seen = [];
  const g = gate.createBusyGate(timers, v => seen.push(v));
  g.set(true);
  timers.advance(200);
  assert.deepEqual(seen, [true]);
  g.dispose();
  assert.equal(timers.pending, 0, 'dispose 必须清掉所有计时器');
  timers.advance(5000);
  assert.deepEqual(seen, [true], 'dispose 后不得再回调');
  assert.doesNotThrow(() => g.set(true), 'dispose 后再 set 不得抛');
});

/* ================================================================== *
 * CSS 约束：只动 transform/opacity/color，且尊重 reduced-motion
 * ================================================================== */

const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8');
const section = (() => {
  const start = css.indexOf('/* ---------- 入口按钮');
  assert.ok(start >= 0, 'styles.css 必须有一段专门写入口按钮的样式');
  return css.slice(start);
})();

test('入口按钮 CSS: 状态靠 data 属性切换（不换节点、不靠文字）', () => {
  assert.match(section, /\.ea-hbtn-btn\[data-unread="true"\] \.ea-hbtn-dot/, '未读点必须由 data-unread 驱动');
  assert.match(section, /\.ea-hbtn-btn\[data-busy="true"\] \.ea-hbtn-ring/, '忙碌弧必须由 data-busy 驱动');
  assert.match(section, /\.ea-hbtn-btn\[data-busy="true"\] \.ea-hbtn-glyph/, '忙碌时气泡必须让位给弧');
});

test('入口按钮 CSS: 只动 opacity / color / transform，不动布局属性', () => {
  const declarations = [...section.matchAll(/transition:\s*([^;}]+)/g)].map(m => m[1]).join(' ');
  for (const forbidden of ['width', 'height', 'top', 'left', 'right', 'margin', 'padding', 'font-size']) {
    assert.equal(new RegExp('(^|[,\\s])' + forbidden + '\\b').test(declarations), false,
      '过渡里不得出现 ' + forbidden + '（会重排/抖动）：' + declarations);
  }
  assert.match(section, /transition:[^;}]*opacity/, '至少要有透明度过渡');
});

test('入口按钮 CSS: hover 不用 scale（1px 描边缩开会发虚），且 reduced-motion 有降级', () => {
  assert.equal(/\.ea-hbtn-btn:hover[^{]*\{[^}]*transform\s*:\s*scale/.test(section), false,
    'hover 不得对图标做 scale：1px 描边缩到 0.94 会被抗锯齿摊成灰边');
  assert.match(section, /@media\s*\(prefers-reduced-motion:reduce\)/, '必须有 reduced-motion 降级');
  const reduced = section.slice(section.indexOf('@media (prefers-reduced-motion:reduce)'));
  assert.match(reduced, /\.ea-hbtn-glyph/, 'reduced-motion 下图标过渡必须关掉');
  assert.match(reduced, /animation:none/, 'reduced-motion 下忙碌弧不得继续旋转');
});

test('入口按钮 CSS: 未读点不参与布局', () => {
  const dot = /\.ea-hbtn-dot\{([^}]*)\}/.exec(section);
  assert.ok(dot, '必须有 .ea-hbtn-dot 规则');
  assert.match(dot[1], /position:absolute/, '未读点必须绝对定位（否则每次出现都会挤压图标）');
  assert.match(dot[1], /pointer-events:none/, '未读点不得抢点击');
});

test('入口按钮 CSS: 按钮本体必须自己画（宿主不给插槽里的 button 任何样式）', () => {
  const rule = /\.ea-hbtn-btn\{([^}]*)\}/.exec(section);
  assert.ok(rule, '必须有 .ea-hbtn-btn 规则');
  const body = rule[1];
  assert.match(body, /border:0/, '必须去掉浏览器默认边框');
  assert.match(body, /background:transparent/, '浏览器默认的浅灰底必须去掉（那就是"丑"的另一半）');
  assert.match(body, /appearance:none/, '必须关掉 UA 外观');
  assert.match(section, /\.ea-hbtn-btn:hover\{[^}]*background/, 'hover 必须有底色反馈');
  assert.match(section, /\.ea-hbtn-btn:focus-visible\{[^}]*outline/, '键盘焦点必须有可见环（去掉默认样式后不能丢掉可访问性）');
});

test('忙碌门控: 计时器必须按全局方式调用（浏览器的 setTimeout 被当成对象方法会抛 Illegal invocation）', () => {
  // 复刻浏览器行为：window.setTimeout 只要 this 不是全局对象，就抛 Illegal invocation。
  // 2026-10-31 线上事故就是这个：gate 里写成 timers.setTimeout(...)，this 变成那个普通对象，
  // 于是「点开浮窗」这个 effect 抛错 → React 把整个入口插槽卸载 → 图标消失、点什么都没反应。
  const strictTimers = {
    setTimeout(handler, ms) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return 1;
    },
    clearTimeout(handle) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
    },
  };
  const g = gate.createBusyGate(strictTimers, () => {});
  assert.doesNotThrow(() => g.set(true), 'set(true) 不得抛 Illegal invocation（否则入口会被 React 卸载）');
  assert.doesNotThrow(() => g.dispose());
});
