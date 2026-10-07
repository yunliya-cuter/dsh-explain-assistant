import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCss, declsFor, px, expandPadding, colorFallback, FAINT_COLORS, textWidth } from './fixtures/css-box.mjs';

/**
 * UI 可达性与可见性闸（源码级）。
 *
 * ── 起因：用户实测报的缺陷 ──────────────────────────────────────────
 * 浮窗右下角**有**一个缩放手柄（◢），用户的原话是「哦，有◢，但是不好用，也不明显」
 * 「正常情况下根本看不出来这个大小可以用来调整大小」。
 * Lead 量到的旧样式：18×18px、background 全透明、字色 label-tertiary(#888)、font-size 11px，
 * 且与发送按钮的矩形**重叠约 5×6px**。
 * 也就是说：**控件存在，但可达性与可见性都不合格** —— 而过去所有测试都没抓住这类问题。
 *
 * 本文件把这一类问题变成**自动可检出的闸**。判据全部**从 CSS 文本解析得到**，
 * 不写死数字 —— Lead 正在改那两处样式，改完闸会自动跟上。
 *
 * ⚠️ 诚实边界：这是源码级近似（理由与限制见 tests/fixtures/css-box.mjs 头部）。
 * 它的可信度靠一条**已知事实校验**支撑：把历史样式喂进同一个模型，算出的重叠是
 * **5×6px**，与 Lead 实测逐像素一致（见下方「模型校验」用例）。
 */

const STYLES = new URL('../src/client/styles.css', import.meta.url);
const OVERLAY = new URL('../src/client/overlay.tsx', import.meta.url);
const CSS = readFileSync(STYLES, 'utf8');
const RULES = parseCss(CSS);

/** 浮窗默认几何（与 overlay.tsx 的 clampGeometry 默认值一致；用于把绝对定位换算成矩形）。 */
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 420;

/**
 * 命中面积下限（CSS px）。24 是 WCAG 2.5.8（Target Size Minimum）的 AA 值。
 * 低于它的控件必须登记在 EXEMPT 里并写明理由。
 */
const MIN_TARGET = 24;

/**
 * 豁免表：确有理由小于下限的控件。
 * **必须写明理由**（测试会检查理由非空）——防止「为了全绿随口豁免」。
 */
// 写法必须是 [选择器, 理由] 数组对：写成对象会让 Map 收到 key=undefined，
// 于是 get(selector) 永远取不到 —— 豁免看起来登记了、实际完全没生效（闸会照红）。
const EXEMPT = new Map([
  // 四条「边」热区厚度 7px，低于 24px 下限。**理由如下，不是随口豁免**：
  //   · 7px 是窗口边框的通行尺寸（Windows / macOS 原生窗口边框约 4~8px）。
  //     用户对「拖窗口边改大小」的预期正是基于这个厚度 —— 加厚到 24px 反而不像窗口，
  //     而且会覆盖正文区与滚动条，抢走它们的点击（那是**新增**的坏体验）。
  //   · 该功能有等效替代：四个 **24×24** 的角热区提供同样的改大小能力，
  //     WCAG 2.5.8 允许「等效替代」满足目标尺寸要求。
  //   · 边热区是**贴着窗口边缘的长条**（如 312×7），沿边方向的命中长度远超 24px，
  //     只有垂直于边的厚度是 7px；把它当 24×24 的方块来要求并不适用。
  // 结论：登记豁免，并把理由写在这里；若将来边热区被加厚到 ≥24，应删掉这几条。
  ['.ea-resize-n', '窗口边框厚度惯例 7px；沿边命中长度 300+px；同一功能由 24×24 的角热区等效提供（WCAG 2.5.8 允许等效替代）；加厚会覆盖正文与滚动条'],
  ['.ea-resize-s', '同上：窗口边框厚度惯例 7px；同一功能由 24×24 的角热区等效提供；加厚会覆盖正文'],
  ['.ea-resize-e', '同上：窗口边框厚度惯例 7px；同一功能由 24×24 的角热区等效提供；加厚会覆盖正文'],
  ['.ea-resize-w', '同上：窗口边框厚度惯例 7px；同一功能由 24×24 的角热区等效提供；加厚会覆盖正文'],
]);

