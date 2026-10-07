// 用**真实落库的模型正文**审一遍 Markdown 渲染器（v2）。
//
// v1 的教训（本轮实际踩到）：我一开始把「渲染后 textContent 里的记号」当成泄漏，
// 于是报出「真实语料残留 2 个 **」。查下去才发现那 2 个在 **代码段里** ——
// 代码段的内容本来就该原样显示，那是 GFM 的正确行为，不是缺陷。
// 所以 v2 只统计**代码段以外**的可见文本：只有在正文里裸露的记号才算泄漏。
import { build } from 'esbuild'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = '/mnt/d/projects/dsh-explain-assistant'
const storeDir = '/home/dsh/.dsh-test/explain-assistant/sessions'
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.attributes = new Map(); this.children = []; this.parentElement = null; this.ownText = ''; this.style = {}; this.dataset = {} }
  setAttribute(k, v) { this.attributes.set(k, String(v)) }
  getAttribute(k) { return this.attributes.get(k) ?? null }
  hasAttribute(k) { return this.attributes.has(k) }
  removeAttribute(k) { this.attributes.delete(k) }
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
const doc = new El('document')
doc.createElement = t => new El(t)
doc.createElementNS = (_n, t) => new El(t)
doc.createTextNode = t => { const e = new El('#text'); e.textContent = t; return e }
doc.head = new El('head')
globalThis.document = doc
const out = await build({ entryPoints: [path.join(root, 'src/client/markdown.ts')], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
const tmp = mkdtempSync(path.join(tmpdir(), 'md-v2-'))
const f = path.join(tmp, 'markdown.mjs')
writeFileSync(f, out.outputFiles[0].text)
const md = await import(pathToFileURL(f).href)

const records = []
for (const name of readdirSync(storeDir)) {
  if (!name.endsWith('.json')) continue
  let j; try { j = JSON.parse(readFileSync(path.join(storeDir, name), 'utf8')) } catch { continue }
  for (const r of j.records || []) {
    if (r.answerText) records.push({ file: name, id: r.id, field: 'answerText', text: r.answerText })
    if (r.reasoningText) records.push({ file: name, id: r.id, field: 'reasoningText', text: r.reasoningText })
  }
}

const NL = String.fromCharCode(10)
// 收集「代码段之外」的可见文本：CODE / PRE 子树整体跳过。
const visibleText = (el, inCode) => {
  const tag = String(el.tagName)
  const code = inCode || tag === 'CODE' || tag === 'PRE'
  if (tag.startsWith('#')) return code ? '' : el.ownText
  return el.children.map(c => visibleText(c, code)).join('')
}
const collect = (el, out, inCode) => {
  const tag = String(el.tagName)
  const code = inCode || tag === 'CODE' || tag === 'PRE'
  if (!tag.startsWith('#') && !code) out.push(tag)
  for (const c of el.children) collect(c, out, code)
}

const BS = String.fromCharCode(92)
const BT = String.fromCharCode(96)
const MARKERS = [
  ['fence', BT + '{3}'],
  ['h1', '^ {0,3}# '],
  ['h2', '^ {0,3}## '],
  ['h3+', '^ {0,3}###+ '],
  ['bold **', BS + '*' + BS + '*(?=' + BS + 'S)'],
  ['strike', '~~(?=' + BS + 'S)'],
  ['italic-star', '(?<![*' + BS + 'w])' + BS + '*(?=' + BS + 'S)'],
  ['list-ul', '^ {0,3}[-*+] '],
  ['list-ol', '^ {0,3}' + BS + 'd+' + BS + '. '],
  ['quote', '^ {0,3}> '],
  ['link', BS + '[[^' + BS + ']' + NL + ']+' + BS + ']' + BS + '([^)' + BS + 's]+' + BS + ')'],
  ['table-row', '^ {0,3}' + BS + '|.*' + BS + '|[' + BS + 't ]*$'],
].map(([n, p]) => [n, new RegExp(p, 'gm')])
const countOf = (t, re) => { let n = 0; re.lastIndex = 0; while (re.exec(t)) { n++; if (re.lastIndex === 0) break } return n }

const totals = new Map()
for (const [n] of MARKERS) totals.set(n, { raw: 0, leak: 0, recWithMarker: 0, recWithLeak: 0 })
const types = new Map()
const leaks = []
let rendered = 0, thrown = 0
// 逐段检查 ** 配对：非代码可见文本里 ** 个数应恒为偶数
const oddBold = []

for (const rec of records) {
  let nodes
  try { nodes = md.renderMarkdownNodes(rec.text) } catch (e) { thrown++; leaks.push({ kind: 'THROW', file: rec.file.slice(-16), field: rec.field, ctx: String(e && e.message).slice(0, 120) }); continue }
  rendered++
  const host = new El('div')
  for (const n of nodes) host.appendChild(n)
  const vis = visibleText(host, false)
  const tags = []; collect(host, tags, false)
  for (const t of tags) types.set(t, (types.get(t) || 0) + 1)
  for (const [name, re] of MARKERS) {
    const before = countOf(rec.text, re)
    const after = countOf(vis, re)
    const t = totals.get(name)
    t.raw += before; t.leak += after
    if (before > 0) t.recWithMarker++
    if (after > 0) {
      t.recWithLeak++
      const i = vis.search(re)
      leaks.push({ kind: name, file: rec.file.slice(-16), field: rec.field, ctx: vis.slice(Math.max(0, i - 50), i + 70).split(NL).join(' / ') })
    }
  }
  const boldCount = countOf(vis, new RegExp(BS + '*' + BS + '*', 'g'))
  if (boldCount % 2 !== 0) oddBold.push({ file: rec.file.slice(-16), field: rec.field, n: boldCount, sample: vis.slice(0, 120).split(NL).join(' / ') })
}

console.log('=== 语料 ===')
console.log('真实落库正文条数（answer 与 reasoning 分开算）:', records.length, ' 成功渲染:', rendered, ' 抛异常:', thrown)
console.log('')
console.log('=== 记号：原始出现 vs 渲染后**非代码区**残留 ===')
console.log('记号'.padEnd(14), '原始'.padStart(7), '残留'.padStart(7), '含该记号正文'.padStart(13), '有残留正文'.padStart(12))
for (const [name, t] of totals) console.log(name.padEnd(14), String(t.raw).padStart(7), String(t.leak).padStart(7), String(t.recWithMarker).padStart(13), String(t.recWithLeak).padStart(12))
console.log('')
console.log('=== 非代码可见文本里 ** 个数为奇数（=真泄漏）的正文 ===')
console.log('条数:', oddBold.length)
for (const o of oddBold.slice(0, 10)) console.log('   ', o.file, o.field, 'n=' + o.n, '|', o.sample)
console.log('')
console.log('=== 渲染出的元素类型统计 ===')
for (const [k, v] of [...types].sort((a, b) => b[1] - a[1])) console.log('   ', k, v)
console.log('')
console.log('=== 残留实例（最多 25 条）===')
for (const e of leaks.slice(0, 25)) console.log('   ', e.kind, '|', e.file, '|', e.field, '|', (e.ctx || '').slice(0, 130))