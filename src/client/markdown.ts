/**
 * 回答正文的 Markdown 渲染。
 *
 * 用户原话：「没有对 md 的符号进行解析。我希望能够解析的同时还保证性能。」
 * 两件事必须同时成立：**记号要变成格式**，且**流式吐字时不能卡**。
 *
 * ── 为什么不引第三方库 ────────────────────────────────────────────────
 * 主对话界面自己那套渲染器（dsh-client-ui-primitives 的 MarkdownText）确实已经打进
 * 页面里，但它是 React 组件、依赖 react-dom/client；本插件的浮窗是**命令式 DOM**
 * （见 overlay.tsx 的 el()）。更要紧的是：本仓库的测试跑在假 DOM 里，React 树在那儿
 * 根本渲染不出来 —— 复用它等于把「解析对不对」变成只有人眼在页面上才能验的事。
 * 所以自写一层：纯 DOM、零依赖、能在假 DOM 里逐条断言，也能在真页面上跑同一份代码。
 *
 * ── 性能怎么保证 ────────────────────────────────────────────────────
 * 流式回答期间宿主每来一个分片就重画一次（一次回答几十到几百次）。若每次都整篇重新
 * 解析并重建 DOM，代价随长度线性增长、总代价平方级 —— 这就是「越解析越慢」。
 * 这里做三件事：
 *   1. **块级冻结**：已终结的块（后面跟着空行 / 代码围栏已闭合）DOM 只建一次，
 *      之后一直复用同一批节点对象，不再重新解析。每来一个分片只重解析**最后一块**。
 *   2. **代码块增量追加**：正在生长的代码围栏不重写 textContent，只追加新增的那一段。
 *   3. **只替换尾部**：调用方通过 mountMarkdown 把冻结前缀原样留在容器里，只换尾部节点；
 *      冻结部分的 DOM 连挪动都不会发生（否则会打断浏览器的滚动锚定，表现为跳变）。
 *
 * ── 安全 ────────────────────────────────────────────────────────────
 * 全程只用 createElement / textContent，**从不碰 innerHTML**。链接只允许
 * http/https/mailto 变成可点锚点，其他协议（javascript:、data:、file:）一律退回纯文本。
 */

/* ------------------------------------------------------------------ *
 * DOM 小工具（本文件自足，不依赖 overlay.tsx，避免循环引用）
 * ------------------------------------------------------------------ */