/* ================================================================== *
 * 工具：把控件解析成矩形
 * ================================================================== */

/**
 * 解析一个选择器的盒模型。
 * 返回 { width, height, left, top, source } 或 { undecidable: 原因 }。
 */
function boxOf(selector) {
  const d = declsFor(RULES, selector);
  const width = px(d.width);
  const height = px(d.height);
  // 尺寸必须能从**任一种**合法写法得出，否则才算不可判定：
  //   · 显式 width/height（px）
  //   · 两侧同时锚定（left+right 定宽 / top+bottom 定高）—— `.ea-resize-n` 就是这种
  // 第一版要求 width 与 height **都**是 px，于是四个"边"热区（只有 height、宽度靠两侧撑开）
  // 被判成不可判定，接着「八个热区」那条闸只解析到 4 个而假红。
  const hasWidth = width !== undefined || (px(d.left) !== undefined && px(d.right) !== undefined);
  const hasHeight = height !== undefined || (px(d.top) !== undefined && px(d.bottom) !== undefined);
  if (!hasWidth || !hasHeight) {
    return { undecidable: selector + ' 既无显式 width/height，也无法由两侧锚定推出（'
      + d.width + '/' + d.height + ' left=' + d.left + ' right=' + d.right + ' top=' + d.top + ' bottom=' + d.bottom + '）' };
  }
  // padding 简写与**长写**都要认：`.ea-composer-actions{padding-right:18px}` 用的是长写，
  // 只读 shorthand 会得到 0，于是「右侧留白把手柄与发送按钮解耦」这件事被判成没做（假红）。
  const pad = paddingOf(d);
  // `pointer-events:none` 的元素**不接收指针事件**，因此它不是命中目标：
  // 它既不该参与命中面积下限，也不可能与别的控件「抢同一次按下」。
  // （Lead 把角落那个 ◢ 做成纯装饰、由 .ea-resize-se 接管拖拽，就是靠这个属性。）
  const inert = String(d['pointer-events'] ?? '') === 'none';
  // 绝对定位支持**四种锚定**：left / right / top / bottom 任意组合 +
  // 「两边同时声明」（如 `.ea-resize-n{left:14px;right:14px;height:7px}` → 宽度由两侧撑开）。
  // 第一版只认 right/bottom，于是边热区被判成 0 宽/0 高，八热区全被误报成「相交」（假红）。
  const left0 = px(d.left), right0 = px(d.right), top0 = px(d.top), bottom0 = px(d.bottom);

  let widthPx = width, leftPx;
  if (left0 !== undefined && right0 !== undefined && d.width === undefined) {
    widthPx = DEFAULT_WIDTH - left0 - right0;      // 两侧撑开
    leftPx = left0;
  } else if (left0 !== undefined) leftPx = left0;
  else if (right0 !== undefined) leftPx = DEFAULT_WIDTH - right0 - widthPx;
  else leftPx = undefined;

  let heightPx = height, topPx;
  if (top0 !== undefined && bottom0 !== undefined && d.height === undefined) {
    heightPx = DEFAULT_HEIGHT - top0 - bottom0;
    topPx = top0;
  } else if (top0 !== undefined) topPx = top0;
  else if (bottom0 !== undefined) topPx = DEFAULT_HEIGHT - bottom0 - heightPx;
  else topPx = undefined;

  if (leftPx === undefined || topPx === undefined) {
    return { undecidable: selector + ' 缺少定位信息（left/right 与 top/bottom 至少要各有一个）' };
  }
  if (!(widthPx > 0) || !(heightPx > 0)) {
    return { undecidable: selector + ' 解析出的尺寸非正（' + widthPx + '×' + heightPx + '）' };
  }
  return {
    selector,
    width: widthPx, height: heightPx,
    padding: pad,
    inert,
    left: leftPx,
    top: topPx,
    right: leftPx + widthPx,
    bottomEdge: topPx + heightPx,
    decls: d,
  };
}

