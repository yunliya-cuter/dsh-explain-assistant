import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCss, declsFor, px, textWidth } from './fixtures/css-box.mjs';

/**
 * 「发送」按钮的形态契约（源码级）。
 *
 * ── 起因 ────────────────────────────────────────────────────────────────
 * 用户 2026-10-25 的截图里，这颗按钮还是一块 8px 圆角的实心方块，而浮窗外壳早就是
 * 参考项目（设置向导 .panel）那套玻璃了 —— 整个界面上只有它没跟上。
 * 用户原话：「第一个图中的按钮重做，参考第二个图（项目在 D:\qq文件数据\setup）」。
 *
 * 参考实现把按钮拆成三层（.btn / .btn-bg / .btn-label）：胶囊外形、半透明底 + 模糊 +
 * 四条内阴影叠出的玻璃厚度、单独一层带柔光字影的文字。这里不重测「像不像」
 * （那要靠截图），只钉住**改坏了会立刻出问题**的几条：
 *
 *   1. 形态：必须还是胶囊（999px）、必须有背景模糊、必须有内阴影叠出来的厚度；
 *   2. 尺寸：定高 34px、起宽 76px —— 起宽必须真的容得下「处理中」三个字，
 *      否则切到忙碌态这一行会左右跳（旧版跳 13px，圆环跟着抖）；
 *   3. 禁用态：必须自己写 background-color / box-shadow。
 *      深色主题那条覆盖选择器是 body[data-ds-dark-theme] .ea-send（0,2,1），
 *      比 .ea-send:disabled（0,2,0）高 —— 只改变量的话禁用态会被它盖回去。
 *      这个坑是真的踩到了：实测禁用态的填充和投影当时根本没生效（见 send5 的实测记录）；
 *   4. 交互：悬停只抬 1px、按下只缩 1.5%（幅度再大就成了「按钮跳了一下」）；
 *      减少动态偏好下不得有位移。
 *
 * ⚠️ 判据里的**基础样式**只看 @media 之外的部分：媒体查询里的声明是条件生效的，
 * 把它们混进基础规则会得出「悬停位移是 none」的假结论（第一版就撞上了）。
 */

const STYLES = new URL('../src/client/styles.css', import.meta.url);
const RAW = readFileSync(STYLES, 'utf8');

/** 去掉所有 @media 块（连同内部声明），返回只含基础样式的文本。 */
function stripAtBlocks(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at < 0) { out += css.slice(i); break; }
    out += css.slice(i, at);
    let depth = 0;
    let j = at;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    i = j;
  }
  return out;
}

/** 取**所有**同名媒体块的正文并拼在一起（同一个条件可以出现多次，只取第一块会漏）。 */
function mediaBlock(css, query) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf('@media ' + query, from);
    if (at < 0) break;
    const open = css.indexOf('{', at);
    if (open < 0) break;
    let depth = 0;
    let end = css.length;
    for (let j = open; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    out.push(css.slice(open + 1, end));
    from = end + 1;
  }
  return out.join(String.fromCharCode(10));
}

const BASE = stripAtBlocks(RAW);
const RULES = parseCss(BASE);
const SEND = declsFor(RULES, '.ea-send');
const SEND_DARK = declsFor(RULES, 'body[data-ds-dark-theme] .ea-send');
const SEND_DISABLED = declsFor(RULES, '.ea-send:disabled');
const RIM = String(SEND['--ea-send-rim'] ?? '');