function node(tag: string, className?: string, text?: string): HTMLElement {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function appendAll(parent: Node, children: (Node | null | undefined)[]): void {
  for (const child of children) if (child) parent.appendChild(child)
}

/* ------------------------------------------------------------------ *
 * 字符分类
 * ------------------------------------------------------------------ */

function isSpace(ch: string | undefined): boolean { return ch === undefined || /\s/.test(ch) }
function isWordChar(ch: string | undefined): boolean { return !!ch && /[\p{L}\p{N}]/u.test(ch) }

function countRun(src: string, from: number, ch: string): number {
  let n = 0
  while (from + n < src.length && src[from + n] === ch) n++
  return n
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>', '~', '|', '"', "'"])

/**
 * 一段强调记号能不能「开」。
 * 规则（CommonMark 左右侧翼规则的简化版）：后面不能是空白；
 * 下划线夹在字母/数字之间时既不能开也不能合（foo_bar_baz 不该变斜体）。
 */
function delimCanOpen(src: string, at: number, run: number, ch: string): boolean {
  const next = src[at + run]
  if (isSpace(next)) return false
  if (ch === '_' && isWordChar(src[at - 1]) && isWordChar(next)) return false
  return true
}

function delimCanClose(src: string, at: number, run: number, ch: string): boolean {
  const prev = src[at - 1]
  if (isSpace(prev)) return false
  const next = src[at + run]
  if (ch === '_' && isWordChar(prev) && isWordChar(next)) return false
  return true
}

function findClosingBackticks(src: string, from: number, run: number): number {
  let i = from
  while (i < src.length) {
    if (src[i] === '`') {
      const n = countRun(src, i, '`')
      if (n === run) return i
      i += n
      continue
    }
    i++
  }
  return -1
}

/** 跳过一段代码跨度，返回结束后的下标；找不到闭合返回 -1。 */
function skipCodeSpan(src: string, at: number): number {
  const run = countRun(src, at, '`')
  const close = findClosingBackticks(src, at + run, run)
  return close === -1 ? -1 : close + run
}

/**
 * 从开记号之后找配对的闭记号。
 *
 * 关键在于**同一字符的嵌套计数**：`*a **b** c*` 里中间那两个 ** 是嵌套的强记号，
 * 不能被当成外层 * 的闭合 —— 否则会渲染成 <em>a **b</em> c*。
 * 所以扫描时维护 nesting：只能开不能合的进一层；能合且 nesting>0 的出一层；
 * 只有 nesting 归零时的可合记号才是真正的闭合。
 */
function findClose(src: string, from: number, ch: string, openRun: number, index?: CloseIndex): { at: number; len: number } | undefined {
  const table = index ?? closeIndexOf(src)
  let i = from
  let nesting = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === '`') {
      const after = skipCodeSpan(src, i)
      if (after !== -1) { i = after; continue }
      i += countRun(src, i, '`')
      continue
    }
    if (c === '[') {
      const link = matchLink(src, i, table)
      if (link) { i = link.end; continue }
      i++
      continue
    }
    if (c !== ch) { i++; continue }
    const run = countRun(src, i, ch)
    const canOpen = delimCanOpen(src, i, run, ch)
    const canClose = delimCanClose(src, i, run, ch)
    if (canClose && nesting === 0) {
      if (run >= openRun || openRun === 1) return { at: i, len: Math.min(openRun, run) }
    }
    if (canOpen && !canClose) nesting++
    else if (canClose && nesting > 0) nesting--
    i += run
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * 行内
 * ------------------------------------------------------------------ */

/**
 * 每个位置「下一个未转义的 `]` / `)` 在哪」的预计算表。
 *
 * ── 为什么必须有这张表（用户点名要求「保证性能」）──────────────
 * 朴素写法在找不到闭合符时会**从当前位置一路扫到字符串结尾**。于是：
 *   · 一串没有闭合的 `[`（模型吐出半个链接、或正文里本来就有很多方括号）→ 每个位置都扫到尾部 → O(n²)；
 *   · 深嵌套方括号 → 同上。
 * 实测（修前）：8000 个 `[` 要 150ms、16000 个要 611ms、32000 个要 2624ms ——
 * 而 8000 字普通中文只要 2ms。4 倍输入、17 倍耗时，是明确的平方级。
 * 这不只是「慢」：流式期间每来一个分片就要重解析一次，卡住的是整个页面。
 *
 * 修法：整段扫描**一次**，把每个下标对应的「下一个闭合符位置」先算出来（O(n) 时间、O(n) 空间），
 * 之后每次探测都是查表 O(1)。转义符（反斜杠）在预计算时就已经排除。
 *
 * 表只在缺少闭合符时用于**快速否定**：查到「这里根本没有下一个 ]」就直接返回 undefined，
 * 不再扫。有限的层数仍由下面的 depth 上限与 depth>=8 的截断兜住。
 */
type CloseIndex = { bracket: Int32Array; paren: Int32Array }

function buildCloseIndex(src: string): CloseIndex {
  const n = src.length
  const bracket = new Int32Array(n + 1)
  const paren = new Int32Array(n + 1)
  bracket[n] = -1
  paren[n] = -1
  let nextBracket = -1
  let nextParen = -1
  for (let i = n - 1; i >= 0; i--) {
    const c = src[i]
    // 被反斜杠转义的字符不算闭合符：\] 是字面量。
    if (c === '\\' && i + 1 < n) {
      bracket[i] = nextBracket
      paren[i] = nextParen
      i-- // 跳过被转义的那个字符本身
      bracket[i] = nextBracket
      paren[i] = nextParen
      continue
    }
    if (c === ']') nextBracket = i
    else if (c === ')') nextParen = i
    bracket[i] = nextBracket
    paren[i] = nextParen
  }
  return { bracket, paren }
}

/** 查表：从 from 起（含）下一个未转义的该字符在哪；没有则 -1。 */
function nextClose(index: CloseIndex, which: 'bracket' | 'paren', from: number, src: string): number {
  if (from < 0) return -1
  if (from >= src.length) return -1
  return (which === 'bracket' ? index.bracket : index.paren)[from]
}

let closeIndex: CloseIndex | null = null
let closeIndexSource: string | null = null

/** 取当前文本的预计算表，同一份文本只算一次（流式下同一文本可能被反复查询）。 */
function closeIndexOf(src: string): CloseIndex {
  if (closeIndex && closeIndexSource === src) return closeIndex
  closeIndex = buildCloseIndex(src)
  closeIndexSource = src
  return closeIndex
}

/** [文字](地址) / ![替代文字](地址)：只做语法识别，安全判定在生成节点处。 */
function matchLink(src: string, at: number, index?: CloseIndex): { image: boolean; label: string; dest: string; end: number } | undefined {
  let i = at
  const image = src[i] === '!' && src[i + 1] === '['
  if (image) i++
  if (src[i] !== '[') return undefined
  const table = index ?? closeIndexOf(src)
  // 快速否定：这一段后面**根本没有**未转义的 "]" 就直接放弃，不再扫。
  // 这一条就是修掉平方级的那个关键动作 —— 长串 "[" 每一个位置都会走到这里，O(1) 就返回。
  if (nextClose(table, 'bracket', i + 1, src) === -1) return undefined
  let depth = 0
  let j = i
  for (; j < src.length; j++) {
    const c = src[j]
    if (c === '\\') { j++; continue }
    if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) break }
  }
  if (j >= src.length || src[j] !== ']') return undefined
  const label = src.slice(i + 1, j)
  if (src[j + 1] !== '(') return undefined
  if (nextClose(table, 'paren', j + 2, src) === -1) return undefined
  let k = j + 2
  let destDepth = 0
  let raw = ''
  for (; k < src.length; k++) {
    const c = src[k]
    if (c === '\\') { raw += src[k + 1] ?? ''; k++; continue }
    if (c === '(') destDepth++
    if (c === ')') { if (destDepth === 0) break; destDepth-- }
    raw += c
  }
  if (k >= src.length || src[k] !== ')') return undefined
  let dest = raw.trim()
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(dest)
  if (titled) dest = titled[1]
  if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1)
  return { image, label, dest, end: k + 1 }
}

/** 只有这几种协议允许变成真正可点的链接；其余一律退回纯文本。 */
function safeHref(dest: string): string | undefined {
  const value = dest.trim()
  if (!value) return undefined
  if (/^(https?:|mailto:)/i.test(value)) return value
  return undefined
}

/** 行内代码：按 CommonMark 去掉首尾各一个空格（当且仅当两端都是空格且不全是空格）。 */
function codeSpanText(raw: string): string {
  let text = raw.replace(/\n/g, ' ')
  if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim()) text = text.slice(1, -1)
  return text
}

/**
 * 把一段行内文本渲染成节点数组。
 * depth 是防御性的深度上限：异常深层嵌套不该把页面拖死。
 */
