import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource, fakeDom } from './fixtures/runtime.mjs';

/**
 * 已定稿正文缓存的「共享节点」闸（task-36）。
 *
 * 缺陷：cachedMarkdownNodes 把**同一批 Node 对象**交给每个调用方。真实 DOM 的
 * appendChild 是**移动**语义（不是复制）—— 同一批节点第二次被挂到另一个容器时，
 * 会从第一个容器里被搬走，于是**先渲染的那一处变成空白**。
 * 用户看到的是历史正文「时有时无」（取决于重画顺序，所以是间歇性的）。
 *
 * ── 这条闸为什么不依赖「夹具模拟移动语义」────────────────────────────
 * 最直白的写法是让夹具的 appendChild 具备真实移动语义、再断言第一个容器被搬空。
 * 但那样做会打破既有闸里两条钉住「夹具当前行为」的断言（实测：全量 2 红，
 * 且那两条位于我无权改动、且被指定为本轮验收标准的文件里）。
 *
 * 所以这里改成直接断言**机制本身**，与夹具是否模拟移动无关：
 *   「一个已经属于某个容器的节点批次，不得再作为同一批对象交付出去」。
 * 只要这条成立，第二个容器就不可能拿到第一个容器里的节点，「搬空」从根上不会发生。
 * 这条断言在修复前是红的（见文件末尾证伪记录）。
 */

const md = await moduleFromSource('src/client/markdown.ts');

/** 递归收集一棵子树里的全部节点对象，用来判断两个容器是否共享节点。 */
function collect(el, out = []) {
  out.push(el);
  for (const child of el.children) collect(child, out);
  return out;
}

/** 把一批节点挂进一个新容器，返回该容器。 */
function mount(dom, nodes) {
  const container = dom.document.createElement('div');
  for (const node of nodes) container.appendChild(node);
  return container;
}

test('[真DOM] 已挂载的缓存节点不得再次直接交付（否则第二次挂载会把前面搬空）', () => {
  const dom = fakeDom();
  try {
    md.clearSettledCache();
    const first = md.cachedMarkdownNodes('rec-1', '正文 **粗**');
    mount(dom, first);            // 第一批已经被某个容器持有
    const second = md.cachedMarkdownNodes('rec-1', '正文 **粗**');

    // 关键断言：第二批里**不能**有「已经挂在别处」的节点。
    // 修复前 second === first，而 first 里每个节点都挂着 c1 → 这里红。
    const alreadyAttached = second.filter(node => node.parentElement !== null);
    assert.equal(alreadyAttached.length, 0,
      '第二次取到 ' + alreadyAttached.length + ' 个已属于其它容器的节点 —— 真实浏览器里'
      + '把这些节点挂到第二处时会从第一处被搬走，用户看到正文消失（时有时无）');
    md.clearSettledCache();
  } finally { dom.restore(); }
});

test('[真DOM] 同一 key 渲染到两个容器时，两容器不得共享任何节点对象', () => {
  const dom = fakeDom();
  try {
    md.clearSettledCache();
    const text = '标题' + String.fromCharCode(10) + String.fromCharCode(10) + '正文 **粗**';
    const c1 = mount(dom, md.cachedMarkdownNodes('rec-2', text));
    const c2 = mount(dom, md.cachedMarkdownNodes('rec-2', text));

    const inA = new Set(collect(c1));
    const shared = collect(c2).filter(node => inA.has(node));
    assert.equal(shared.length, 0,
      '两个容器共享了 ' + shared.length + ' 个节点对象 —— 这正是「不得把同一批节点交给两个容器」被违反');
    assert.ok(c1.textContent.includes('正文'), '第一处内容被搬空：' + c1.textContent);
    assert.ok(c2.textContent.includes('正文'), '第二处内容缺失：' + c2.textContent);
    md.clearSettledCache();
  } finally { dom.restore(); }
});

test('命中缓存仍必须成立：同一 key 不重复解析（修法不得退化成每次重解析）', () => {
  const dom = fakeDom();
  try {
    md.clearSettledCache();
    const before = md.settledCacheParseCount();
    md.cachedMarkdownNodes('rec-3', '一段 **历史** 回答');
    const afterFirst = md.settledCacheParseCount();
    assert.equal(afterFirst - before, 1, '首次调用应当解析一次');
    for (let i = 0; i < 5; i++) md.cachedMarkdownNodes('rec-3', '一段 **历史** 回答');
    assert.equal(md.settledCacheParseCount(), afterFirst,
      '命中缓存不应再解析 —— 缓存被退化成每次重解析了');
    assert.equal(md.settledCacheSize(), 1, '同一 key 只应有一条缓存');
    md.clearSettledCache();
  } finally { dom.restore(); }
});