test('发送按钮形态: 胶囊外形 + 背景模糊 + 内阴影叠出的玻璃厚度', () => {
  assert.equal(SEND['border-radius'], '999px', '必须是胶囊（参考项目的 .btn-bg 就是 999px）');
  assert.equal(px(SEND.border), 0, '边框交给 box-shadow 的那几层画，不要真的 border');
  assert.ok(SEND['backdrop-filter'] && /blur\(/.test(SEND['backdrop-filter']),
    '必须有背景模糊：玻璃和「一块半透明色」的区别就在这里，实际 ' + JSON.stringify(SEND['backdrop-filter']));
  assert.ok(SEND['-webkit-backdrop-filter'], 'WebKit 前缀那条也要有（同一份代码要能落到两种引擎上）');

  const insets = (RIM.match(/inset/g) || []).length;
  assert.ok(insets >= 3,
    '边缘反光至少三层（顶光 / 侧沿 / 底沿压暗）才叠得出厚度，实际 ' + insets + ' 层：' + RIM);
  const shadow = String(SEND['box-shadow'] ?? '');
  assert.ok(shadow.includes('var(--ea-send-rim)'), '边缘那几层要收在 --ea-send-rim 里，深浅两套主题各自配');
  assert.ok(shadow.includes('var(--ea-send-lift-y)') && shadow.includes('var(--ea-send-lift-blur)')
    && shadow.includes('var(--ea-send-lift-alpha)'),
    '外投影的参数要放在变量里：悬停/按下靠改它们让阴影摊开或收窄，实际 ' + shadow);
  assert.ok(String(SEND['background-image']).includes('var(--ea-send-grad)'),
    '表面那道竖向渐变必须引用 --ea-send-grad（受光面在上、暗部在下，厚度就来自它）');
});

test('发送按钮形态: 深浅两套主题各有自己的边缘反光', () => {
  assert.ok(SEND_DARK['--ea-send-rim'], '深色主题必须覆盖 --ea-send-rim（浅底上的白边会读成描边，要单独配）');
  assert.notEqual(SEND_DARK['--ea-send-rim'], SEND['--ea-send-rim'], '深浅两套的边缘反光不能是同一份数值');
  assert.ok(SEND_DARK['--ea-send-fill'], '深色主题要单独定填充（primary 在这套主题里是浅灰白，透明度得另外调）');
  assert.ok(SEND_DARK['--ea-send-grad'], '深色主题要有自己的表面渐变（浅底上的白边看不见，立体感只能靠这道光）');
  assert.ok(SEND_DARK['--ea-send-label'], '深色主题的字色要单独定（浅底黑字 vs 深底白字）');
  // 两套的变量都必须被 .ea-send 真的用上，否则改了没效果
  assert.ok(String(SEND['background-color']).includes('var(--ea-send-fill)'), '填充必须引用 --ea-send-fill');
  assert.ok(String(SEND['background-image']).includes('var(--ea-send-grad)'), '表面渐变必须引用 --ea-send-grad');
});

test('发送按钮尺寸: 起宽要真的容得下「处理中」，切状态时这一行不左右跳', () => {
  assert.equal(px(SEND.height), 40, '定高 40px（参考是 44px，这里收 4px 以贴合输入区那一行）');
  const min = px(SEND['min-width']);
  assert.ok(min !== undefined && min >= 70, '必须有起宽，实际 ' + JSON.stringify(SEND['min-width']));

  const pad = String(SEND.padding ?? '').trim().split(/\s+/).map(px);
  assert.deepEqual(pad.length === 2 ? pad : [], [0, 22], '内边距应为 0 22px（上下不撑、左右 22px）');
  const fontSize = px(SEND['font-size']) ?? 14.5;
  const need = pad[1] * 2 + textWidth('处理中', fontSize);
  assert.ok(min >= need,
    '起宽 ' + min + 'px 容不下「处理中」（需要 ' + need.toFixed(1) + 'px）：' +
    '忙碌态会把这一行撑宽，圆环与按钮的相对位置跟着抖 —— 旧版就是这样跳了 13px');
});

test('发送按钮禁用态: 自己写 background-color / box-shadow（否则被深色主题那条盖回去）', () => {
  // 深色那条 body[data-ds-dark-theme] .ea-send 的权重是 (0,2,1)，高于 .ea-send:disabled (0,2,0)。
  // 只改 --ea-send-fill / --ea-send-lift-* 的话，禁用态根本不生效（实测过：send5 那一轮）。
  assert.ok(SEND_DISABLED['background-color'], '禁用态必须直接写 background-color，不能只改 --ea-send-fill');
  assert.ok(!String(SEND_DISABLED['background-color']).includes('var(--ea-send-fill'),
    '禁用态的填充不能引用那个会被深色主题覆盖的变量');
  assert.ok(SEND_DISABLED['box-shadow'], '禁用态必须直接写 box-shadow（只留边缘反光，不要那层浮动投影）');
  assert.ok(!String(SEND_DISABLED['box-shadow']).includes('--ea-send-lift'),
    '禁用态不得带浮动投影：一颗按不动的按钮还浮着，读起来像「能按」');
  assert.equal(SEND_DISABLED.opacity, '1',
    '必须把 .ea-btn:disabled 的 opacity:.5 顶掉：半透明会连文字一起糊掉，而按钮文案本身要能读');
});

test('发送按钮交互: 悬停只抬 1px、按下只缩 1.5%，不撒手不回弹', () => {
  const hover = declsFor(RULES, '.ea-send:hover:not(:disabled)');
  const active = declsFor(RULES, '.ea-send:active:not(:disabled)');
  const lift = /translateY\((-?[\d.]+)px\)/.exec(String(hover.transform ?? ''));
  assert.ok(lift, '悬停要有位移，实际 transform = ' + JSON.stringify(hover.transform));
  assert.ok(Math.abs(Number(lift[1])) <= 1, '悬停抬升不得超过 1px（再大就成了「按钮跳了一下」），实际 ' + lift[1] + 'px');

  const press = String(active.transform ?? '');
  const scale = /scale\(([\d.]+)\)/.exec(press);
  assert.ok(scale, '按下要有缩放反馈，实际 transform = ' + JSON.stringify(active.transform));
  const s = Number(scale[1]);
  assert.ok(s >= 0.97 && s < 1, '按下缩到 0.97~1 之间（太小像被压扁），实际 ' + s);
  assert.ok(!/scale\(1\.[\d]+\)/.test(press), '按下不得放大（那是「弹」不是「按」）');
  const pressDur = Number.parseFloat(String(active['transition-duration'] ?? '').replace('s', ''));
  assert.ok(Number.isFinite(pressDur) && pressDur <= 0.08,
    '按下要比悬停更快收（手感才脆，≤80ms），实际 transition-duration = ' + JSON.stringify(active['transition-duration']));
  assert.ok(hover['--ea-send-lift-y'] && active['--ea-send-lift-y'],
    '悬停/按下的位移要伴随投影变化（只动位置不动影子，看起来像图层在抖）');
});

test('发送按钮无障碍: 减少动态偏好下不做位移', () => {
  const block = mediaBlock(RAW, '(prefers-reduced-motion: reduce)');
  assert.ok(block, '必须存在 prefers-reduced-motion: reduce 的块');
  assert.ok(/\.ea-send\s*\{[^}]*transition\s*:\s*none/.test(block),
    '减少动态偏好下要关掉这颗按钮的过渡（颜色/阴影的静态差异仍然保留）');
  assert.ok(/\.ea-send:hover:not\(:disabled\)[^{]*\{[^}]*transform\s*:\s*none/.test(block),
    '减少动态偏好下悬停/按下都不得位移');
});