/** 取 padding：shorthand 优先，缺失的边用长写补齐。 */
function paddingOf(decls) {
  const shorthand = expandPadding(decls.padding);
  if (shorthand) return shorthand;
  return [
    px(decls['padding-top']) ?? 0,
    px(decls['padding-right']) ?? 0,
    px(decls['padding-bottom']) ?? 0,
    px(decls['padding-left']) ?? 0,
  ];
}

/** 两个矩形是否相交（面积 > 0）。 */
function intersection(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottomEdge, b.bottomEdge) - Math.max(a.top, b.top);
  return { w, h, overlaps: w > 0 && h > 0 };
}

/** 控件清单：从 overlay.tsx 源码里取到「用了哪个 class」。 */
function controlSource() {
  return readFileSync(OVERLAY, 'utf8');
}

/* ================================================================== *
 * 0) 模型校验：用历史样式复现 Lead 量到的 5×6 重叠
 * ================================================================== */

test('UI 可达性 模型校验: 用历史样式能复现 Lead 实测的「5×6px 重叠」（证明模型不是空转）', () => {
  // 这是整个文件的**可信度地基**：如果模型连已知事实都算不对，
  // 它判「合格」就没有意义。历史样式取自 Lead 的实测记录。
  const HIST = [
    '.dsh-explain-assistant-form{padding:11px 13px 12px}',
    '.ea-btn-primary{padding:9px 18px}',
    '.ea-composer-actions{display:flex;justify-content:space-between}',
    '.dsh-explain-assistant-resize{position:absolute;right:0;bottom:0;width:18px;height:18px}',
  ].join('\n');
  const rules = parseCss(HIST);
  const get = s => declsFor(rules, s);

  const hp = expandPadding(get('.dsh-explain-assistant-form').padding);   // [t,r,b,l]
  const bp = expandPadding(get('.ea-btn-primary').padding);
  const hw = px(get('.dsh-explain-assistant-resize').width);
  const hh = px(get('.dsh-explain-assistant-resize').height);

  // 发送按钮：宽度 = 左右内边距 + 文字宽（"发送" 两个中文字 @13px）
  const fontSize = 13;
  const btnW = bp[1] * 2 + textWidth('发送', fontSize);
  const btnH = bp[0] * 2 + fontSize * 1.2;
  const handle = { left: DEFAULT_WIDTH - hw, right: DEFAULT_WIDTH, top: DEFAULT_HEIGHT - hh, bottomEdge: DEFAULT_HEIGHT };
  const send = {
    left: DEFAULT_WIDTH - hp[1] - btnW, right: DEFAULT_WIDTH - hp[1],
    top: DEFAULT_HEIGHT - hp[2] - btnH, bottomEdge: DEFAULT_HEIGHT - hp[2],
  };
  const hit = intersection(handle, send);
  assert.ok(hit.overlaps, '历史样式下两者必须相交（否则模型算不出 Lead 报的重叠）');
  assert.equal(Math.round(hit.w), 5,
    '横向重叠应为 5px（Lead 实测「约 5×6px」），实际 ' + hit.w.toFixed(1)
    + ' —— 若这里变了，说明盒模型或默认几何改了，需重新校准');
  assert.equal(Math.round(hit.h), 6,
    '纵向重叠应为 6px（Lead 实测），实际 ' + hit.h.toFixed(1));
});

/* ================================================================== *
 * 1) 命中面积下限
 * ================================================================== */

