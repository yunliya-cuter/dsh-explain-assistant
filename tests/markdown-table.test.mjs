import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/*
 * Markdown 表格闸（0.2.12）。
 *
 * 来由：用户放行「Markdown 表格始终允许」之后，我才发现**渲染器根本不支持表格** ——
 * 块类型只有 paragraph/heading/code/list/quote/hr，源文件里 6 处 'table' 全是
 * 一个叫 table 的局部变量（括号索引表）。也就是说：只放行提示词不够，
 * 模型真吐出表格时，用户看到的会是一堆裸露的竖线。所以先补渲染器，再补这条闸。
 *
 * 本文件自带最小 DOM 与自编译，不依赖 tests/fixtures/runtime.mjs（那个文件由别的任务线在用）。
 */

const root = path.resolve(import.meta.dirname, '..')

class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.attributes = new Map(); this.children = []; this.parentElement = null; this.ownText = '' }
  setAttribute(k, v) { this.attributes.set(k, String(v)) }
  getAttribute(k) { return this.attributes.get(k) ?? null }
  hasAttribute(k) { return this.attributes.has(k) }
  appendChild(n) { n.parentElement = this; this.children.push(n); return n }
  append(...ns) { ns.forEach(n => this.appendChild(n)) }
  remove() { if (!this.parentElement) return; this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.parentElement = null }
  replaceChildren(...ns) { this.children.forEach(c => { c.parentElement = null }); this.children = []; ns.forEach(n => this.appendChild(n)) }
  get firstElementChild() { return this.children.find(c => !String(c.tagName).startsWith('#')) ?? null }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join('') }
  set textContent(v) { this.ownText = v == null ? '' : String(v); this.children = [] }
  get className() { return this.getAttribute('class') || '' }
  set className(v) { this.setAttribute('class', v) }
  cloneNode(deep = false) { const c = new El(this.tagName.toLowerCase()); for (const [k, v] of this.attributes) c.attributes.set(k, v); c.ownText = this.ownText; if (deep) for (const ch of this.children) c.appendChild(ch.cloneNode(true)); return c }
}
function withDom(fn) {
  const prev = globalThis.document
  const doc = new El('document')
  doc.createElement = t => new El(t)
  doc.createElementNS = (_n, t) => new El(t)
  doc.createTextNode = t => { const e = new El('#text'); e.textContent = t; return e }
  doc.head = new El('head')
  globalThis.document = doc
  try { return fn() } finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev }
}

