import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleFromSource, fakeDom } from './fixtures/runtime.mjs';

/**
 * 回答正文的 Markdown 渲染闸（0.2.7）。
 *
 * 用户原话：「没有对 md 的符号进行解析。我希望能够解析的同时还保证性能。」
 * 所以这里有两组互不替代的断言：
 *   A. 记号要变成格式 —— 把渲染结果的 textContent 摊平，**记号本身不得出现**；
 *      只删记号不出格式不算过（断言的是元素类型，不是「字没了」）。
 *   B. 流式不能卡 —— 用「块级解析次数」当可数的指标，回答越长它也不该线性涨。
 *
 * 为什么 B 必须是可数指标而不是「感觉快」：性能断言一旦写成墙钟时间，
 * 就会在慢机器上偶发变红，最后被当成「不稳定测试」忽略掉。
 * blockRenders 是渲染器自己数的、确定性的，改坏了必红。
 */

const md = await moduleFromSource('src/client/markdown.ts');
const SOURCE = await readFile(new URL('../src/client/markdown.ts', import.meta.url), 'utf8');

/** 在假 DOM 里跑一段渲染，返回根节点与扁平化文本。 */
function render(text, streaming = false, steps) {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    if (steps) for (const step of steps) view.update(step, streaming);
    else view.update(text, streaming);
    return { container, view, text: container.textContent || '' };
  } finally {
    // 调用方已经拿到需要的值；DOM 全局还原由 dom.restore 负责。
    dom.restore();
  }
}

/** 收集容器里出现过的所有标签名，用来断言「格式真的出来了」。 */
function tagsOf(element) {
  const out = [];
  const walk = node => {
    if (node.tagName && !String(node.tagName).startsWith('#')) out.push(String(node.tagName).toLowerCase());
    for (const child of node.children || []) walk(child);
  };
  walk(element);
  return out;
}

/* ================================================================== *
 * A. 记号要变成格式
 * ================================================================== */

test('常见记号都变成对应元素，且记号本身不再出现在正文里', () => {
  const source = [
    '# 标题一',
    '',
    '这一句有 **粗体** 和 *斜体* 还有 ~~删除线~~。',
    '',
    '- 第一条',
    '- 第二条',
    '',
    '> 一段引用',
    '',
    '行内代码是 \`const a = 1\`。',
    '',
    '\`\`\`js',
    'console.log(1)',
    '\`\`\`',
    '',
    '[点这里](https://example.com)',
  ].join('\n');

  const { container, text } = render(source);
  const tags = tagsOf(container);

  // 格式确实出来了（这一条是「只删记号不出格式」的判别点）。
  for (const expected of ['h1', 'strong', 'em', 'del', 'ul', 'li', 'blockquote', 'code', 'pre', 'a']) {
    assert.ok(tags.includes(expected), '缺少 <' + expected + '>，实际标签：' + tags.join(','));
  }

  // 记号本身不再露出。
  assert.ok(!text.includes('**'), '正文里还露着 **：' + text);
  assert.ok(!text.includes('~~'), '正文里还露着 ~~：' + text);
  assert.ok(!text.includes('# '), '正文里还露着标题记号：' + text);
  assert.ok(!text.includes('> 一段引用'), '正文里还露着引用记号：' + text);
  assert.ok(!text.includes('\`'), '正文里还露着反引号：' + text);
  // 列表记号：条目文字前面不该再有 "- "。
  assert.ok(!/- 第一条/.test(text), '正文里还露着列表记号：' + text);

  // 内容本身不能丢。
  for (const kept of ['标题一', '粗体', '斜体', '删除线', '第一条', '一段引用', 'const a = 1', 'console.log(1)', '点这里']) {
    assert.ok(text.includes(kept), '内容丢了：' + kept);
  }
});

test('有序列表与嵌套强调', () => {
  const { container, text } = render('1. 第一\n2. 第二\n\n*a **b** c*');
  const tags = tagsOf(container);
  assert.ok(tags.includes('ol'), '有序列表应渲染成 <ol>：' + tags.join(','));
  assert.ok(!/^\s*1\./m.test(text), '有序列表记号还露着：' + text);
  assert.ok(text.includes('b'), '嵌套内容丢了：' + text);
  assert.ok(!text.includes('*'), '强调记号还露着：' + text);
});

test('转义的反斜杠记号按字面显示', () => {
  const { text } = render('这不是粗体：\\*\\*原样\\*\\*');
  assert.ok(text.includes('**原样**'), '转义后应显示字面星号，实际：' + text);
});