test('UI 可达性 命中面积: 每个可交互控件的命中区不得小于下限（低于者必须登记豁免并写明理由）', () => {
  // 从源码取「真正被创建出来的可交互控件」的 class 选择器。
  // 只检查**有显式尺寸声明**的那些：没写 width/height 的由内容撑开，
  // 源码级无法可靠判定（不猜），归入下面单独一条用例报「不可判定」。
  const controls = [
    { name: '缩放手柄', selector: '.dsh-explain-assistant-resize' },
    { name: '缩放手柄(兼容类名)', selector: '.ea-resize' },
    { name: '四角热区', selector: '.ea-resize-ne' },
    { name: '四边热区', selector: '.ea-resize-n' },
  ];

  const failures = [];
  const checked = [];
  for (const { name, selector } of controls) {
    const box = boxOf(selector);
    if (box.undecidable) continue;   // 没有显式尺寸 → 见「不可判定」用例
    // 纯装饰元素（pointer-events:none）不是命中目标，不参与面积下限；
    // 它的「能不能被看出来」由第 3 组用例负责。
    if (box.inert) continue;
    checked.push(name + '(' + box.width + '×' + box.height + ')');
    const tooSmall = box.width < MIN_TARGET || box.height < MIN_TARGET;
    if (!tooSmall) continue;
    // 取到的是**理由字符串**（见 EXEMPT 的写法说明）。
    const exempt = EXEMPT.get(selector);
    if (typeof exempt === 'string' && exempt.trim()) continue;
    failures.push(name + ' ' + selector + ' 命中区只有 ' + box.width + '×' + box.height
      + 'px，小于下限 ' + MIN_TARGET + '×' + MIN_TARGET + '（WCAG 2.5.8）');
  }

  assert.ok(checked.length > 0, '必须真的检查到控件（否则这条闸是空的）');
  assert.deepEqual(failures, [],
    '以下控件的命中区小于下限，且未登记豁免理由：\n' + failures.join('\n'));
});

test('UI 可达性 命中面积: 关键动作控件（改变窗口几何）必须达到下限', () => {
  // 这一条专门钉「拖拽/缩放」这类需要精细操作的关键动作：
  // 它们比其他按钮更依赖命中面积（拖到一半脱手很难受）。
  // 注意：这里必须和上一条用**同一个**「是不是命中目标」的判定。
  // 上一版漏了 inert 检查，于是把 pointer-events:none 的**装饰标记**（那个 ◢）
  // 也当成命中目标去要求 24×24 —— 那是闸自己的模型缺陷，不是代码问题。
  // 真正响应拖拽的是它上层的 .ea-resize-se 热区（已单独列入本表）。
  const geometryControls = [
    { name: '右下角缩放手柄(装饰标记)', selector: '.dsh-explain-assistant-resize' },
    { name: '四角热区', selector: '.ea-resize-se' },
  ];
  const failures = [];
  const checked = [];
  for (const { name, selector } of geometryControls) {
    const box = boxOf(selector);
    if (box.undecidable) continue;
    // 纯装饰元素不接收指针事件 → 不是命中目标，不参与面积下限。
    if (box.inert) continue;
    checked.push(name);
    const exempt = EXEMPT.get(selector);
    if (typeof exempt === 'string' && exempt.trim()) continue;
    if (box.width < MIN_TARGET || box.height < MIN_TARGET) {
      failures.push(name + ' ' + selector + ' = ' + box.width + '×' + box.height + 'px');
    }
  }
  assert.ok(checked.length > 0, '必须真的检查到关键动作控件（否则这条闸是空的）');
  assert.deepEqual(failures, [], '改变窗口几何的控件必须够大：\n' + failures.join('\n'));
});

test('UI 可达性 命中面积: 四边热区必须完全贴边（否则拖不到最外侧）', () => {
  // 边热区若没有贴到 0/边缘，用户把指针移到窗口边界上就抓不到 —— 这正是「不好用」的一种。
  const edges = [
    { selector: '.ea-resize-n', edge: 'top', expect: 0 },
    { selector: '.ea-resize-s', edge: 'bottom', expect: 0 },
    { selector: '.ea-resize-e', edge: 'right', expect: 0 },
    { selector: '.ea-resize-w', edge: 'left', expect: 0 },
  ];
  const failures = [];
  for (const { selector, edge, expect } of edges) {
    const d = declsFor(RULES, selector);
    const raw = d[edge];
    if (raw === undefined) { failures.push(selector + ' 没有声明 ' + edge); continue; }
    const value = px(raw);
    if (value === undefined || value !== expect) failures.push(selector + ' 的 ' + edge + ' = ' + raw + '（应为 ' + expect + 'px）');
  }
  assert.deepEqual(failures, [], '边热区必须贴边：\n' + failures.join('\n'));
});

/* ================================================================== *
 * 2) 重叠
 * ================================================================== */

