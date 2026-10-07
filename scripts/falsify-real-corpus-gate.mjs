// 证伪：证明 tests/markdown-real-corpus.test.mjs 真的有区分力。
//
// 三条纪律（都是本轮实际踩出来的）：
//  1. 不直接在仓库里改 src/client/markdown.ts —— 那个文件此刻由 impl-history 的 task-39 在用，
//     两个 agent 同改一个源文件会让红绿结论互相污染（本项目踩过「队友正在写时读到半截状态」）。
//     改动只落在临时副本上。
//  2. **先断言语料非空**。第一版因为一个写错的表达式让语料悄悄变成 0 条，
//     于是所有突变都「没泄漏」-> 全报绿。那不是闸没区分力，是证伪自己空跑了。
//  3. **突变必须真的是突变**。第二版有个突变把原表达式原样注入回去，等于没改，
//     却仍然报「假绿」——差点让我去改一个本来没问题的闸。所以下面每个突变都先自检 changed。
import { build } from 'esbuild'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = '/mnt/d/projects/dsh-explain-assistant'
const STORE = '/home/dsh/.dsh-test/explain-assistant/sessions'

class El {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.attributes = new Map(); this.children = []; this.parentElement = null; this.ownText = '' }
  setAttribute(k, v) { this.attributes.set(k, String(v)) }
  getAttribute(k) { return this.attributes.get(k) ?? null }
  appendChild(n) { n.parentElement = this; this.children.push(n); return n }
  append(...ns) { ns.forEach(n => this.appendChild(n)) }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join('') }
  set textContent(v) { this.ownText = v == null ? '' : String(v); this.children = [] }
  get className() { return this.getAttribute('class') || '' }
  set className(v) { this.setAttribute('class', v) }
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

const NL = String.fromCharCode(10)
const BS = String.fromCharCode(92)
const BT = String.fromCharCode(96)
const AST = String.fromCharCode(42)
const MARKERS = [
  ['fence', BT + '{3}'], ['h1', '^ {0,3}# '], ['h2', '^ {0,3}## '], ['h3+', '^ {0,3}###+ '],
  ['bold', BS + AST + BS + AST + '(?=' + BS + 'S)'],
  ['italic-star', '(?<![*' + BS + 'w])' + BS + AST + '(?=' + BS + 'S)'],
  ['list-ul', '^ {0,3}[-*+] '], ['list-ol', '^ {0,3}' + BS + 'd+' + BS + '. '], ['quote', '^ {0,3}> '],
].map(([n, p]) => [n, new RegExp(p, 'gm')])
const countOf = (t, re) => { let n = 0; re.lastIndex = 0; while (re.exec(t)) { n++; if (re.lastIndex === 0) break } return n }
const visibleText = (el, inCode = false) => { const tag = String(el.tagName); const code = inCode || tag === 'CODE' || tag === 'PRE'; if (tag.startsWith('#')) return code ? '' : el.ownText; return el.children.map(c => visibleText(c, code)).join('') }
const countTag = (el, want) => { const t = String(el.tagName); let n = t === want ? 1 : 0; for (const c of el.children) n += countTag(c, want); return n }

const corpus = []
for (const name of readdirSync(STORE)) {
  if (!name.endsWith('.json')) continue
  let j; try { j = JSON.parse(readFileSync(path.join(STORE, name), 'utf8')) } catch { continue }
  for (const r of j.records || []) {
    if (r.answerText) corpus.push({ file: name, field: 'answerText', text: r.answerText })
    if (r.reasoningText) corpus.push({ file: name, field: 'reasoningText', text: r.reasoningText })
  }
}
if (corpus.length === 0) { console.log('证伪中止：语料 0 条，空跑出来的绿没有意义。'); process.exit(3) }

async function audit(source) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'md-falsify-'))
  const entry = path.join(tmp, 'markdown.ts')
  writeFileSync(entry, source)
  const built = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
  const f = path.join(tmp, 'm.mjs')
  writeFileSync(f, built.outputFiles[0].text)
  const md = await import(pathToFileURL(f).href)
  return withDom(() => {
    let leaks = 0, strong = 0, li = 0
    for (const rec of corpus) {
      const host = new El('div')
      for (const n of md.renderMarkdownNodes(rec.text)) host.appendChild(n)
      const vis = visibleText(host)
      for (const [, re] of MARKERS) leaks += countOf(vis, re)
      const b = countOf(vis, new RegExp(BS + AST + BS + AST, 'g'))
      if (b % 2 !== 0) leaks += 1
      strong += countTag(host, 'STRONG')
      li += countTag(host, 'LI')
    }
    return { leaks, strong, li }
  })
}

const original = readFileSync(path.join(root, 'src/client/markdown.ts'), 'utf8')
const NF = 'export function renderMarkdownNodes(text: string): Node[] {'
const NI = 'export function renderInlineNodes(src: string, depth = 0, index?: CloseIndex): Node[] {'
if (!original.includes(NF) || !original.includes(NI)) { console.log('找不到注入口，脚本需要更新'); process.exit(2) }
const atFn = (needle, body) => original.replace(needle, needle + NL + '  ' + body + NL)

const MUTANTS = [
  ['突变A 完全不解析（整段一个纯文本节点）', atFn(NF, 'return [document.createTextNode(text)];'), 'leak'],
  ['突变B 行内停摆（块级还在，星号全裸露）', atFn(NI, 'return [document.createTextNode(src)];'), 'leak'],
  ['突变C 把星号直接删掉（不出格式，记号也没了）', atFn(NI, 'return [document.createTextNode(src.split(String.fromCharCode(42)).join(""))];'), 'type'],
]

console.log('=== 证伪：真实语料闸是否有区分力 ===')
console.log('语料条数:', corpus.length)
const base = await audit(original)
console.log('基线 泄漏=' + base.leaks + ' STRONG=' + base.strong + ' LI=' + base.li, base.leaks === 0 && base.strong > 100 ? '-> 绿 ✔（与仓库断言一致）' : '-> 意外，先查基线')
console.log('')
let bad = 0
for (const [label, src, expect] of MUTANTS) {
  if (src === original) { console.log(label.padEnd(36), '注入失败（与原文相同），跳过'); bad++; continue }
  const r = await audit(src)
  const leakRed = r.leaks > 0
  const typeRed = !(r.strong > 100 && r.li > 20)
  const caught = expect === 'leak' ? leakRed : typeRed
  if (!caught) bad++
  console.log(label.padEnd(36), '泄漏=' + String(r.leaks).padStart(5), 'STRONG=' + String(r.strong).padStart(5), 'LI=' + String(r.li).padStart(4), caught ? '=> 被闸抓到 ✔（' + (leakRed ? '记号泄漏断言' : '元素类型断言') + '）' : '=> 无人抓到 ✘ 缺口')
}
console.log('')
console.log(bad === 0 ? '结论：三个突变全部被抓到，闸有区分力。' : '结论：有 ' + bad + ' 个突变没被抓到，闸有缺口。')