test('危险协议不生成可点链接', () => {
  const { container, text } = render('[点我](javascript:alert(1)) 和 [安全](https://example.com)');
  const anchors = [];
  const walk = node => {
    if (String(node.tagName).toLowerCase() === 'a') anchors.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(container);
  assert.equal(anchors.length, 1, '只应有一个锚点，实际 ' + anchors.length);
  assert.equal(anchors[0].getAttribute('href'), 'https://example.com');
  assert.ok(text.includes('点我'), '不安全链接的文字仍应保留：' + text);
});

test('渲染器不碰 innerHTML', () => {
  // 断言的是**实际用法**（赋值/读取属性），不是「文件里出现过这个词」——
  // 否则连解释「为什么不用 innerHTML」的注释都会把闸打红（这个坑本项目吃过一次）。
  assert.ok(!/\.innerHTML\b/.test(SOURCE), 'markdown.ts 里出现了 .innerHTML —— 未信任文本绝不能走 HTML 注入');
  assert.ok(!/insertAdjacentHTML|\.outerHTML\b/.test(SOURCE), '不得使用 HTML 注入类 API');
  assert.ok(/createElement|createTextNode/.test(SOURCE), '应当只用 DOM 构造 API');
});

test('空文本与纯文本不报错', () => {
  assert.equal(render('').text, '');
  assert.equal(render('就是一句普通的话').text, '就是一句普通的话');
});

/* ================================================================== *
 * B. 流式不能卡
 * ================================================================== */

/** 造一段会不断变长的回答：每步追加一小段，按块结构分段。 */
function growingAnswer(steps) {
  const chunks = [];
  for (let i = 0; i < steps; i++) {
    if (i % 3 === 0) chunks.push('\n\n## 第 ' + i + ' 节\n\n');
    chunks.push('第' + i + '句普通文字，带 **粗体** 与 \`代码\`。');
  }
  return chunks;
}

test('流式渲染：块级解析次数不随回答长度线性增长', () => {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    const chunks = growingAnswer(120);
    let text = '';
    for (const chunk of chunks) { text += chunk; view.update(text, true); }
    const stats = view.stats;
    // 120 个分片、约 80 个块。若没有冻结，每来一个分片都要重解析全部块 →
    // blockRenders 会是几千。有冻结则每个块只建一次 DOM，量级与块数同阶。
    assert.ok(stats.blockRenders < 400,
      '块级解析次数过高（' + stats.blockRenders + '），说明冻结没生效：每个分片都在重解析整篇');
    assert.ok(stats.blockRenders >= 20, '块数太少，这条断言没有区分力');
    // 全文内容仍然完整。
    assert.ok((container.textContent || '').includes('第119句'), '最后一段内容丢了');
  } finally { dom.restore(); }
});

test('流式渲染：已冻结的节点在后续更新里是同一个对象（不会被换掉）', () => {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    let text = '## 第一节\n\n第一段。\n\n## 第二节\n\n第二段。\n\n';
    view.update(text, true);
    const before = container.children.slice();
    assert.ok(before.length >= 3, '至少应渲染出三个块，实际 ' + before.length);
    // 合法的断言范围是**冻结块**，不是「所有已渲染的块」。
    //
    // 增量器的契约只有一条：已冻结的块稳定。而「最后一块永远不冻」是刻意的设计
    // （见 createMarkdownRenderer 里那段说明：流式文本常停在「- a」，下一段可能是「- b」，
    // 冻死了就再也合不回去）。所以刚渲染出来的最后一块**本来就是临时的**，
    // 下一次更新把它换成真正的列表对象是正确行为，不是缺陷。
    //
    // 实测依据：本条最初写成「开头所有块都必须稳定」，首次渲染后 frozenCount=3 而
    // before.length=4 —— 索引 3 正是那个临时块，断言必然失败。那是断言范围写错了，不是实现错了。
    const frozen = view.frozenCount;
    assert.ok(frozen >= 2 && frozen < before.length,
      '首次渲染应已有冻结块、且仍留了临时块，实际 frozenCount=' + frozen + ' 共 ' + before.length + ' 块');
    // 再追加很多内容。
    for (let i = 0; i < 40; i++) { text += '补充第' + i + '句。\n\n'; view.update(text, true); }
    const after = container.children.slice();
    for (let i = 0; i < frozen; i++) {
      assert.equal(after[i], before[i], '第 ' + i + ' 个块是已冻结的，却被重建了（冻结失效）');
    }
  } finally { dom.restore(); }
});