let rp = null
function renderer() {
  rp ??= build({ entryPoints: [path.join(root, 'src/client/markdown.ts')], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
    .then(b => { const t = mkdtempSync(path.join(tmpdir(), 'md-table-')); const f = path.join(t, 'm.mjs'); writeFileSync(f, b.outputFiles[0].text); return import(pathToFileURL(f).href) })
  return rp
}

const NL = String.fromCharCode(10)
const find = (el, tag) => { if (String(el.tagName) === tag) return el; for (const c of el.children) { const f = find(c, tag); if (f) return f } return null }
const all = (el, tag, out = []) => { if (String(el.tagName) === tag) out.push(el); for (const c of el.children) all(c, tag, out); return out }
function render(md, src) { const host = new El('div'); for (const n of md.renderMarkdownNodes(src)) host.appendChild(n); return host }

const BASIC = '| 项目 | 状态 |' + NL + '| --- | --- |' + NL + '| 打开页面 | 正常 |' + NL + '| 截图 | 缺失 |' + NL

test('表格: 表头与单元格必须被渲染成 table/thead/th/td（不是裸露的竖线）', async () => {
  const md = await renderer()
  const r = withDom(() => { const h = render(md, BASIC); return { table: !!find(h, 'TABLE'), ths: all(h, 'TH').length, tds: all(h, 'TD').length, trs: all(h, 'TR').length, text: h.textContent } })
  assert.ok(r.table, '必须建出 <table>')
  assert.equal(r.ths, 2, '表头应有 2 个 th')
  assert.equal(r.tds, 4, '两行数据应有 4 个 td，实际 ' + r.tds)
  assert.equal(r.trs, 3, '表头 1 行 + 数据 2 行 = 3 个 tr，实际 ' + r.trs)
  assert.ok(!r.text.includes('|'), '可见文本里不得再有竖线，实际 = ' + JSON.stringify(r.text.slice(0, 80)))
  assert.ok(!r.text.includes('---'), '不得把分隔行当正文显示')
})

test('表格: 列数不一致（分隔行列数 ≠ 表头）时不得当成表格', async () => {
  const md = await renderer()
  const src = '| 甲 | 乙 |' + NL + '| --- | --- | --- |' + NL + '| 1 | 2 |' + NL
  const r = withDom(() => { const h = render(md, src); return { table: !!find(h, 'TABLE'), text: h.textContent } })
  assert.ok(!r.table, '分隔行列数不匹配时**不能**判成表格（否则会把两行普通文本吃成表格）')
  assert.ok(r.text.includes('|'), '既然不是表格，竖线就该原样留着')
})

test('表格: 没有分隔行就不是表格', async () => {
  const md = await renderer()
  const src = '| 甲 | 乙 |' + NL + '| 1 | 2 |' + NL
  const r = withDom(() => { const h = render(md, src); return { table: !!find(h, 'TABLE'), text: h.textContent } })
  assert.ok(!r.table, '缺分隔行 -> 不是表格')
  assert.ok(r.text.includes('|'), '竖线应原样保留')
})

test('表格: 短行必须补空到表头列数（否则列会错位）', async () => {
  const md = await renderer()
  const src = '| A | B | C |' + NL + '| --- | --- | --- |' + NL + '| 1 |' + NL
  // 只取**数据行**：表头行里的单元格是 TH，不是 TD。
  const r = withDom(() => { const h = render(md, src); const trs = all(h, 'TR'); const dataRows = trs.filter(tr => tr.children.some(c => String(c.tagName) === 'TD')); return { rows: dataRows.map(tr => tr.children.filter(c => String(c.tagName) === 'TD').length), tds: all(h, 'TD').length } })
  assert.equal(r.rows.length, 1, '应有一行数据')
  assert.equal(r.rows[0], 3, '短行必须补齐到 3 个 td，实际 ' + r.rows[0])
  assert.equal(r.tds, 3)
})

test('表格: 单元格里的转义竖线必须算一个单元格（不能被切成两列）', async () => {
  const md = await renderer()
  const src = '| A | B |' + NL + '| --- | --- |' + NL + '| a ' + String.fromCharCode(92) + '| b | c |' + NL
  const r = withDom(() => { const h = render(md, src); const tds = all(h, 'TD'); return { n: tds.length, texts: tds.map(t => t.textContent) } })
  assert.equal(r.n, 2, '转义竖线不得多切出一列，实际 td 数 = ' + r.n)
  assert.equal(r.texts[0], 'a | b', '第一格应是「a | b」，实际 ' + JSON.stringify(r.texts[0]))
})

test('表格: 对齐标记要落成可用的属性（:--- / :---: / ---:）', async () => {
  const md = await renderer()
  const src = '| 左 | 中 | 右 |' + NL + '| :--- | :---: | ---: |' + NL + '| 1 | 2 | 3 |' + NL
  const r = withDom(() => { const h = render(md, src); const ths = all(h, 'TH'); const tds = all(h, 'TD'); return { th: ths.map(t => t.getAttribute('data-align')), td: tds.map(t => t.getAttribute('data-align')) } })
  assert.deepEqual(r.th, ['left', 'center', 'right'], '表头对齐属性，实际 ' + JSON.stringify(r.th))
  assert.deepEqual(r.td, ['left', 'center', 'right'], '单元格对齐属性，实际 ' + JSON.stringify(r.td))
})

test('表格: 表格必须能打断段落（否则表头会被上一段吞掉）', async () => {
  const md = await renderer()
  const src = '先说一句话。' + NL + '| A | B |' + NL + '| --- | --- |' + NL + '| 1 | 2 |' + NL
  const r = withDom(() => { const h = render(md, src); const ps = all(h, 'P'); return { paras: ps.length, firstPara: ps[0] ? ps[0].textContent : null, table: !!find(h, 'TABLE') } })
  assert.ok(r.table, '段落后面紧跟的表格必须被识别')
  assert.equal(r.paras, 1, '应只有一个段落（那一句话），实际 ' + r.paras)
  assert.equal(r.firstPara, '先说一句话。', '段落内容不得被表格吃掉，实际 ' + JSON.stringify(r.firstPara))
})

test('表格: 行内记号在单元格里仍要被解析（**粗体** 等）', async () => {
  const md = await renderer()
  const src = '| A | B |' + NL + '| --- | --- |' + NL + '| 这里**很重要** | 普通 |' + NL
  const r = withDom(() => { const h = render(md, src); return { strong: all(h, 'STRONG').length, strongText: all(h, 'STRONG').map(s => s.textContent), text: h.textContent } })
  assert.equal(r.strong, 1, '单元格里的粗体必须被解析')
  assert.deepEqual(r.strongText, ['很重要'])
  assert.ok(!r.text.includes('**'), '不得残留星号')
})

test('表格 反例: 普通段落里的竖线不得被误判成表格', async () => {
  const md = await renderer()
  const src = '这个命令写作 a | b，是管道的意思。' + NL
  const r = withDom(() => { const h = render(md, src); return { table: !!find(h, 'TABLE'), text: h.textContent } })
  assert.ok(!r.table, '单行含竖线的普通句子不是表格')
  assert.ok(r.text.includes('a | b'), '原样保留')
})
