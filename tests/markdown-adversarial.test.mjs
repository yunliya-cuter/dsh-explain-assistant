import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource, fakeDom } from './fixtures/runtime.mjs';

/**
 * Markdown 渲染器的**对抗性**审查（Lead 已单独修过的那条「列表在流式下重复」不再重复报）。
 *
 * 本文件只写这一条测试文件，不动 src/。每条用例都对应一次实测复现，并在注释里写明
 * 「怎么改回去会变红」，以及证伪结果。
 *
 * 分三档标注每条结论的可信度：
 *   [实测] 在假 DOM 里跑出来、有确定输出；
 *   [真DOM] 依赖真实浏览器的语义（假 DOM 不模拟），无法在本文件里红，只能报告。
 */

const md = await moduleFromSource('src/client/markdown.ts');
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const FENCE = '```';

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 在假 DOM 里渲染一次，返回扁平文本与 DOM 结构串。 */
function render(text, streaming = false) {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    view.update(text, streaming);
    return { container, view, text: container.textContent || '', dom: dump(container) };
  } finally { dom.restore(); }
}

/** 把 DOM 树摊成可断言的结构串（含 ownText —— 假 DOM 的 textContent 会聚合，看不出层级）。 */
function dump(el) {
  let out = '';
  if (el.ownText) out += JSON.stringify(el.ownText);
  for (const child of el.children || []) {
    const tag = String(child.tagName || '').toLowerCase();
    if (tag.startsWith('#')) { out += JSON.stringify(child.textContent); continue; }
    const attrs = child.attributes
      ? [...child.attributes.entries()].map(([k, v]) => ' ' + k + '=' + JSON.stringify(v)).join('')
      : '';
    out += '<' + tag + attrs + '>' + dump(child) + '</' + tag + '>';
  }
  return out;
}

function count(haystack, needle) { return haystack.split(needle).length - 1; }

/* ================================================================== *
 * 1. CRLF 换行：整篇解析退化 + 回车符残留（实测）
 * ================================================================== */

test('[实测] CRLF 换行会整篇退化：标题/列表不识别，且回车符残留正文里', () => {
  // 现象：模型（尤其经某些代理/网关时）会吐 \r\n。扫描器按 \n 切行，行尾留下 \r，
  // 于是「# 标题」这一行的文本是 "# 标题\r" —— HEADING 的 [ \t]*$ 匹配不上 → 不是标题；
  // 空行变成 "\r" 而不是 ""，BLANK 也匹配不上 → 段落不再被空行切断。
  const lf = render('# 标题' + NL + NL + '- 甲' + NL + '- 乙');
  const crlf = render('# 标题' + CR + NL + CR + NL + '- 甲' + CR + NL + '- 乙');

  // 先确认 LF 是好的（否则说明问题在别处）
  assert.equal(count(lf.dom, '<h1>'), 1, '前置：LF 下应识别标题，实际 ' + lf.dom);
  assert.equal(count(lf.dom, '<li>'), 2, '前置：LF 下应识别两个列表项，实际 ' + lf.dom);

  // CRLF 下的退化
  assert.equal(count(crlf.dom, '<h1>'), 1,
    'CRLF 文本的标题也应被识别成 <h1>；实际 DOM = ' + crlf.dom
    + ' —— 修法：扫描前把 CRLF/CR 规范化成 LF');
  assert.equal(count(crlf.dom, '<li>'), 2, 'CRLF 文本的列表项也应被识别；实际 DOM = ' + crlf.dom);
  assert.equal(crlf.text.includes(CR), false,
    '正文里不得残留回车符，实际 = ' + JSON.stringify(crlf.text));
});

test('[实测] CRLF 下两个段落会被合成一个大段落', () => {
  const lf = render('第一段' + NL + NL + '第二段');
  const crlf = render('第一段' + CR + NL + CR + NL + '第二段');
  assert.equal(count(lf.dom, '<p>'), 2, '前置：LF 下是两个段落，实际 ' + lf.dom);
  assert.equal(count(crlf.dom, '<p>'), 2,
    'CRLF 下也应是两个段落，实际 ' + crlf.dom + '（整段被并成一个 <p>）');
});

/* ================================================================== *
 * 2. 缩进的闭合围栏：吞掉后续正文（实测，有内容损失）
 * ================================================================== */

