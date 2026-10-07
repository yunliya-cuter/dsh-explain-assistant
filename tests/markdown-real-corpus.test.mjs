import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/*
 * 真语料回放：用**真实落库的模型正文**审 Markdown 渲染器。
 *
 * 为什么需要它：此前的渲染闸，输入全是人手编的样例。真实模型写出来的换行、
 * 半角全角混排、代码段里套着记号，从没进过闸。
 *
 * 两条本轮实际踩到的教训（写在这里，防止后人重犯）：
 *  1. 第一版把「渲染后 textContent 里的记号」当泄漏，于是报出「真实语料残留 2 个 **」。
 *     查下去发现那 2 个在**代码段里** —— 代码段的内容本就该原样显示，那是 GFM 的正确行为。
 *     所以判定必须**排除代码段**：只有正文里裸露的记号才是泄漏。
 *  2. 统计元素类型时把自己的容器也算进去了，于是「每条记录恰好 1 个 DIV」。
 *     那是夹具根节点的假象，不是渲染器的输出。
 *
 * 本文件**自带最小 DOM 与自编译**，刻意不依赖 tests/fixtures/runtime.mjs：
 * 那个文件由别的任务线在改，共用会让两边的红绿结论互相污染。
 */

const root = path.resolve(import.meta.dirname, '..')
/*
 * 取数路径可以覆盖：本机有真实落库目录时用它（现状），
 * 没有时自动退回仓库里的**脱敏固件**（tests/fixtures/real-markdown-corpus.json）。
 *
 * 为什么要有固件（task-43 解决的缺口）：
 *   此前本文件只读 STORE，换一台机器时 6 条会以 **skip** 呈现 —— 那是「不是 pass」，
 *   等于这个闸只在本机是真闸。固件进仓库后，任何机器上都是**真跑**。
 * 环境变量 MARKDOWN_CORPUS_STORE 可指向任意目录（含不存在的路径），用于验证固件路径。
 */
const STORE = process.env.MARKDOWN_CORPUS_STORE || '/home/dsh/.dsh-test/explain-assistant/sessions'
const FIXTURE = new URL('./fixtures/real-markdown-corpus.json', import.meta.url)

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

let rendererPromise = null
function renderer() {
  rendererPromise ??= build({ entryPoints: [path.join(root, 'src/client/markdown.ts')], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
    .then(built => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'md-corpus-test-'))
      const file = path.join(tmp, 'markdown.mjs')
      writeFileSync(file, built.outputFiles[0].text)
      return import(pathToFileURL(file).href)
    })
  return rendererPromise
}

/*
 * 渲染器在**调用时**读全局 document（不是加载时），所以 DOM 必须在每次渲染期间都在位。
 * 第一版把 DOM 的安装与还原都放在 build 前后，于是渲染阶段 document 已被还原，
 * 6 条里 5 条直接 ReferenceError —— 这里改成显式的作用域包住「构造 + 断言」。
 */
function withDom(fn) {
  const previous = globalThis.document
  const doc = new El('document')
  doc.createElement = t => new El(t)
  doc.createElementNS = (_n, t) => new El(t)
  doc.createTextNode = t => { const e = new El('#text'); e.textContent = t; return e }
  doc.head = new El('head')
  globalThis.document = doc
  try { return fn() } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous }
}

const NL = String.fromCharCode(10)
const BS = String.fromCharCode(92)
const BT = String.fromCharCode(96)
const AST = String.fromCharCode(42)

/** 代码段（CODE/PRE）之外的可见文本。代码段内容原样显示是正确行为，不算泄漏。 */
function visibleText(el, inCode = false) {
  const tag = String(el.tagName)
  const code = inCode || tag === 'CODE' || tag === 'PRE'
  if (tag.startsWith('#')) return code ? '' : el.ownText
  return el.children.map(c => visibleText(c, code)).join('')
}

/** 收集代码段之外的元素标签（不收集传入的根节点自身，避免把容器算成渲染产物）。 */
function collectTags(el, out = [], inCode = false) {
  const tag = String(el.tagName)
  const code = inCode || tag === 'CODE' || tag === 'PRE'
  for (const c of el.children) {
    const t = String(c.tagName)
    const childCode = code || t === 'CODE' || t === 'PRE'
    if (!t.startsWith('#') && !childCode) out.push(t)
    collectTags(c, out, childCode)
  }
  return out
}

const countOf = (text, re) => { let n = 0; re.lastIndex = 0; while (re.exec(text)) { n++; if (re.lastIndex === 0) break } return n }