export function renderInlineNodes(src: string, depth = 0, index?: CloseIndex): Node[] {
  const out: Node[] = []
  if (!src) return out
  // 预计算表整段只建一次，递归与循环共用 —— 这是把行内扫描压回线性的关键。
  const table = index ?? closeIndexOf(src)
  let buffer = ''
  const flush = () => { if (buffer) { out.push(document.createTextNode(buffer)); buffer = '' } }

  let i = 0
  while (i < src.length) {
    const ch = src[i]

    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      buffer += src[i + 1]
      i += 2
      continue
    }

    if (ch === '`') {
      const run = countRun(src, i, '`')
      const close = findClosingBackticks(src, i + run, run)
      if (close !== -1) {
        flush()
        out.push(node('code', 'ea-md-code', codeSpanText(src.slice(i + run, close))))
        i = close + run
        continue
      }
      buffer += src.slice(i, i + run)
      i += run
      continue
    }

    if (ch === '<') {
      const end = src.indexOf('>', i + 1)
      if (end !== -1) {
        const inside = src.slice(i + 1, end)
        if (/^(https?:|mailto:)\S*$/i.test(inside)) {
          flush()
          const anchor = node('a', 'ea-md-link', inside)
          anchor.setAttribute('href', inside)
          anchor.setAttribute('target', '_blank')
          anchor.setAttribute('rel', 'noreferrer noopener')
          out.push(anchor)
          i = end + 1
          continue
        }
      }
      buffer += ch
      i++
      continue
    }

    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const link = matchLink(src, i)
      if (link) {
        flush()
        const href = safeHref(link.dest)
        if (link.image) {
          if (href) {
            const image = node('img', 'ea-md-image') as HTMLImageElement
            image.setAttribute('src', href)
            image.setAttribute('alt', link.label)
            image.setAttribute('loading', 'lazy')
            out.push(image)
          } else {
            out.push(node('span', 'ea-md-image-alt', link.label))
          }
        } else if (href) {
          const anchor = node('a', 'ea-md-link')
          appendAll(anchor, depth >= 8 ? [document.createTextNode(link.label)] : renderInlineNodes(link.label, depth + 1))
          anchor.setAttribute('href', href)
          anchor.setAttribute('target', '_blank')
          anchor.setAttribute('rel', 'noreferrer noopener')
          out.push(anchor)
        } else {
          // 协议不安全：只渲染文字，绝不生成可点锚点。
          if (depth >= 8) out.push(document.createTextNode(link.label))
          else out.push(...renderInlineNodes(link.label, depth + 1))
        }
        i = link.end
        continue
      }
      buffer += ch
      i++
      continue
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const run = countRun(src, i, ch)
      if (ch !== '~' || run >= 2) {
        if (delimCanOpen(src, i, run, ch)) {
          const close = findClose(src, i + run, ch, run)
          if (close) {
            flush()
            const inner = src.slice(i + run, close.at)
            const children = depth >= 8 ? [document.createTextNode(inner)] : renderInlineNodes(inner, depth + 1)
            if (ch === '~') {
              const element = node('del', 'ea-md-del')
              appendAll(element, children)
              out.push(element)
            } else if (run >= 3 && close.len >= 3) {
              const strong = node('strong', 'ea-md-strong')
              const em = node('em', 'ea-md-em')
              appendAll(em, children)
              strong.appendChild(em)
              out.push(strong)
            } else {
              const element = node(run >= 2 && close.len >= 2 ? 'strong' : 'em', run >= 2 && close.len >= 2 ? 'ea-md-strong' : 'ea-md-em')
              appendAll(element, children)
              out.push(element)
            }
            i = close.at + close.len
            continue
          }
        }
      }
      buffer += src.slice(i, i + run)
      i += run
      continue
    }

    buffer += ch
    i++
  }
  flush()
  return out
}

/* ------------------------------------------------------------------ *
 * 块级扫描
 * ------------------------------------------------------------------ */

export type MarkdownBlock = {
  type: 'paragraph' | 'heading' | 'code' | 'list' | 'quote' | 'hr' | 'table'
  start: number
  end: number
  /** 已经被确定终结（后面跟着空行，或代码围栏已闭合）。只有终结的块才允许冻结。 */
  closed: boolean
  level?: number
  text?: string
  info?: string
  ordered?: boolean
  /** 有序列表的起始号（CommonMark 的 <ol start>）。仅当不是 1 时才需要写进 DOM。 */
  startNumber?: number
  items?: { text: string }[]
  /** 表格表头单元格（已按未转义竖线切开、已 trim）。 */
  header?: string[]
  /** 表格每列对齐（GFM 的 :--- / :---: / ---:）。null = 默认左对齐。 */
  align?: (string | null)[]
  /** 表格正文行；短行在渲染时补空、长行丢弃，保证列不错位。 */
  rows?: string[][]
}