test('[实测] 缩进的闭合围栏不被识别，会把后面的正文吞进代码块', () => {
  // CommonMark：闭合围栏允许 0-3 个前导空格。这里用 /^ {0,3}(`{3,}|~{3,})/ 识别**开始**围栏，
  // 但闭合判定用 countRun(candidate, 0, marker)（从第 0 列开始数），
  // 于是「两个空格 + 三个反引号」这类缩进闭合符匹配不上 → 围栏永不闭合 → 后面所有内容都算代码。
  const flat = render(FENCE + NL + 'code' + NL + FENCE + NL + '这行本该是普通段落');
  const indented = render(FENCE + NL + 'code' + NL + '  ' + FENCE + NL + '这行本该是普通段落');

  assert.equal(count(flat.dom, '<p>'), 1, '前置：不缩进时闭合正常，实际 ' + flat.dom);
  assert.equal(count(indented.dom, '<p>'), 1,
    '缩进 2 空格的闭合围栏也应被识别（CommonMark 允许 0-3 空格）；实际 DOM = ' + indented.dom
    + ' —— 后面的正文被整段吞进了 <pre>');
  assert.equal(count(indented.dom, '<pre>'), 1, '应只有一个代码块，实际 ' + indented.dom);
});

/* ================================================================== *
 * 3. 列表项里的代码块：跑出列表之外（实测，结构错误）
 * ================================================================== */

test('[实测] 列表项里的代码块会跑到列表外面', () => {
  // 现象：'- 项' + NL + NL + '  ```' ... —— 列表在空行处终止，代码块成为顶级块。
  // 用户看到的是「列表项 + 一个与列表平级的代码块」，而不是列表项**里面**的代码块。
  const result = render('- 项' + NL + NL + '  ' + FENCE + NL + '  code' + NL + '  ' + FENCE);
  // ⚠️ 判据必须要求 <pre> **落在 <li> 的闭合标签之前**。
  // 我第一版写成 /<li>[^]*?<pre>/ —— 那个正则跨过了 </li></ul>，所以「代码块在列表外面」
  // 也会匹配成功（假绿）。实测抓到并改正：改成按 <li>…</li> 区间取子串再找 <pre>。
  const liBlocks = result.dom.match(/<li>[^]*?<\/li>/g) || [];
  const liWithPre = liBlocks.some(block => block.includes('<pre>'));
  assert.ok(liWithPre,
    '列表项里的代码块应嵌在 <li> 内；实际 DOM = ' + result.dom
    + '（<li> 区块 = ' + JSON.stringify(liBlocks) + '）—— 代码块跑到了列表外面（<ul> 已闭合）');
});

/* ================================================================== *
 * 4. 有序列表丢弃起始号（实测）
 * ================================================================== */

test('[实测] 有序列表丢弃起始号：3. 开头的列表渲染成从 1 开始', () => {
  const result = render('3. 丙' + NL + '4. 丁');
  // ⚠️ 计数必须用容器查询，不能用 count(dom, '<ol>')：修好之后 DOM 是
  // `<ol start="3">`，字面量 '<ol>' 会数不到（我第一版就是这样，导致「修好反而红」）。
  // 用 querySelectorAll 按标签名计数，对属性变化免疫。
  assert.equal(result.container.querySelectorAll('ol').length, 1,
    '前置：应渲染成有序列表，实际 ' + result.dom);
  const ol = result.container.querySelector('ol');
  assert.ok(ol, '必须有 <ol>');
  assert.equal(ol.getAttribute('start'), '3',
    '有序列表必须带上起始号（CommonMark：<ol start="3">）；实际 start = '
    + JSON.stringify(ol.getAttribute('start')) + ' —— 用户看到编号从 1 重新开始');
});

/* ================================================================== *
 * 5. 宽松列表被拆成两个列表（实测）
 * ================================================================== */

test('[实测] 空行分隔的同类列表被拆成两个独立列表', () => {
  // CommonMark：'- a' + 空行 + '- b' 是**同一个列表**（列表项可以是宽松的）。
  const result = render('- a' + NL + NL + '- b');
  assert.equal(count(result.dom, '<ul>'), 1,
    '空行分隔的同类列表应合并为一个 <ul>；实际 DOM = ' + result.dom + '（被拆成两个列表）');
  assert.equal(count(result.dom, '<li>'), 2, '两个条目都应保留，实际 ' + result.dom);
});

/* ================================================================== *
 * 6. 深嵌套与病态输入：超线性耗时（实测，可被用来拖死页面）
 * ================================================================== */