test('流式渲染：未闭合的代码块只追加增量，不整段重写', () => {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    let text = '看这段代码：\n\n\`\`\`js\n';
    view.update(text, true);
    const code = container.querySelector('code');
    assert.ok(code, '代码块应当渲染出 <code>');
    let total = 0;
    for (let i = 0; i < 80; i++) {
      const line = 'const v' + i + ' = ' + i + ';\n';
      text += line;
      total += line.length;
      view.update(text, true);
    }
    const stats = view.stats;
    // 真实可观察量一：追加进去的文本节点一直留在原地（整段重写会把子节点清空）。
    assert.ok(code.children.length > 50,
      '代码块没有走增量追加：子文本节点只有 ' + code.children.length + ' 个，说明每次分片都在重写整段');
    // 真实可观察量二：实际写进 DOM 的字符数应当约等于文本长度。
    // 若退化成整段重写，这里会是每次分片长度的累加（平方级），远超 total。
    assert.ok(stats.codeChars < total * 2,
      '写入字符数 ' + stats.codeChars + ' 远超文本长度 ' + total + '，说明每次分片都在重写整段代码');
    assert.ok((container.textContent || '').includes('const v79 = 79;'), '追加内容不完整');
  } finally { dom.restore(); }
});

test('文本未变化时整次跳过', () => {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    view.update('一段话', true);
    const after = view.stats.calls;
    view.update('一段话', true);
    view.update('一段话', true);
    assert.equal(view.stats.calls, after + 2, '调用计数应如实增长');
    assert.equal(view.stats.skips, 2, '相同文本应当被跳过，实际 skips=' + view.stats.skips);
  } finally { dom.restore(); }
});

test('文本被整体替换时从头重来（不会把旧内容留在页面上）', () => {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    view.update('第一次的回答内容', true);
    view.update('完全不同的第二次回答', true);
    const text = container.textContent || '';
    assert.ok(text.includes('第二次'), '新内容没出来：' + text);
    assert.ok(!text.includes('第一次'), '旧内容没被清掉：' + text);
  } finally { dom.restore(); }
});

test('定稿渲染（streaming=false）内容与流式结果一致', () => {
  const source = '## 标题\n\n一段 **粗体**。\n\n\`\`\`\ncode\n\`\`\`\n';
  const settled = render(source, false);
  assert.ok(settled.text.includes('标题'));
  assert.ok(settled.text.includes('粗体'));
  assert.ok(!settled.text.includes('**'));
  assert.ok(tagsOf(settled.container).includes('pre'));
});

/* ================================================================== *
 * C. 已定稿正文的缓存
 * ================================================================== */

test('已定稿正文命中缓存，不会每次重画都重新解析', () => {
  const dom = fakeDom();
  try {
    md.clearSettledCache();
    const first = md.cachedMarkdownNodes('record-1', '一段 **历史** 回答');
    const second = md.cachedMarkdownNodes('record-1', '一段 **历史** 回答');
    assert.equal(second, first, '相同键与正文应返回同一批节点');
    assert.equal(md.settledCacheSize(), 1);
    // 正文变了就应当失效。
    const third = md.cachedMarkdownNodes('record-1', '换了一段 **历史** 回答');
    assert.notEqual(third, first, '正文变化后必须重新渲染');
    md.clearSettledCache();
  } finally { dom.restore(); }
});

/* ================================================================== *
 * D. 增量渲染与容器的一致性
 *
 * 这一组来自 Lead 用独立探针跑出来的一个**真缺陷**（不是推演）：
 * 容器里实际挂的节点与「已挂节点」记账脱节。
 * 复现序列：流式文本从 "- 甲" 逐行长到 "- 甲\n- 乙\n- 丙"，再补一个空行。
 * 定稿那一刻，页面上的 <ul> 从 1 个变成 2 个、<li> 从 3 条变成 6 条 —— 列表重复显示。
 * 根因：某个块**第一次被冻结**时冻结出的是新对象，而容器里还是上一轮的旧对象；
 * 旧的按「前缀已经对了」跳过追加，于是新对象进不来、旧对象出不去。
 * 修法：从前往后按**对象同一性**对齐，第一个不一致的位置之后整体替换。
 * ================================================================== */