test('UI 可达性 重叠: 缩放手柄与发送按钮的命中区不得相交（既有实例：8×10px 相交）', () => {
  // 这是用户报的那个缺陷的直接量化复现：手柄压在发送按钮下面。
  const handle = boxOf('.dsh-explain-assistant-resize');
  if (handle.undecidable) assert.fail('缩放手柄的尺寸必须能从 CSS 解析：' + handle.undecidable);

  // 发送按钮：宽度由 padding + 文字宽估算，高度 = padding + 行高。
  // 文字取「发送」（最长态；「处理中」更长，但那是禁用态，不参与点击冲突判定）。
  const btnDecls = declsFor(RULES, '.ea-btn-primary');
  const btnPad = expandPadding(btnDecls.padding) ?? [0, 0, 0, 0];
  const formDecls = declsFor(RULES, '.dsh-explain-assistant-form');
  const formPad = paddingOf(formDecls);
  // 右侧留白：.ea-composer-actions 的 padding-right（Lead 就是用它把手柄与按钮解耦的）。
  // ⚠️ 这里必须是**长写优先**：CSS 写的是 `padding-right:18px` 而不是 shorthand，
  // 只读 shorthand 会得到 0 → 把「已经解耦」误判成「仍在重叠」（假红）。
  const actionsDecls = declsFor(RULES, '.ea-composer-actions');
  const reserve = paddingOf(actionsDecls)[1];

  const baseFont = 13;
  const label = '发送';
  const btnW = btnPad[1] * 2 + textWidth(label, baseFont);
  const btnH = btnPad[0] * 2 + baseFont * 1.2;
  const send = {
    right: DEFAULT_WIDTH - formPad[1] - reserve,
    left: DEFAULT_WIDTH - formPad[1] - reserve - btnW,
    bottomEdge: DEFAULT_HEIGHT - formPad[2],
    top: DEFAULT_HEIGHT - formPad[2] - btnH,
  };

  const hit = intersection(handle, send);
  assert.equal(hit.overlaps, false,
    '缩放手柄与发送按钮的命中区不得相交：当前重叠 ' + hit.w.toFixed(1) + '×' + hit.h.toFixed(1)
    + 'px（手柄 x[' + handle.left + ',' + handle.right + '] y[' + handle.top + ',' + handle.bottomEdge + ']；'
    + '发送 x[' + send.left.toFixed(1) + ',' + send.right.toFixed(1) + '] y[' + send.top.toFixed(1) + ',' + send.bottomEdge.toFixed(1) + ']）');
});

test('UI 可达性 重叠: 八个 resize 热区两两不得相交（否则抢同一次按下）', () => {
  // CSS 注释里明确写了「让开角，避免两个热区抢同一次按下」——这条把该意图变成自动检查。
  const zones = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(d => '.ea-resize-' + d);
  const boxes = zones.map(boxOf).filter(b => !b.undecidable);
  assert.ok(boxes.length >= 8, '八个热区都必须有显式尺寸声明，实际解析到 ' + boxes.length);

  const failures = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const hit = intersection(boxes[i], boxes[j]);
      // 相邻的边/角共享一条边线不算冲突（面积为 0），只在面积 > 0 时报
      if (hit.overlaps) {
        failures.push(boxes[i].selector + ' 与 ' + boxes[j].selector + ' 相交 ' + hit.w.toFixed(1) + '×' + hit.h.toFixed(1) + 'px');
      }
    }
  }
  assert.deepEqual(failures, [], 'resize 热区不得互相重叠：\n' + failures.join('\n'));
});

/* ================================================================== *
 * 3) 可见告示：关键动作控件不得「隐形」
 * ================================================================== */