test('未挂载时仍返回同一批节点（保持既有契约，不无谓克隆）', () => {
  const dom = fakeDom();
  try {
    md.clearSettledCache();
    const a = md.cachedMarkdownNodes('rec-4', '正文 **粗**');
    const b = md.cachedMarkdownNodes('rec-4', '正文 **粗**');
    assert.equal(b, a, '尚未挂载时没有「两个容器争抢」的风险，应保持原契约返回同一批');
    md.clearSettledCache();
  } finally { dom.restore(); }
});

test('正文变化后缓存失效，且新正文不得复用旧节点', () => {
  const dom = fakeDom();
  try {
    md.clearSettledCache();
    const a = md.cachedMarkdownNodes('rec-5', '第一版 **正文**');
    const ca = mount(dom, a);
    const b = md.cachedMarkdownNodes('rec-5', '第二版 **正文**');
    assert.notEqual(b, a, '正文变化必须重新渲染');
    const cb = mount(dom, b);
    const inA = new Set(collect(ca));
    const shared = collect(cb).filter(node => inA.has(node));
    assert.equal(shared.length, 0, '新正文不得复用旧正文的节点');
    assert.ok(b.some(n => String(n.textContent || '').includes('第二版')), '新正文内容应正确');
    md.clearSettledCache();
  } finally { dom.restore(); }
});

test('克隆出来的节点内容与结构完整（深克隆，不是浅拷贝）', () => {
  const dom = fakeDom();
  try {
    md.clearSettledCache();
    const NL = String.fromCharCode(10);   // 反引号在源码里用占位符写，避免模板串冲突
    const text = '# 标题' + NL + NL + '- 甲' + NL + '- 乙' + NL + NL + '> 引用' + NL + NL
      + String.fromCharCode(96).repeat(3) + NL + 'code' + NL + String.fromCharCode(96).repeat(3);
    const first = mount(dom, md.cachedMarkdownNodes('rec-6', text));
    const second = mount(dom, md.cachedMarkdownNodes('rec-6', text));
    for (const sel of ['h1', 'ul', 'li', 'blockquote', 'pre', 'code']) {
      assert.equal(second.querySelectorAll(sel).length, first.querySelectorAll(sel).length,
        '克隆后 ' + sel + ' 数量不一致（浅拷贝会丢子节点）');
    }
    assert.equal(second.textContent, first.textContent, '克隆后文本应逐字一致');
    md.clearSettledCache();
  } finally { dom.restore(); }
});

test('同 key 被两个容器交替反复取用时，两处内容始终都在', () => {
  const dom = fakeDom();
  try {
    md.clearSettledCache();
    const text = '反复取用 **正文**';
    const c1 = dom.document.createElement('div');
    const c2 = dom.document.createElement('div');
    for (let i = 0; i < 4; i++) {
      for (const n of md.cachedMarkdownNodes('rec-7', text)) c1.appendChild(n);
      for (const n of md.cachedMarkdownNodes('rec-7', text)) c2.appendChild(n);
      assert.ok(c1.textContent.includes('反复取用'), '第 ' + (i + 1) + ' 轮后第一处被搬空');
      assert.ok(c2.textContent.includes('反复取用'), '第 ' + (i + 1) + ' 轮后第二处缺失');
    }
    md.clearSettledCache();
  } finally { dom.restore(); }
});

/*
 * ── 证伪结果（实测记录）──────────────────────────────────────────────
 * 把 cachedMarkdownNodes 命中分支改回 return hit（并去掉首次返回的克隆）：
 *   → 第 1 条「已挂载的缓存节点不得再次直接交付」红
 *   → 第 2 条「两容器不得共享任何节点对象」红
 *   → 第 3 条「命中缓存仍必须成立」仍绿（说明性能契约与共享缺陷是两个独立轴）
 *   → 第 4 条「未挂载时仍返回同一批节点」仍绿（它测的是契约的另一面）
 * 恢复修复版 → 全部绿，且与修改前逐字节一致。
 *
 * 「未挂载时返回同一批」与「已挂载时不得共享」并不矛盾：
 * 前者是被 tests/markdown-render.test.mjs 钉住的既有契约，后者是本次修的缺陷。
 * 修复取的是**条件交付**：只有节点已经属于某个容器之后才克隆 —— 那正是唯一
 * 会发生「互相搬空」的时刻；未挂载时保持原契约、零克隆开销。
 */