test('列表在流式增长后定稿，不得出现重复的列表或条目', () => {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    let text = '';
    // 逐行到达：这是流式最常见的形态（模型一行一行往外吐）。
    for (const chunk of ['- 甲', '\n- 乙', '\n- 丙']) {
      text += chunk;
      view.update(text, true);
      assert.equal(container.querySelectorAll('ul').length, 1, '流式中途只能有一个 <ul>，实际：' + container.querySelectorAll('ul').length);
      assert.equal(container.querySelectorAll('li').length, container.querySelectorAll('li').length, '占位');
    }
    // 补上分隔空行 —— 这一刻列表块会从「正在长」变成「已终结」并被冻结。
    text += '\n\n普通段落';
    view.update(text, true);
    assert.equal(container.querySelectorAll('ul').length, 1, '补空行后列表重复了：' + container.querySelectorAll('ul').length + ' 个 <ul>');
    assert.equal(container.querySelectorAll('li').length, 3, '补空行后条目重复了：' + container.querySelectorAll('li').length + ' 条 <li>');

    // 定稿同样不得重复。
    view.update(text, false);
    assert.equal(container.querySelectorAll('ul').length, 1, '定稿后列表重复了：' + container.querySelectorAll('ul').length + ' 个 <ul>');
    assert.equal(container.querySelectorAll('li').length, 3, '定稿后条目重复了：' + container.querySelectorAll('li').length + ' 条 <li>');
    const flat = container.textContent || '';
    assert.equal(flat.split('甲').length - 1, 1, '「甲」出现了 ' + (flat.split('甲').length - 1) + ' 次，内容被重复渲染了：' + flat);
    assert.equal(flat.split('丙').length - 1, 1, '「丙」出现了 ' + (flat.split('丙').length - 1) + ' 次：' + flat);
  } finally { dom.restore(); }
});

test('容器里的节点数始终等于渲染器给出的节点数（不会多也不会少）', () => {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    // 混合结构：标题 + 列表 + 代码块 + 段落，逐块到达，中间不停插入空行触发冻结。
    const chunks = ['## 标题', '\n\n', '- 一', '\n- 二', '\n\n', '中间段落', '\n\n', '\`\`\`js\n', 'let a = 1\n', '\`\`\`\n', '\n', '收尾段落'];
    let text = '';
    for (const chunk of chunks) {
      text += chunk;
      view.update(text, true);
    }
    view.update(text, false);
    // 定稿路径会整份重渲染，节点数必须与容器一致 —— 这一条抓的正是「记账与容器脱节」。
    const expected = md.renderMarkdownNodes(text).length;
    assert.equal(container.children.length, expected,
      '容器里有 ' + container.children.length + ' 个节点，而渲染同样文本得到 ' + expected + ' 个 —— 记账与容器脱节了');
  } finally { dom.restore(); }
});

test('冻结的节点在后续流式更新中一次都没有被摘下来（对齐不能靠整棵重挂）', () => {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    let text = '## 第一节\n\n第一段内容。\n\n';
    view.update(text, true);
    const heading = container.children[0];
    assert.ok(heading, '应已渲染出标题块');
    const detaches = heading.detachments;
    for (let i = 0; i < 25; i++) { text += '- 条目' + i + '\n'; view.update(text, true); }
    view.update(text + '\n收尾', true);
    assert.equal(container.children[0], heading, '标题块被换掉了');
    assert.equal(heading.detachments, detaches,
      '冻结的标题被摘下来过 ' + (heading.detachments - detaches) + ' 次 —— 浏览器会丢滚动锚点');
  } finally { dom.restore(); }
});


/* ================================================================== *
 * 无跳变的**确定性**上界：整段流式过程中，冻结前缀的摘除次数必须恒为 0
 *
 * 为什么需要这条：页面实测只能证明「110ms 粒度上没看到跳变」，
 * 110ms 以下的抖动测不到（verify-3082 自己标了这个边界）。
 * 而跳变的机制来源是确定的 —— 冻结节点被从容器上摘下来再挂回去，
 * 浏览器会因此丢掉滚动锚点。所以「摘除次数」是一个比肉眼更硬的上界：
 * 恒为 0 则任何粒度下都不可能因「摘挂」而跳。
 *
 * 注意这条**不能**推广成「页面上绝对不会跳」：字体加载、图片撑开、
 * 内容变短导致滚动钳制等仍可能造成位移。它只排除「摘挂」这一种成因。
 * ================================================================== */

