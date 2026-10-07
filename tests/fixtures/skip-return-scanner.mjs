import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * 扫描器：找出「test 用例体内、在任何断言之前就 return」的情况。
 *
 * 为什么需要它（task-44）：
 *   node:test 把「体内提前 return 且无断言失败」计为 **pass**（不是 skip）。
 *   所以「用 return 当作跳过」的写法在**没有数据的机器上**会报绿，却一次比对都没做 ——
 *   本机看不出来，换机器就是假绿。这类问题不该靠人眼发现。
 *
 * 判据（刻意避开误报/漏报，见 docs/evidence/skip-vs-return-sweep.md）：
 *   ① 断言写在**辅助函数**里要算数 —— 用例体内 0 个 assert 但调用了 assertMarkdownized()，
 *      那是有断言的（Lead 第一版扫描器就把它误报了）。
 *   ② **回调里的 return 不算** —— 箭头函数体、普通函数体、**对象/类的方法简写**都算回调。
 *      这一条是实测补上的：第一版只认 `=> {` 与 `function {`，于是把
 *      `subscribe(l) { ... return ... }`、类方法、generator 方法全误报成候选（实测 13 条里 10 条是它）。
 *   ③ 显式声明了 { skip: ... } 的用例直接放行（那是正确的跳过写法）。
 */

/** 把注释与字符串替换成等长空格，保留偏移量（便于定位行号）。 */
function strip(src) {
  const out = src.split('')
  const BT_CH = String.fromCharCode(96)
  const NL = String.fromCharCode(10)
  const BS = String.fromCharCode(92)
  let i = 0
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== NL) out[i++] = ' '; continue }
    if (c === '/' && n === '*') {
      out[i++] = ' '; out[i++] = ' '
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        // 换行必须保留：否则 stripped 的行号会与原文漂移（实测差 57 行）。
        out[i] = src[i] === String.fromCharCode(10) ? String.fromCharCode(10) : ' '
        i++
      }
      if (i < src.length) { out[i++] = ' '; out[i++] = ' ' }
      continue
    }
    const q = c
    if (q === '"' || q === String.fromCharCode(39) || q === BT_CH) {
      out[i++] = ' '
      while (i < src.length && src[i] !== q) {
        if (src[i] === BS) { out[i++] = ' '; if (i < src.length) out[i++] = ' '; continue }
        if (src[i] === NL && q !== BT_CH) break
        out[i++] = ' '
      }
      if (i < src.length) out[i++] = ' '
      continue
    }
    i++
  }
  return out.join('')
}

function matchBrace(s, open) {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d++
    else if (s[i] === '}') { d--; if (d === 0) return i }
  }
  return -1
}

function matchParen(s, open) {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')') { d--; if (d === 0) return i }
  }
  return -1
}

/** 控制关键字：它们后面跟括号，但不是「函数体」。 */
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'do', 'else', 'await', 'yield', 'delete', 'void', 'in', 'of', 'case'])

/** 本地「会断言的辅助函数」名字集合。 */
function assertHelpers(s) {
  const names = new Set()
  const consider = (name, bodyStart) => {
    if (bodyStart === -1) return
    const end = matchBrace(s, bodyStart)
    if (end === -1) return
    if (/\bassert\b/.test(s.slice(bodyStart, end))) names.add(name)
  }
  for (const m of s.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    consider(m[1], s.indexOf('{', m.index))
  }
  for (const m of s.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(/g)) {
    const arrow = s.indexOf('=>', m.index)
    if (arrow === -1) continue
    consider(m[1], s.indexOf('{', arrow))
  }
  return names
}

/** 找出所有 test(...) 调用，返回用例体与其绝对偏移。 */
function findTests(s) {
  const out = []
  for (const m of s.matchAll(/(?:^|\n)[ \t]*test(?:\.\w+)?\s*\(/g)) {
    const open = s.indexOf('(', m.index)
    const close = matchParen(s, open)
    if (close === -1) continue
    const args = s.slice(open + 1, close)
    const argsAbs = open + 1
    const hasSkip = /\{[^}]*\bskip\s*:/.test(args)
    const arrow = args.indexOf('=>')
    if (arrow === -1) continue
    const braceRel = args.indexOf('{', arrow)
    if (braceRel === -1) continue
    const endRel = matchBrace(args, braceRel)
    if (endRel === -1) continue
    out.push({
      // m.index 落在「行首或换行」处，要报告含 test( 的那一行，故把索引推到 test 本身再数。
      line: s.slice(0, m.index + m[0].indexOf('test')).split(String.fromCharCode(10)).length,
      hasSkip,
      body: args.slice(braceRel + 1, endRel),
      bodyAbs: argsAbs + braceRel + 1,
    })
  }
  return out
}

/**
 * body 内嵌套函数体的区间 —— 用于排除**回调里的 return**。
 *
 * 三种嵌套形态都要认（这是实测补出来的，只认前两种会大量误报）：
 *   · 箭头函数块体      map(x => { ... })
 *   · 普通函数声明/表达式 function f() { ... }
 *   · **方法简写**       obj = { subscribe(l) { ... } } / class 里的 method() { ... }
 */
function nestedSpans(body) {
  const spans = []
  const push = (b) => { if (b === -1) return; const e = matchBrace(body, b); if (e !== -1) spans.push([b, e]) }
  for (const m of body.matchAll(/=>\s*\{/g)) push(m.index + m[0].length - 1)
  for (const m of body.matchAll(/\bfunction\b[^{]*\{/g)) push(m.index + m[0].length - 1)
  // 方法简写，含 async / generator：subscribe(l) { } / async listModels(p) { } / async *stream() { }
  for (const m of body.matchAll(/(?:^|[\s,{(])(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*(\([^()]*\))\s*\{/g)) {
    if (KEYWORDS.has(m[1])) continue
    if (/\b(?:test|describe|it)\b/.test(m[1])) continue
    push(m.index + m[0].length - 1)
  }
  return spans
}

export function scanEarlyReturns(raw, fileName) {
  const s = strip(raw)
  const helpers = assertHelpers(s)
  const helperRe = helpers.size ? new RegExp('\\b(?:' + [...helpers].join('|') + ')\\s*\\(') : null
  const findings = []
  for (const t of findTests(s)) {
    if (t.hasSkip) continue
    const spans = nestedSpans(t.body)
    const inNested = pos => spans.some(([a, b]) => pos > a && pos < b)
    for (const m of t.body.matchAll(/\breturn\b/g)) {
      if (inNested(m.index)) continue
      const before = t.body.slice(0, m.index)
      const hasAssertBefore = /\bassert\b/.test(before) || (helperRe ? helperRe.test(before) : false)
      if (hasAssertBefore) continue
      findings.push({
        file: fileName,
        line: raw.slice(0, t.bodyAbs + m.index).split(String.fromCharCode(10)).length,
        declLine: t.line,
      })
    }
  }
  return findings
}

export function scanDir(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.test.mjs')) continue
    out.push(...scanEarlyReturns(readFileSync(path.join(dir, name), 'utf8'), name))
  }
  return out
}