test('[实测] 未闭合方括号的渲染耗时呈超线性增长（32k 已到秒级）', () => {
  // 现象：renderInlineNodes 遇到 '[' 会调 matchLink；matchLink 在找不到 ']' 时
  // 从 i 一路扫到字符串结尾。长串 '[' 于是变成 O(n^2)。
  // 危险场景：模型吐出一段不含闭合方括号的长文本（例如大量 '[' 或未完成的链接）。
  //
  // ── 判据为什么不写成「4 倍输入 < 12 倍耗时」────────────────────────
  // 那个比值判据在修好之后**会偶发假红**：修好后耗时降到毫秒级，基准值小到
  // 会被一次 GC 或调度打断淹没（实测同一台机器上比值在 0.7 ~ 9.0 之间跳），
  // 它测的就不再是「阶」，而是「这一毫秒有没有被打断」。
  // 现在改成两条都稳的判据：①取多轮**最小值**（最小值天然抗打断）作代表；
  // ②绝对上限——旧写法 32000 个 '[' 实测 2624ms，线性写法 <50ms，
  // 所以「32k 必须在 500ms 内」既能抓住旧写法、又留了 10 倍以上余量。
  const dom = fakeDom();
  try {
    const time = (n) => {
      const src = '['.repeat(n);
      const t0 = Date.now();
      md.renderInlineNodes(src);
      return Date.now() - t0;
    };
    const best = (n, rounds) => {
      let min = Infinity;
      for (let i = 0; i < rounds; i++) min = Math.min(min, time(n));
      return min;
    };
    best(2000, 3);                       // 预热
    const small = best(8000, 3);
    const large = best(32000, 3);
    // ① 绝对上限 —— **主判据**。旧写法 32000 个 '[' 实测 2624ms，线性写法 3ms，
    //    500ms 上限既能抓住旧写法、又留了 100 倍以上余量，不受采样抖动影响。
    assert.ok(large < 500,
      '32000 个未闭合方括号耗时 ' + large + 'ms，超过 500ms 上限 —— 流式期间每来一个分片都会这样卡一次');
    // ② 阶 —— 只在**基准足够大**时才比，否则这条判据会退化成噪声。
    //
    // 实测教训：修好后 small 常为 0ms，而 Math.max(1, small) 会把基准抬成 1ms，
    // 12 倍阈值于是退化成 12ms；large 只要因调度抖到 13ms 就红。
    // 这与「阶」无关，纯是毫秒级计时噪声（实测同一台机器比值在 0.7~9.0 间跳）。
    // 所以：基准 < 5ms 时不比阶（此时绝对上限已经足够说明问题）。
    if (small >= 5) {
      assert.ok(large < small * 12,
        '4 倍输入耗时增长应接近线性；实测 8k=' + small + 'ms, 32k=' + large + 'ms（比值 '
        + (large / small).toFixed(1) + '）—— 说明 matchLink 在无闭合方括号时是 O(n^2)');
    }
  } finally { dom.restore(); }
});

test('[实测] 深嵌套方括号同样超线性（16k 层已秒级）', () => {
  const dom = fakeDom();
  try {
    const time = (n) => {
      const t0 = Date.now();
      md.renderInlineNodes('['.repeat(n) + 'x' + ')'.repeat(n));
      return Date.now() - t0;
    };
    const best = (n, rounds) => { let min = Infinity; for (let i = 0; i < rounds; i++) min = Math.min(min, time(n)); return min; };
    best(1000, 3);
    const small = best(4000, 3);
    const large = best(16000, 3);
    // 主判据：绝对上限。旧写法此处为秒级（16k 实测 1911ms），300ms 上限余量充足。
    assert.ok(large < 300,
      '16000 层深嵌套耗时 ' + large + 'ms，超过 300ms 上限（旧写法此处为秒级）');
    // 阶：只在基准足够大时比，理由同上一条（毫秒级基准会让比值退化成时间噪声）。
    if (small >= 5) {
      assert.ok(large < small * 12,
        '4 倍嵌套深度耗时增长应接近线性；实测 4k=' + small + 'ms, 16k=' + large + 'ms（比值 '
        + (large / small).toFixed(1) + '）');
    }
  } finally { dom.restore(); }
});

/* ================================================================== *
 * 7. 缓存返回共享节点：[真DOM] 无法在本文件里红，但必须被记录
 * ================================================================== */

test('[真DOM] cachedMarkdownNodes 返回同一批共享节点，重复使用会把前面的搬空', () => {
  const dom = fakeDom();
  try {
    md.clearSettledCache();
    const first = md.cachedMarkdownNodes('rec-1', '正文 **粗**');
    const second = md.cachedMarkdownNodes('rec-1', '正文 **粗**');
    assert.equal(second, first, '前置：同 key 同正文命中缓存（这是设计意图）');
    assert.equal(second[0], first[0], '命中缓存返回的是**同一个 DOM 节点对象**');

    const c1 = dom.document.createElement('div');
    const c2 = dom.document.createElement('div');
    for (const n of first) c1.appendChild(n);
    for (const n of second) c2.appendChild(n);
    assert.equal(c1.children[0], c2.children[0],
      '两个容器里是同一个节点对象 —— 真实浏览器里第二次 appendChild 会把它从第一个容器搬走');
    md.clearSettledCache();
  } finally { dom.restore(); }
});