const FENCE = /^ {0,3}(\x60{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/
const QUOTE = /^ {0,3}>/
const BLANK = /^[ \t]*$/

type Line = { text: string; start: number; end: number }

/**
 * 按换行切行。
 *
 * 行尾的回车必须在这里去掉：模型（尤其经过某些代理/网关时）会吐 CRLF，
 * 而若把回车留在行文本里，「井号 标题 回车」匹配不上标题规则、空行变成「回车」
 * 匹配不上空行规则 —— **整篇会退化**：标题不识别、列表不识别、段落之间不再被空行切开。
 * 实测（对抗性审查）：CRLF 下 h1 与 li 全部消失、两个段落被并成一个。
 *
 * 注意 end 仍然指向换行符本身的位置，不随去掉的回车变化 ——
 * 增量渲染器靠 start/end 记账并据此冻结前缀，偏移量不能整体重排。
 */
function splitLines(src: string, from: number): Line[] {
  const lines: Line[] = []
  let i = from
  for (;;) {
    let nl = src.indexOf('\n', i)
    if (nl === -1) nl = src.length
    let end = nl
    if (end > i && src[end - 1] === '\r') end--
    lines.push({ text: src.slice(i, end), start: i, end: nl })
    if (nl >= src.length) break
    i = nl + 1
  }
  return lines
}

/**
 * 单个块最多允许多长还不终结。
 *
 * 存在的理由：模型偶尔会吐出一整段没有任何空行的长文。那种情况下「最后一块」
 * 就等于整篇，冻结永远轮不到它，代价又退回平方级。超过这个长度就在**行边界**上
 * 把已经确定的部分切出来冻结 —— 按行切不会切断行内记号，视觉上也仍然是一段话。
 */
const MAX_OPEN_PARAGRAPH = 1500
const KEEP_OPEN_TAIL = 600

/** 表格分隔行里的单个单元格：--- / :--- / ---: / :---: 。 */
const DELIM_CELL = /^:?-+:?$/

/**
 * 把一行表格文本切成单元格；不是表格行则返回 null。
 *
 * 必须处理 `\|` 转义：GFM 允许在单元格里用反斜杠竖线表示一个字面竖线，
 * 若直接按 | 切，用户写「a \| b」会被当成两列，表格结构当场歪掉。
 */
function tableCells(text: string): string[] | null {
  if (!text.includes('|')) return null
  let s = text.trim()
  if (!s.includes('|')) return null
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  const cells: string[] = []
  let buf = ''
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]
    if (ch === '\\' && s[k + 1] === '|') { buf += '|'; k++; continue }
    if (ch === '|') { cells.push(buf); buf = ''; continue }
    buf += ch
  }
  cells.push(buf)
  return cells.map(c => c.trim())
}

function isDelimiterRow(cells: string[] | null): boolean {
  return !!cells && cells.length > 0 && cells.every(c => DELIM_CELL.test(c))
}

/**
 * lines[k] 是一个表头行、lines[k+1] 是**列数相同**的分隔行 —— 即「表格从这里开始」。
 *
 * 列数必须相同：否则「| a | b |」后面跟「|---|」会被误判成表格，
 * 把本该是普通段落的两行吃成一张表。
 */
function isTableStart(lines: Line[], k: number): boolean {
  if (k + 1 >= lines.length) return false
  const head = tableCells(lines[k].text)
  if (!head || head.length === 0) return false
  const delim = tableCells(lines[k + 1].text)
  if (!isDelimiterRow(delim)) return false
  return (delim as string[]).length === head.length
}