test('整段流式过程中，冻结前缀一次都没有被摘下来过（无跳变的确定性上界）', () => {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    // 造一段结构丰富的回答：标题、列表、段落、代码块依次到达。
    const chunks = ['# 第一节' + '\n' + '\n', '第一段 **内容**。' + '\n' + '\n'];
    for (let i = 0; i < 6; i++) chunks.push('- 条目' + i + '\n');
    chunks.push('\n', '第二段。' + '\n' + '\n');
    chunks.push('```' + '\n', 'code' + '\n', '```' + '\n', '\n');
    chunks.push('收尾。');
    let text = '';
    const tracked = [];
    for (const chunk of chunks) {
      text += chunk;
      view.update(text, true);
      // 每步都记下「当前被冻结的前缀」有哪些节点，以及它们的摘除计数。
      const frozen = container.children.slice(0, view.frozenCount);
      for (const node of frozen) {
        if (!tracked.some(entry => entry.node === node)) tracked.push({ node, at: node.detachments });
      }
    }
    // 先断言**流式期间**（不含最后的定稿切换）。
    assert.ok(tracked.length >= 2, '至少应观察到两个冻结节点，实际 ' + tracked.length + '（闸没有区分力）');
    for (const entry of tracked) {
      assert.equal(entry.node.detachments, entry.at,
        '一个冻结节点在**流式过程中**被摘下来过 ' + (entry.node.detachments - entry.at) + ' 次 —— '
        + '真实浏览器会因此丢滚动锚点（这就是「跳变」的机制来源）');
    }
    // 再单独断言「流式结束 → 定稿」这一次切换。
    //
    // 这一步曾经是真缺陷：定稿分支调 reset() 后整份重渲染，产出全新对象，
    // 对齐算法于是把**整棵正文 DOM** 换掉 —— 实测 5/5 个冻结节点在这一刻被摘除。
    // 真实浏览器里用户看到的是「答完的瞬间正文闪一下」。
    // 修法：定稿沿用流式成果，只补齐后面几块，冻结前缀原地不动。
    const beforeSettle = tracked.map(entry => ({ node: entry.node, d: entry.node.detachments }));
    view.update(text, false);
    const stillDetached = beforeSettle.filter(entry => entry.node.detachments !== entry.d);
    assert.equal(stillDetached.length, 0,
      '定稿那一刻有 ' + stillDetached.length + '/' + beforeSettle.length + ' 个冻结节点被重建 —— '
      + '真实浏览器里这就是「答完的瞬间闪一下」（流式期间不动、偏偏收尾时动）');
  } finally { dom.restore(); }
});


/* ================================================================== *
 * 独立视角复核：不依赖 detachments 计数器
 *
 * 上面那条「无跳变的确定性上界」用的是夹具里我自己加的 detachments 计数。
 * 万一那个计数本身写错了，测试会**假绿**——这是本项目吃过一次的亏（假指标）。
 * 所以这里换一个完全独立的判据：**节点对象是否还挂在容器上**（parentElement 链）。
 * 它不依赖任何我新加的字段，是 DOM 自身的语义。
 * ================================================================== */

test('定稿后，流式期间的那些正文节点仍然挂在容器上（独立于自定义计数器）', () => {
  const dom = fakeDom();
  try {
    const container = dom.document.createElement('div');
    const view = md.mountMarkdown(container);
    let text = '# 标题' + '\n' + '\n' + '一段内容。' + '\n' + '\n' + '再一段。' + '\n' + '\n';
    view.update(text, true);
    // 记下流式期间已经渲染出来的节点对象本身（不只记数量）。
    const duringStream = container.children.slice();
    assert.ok(duringStream.length >= 3, '流式期间应已渲染出至少三个块，实际 ' + duringStream.length);
    // 继续追加，然后定稿。
    text += '收尾段落。';
    view.update(text, true);
    view.update(text, false);
    // 判据：**已冻结的前缀**必须全部还挂在容器上。
    //
    // 为什么不是「全部节点」：最后一个块是**刻意不冻结**的（见 createMarkdownRenderer 说明——
    // 流式常停在「- a」，下一段可能是「- b」，冻死了就合不回去）。所以它本来就是临时的，
    // 定稿时换成正式渲染的版本是**正确行为**，不算重建。
    // 真正要防的是「连已冻结的前缀也被换掉」——那才是整棵 DOM 重建。
    const missing = duringStream.filter(node => node.parentElement !== container);
    const missingIndexes = duringStream.map((node, index) => (node.parentElement !== container ? index : -1)).filter(index => index >= 0);
    const frozenAtStream = duringStream.length - 1; // 最后一个块是临时块，前面的都应为冻结块
    assert.ok(frozenAtStream >= 2, '至少应有两个冻结块，实际 ' + frozenAtStream + '（闸没有区分力）');
    const frozenMissing = missingIndexes.filter(index => index < frozenAtStream);
    assert.equal(frozenMissing.length, 0,
      '定稿后有 ' + frozenMissing.length + ' 个**已冻结**的正文节点不再挂在容器上（索引 ' + JSON.stringify(frozenMissing) + '）—— '
      + '说明冻结前缀被重建了（真实浏览器里这就是「答完的瞬间闪一下」）');
    // 内容仍然完整。
    assert.ok((container.textContent || '').includes('收尾段落。'), '定稿后内容不得丢失');
  } finally { dom.restore(); }
});