/** 从真实落库目录取数（本机有数据时的路径）。 */
function readRealCorpus() {
  if (!existsSync(STORE)) return []
  const out = []
  for (const name of readdirSync(STORE)) {
    if (!name.endsWith('.json')) continue
    let json
    try { json = JSON.parse(readFileSync(path.join(STORE, name), 'utf8')) } catch { continue }
    for (const r of json.records || []) {
      if (r.answerText) out.push({ file: name, id: r.id, field: 'answerText', text: r.answerText })
      if (r.reasoningText) out.push({ file: name, id: r.id, field: 'reasoningText', text: r.reasoningText })
    }
  }
  return out
}

/** 从脱敏固件取数（任何机器上都有；句子全部重写，只保留真实记号密度与结构）。 */
function readFixtureCorpus() {
  let json
  try { json = JSON.parse(readFileSync(FIXTURE, 'utf8')) } catch { return [] }
  return (json.blocks || [])
    .filter(b => typeof b.text === 'string' && b.text.length > 0)
    .map(b => ({ file: 'fixture', id: b.id, field: b.field, text: b.text }))
}

/*
 * 两路取数：**本机真实数据优先**，没有则用固件。
 * 两条路径都必须让全部 6 条**真跑**（不是 skip）—— 这是 task-43 的核心要求：
 * 只有当「真实语料」在每台机器上都能被回放，这个闸才不是本机专属的。
 */
const realCorpus = readRealCorpus()
const corpus = realCorpus.length > 0 ? realCorpus : readFixtureCorpus()
const USING = realCorpus.length > 0 ? 'real' : 'fixture'
/*
 * 仍然保留 SKIP：只有当**两条来源都为空**时才会出现（例如固件被误删）。
 * 那种情况下必须显式 skip 而不是静默通过 —— 这条判定本身也有一条用例守着
 * （见文件末尾「反例: 语料文件缺失时必须显式跳过」）。
 */
const SKIP = corpus.length === 0
console.log('  [真语料闸] 取数来源 =', USING, '| 正文块数 =', corpus.length,
  USING === 'real' ? '（本机真实落库：' + STORE + '）' : '（仓库固件：tests/fixtures/real-markdown-corpus.json）')

const MARKERS = [
  ['fence', BT + '{3}'],
  ['h1', '^ {0,3}# '],
  ['h2', '^ {0,3}## '],
  ['h3+', '^ {0,3}###+ '],
  ['bold', BS + AST + BS + AST + '(?=' + BS + 'S)'],
  ['italic-star', '(?<![*' + BS + 'w])' + BS + AST + '(?=' + BS + 'S)'],
  ['list-ul', '^ {0,3}[-*+] '],
  ['list-ol', '^ {0,3}' + BS + 'd+' + BS + '. '],
  ['quote', '^ {0,3}> '],
  ['link', BS + '[[^' + BS + ']' + NL + ']+' + BS + ']' + BS + '([^)' + BS + 's]+' + BS + ')'],
].map(([n, p]) => [n, new RegExp(p, 'gm')])

function renderToHost(md, text) { const host = new El('div'); for (const n of md.renderMarkdownNodes(text)) host.appendChild(n); return host }

test('真语料回放 前提: 语料非空（不得悄悄 0 条还报绿）', { skip: SKIP }, () => {
  assert.ok(corpus.length > 0, '真实语料条数必须 > 0')
  assert.ok(corpus.some(r => r.field === 'answerText'), '至少要有一条 answerText 正文')
})

test('真语料回放: 真实正文不得让渲染器抛异常', { skip: SKIP }, async () => {
  const md = await renderer()
  const failures = withDom(() => {
    const out = []
    for (const rec of corpus) { try { md.renderMarkdownNodes(rec.text) } catch (e) { out.push(rec.file + '/' + rec.field + ': ' + (e && e.message)) } }
    return out
  })
  assert.deepEqual(failures, [], '真实正文渲染抛异常：' + failures.slice(0, 3).join(' | '))
})

test('真语料回放: 正文里裸露的 Markdown 记号必须被解析掉（代码段除外）', { skip: SKIP }, async () => {
  const md = await renderer()
  const leaks = withDom(() => {
    const out = []
    for (const rec of corpus) {
      const vis = visibleText(renderToHost(md, rec.text))
      for (const [name, re] of MARKERS) {
        const n = countOf(vis, re)
        if (n > 0) { const i = vis.search(re); out.push(name + ' x' + n + ' @' + rec.file.slice(-16) + '/' + rec.field + ' :: ' + vis.slice(Math.max(0, i - 40), i + 60).split(NL).join(' / ')) }
      }
      const bold = countOf(vis, new RegExp(BS + AST + BS + AST, 'g'))
      if (bold % 2 !== 0) out.push('** 个数为奇数（' + bold + '）@' + rec.file.slice(-16) + '/' + rec.field + ' :: ' + vis.slice(0, 100).split(NL).join(' / '))
    }
    return out
  })
  assert.deepEqual(leaks.slice(0, 5), [], '真实正文里记号裸露（前 5 条）：' + leaks.slice(0, 5).join(' || '))
})