function alignOf(cell: string): string | null {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/** 把 src[from..) 扫成块。调用方负责把已冻结的前缀排除在外。 */
export function scanBlocks(src: string, from = 0): MarkdownBlock[] {
  const lines = splitLines(src, from)
  const blocks: MarkdownBlock[] = []
  let i = 0

  /** 从 from 起（含）第一个非空行的下标；没有则返回 lines.length。 */
  const nextNonBlank = (from2: number): number => {
    let k = from2
    while (k < lines.length && BLANK.test(lines[k].text)) k++
    return k
  }

  while (i < lines.length) {
    const line = lines[i]
    if (BLANK.test(line.text)) { i++; continue }

    // 代码围栏
    const fence = FENCE.exec(line.text)
    if (fence) {
      const marker = fence[1][0]
      const size = fence[1].length
      let j = i + 1
      let closed = false
      while (j < lines.length) {
        const candidate = lines[j].text
        // 闭合围栏允许 0-3 个前导空格（CommonMark），且必须与开围栏同字符、不短于它、不带信息串。
        // 早先这里从第 0 列开始数 marker，于是「两个空格 + 三个反引号」这类缩进闭合符认不出来 ->
        // 围栏永不闭合 -> 后面**所有正文被吞进代码块**。实测：缩进 2 空格的闭合符会让本该是
        // 普通段落的那一行消失（内容损失，不是排版问题）。
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(candidate)
        if (close && close[1][0] === marker && close[1].length >= size) { closed = true; break }
        j++
      }
      const contentStart = Math.min(line.end + 1, src.length)
      const contentEnd = closed ? Math.max(contentStart, lines[j].start - 1) : src.length
      blocks.push({
        type: 'code',
        start: line.start,
        end: closed ? lines[j].end : src.length,
        closed,
        info: fence[2].trim(),
        text: src.slice(contentStart, contentEnd),
      })
      i = closed ? j + 1 : lines.length
      continue
    }

    // 标题
    const heading = HEADING.exec(line.text)
    if (heading) {
      blocks.push({ type: 'heading', start: line.start, end: line.end, closed: line.end < src.length, level: heading[1].length, text: (heading[2] ?? '').trim() })
      i++
      continue
    }

    // 分隔线
    if (HR.test(line.text)) {
      blocks.push({ type: 'hr', start: line.start, end: line.end, closed: line.end < src.length })
      i++
      continue
    }

    // 引用
    if (QUOTE.test(line.text)) {
      const inner: string[] = []
      let j = i
      let closed = false
      while (j < lines.length) {
        if (BLANK.test(lines[j].text) || !QUOTE.test(lines[j].text)) { closed = true; break }
        inner.push(lines[j].text.replace(/^ {0,3}> ?/, ''))
        j++
      }
      blocks.push({ type: 'quote', start: line.start, end: lines[j - 1].end, closed, text: inner.join('\n') })
      i = j
      continue
    }

    // 列表
    const item = LIST_ITEM.exec(line.text)
    if (item) {
      const baseIndent = item[1].length
      const ordered = /\d/.test(item[2])
      // 起始号必须记下来：'- 3. 开头' 若不写进 <ol start>，用户看到的编号会从 1 重来，
      // 而正文里写的是 3、4 —— 与原文对不上（对抗性审查实测）。
      const startNumber = ordered ? parseInt(item[2], 10) : undefined
      const items: { text: string }[] = []
      let current: string[] | null = null
      let j = i
      let closed = false
      while (j < lines.length) {
        const text = lines[j].text
        const marker = LIST_ITEM.exec(text)
        // 同类标记（同为有序/无序）且缩进不深于本层 -> 本列表的下一项。
        if (marker && marker[1].length <= baseIndent && /\d/.test(marker[2]) === ordered) {
          if (current) items.push({ text: current.join('\n') })
          current = [text.slice(marker[0].length)]
          j++
          continue
        }
        if (BLANK.test(text)) {
          // **空行不等于列表结束**（这一条修掉了两个用户可见缺陷）：
          //   · 宽松列表：'- a' 空行 '- b' 在 CommonMark 里是**同一个**列表，
          //     早先直接 break，会被拆成两个 <ul>（用户看到两个分开的列表）；
          //   · 列表项里的代码块：'- 项' 空行 '  ```' 里的代码块属于该列表项，
          //     早先直接 break，代码块会跑到列表**外面**（结构错误）。
          // 所以往后看第一个非空行再决定。
          const next = nextNonBlank(j)
          if (next >= lines.length) { closed = true; break }
          const nextText = lines[next].text
          const nextMarker = LIST_ITEM.exec(nextText)
          const nextIndent = nextText.length - nextText.trimStart().length
          if (nextMarker && nextMarker[1].length <= baseIndent && /\d/.test(nextMarker[2]) === ordered) {
            // 宽松列表：同一个列表的下一项。空行保留在条目里，段落分隔照旧。
            if (current) current.push('')
            j = next
            continue
          }
          if (nextIndent > baseIndent && current) {
            // 更深缩进：属于当前条目（嵌套列表、续段、或代码块）。
            current.push('')
            j = next
            continue
          }
          closed = true
          break
        }
        if (!current) { closed = true; break }
        const indent = text.length - text.trimStart().length
        if (indent <= baseIndent) { closed = true; break }
        current.push(text.slice(Math.min(indent, baseIndent + 2)))
        j++
      }
      if (current) items.push({ text: current.join('\n') })
      blocks.push({ type: 'list', start: line.start, end: lines[j - 1].end, closed, ordered, startNumber, items })
      i = j
      continue
    }

    // 表格（必须在段落之前判：表头行本身也像普通文本，落到段落后就被吞掉了）
    if (isTableStart(lines, i)) {
      const header = tableCells(line.text) as string[]
      const delim = tableCells(lines[i + 1].text) as string[]
      const align = delim.map(alignOf)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length) {
        const text2 = lines[j].text
        if (BLANK.test(text2)) break
        const cells = tableCells(text2)
        if (!cells || cells.length === 0) break
        // 只收列数一致的整行；更多列的行会顶歪表头，宁可当它是下一段的普通文本。
        if (cells.length > header.length) break
        // 短行在渲染时补空（CommonMark 行为），不在这里丢数据。
        rows.push(cells)
        j++
      }
      blocks.push({
        type: 'table',
        start: line.start,
        end: lines[j - 1].end,
        closed: j < lines.length,
        header,
        align,
        rows,
      })
      i = j
      continue
    }
    // 段落
    const start = line.start
    let j = i
    let closed = false
    while (j < lines.length) {
      const text = lines[j].text
      if (BLANK.test(text)) { closed = true; break }
      if (j > i && (FENCE.test(text) || HR.test(text) || QUOTE.test(text) || LIST_ITEM.test(text) || HEADING.test(text) || isTableStart(lines, j))) { closed = true; break }
      j++
    }
    const end = lines[j - 1].end
    const text = lines.slice(i, j).map(l => l.text).join('\n')
    if (!closed && text.length > MAX_OPEN_PARAGRAPH) {
      // 见 MAX_OPEN_PARAGRAPH：在行边界上切出一段确定的前缀先冻结，剩下的继续跟。
      const parts = text.split('\n')
      let cut = 0
      let acc = 0
      for (let k = 0; k < parts.length; k++) {
        acc += parts[k].length + 1
        if (acc >= text.length - KEEP_OPEN_TAIL) break
        cut = k + 1
      }
      if (cut > 0) {
        const frozen = parts.slice(0, cut).join('\n')
        blocks.push({ type: 'paragraph', start, end: start + frozen.length, closed: true, text: frozen })
        blocks.push({ type: 'paragraph', start: start + frozen.length + 1, end, closed: false, text: parts.slice(cut).join('\n') })
        i = j
        continue
      }
    }
    blocks.push({ type: 'paragraph', start, end, closed, text })
    i = j
  }

  return blocks
}

/* ------------------------------------------------------------------ *
 * 块级渲染
 * ------------------------------------------------------------------ */

function renderCodeBlock(block: MarkdownBlock): HTMLElement {
  const pre = node('pre', 'ea-md-pre')
  const code = node('code', 'ea-md-codeblock')
  if (block.info) code.setAttribute('data-lang', block.info)
  code.textContent = block.text ?? ''
  pre.appendChild(code)
  return pre
}

function renderListItem(item: { text: string }): Node {
  const li = node('li', 'ea-md-li')
  const children = scanBlocks(item.text, 0)
  if (children.length === 1 && children[0].type === 'paragraph') {
    // 紧凑列表项：单个段落不额外包一层 <p>，否则行距会莫名变大。
    appendAll(li, renderInlineNodes(children[0].text ?? ''))
  } else {
    appendAll(li, children.map(renderBlock))
  }
  return li
}