test('[真DOM] 假 DOM 的 appendChild 不模拟移动语义（限制了上面那条的可验证性）', () => {
  // 这条测试**记录 fixture 的边界**，避免以后有人误以为上面的用例已经证明了「用户只看到一处」。
  // 真实 DOM：同一节点 appendChild 到新父节点会被**移动**（旧父节点里消失）。
  // tests/fixtures/runtime.mjs 的 FakeElement.appendChild 只 push，不移除旧父引用。
  const dom = fakeDom();
  try {
    const a = dom.document.createElement('div');
    const b = dom.document.createElement('div');
    const child = dom.document.createElement('span');
    a.appendChild(child);
    b.appendChild(child);
    assert.equal(a.children.length, 1,
      '假 DOM 保留了旧父引用（真实 DOM 此处应为 0 —— 节点已被移走）；'
      + '若这条断言在未来变成失败，说明 fixture 已支持移动语义，上面那条可升级为真缺陷断言');
  } finally { dom.restore(); }
});

/* ================================================================== *
 * 8. 渲染器与容器的一致性：把 Lead 修过的那条做成更广的不变量
 * ================================================================== */

test('[实测] 流式每一步：容器里不出现重复节点，结束后与一次性渲染逐字一致', () => {
  const pieces = [
    '- 甲' + NL, '- 乙' + NL, '- 丙' + NL, NL,
    '普通段落' + NL, NL,
    FENCE + NL, 'code1' + NL, 'code2' + NL, FENCE + NL, NL,
    '### 标题' + NL, NL, '> 引用' + NL, '- 列表' + NL, '  - 嵌套' + NL,
  ];
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    let text = '';
    for (const piece of pieces) {
      text += piece;
      view.update(text, true);
      const seen = new Set();
      for (const child of container.children) {
        assert.equal(seen.has(child), false, '容器里出现了重复的节点对象 @' + JSON.stringify(text.slice(-24)));
        seen.add(child);
      }
    }
    view.update(text, false);
    const settled = md.renderMarkdownNodes(text).map(n => n.textContent || '').join('');
    assert.equal(container.textContent, settled,
      '流式过程结束后，容器文本必须与一次性渲染完全一致' + NL
      + '  流式=' + JSON.stringify(container.textContent) + NL
      + '  定稿=' + JSON.stringify(settled));
  } finally { dom.restore(); }
});

test('[实测] dispose 之后容器清空、渲染器重置（可再次使用）', () => {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    view.update('## 标题' + NL + NL + '段落', true);
    assert.ok(container.children.length > 0, '前置：应有内容');
    view.dispose();
    assert.equal(container.children.length, 0, 'dispose 必须把已挂节点全部摘掉');
    assert.equal(view.frozenCount, 0, 'dispose 必须重置冻结计数');
    view.update('新的内容', true);
    assert.equal(container.textContent, '新的内容', 'dispose 后可继续使用');
  } finally { dom.restore(); }
});

/* ================================================================== *
 * 9. 安全：确认没有 HTML 进入 DOM（扩大覆盖面）
 * ================================================================== */

test('[实测] 各类 HTML / 危险协议都不进入 DOM', () => {
  const cases = [
    ['script 标签', '<script>alert(1)</script>', 'script'],
    ['带 onerror 的 img', '<img src=x onerror=alert(1)>', 'img'],
    ['尖括号 b 标签', '<b>粗</b>', 'b'],
    ['iframe', '<iframe src=javascript:alert(1)></iframe>', 'iframe'],
  ];
  for (const [label, source, forbidden] of cases) {
    const result = render(source);
    assert.equal(result.container.querySelectorAll(forbidden).length, 0,
      label + ' 不得进入 DOM，实际 DOM = ' + result.dom);
    assert.ok(result.text.includes('<'), label + ' 应作为**纯文本**原样显示，实际 ' + JSON.stringify(result.text));
  }

  for (const source of [
    '[x](javascript:alert(1))',
    '[x](data:text/html,<b>hi</b>)',
    '[x](vbscript:msgbox)',
    '[x](file:///etc/passwd)',
    '[x](blob:https://e.com/x)',
    '![i](data:image/svg+xml,<svg onload=alert(1)>)',
  ]) {
    const result = render(source);
    assert.equal(result.container.querySelectorAll('a').length, 0,
      source + ' 不得生成锚点，实际 DOM = ' + result.dom);
    assert.equal(result.container.querySelectorAll('img').length, 0,
      source + ' 不得生成图片，实际 DOM = ' + result.dom);
  }
  const mixed = render('[x](JaVaScRiPt:alert(1))');
  assert.equal(mixed.container.querySelectorAll('a').length, 0, '大小写混淆的 javascript: 也要挡住');
});