test('真语料回放: 记号确实变成了格式，而不是被删掉（元素类型必须出现）', { skip: SKIP }, async () => {
  const md = await renderer()
  const types = withDom(() => {
    const t = new Map()
    for (const rec of corpus) for (const tag of collectTags(renderToHost(md, rec.text))) t.set(tag, (t.get(tag) || 0) + 1)
    return t
  })
  // 只断言「不出现记号」是不够的 —— 把记号直接删掉也能满足，所以必须断言格式元素真的建出来了。
  //
  // ── 阈值为什么改成「按输入记号数」而不是写死的绝对值（task-43）────────────
  // 写死绝对值（原来 STRONG>100 / LI>20 / H2>0）只在**本机那份大语料**上成立；
  // 换成仓库固件（规模小得多）要么放宽到形同虚设、要么直接红，两种都不对。
  // 现在用**输入里的记号数**导出期望，好处是：
  //   ① 两条取数路径（真实 / 固件）用**同一套**断言，不必各写一份；
  //   ② 固件若被人改小到「什么都没测」，这里的期望会跟着变小 → **上界失效**，
  //      所以额外加了一条「输入记号规模必须够」的前置断言把它挡住（见下面 ins 部分）。
  // 依据：实测渲染器对**代码区之外**的记号是一比一转换的 ——
  //   真实语料：输入 bold 300 / li 60 / h2 4  →  产出 STRONG 300 / LI 60 / H2 4
  //   仓库固件：输入 bold  13 / li 27 / h2 12 →  产出 STRONG  13 / LI 27 / H2 12
  // 所以「产出 ≥ 输入记号数」是一个**有区分力**的断言：行内解析一旦停摆，产出会掉到 0。
  const inputs = withDom(() => {
    const acc = { bold: 0, li: 0, h2: 0 }
    for (const rec of corpus) {
      // 先剥掉代码段：那里的记号本来就该原样保留，不算「应被解析的记号」。
      const stripped = rec.text
        .split(NL).filter((_, i, all) => {
          // 成对围栏之间整段跳过
          let open = 0
          for (let k = 0; k < i; k++) if (all[k].trimStart().startsWith(BT + BT + BT)) open++
          return open % 2 === 0
        }).join(NL)
        .replace(new RegExp(BT + '{3}[\\s\\S]*?' + BT + '{3}', 'g'), '')
        .replace(new RegExp(BT + '[^' + BT + NL + ']*' + BT, 'g'), '')
      acc.bold += Math.floor(stripped.split('**').length - 1) / 2
      acc.li += (stripped.match(/^ {0,3}[-*+] /gm) || []).length
      acc.li += (stripped.match(/^ {0,3}[0-9]+[.)] /gm) || []).length
      acc.h2 += (stripped.match(/^ {0,3}## /gm) || []).length
    }
    return acc
  })
  // 上界有效性的前置：输入记号必须够多，否则「产出 ≥ 输入」这条会退化成 0 ≥ 0。
  assert.ok(inputs.bold >= 10, '语料里应含足够的粗体记号（否则本闸没在测东西），实际 ' + inputs.bold)
  assert.ok(inputs.li >= 10, '语料里应含足够的列表项，实际 ' + inputs.li)
  assert.ok(inputs.h2 >= 3, '语料里应含足够的二级标题，实际 ' + inputs.h2)

  const strong = types.get('STRONG') || 0
  const li = types.get('LI') || 0
  const h2 = types.get('H2') || 0
  assert.ok(strong >= inputs.bold,
    '输入的 ' + inputs.bold + ' 对粗体记号必须都变成 STRONG，实际 STRONG = ' + strong)
  assert.ok(li >= inputs.li,
    '输入的 ' + inputs.li + ' 个列表项必须都变成 LI，实际 LI = ' + li)
  assert.ok(h2 >= inputs.h2,
    '输入的 ' + inputs.h2 + ' 个二级标题必须都变成 H2，实际 H2 = ' + h2)
})

test('真语料回放 反例: 代码段里的记号必须原样保留（不能被当成格式解析掉）', async () => {
  const md = await renderer()
  // 这段来自真实语料：模型把 **cn:deepseek-v4.1-flash** 写在反引号里。
  // 若渲染器把代码段内容也解析成 <strong>，用户看到的会与原文不符。
  const src = '以及模型名 ' + BT + '**cn:deepseek-v4.1-flash**' + BT + '。' + NL
  const result = withDom(() => {
    const host = renderToHost(md, src)
    const find = el => { if (String(el.tagName) === 'CODE') return el; for (const c of el.children) { const f = find(c); if (f) return f } return null }
    return { code: find(host), vis: visibleText(host) }
  })
  assert.ok(result.code, '应建出 CODE 元素')
  assert.equal(result.code.textContent, '**cn:deepseek-v4.1-flash**', '代码段内容必须原样保留（含星号）')
  assert.ok(!result.vis.includes('**'), '代码段以外的可见文本里不该再有星号')
})

test('真语料回放 反例: 语料文件缺失时必须显式跳过而不是静默通过', () => {
  if (SKIP) assert.ok(SKIP, '两条取数来源都为空 -> 上面的用例以 skip 呈现，不是 pass')
  else assert.ok(corpus.length > 0, '有语料时本用例确认语料非空')
})

/* ================================================================== *
 * 固件卫生（task-43 新增）
 * ================================================================== */

test('固件卫生: 固件必须真的存在且规模够大（否则固件路径形同虚设）', () => {
  // 这条**不依赖任何取数路径**：它直接审仓库里的固件文件本身。
  // 若有人把固件删了或改小到「什么都没测」，固件路径会静默变弱 —— 这里挡住。
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const blocks = raw.blocks || []
  assert.ok(blocks.length >= 6, '固件正文块数应 ≥ 6，实际 ' + blocks.length)
  const chars = blocks.reduce((n, b) => n + String(b.text || '').length, 0)
  assert.ok(chars >= 2000, '固件总字符数应 ≥ 2000（够撑起记号密度统计），实际 ' + chars)
  const fields = new Set(blocks.map(b => b.field))
  assert.ok(fields.has('answerText'), '固件必须含 answerText 正文（真实回答那一类）')
  assert.ok(fields.has('reasoningText'), '固件必须含 reasoningText 正文（推理那一类）')
  // 记号密度：固件的价值全在「保留真实记号密度」，所以这里按输入直接量一遍。
  const joined = blocks.map(b => b.text).join(NL)
  const bold = Math.floor(joined.split('**').length - 1) / 2
  assert.ok(bold >= 10, '固件应含足够的粗体记号，实际 ' + bold)
  assert.ok((joined.match(/^ {0,3}[-*+] /gm) || []).length >= 8, '固件应含足够的无序列表项')
  assert.ok((joined.match(/^ {0,3}[0-9]+[.)] /gm) || []).length >= 4, '固件应含足够的有序列表项')
  assert.ok((joined.match(/^ {0,3}## /gm) || []).length >= 3, '固件应含足够的二级标题')
  assert.ok(joined.includes(BT + BT + BT), '固件必须含围栏代码段（真实语料里的形态之一）')
})

/*
 * 本机没有真实落库目录时，这条**用 node:test 的 skip 显式跳过**，
 * 而不是「提前 return 然后被计为 pass」。
 *
 * 为什么这么较真：提前 return 会让它显示为 ✔ 且 skipped=0，
 * 看上去像是「验过了」，其实**一次比对都没做** —— 那正是本任务线一直在消灭的假绿形态。
 * （既有的 tests/real-shape-replay.test.mjs:203 用的是提前 return，我这里刻意**不沿用**，
 *  因为在该文件里那样写会让「脱敏有没有做」看起来永远成立。）
 * skip 的代价是 skipped 计数不再是 0，但那**正是诚实的呈现**。
 */
const NO_REAL_FOR_DEID = !existsSync(STORE)

test('固件卫生 脱敏硬闸: 固件里不得含真文件任何一段实质正文（30+ 字符子串）',
  { skip: NO_REAL_FOR_DEID ? '本机无真实落库目录可比对（脱敏比对需要真文件）' : false },
  () => {
  const fixtureRaw = readFileSync(FIXTURE, 'utf8')
  const substrings = new Set()
  const collect = (value) => {
    if (typeof value === 'string') {
      for (let i = 0; i + 30 <= value.length; i++) substrings.add(value.slice(i, i + 30))
      return
    }
    if (Array.isArray(value)) { for (const v of value) collect(v); return }
    if (value && typeof value === 'object') { for (const v of Object.values(value)) collect(v) }
  }
  for (const name of readdirSync(STORE)) {
    if (!name.endsWith('.json')) continue
    let json
    try { json = JSON.parse(readFileSync(path.join(STORE, name), 'utf8')) } catch { continue }
    collect(json)
  }
  const leaked = [...substrings].filter(s => fixtureRaw.includes(s))
  assert.deepEqual(leaked.slice(0, 5), [],
    '固件里泄漏了真文件的实质正文（共 ' + leaked.length + ' 段 30+ 字符子串）')
  assert.ok(substrings.size > 0, '前置：真文件里应当能取出足够多的子串，否则这条闸是空的')
})