function renderBlock(block: MarkdownBlock): Node | null {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level ?? 1))
      const heading = node('h' + level, 'ea-md-h ea-md-h' + level)
      appendAll(heading, renderInlineNodes(block.text ?? ''))
      return heading
    }
    case 'code':
      return renderCodeBlock(block)
    case 'hr':
      return node('hr', 'ea-md-hr')
    case 'table': {
      const wrap = node('div', 'ea-md-table-wrap')
      const table = node('table', 'ea-md-table')
      const head = node('thead', 'ea-md-thead')
      const headRow = node('tr', 'ea-md-tr')
      const header = block.header ?? []
      header.forEach((cell, idx) => {
        const th = node('th', 'ea-md-th')
        const align = block.align?.[idx] ?? null
        // 对齐用类而不是行内 style：行内 style 在这个项目里被闸挡着（不许写 style 字面量），
        // 靠 CSS 类才能既不破闸又有对齐。
        if (align) th.setAttribute('data-align', align)
        appendAll(th, renderInlineNodes(cell))
        headRow.appendChild(th)
      })
      head.appendChild(headRow)
      table.appendChild(head)
      const body = node('tbody', 'ea-md-tbody')
      for (const row of block.rows ?? []) {
        const tr = node('tr', 'ea-md-tr')
        for (let c = 0; c < header.length; c++) {
          const td = node('td', 'ea-md-td')
          const align = block.align?.[c] ?? null
          if (align) td.setAttribute('data-align', align)
          // 短行补空：直接沿用表头列数，保证每行单元格数一致（否则表格会错位）。
          appendAll(td, renderInlineNodes(row[c] ?? ''))
          tr.appendChild(td)
        }
        body.appendChild(tr)
      }
      table.appendChild(body)
      wrap.appendChild(table)
      return wrap
    }
    case 'quote': {
      const quote = node('blockquote', 'ea-md-quote')
      appendAll(quote, scanBlocks(block.text ?? '', 0).map(renderBlock))
      return quote
    }
    case 'list': {
      const list = node(block.ordered ? 'ol' : 'ul', 'ea-md-list')
      // 只有起始号不是 1 时才写：写 start="1" 是多余属性，也无谓地改变了 DOM 形状。
      if (block.ordered && block.startNumber !== undefined && block.startNumber !== 1) list.setAttribute('start', String(block.startNumber))
      appendAll(list, (block.items ?? []).map(renderListItem))
      return list
    }
    default: {
      const paragraph = node('p', 'ea-md-p')
      appendAll(paragraph, renderInlineNodes(block.text ?? ''))
      return paragraph
    }
  }
}

/** 一次性渲染（已定稿的文本）。 */
export function renderMarkdownNodes(text: string): Node[] {
  return scanBlocks(text, 0).map(renderBlock).filter((value): value is Node => value !== null)
}

/* ------------------------------------------------------------------ *
 * 增量渲染器
 * ------------------------------------------------------------------ */

export type MarkdownStats = {
  /** 被真正解析并建过 DOM 的块数（冻结后不再增长）。 */
  blockRenders: number
  /** render() 被调用的次数。 */
  calls: number
  /** 因文本未变而整次跳过的次数。 */
  skips: number
  /** 代码块走「只追加增量」的次数。 */
  codeAppends: number
  /**
   * 真正写进 DOM 的字符数。
   *
   * 为什么需要这个而不是只看 codeAppends：次数只说明「走了哪个分支」，
   * 不说明「干了多少活」——把追加换回整段重写，次数照样涨，测试却不会红（本项目实测过一次）。
   * 字符数则直接反映工作量：增量追加下它 ≈ 文本总长；整段重写下它 ≈ 每次分片长度的累加，
   * 也就是平方级。这条指标改坏了必红。
   */
  codeChars: number
}

export type MarkdownRenderer = {
  render(text: string, streaming: boolean): Node[]
  /** 返回序列中前多少个节点是「已冻结、不会再变」的。 */
  readonly frozenCount: number
  readonly stats: MarkdownStats
  reset(): void
}

/**
 * 增量渲染器。
 *
 * 不变量：frozen 里的节点一旦产生就不再重新解析、不再替换；
 * 每次 render 只重算 frozen.length 之后的那一段（最多两三个块）。
 */