test('UI 可达性 可见告示: 改变窗口几何的控件不得同时「背景全透明 + 字号过小 + 用最低对比度色」', () => {
  // 判据来自用户原话：「正常情况下根本看不出来这个大小可以用来调整大小」。
  // 三条都满足 ⇒ 用户看不出这里有东西 ⇒ 失败。
  // 只看有**可见外观**的控件（纯热区是装饰面，aria-hidden，不在本条的检查对象里）。
  const visibleGeometryControls = [
    { name: '缩放手柄', selector: '.dsh-explain-assistant-resize' },
  ];

  const failures = [];
  for (const { name, selector } of visibleGeometryControls) {
    const d = declsFor(RULES, selector);
    const background = String(d.background ?? '');
    const image = String(d['background-image'] ?? '');
    const fontSize = px(d['font-size']);
    const color = colorFallback(d.color);

    // ① 背景是否「完全透明」：既没背景色，也没有背景图/渐变
    const transparentBg = (background === 'transparent' || background === 'none' || background === '')
      && (image === '' || image === 'none');
    // ② 字号是否 < 12px（含 font-size:0 这种「不显示字形」的写法）
    const tinyFont = fontSize === undefined ? true : fontSize < 12;
    // ③ 是否用最低对比度色
    const faint = FAINT_COLORS.has(color.toLowerCase());

    if (transparentBg && tinyFont && faint) {
      failures.push(name + ' ' + selector + ' 同时满足：背景全透明(' + (background || '(未声明)') + ')'
        + '、字号 ' + (fontSize === undefined ? '(未声明)' : fontSize + 'px') + '、'
        + '最低对比度色 ' + color + ' —— 用户看不出这里可以操作');
    }
  }
  assert.deepEqual(failures, [],
    '关键动作控件必须能「被看出来」。以下控件三项全中：\n' + failures.join('\n'));
});

test('UI 可达性 可见告示: 缩放手柄必须常显（不得只在 hover/focus 才出现）', () => {
  // 用户的原话是「正常情况下根本看不出来」——如果外观只在 hover 时出现，那正是这个抱怨。
  const d = declsFor(RULES, '.dsh-explain-assistant-resize');
  const hasVisibleMark = String(d['background-image'] ?? '') !== '' && String(d['background-image'] ?? '') !== 'none';
  assert.ok(hasVisibleMark || d.background !== undefined && d.background !== 'transparent',
    '缩放手柄必须有**常显**的可见标记（背景图/色），不能只靠 hover 才出现；'
    + '当前 background-image=' + JSON.stringify(d['background-image']) + ' background=' + JSON.stringify(d.background));
});

test('UI 可达性 可见告示: 手柄必须有可访问名称与光标提示（读屏/指针都能识别）', () => {
  const src = controlSource();
  // 手柄必须有 aria-label（读屏）与 resize 光标（指针）
  assert.match(src, /button\('◢',\s*'[^']+'/, '缩放手柄必须带 aria-label');
  const d = declsFor(RULES, '.dsh-explain-assistant-resize');
  assert.match(String(d.cursor ?? ''), /resize/, '缩放手柄必须有 resize 光标（指针形态是「这里能拖」的最直接告示）');
  // 八个方向热区都要有方向光标
  const dirs = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
  const failures = [];
  for (const [dir, cursor] of Object.entries(dirs)) {
    const dd = declsFor(RULES, '.ea-resize-' + dir);
    if (String(dd.cursor ?? '') !== cursor) failures.push('.ea-resize-' + dir + ' 的 cursor = ' + JSON.stringify(dd.cursor) + '（应为 ' + cursor + '）');
  }
  assert.deepEqual(failures, [], '方向热区的光标必须与方向一致：\n' + failures.join('\n'));
});

/* ================================================================== *
 * 4) 不可判定：不猜，但要如实报出来
 * ================================================================== */

test('UI 可达性 不可判定: 无显式尺寸的控件不参与面积判定，但必须被列出来（不静默放过）', () => {
  // 诚实处理：源码级检查算不出「内容撑开的按钮」有多大。
  // 不猜、不假装合格；列出来 + 说明由哪一层负责（浏览器实测 / 页面复验）。
  const noSize = [];
  for (const selector of ['.ea-btn', '.ea-btn-primary', '.ea-btn-soft', '.ea-btn-quiet', '.ea-chip', '.ea-model-option', '.ea-input', '.ea-send', '.dsh-explain-assistant-close']) {
    const d = declsFor(RULES, selector);
    if (d.width === undefined || d.height === undefined) noSize.push(selector);
  }
  assert.ok(noSize.length > 0, '前置：确实存在「内容撑开」的控件，这条用例才有意义');
  console.log('  [ui-affordance] 无显式尺寸、不参与面积判定（由页面复验覆盖）：' + noSize.join(', '));
  // 这些控件的可达性必须由**页面实测**覆盖，此项在回报里如实标注。
});