export function createMarkdownRenderer(): MarkdownRenderer {
  let source = ''
  let frozenBlocks: MarkdownBlock[] = []
  let frozen: Node[] = []
  let tail: Node[] = []
  let lastText: string | null = null
  let lastStreaming = false
  /** 正在生长的代码围栏：记住它的 <code> 元素与已写入的文本，只追加增量。 */
  let liveCode: { start: number; text: string; code: HTMLElement; pre: HTMLElement } | null = null
  const stats: MarkdownStats = { blockRenders: 0, calls: 0, skips: 0, codeAppends: 0, codeChars: 0 }

  const reset = () => {
    source = ''
    frozenBlocks = []
    frozen = []
    tail = []
    lastText = null
    liveCode = null
  }

  const render = (text: string, streaming: boolean): Node[] => {
    stats.calls++
    if (text === lastText && streaming === lastStreaming) { stats.skips++; return [...frozen, ...tail] }
    lastText = text
    lastStreaming = streaming

    // 已定稿。
    //
    // ── 这里**不能** reset 之后整份重渲染（曾经就是这么写的，是一条真缺陷）──
    // reset 会把冻结前缀丢掉，`renderMarkdownNodes` 产出的是**全新对象**，
    // 于是 mountMarkdown 的对齐算法判定「第一个节点就不同」，把整棵正文 DOM 换掉。
    // 真实浏览器里这会让正文区在**答完的那一瞬间整段重建**——用户看到闪一下。
    // 实测：定稿那一刻 **5/5** 个冻结节点全部被摘除（见 tests/markdown-render.test.mjs
    // 「定稿那一刻不得重建冻结前缀」）。流式期间明明一次都没动过，偏偏在收尾时动了。
    //
    // 正确做法：沿用流式路径的成果——**冻结前缀原地保留**，只把后面几块补齐并冻结。
    // 定稿后不会再变，所以这次可以把它们全部收进冻结集。
    if (!streaming) {
      if (!source) {
        // 从没走过流式（例如历史正文直接定稿渲染）：一次性渲染，全部算冻结。
        const nodes = renderMarkdownNodes(text)
        stats.blockRenders += nodes.length
        frozenBlocks = scanBlocks(text, 0)
        frozen = nodes
        tail = []
        source = text
        lastStreaming = false
        liveCode = null
        return nodes
      }
      const blocks = scanBlocks(text, 0)
      // 前缀里「同一个块、逐字相同」的节点保持不动。用原始源码片段比对，
      // 因为它完全决定了渲染结果，比逐字段比类型更可靠。
      const rawOf = (block: MarkdownBlock) => block.type + '\u0000' + text.slice(block.start, block.end)
      let keep = 0
      while (keep < frozenBlocks.length && keep < blocks.length && rawOf(frozenBlocks[keep]) === rawOf(blocks[keep])) keep++
      const keptNodes = frozen.slice(0, keep)
      const rebuilt: Node[] = []
      for (let i = keep; i < blocks.length; i++) {
        const value = renderBlock(blocks[i])
        stats.blockRenders++
        if (value) rebuilt.push(value)
      }
      frozenBlocks = blocks
      frozen = [...keptNodes, ...rebuilt]
      tail = []
      source = text
      lastStreaming = false
      liveCode = null
      return frozen
    }

    // 文本被换掉（新的一次提问 / 不再是同一篇的增长）→ 整份重来。
    if (!text.startsWith(source)) {
      reset()
      lastText = text
      lastStreaming = true
    }

    // 从第一个未冻结的块开始重扫。它之前的内容已经定稿，一个字都不用再看。
    const from = frozenBlocks.length ? frozenBlocks[frozenBlocks.length - 1].end + 1 : 0
    const blocks = [...frozenBlocks, ...scanBlocks(text, Math.min(from, text.length))]
    source = text

    // 冻结：只冻结「已终结」的块，且**永远留下最后一块不冻**。
    //
    // 为什么最后一块必须留：流式文本常常停在「- a\n」这种状态 —— 此时扫描器判定这个
    // 列表已终结（后面是空行），但下一段增量可能是「- b」，两行合成一个列表。
    // 冻了就再也合不回去，页面会显示成两个列表。留最后一块不冻就没有这个问题；
    // 而更早的块后面已经隔着空行，追加再多内容也改变不了它们。
    let index = frozenBlocks.length
    while (blocks.length - index > 1 && blocks[index].closed) {
      const rendered = renderBlock(blocks[index])
      stats.blockRenders++
      if (rendered) frozen.push(rendered)
      frozenBlocks.push(blocks[index])
      index++
    }

    const pending = blocks.slice(frozenBlocks.length)
    const rendered: Node[] = []
    for (const block of pending) {
      // 正在生长的代码围栏：**只追加新增的那一段**。
      // 整段重写 textContent 是 O(长度)，每个分片一次 → 整块代码就是平方级；
      // 追加是 O(增量)，与已经写了多长无关。实测见 tests/markdown-stream.test.mjs。
      if (block.type === 'code' && !block.closed) {
        const body = block.text ?? ''
        if (liveCode && liveCode.start === block.start && body.startsWith(liveCode.text)) {
          const delta = body.slice(liveCode.text.length)
          if (delta) liveCode.code.appendChild(document.createTextNode(delta))
          liveCode.text = body
          stats.codeAppends++
          stats.codeChars += delta.length
          rendered.push(liveCode.pre)
          continue
        }
        const fresh = renderCodeBlock(block)
        liveCode = { start: block.start, text: body, code: fresh.querySelector('code') as HTMLElement, pre: fresh }
        stats.blockRenders++
        stats.codeChars += body.length
        rendered.push(fresh)
        continue
      }
      // 刻意**不**在这里清空 liveCode：它按 start 位置匹配，位置对不上自然就会重建。
      // 早先在这里清空，导致代码块前面只要有一个段落（几乎总是有），
      // 增量追加就永远轮不到，每个分片都在重写整段代码。
      const value = renderBlock(block)
      stats.blockRenders++
      if (value) rendered.push(value)
    }
    tail = rendered
    return [...frozen, ...tail]
  }

  return {
    render,
    get frozenCount() { return frozen.length },
    stats,
    reset,
  }
}

/* ------------------------------------------------------------------ *
 * 已定稿文本的缓存
 * ------------------------------------------------------------------ */

/**
 * 历史记录这类**已定稿**正文的渲染缓存。
 *
 * 为什么必须有：updateOverlay 在流式期间每个分片都跑一次，而它会重建历史区。
 * 没有缓存的话，一次回答里每来一个字就要把**所有历史记录**重新解析一遍 ——
 * 记录越多越卡，而且和历史本身毫无关系。键里带上正文，正文一变自然失效。
 */
const settledCache = new Map<string, Node[]>()
const SETTLED_CACHE_MAX = 40
/** 真正跑过解析的次数。用来证明「交付克隆」没有把缓存退化成每次重解析。 */
let settledCacheParses = 0

/**
 * 把缓存里的节点**交付**给调用方。
 *
 * 修复的缺陷：缓存原本把同一批节点直接返回给每个调用方。真实 DOM 的 appendChild 是
 * **移动**语义（不是复制）—— 同一批节点第二次被挂到另一个容器时，会从第一个容器里
 * 被搬走，于是**先渲染的那一处变成空白**。用户看到历史正文「时有时无」。
 *
 * 为什么是「已挂载才克隆」而不是「一律克隆」：
 *   1. 一律克隆会让 `cachedMarkdownNodes(k,t) === cachedMarkdownNodes(k,t)` 不再成立，
 *      而「命中缓存返回同一批节点」是既有契约（tests/markdown-render.test.mjs 钉着它）；
 *   2. 未挂载时不可能出现「两个容器抢同一批节点」，此时直接返回原批 ——
 *      既保持契约、又完全不产生克隆开销；
 *   3. 只有在这批节点**已经属于某个容器**之后才克隆 —— 那正是唯一会互相搬空的时刻。
 * 于是：既不重解析（命中缓存仍成立），也永远不把**同一批节点**交给两个容器。
 */
function deliverSettled(nodes: Node[]): Node[] {
  const attached = nodes.some(node => node.parentElement !== null)
  if (!attached) return nodes
  return nodes.map(node => node.cloneNode(true))
}

export function cachedMarkdownNodes(key: string, text: string): Node[] {
  const cacheKey = key + '\u0000' + text
  const hit = settledCache.get(cacheKey)
  if (hit) {
    // 命中后挪到末尾，保证淘汰的是最久没用的那条。
    settledCache.delete(cacheKey)
    settledCache.set(cacheKey, hit)
    return deliverSettled(hit)
  }
  settledCacheParses++
  const nodes = renderMarkdownNodes(text)
  settledCache.set(cacheKey, nodes)
  if (settledCache.size > SETTLED_CACHE_MAX) settledCache.delete(settledCache.keys().next().value as string)
  return deliverSettled(nodes)
}

export function settledCacheSize(): number { return settledCache.size }
/** 缓存层真正解析过多少次（命中缓存时不应增长）。 */
export function settledCacheParseCount(): number { return settledCacheParses }
export function clearSettledCache(): void { settledCache.clear(); settledCacheParses = 0 }

/* ------------------------------------------------------------------ *
 * 挂载：只替换尾部，冻结前缀原地不动
 * ------------------------------------------------------------------ */

export type MarkdownView = {
  /** 更新到最新文本。streaming=true 表示还在吐字。 */
  update(text: string, streaming: boolean): void
  /**
   * 容器里前多少个节点属于「已冻结、不会再变」的前缀。
   *
   * 暴露它的理由：这是增量渲染**唯一的对外契约**。没有它，调用方（和测试）
   * 就只能猜「哪些节点是稳定的」——早期一个测试就是这么写的，把「刚渲染出来的
   * 最后一块」也当成稳定块来断言，于是必然失败。契约要能被读到，才谈得上被守住。
   */
  readonly frozenCount: number
  readonly stats: MarkdownStats
  dispose(): void
}

/**
 * 把增量渲染挂到一个容器上。
 *
 * 关键点：**只删尾部、只加尾部**，已冻结的节点始终留在容器里原地不动。
 * 若改成每次 replaceChildren(全部节点)，冻结节点会被「摘下来再挂回去」——
 * 元素虽然还是同一个对象，但浏览器会因此丢掉滚动锚点，用户看到的就是跳变。
 */
export function mountMarkdown(container: Element): MarkdownView {
  const renderer = createMarkdownRenderer()
  let mounted: Node[] = []

  const update = (text: string, streaming: boolean): void => {
    const nodes = renderer.render(text, streaming)

    // 从前往后**按对象同一性**对齐，第一个不一致的位置之后整体替换。
    //
    // ── 为什么不能用「冻结前缀已经有了，跳过前 frozenCount 个」──────
    // 那是这里原来写法，它有一个用户一眼能看见的缺陷（实测复现，见下方回归测试）：
    // 某个块**第一次被冻结**时，冻结出来的是一个**新对象**（例如新的 <ul>），
    // 而容器里挂着的还是上一轮那个**旧对象**。按「前缀已经对了」跳过 →
    // 新对象永远不会被追加进去，旧对象也永远不会被删掉 → 页面上出现两份列表。
    // 实测序列：流式 "- 甲/- 乙/- 丙" 再补空行，定稿后 <ul> 从 1 个变 2 个、条目从 3 条变 6 条。
    //
    // 按同一性对齐则天然正确：冻结节点是**同一些对象**，所以它们永远落在 firstDiff 之前，
    // 一次都不会被摘下来（滚动锚点因此保得住 —— 这正是「只换尾部」想要的性质）；
    // 而新冻结出来的对象在 firstDiff 处被识别为「不一样」，于是被正确追加。
    let firstDiff = 0
    while (firstDiff < mounted.length && firstDiff < nodes.length && mounted[firstDiff] === nodes[firstDiff]) firstDiff++
    if (firstDiff === mounted.length && firstDiff === nodes.length) return
    for (let i = mounted.length - 1; i >= firstDiff; i--) (mounted[i] as ChildNode).remove()
    for (let i = firstDiff; i < nodes.length; i++) container.appendChild(nodes[i])
    mounted = nodes.slice()
  }

  return {
    update,
    get frozenCount() { return renderer.frozenCount },
    get stats() { return renderer.stats },
    dispose() {
      for (const item of mounted) (item as ChildNode).remove()
      mounted = []
      renderer.reset()
    },
  }
}

