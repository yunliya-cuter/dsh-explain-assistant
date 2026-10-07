/**
 * TDZ（暂时性死区）扫描器 —— 无外部解析器依赖的自实现。
 *
 * 为什么自己写：本机 typescript 7 是 **Go 版**，只导出 version（没有 createSourceFile），
 * 也没装 acorn/@babel/parser/espree。
 *
 * ── 判定模型（核心是「词法块身份」，这是修正假阳性的关键）────────────────
 * blockOf(i) = 包含第 i 个 token 的**最内层花括号块**（-1 表示模块顶层）。
 *
 * 三条规则：
 *   A. same-scope  —— 引用与声明在**同一个最内层块**，且引用在声明之前。
 *                    同一块内语句顺序执行 ⇒ **确定 TDZ**。
 *   B. iife        —— 引用在**立即调用**的函数体里（IIFE 当场执行），声明在外层块且在其后
 *                    ⇒ **确定 TDZ**。
 *   C. called-before —— 引用在具名函数 F 的体内，F 在外层块定义，且存在 F 的调用点
 *                    在声明之前 ⇒ **确定 TDZ**（这就是缺陷1 的形态）。
 *   其它（延后调用、找不到调用点、跨块）⇒ **不报**，记入 deferred。
 *
 * 之前两版为什么错（留档，避免重蹈）：
 *   1) 不剥 TS 类型 ⇒ 类型空间被当成值空间，RecordReason/string 等冒出几十条假阳性；
 *   2) 只比较「函数区段锚」而不比较**词法块** ⇒ 不同函数里的同名标识符被混为一谈，
 *      实测 client/api.ts 满屏假阳性（readJsonResponse 的形参 response 撞上 json 里的 let response）。
 */

/** 分词：跳过注释/字符串/模板/正则，只保留标识符与结构符号。 */
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  let prev = null;
  const REGEX_OK = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof", "do", "else", "=>"]);
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "\"" || c === "'") { const q = c; i++; while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; } i++; prev = "str"; continue; }
    if (c === "`") { i++; while (i < n && src[i] !== "`") { if (src[i] === "\\") i++; i++; } i++; prev = "tpl"; continue; }
    if (c === "/" && (prev === null || REGEX_OK.has(prev))) {
      i++; let inClass = false;
      while (i < n) { const ch = src[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === "[") inClass = true; else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break; else if (ch === "\n") break;
        i++; }
      i++; prev = "re"; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { const s = i; while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++; const v = src.slice(s, i); tokens.push({ type: "ident", value: v, pos: s }); prev = v; continue; }
    if (/[0-9]/.test(c)) { const s = i; while (i < n && /[0-9a-fA-FxX._]/.test(src[i])) i++; tokens.push({ type: "num", value: src.slice(s, i), pos: s }); prev = "num"; continue; }
    if (c === "=" && src[i + 1] === ">") { tokens.push({ type: "arrow", value: "=>", pos: i }); i += 2; prev = "=>"; continue; }
    if (c === "." && src[i + 1] === "." && src[i + 2] === ".") { tokens.push({ type: "punct", value: "...", pos: i }); i += 3; prev = "..."; continue; }
    if ("{}()[];,:?.=<>+-*!&|".includes(c)) { tokens.push({ type: "punct", value: c, pos: i }); prev = c; i++; continue; }
    i++;
  }
  return tokens;
}

const KEYWORDS = new Set(["if","for","while","switch","catch","return","typeof","new","else","do","function","class","const","let","var","await","export","import","from","default","extends","instanceof","in","of","case","break","continue","throw","try","finally","yield","async","get","set","delete","void","this","super","null","true","false","undefined"]);
const CONTROL = new Set(["if","for","while","switch","catch"]);

function buildPairs(tokens) {
  const pair = new Map(); const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (v === "(" || v === "{" || v === "[") stack.push(i);
    else if (v === ")" || v === "}" || v === "]") { const o = stack.pop(); if (o !== undefined) { pair.set(o, i); pair.set(i, o); } }
  }
  return pair;
}

/** 是不是函数体花括号。 */
function isFunctionBrace(tokens, pair, idx) {
  const prev = tokens[idx - 1];
  if (!prev) return false;
  if (prev.type === "arrow") return true;
  if (prev.value === ")") {
    const op = pair.get(idx - 1);
    const before = op !== undefined ? tokens[op - 1] : undefined;
    if (before && before.type === "ident" && CONTROL.has(before.value)) return false;
    const before2 = op !== undefined ? tokens[op - 2] : undefined;
    if (before2 && before2.type === "ident" && CONTROL.has(before2.value)) return false;
    return true;
  }
  return false;
}

/** 函数区段：花括号下标、参数范围、名字、是否 IIFE。 */
function findFunctions(tokens, pair) {
  const fns = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== "{") continue;
    if (!isFunctionBrace(tokens, pair, i)) continue;
    const close = pair.get(i);
    if (close === undefined) continue;
    // 参数表：{ 之前的 ) 对应的 (。
    // 箭头函数要**穿过 => 再往前看**：
    //   ... ( ) => { ... }      → prev 是 "=>"，参数表在它前面
    // 漏掉这一条会让箭头函数查不到名字与参数（实测：findFunctions 返回的对象里
    // name/paramsOpen 全是 undefined），于是缺陷1 的形态「abortByParent 在 let 之前被调用」
    // 判不出来 —— 构造样例 B 就是钉这个的。
    let paramsOpen, paramsClose;
    const prev = tokens[i - 1];
    const paramsBefore = prev.value === "=>" ? tokens[i - 2] : prev;
    const paramsBeforeIdx = prev.value === "=>" ? i - 2 : i - 1;
    if (paramsBefore && paramsBefore.value === ")" && pair.get(paramsBeforeIdx) !== undefined) {
      paramsClose = paramsBeforeIdx;
      paramsOpen = pair.get(paramsBeforeIdx);
    }
    let name;
    if (paramsOpen !== undefined) {
      const before = tokens[paramsOpen - 1];
      if (before && before.value === "function") { const nm = tokens[paramsOpen]; name = nm && nm.type === "ident" ? nm.value : undefined; }
      else if (before && before.value === "=") { const nm = tokens[paramsOpen - 2]; if (nm && nm.type === "ident") name = nm.value; }
      else if (before && before.type === "ident") name = before.value;
    }
    // 箭头函数名：`const abortByParent = () => {...}`
    // 参数表是 ( )，所以 paramsOpen 指到 "("，它前面就是 "="。
    // （第一版的判断写成「paramsOpen-1 是 "("」，那是把下标算错了一位，
    //   结果缺陷1 的形态被漏掉——构造样例 B 正是靠这个抓出来的。）
    if (name === undefined && paramsOpen !== undefined) {
      const p1 = tokens[paramsOpen - 1];
      if (p1 && p1.value === "=") {
        const nm = tokens[paramsOpen - 2];
        if (nm && nm.type === "ident") name = nm.value;
      }
    }
    // IIFE：函数体结束后（跳过包裹右括号）紧跟 (
    let k = close + 1;
    while (tokens[k] && tokens[k].value === ")") k++;
    let iife = false;
    if (tokens[k] && tokens[k].value === "(") {
      const cc = pair.get(k);
      const after = cc !== undefined ? tokens[cc + 1] : undefined;
      iife = !after || (after.value !== "=>" && after.value !== "{");
    }
    fns.push({ brace: i, close, paramsOpen, paramsClose, name, iife });
  }
  // 简洁箭头体（**没有花括号**）：`const go = () => zed;`
  // 第一版只认花括号函数体，于是 go 的体不算函数 —— 里面的 zed 被当成
  // 「与 let zed 同作用域的顺序引用」，误报成 TDZ（构造样例「函数被调用但在声明之后」抓到了）。
  // 这里把 `=> 表达式` 也算成函数区段：范围从 => 之后到本语句结束（深度 0 的 ; 或 ,）。
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "arrow") continue;
    const nx = tokens[i + 1];
    if (nx && nx.value === "{") continue;   // 已按花括号处理
    let depth = 0, j = i + 1;
    while (j < tokens.length) {
      const v = tokens[j].value;
      if (v === "(" || v === "[" || v === "{") depth++;
      else if (v === ")" || v === "]" || v === "}") { if (depth === 0) break; depth--; }
      else if ((v === ";" || v === ",") && depth === 0) break;
      j++;
    }
    // 参数表：=> 之前的 ) 配对
    let paramsOpen, paramsClose;
    const prevArrow = tokens[i - 1];
    if (prevArrow && prevArrow.value === ")") { paramsClose = i - 1; paramsOpen = pair.get(i - 1); }
    else if (prevArrow && prevArrow.type === "ident") { paramsOpen = i - 1; paramsClose = i - 1; }
    let name;
    if (paramsOpen !== undefined) {
      const before = tokens[paramsOpen - 1];
      if (before && before.value === "=") { const nm = tokens[paramsOpen - 2]; if (nm && nm.type === "ident") name = nm.value; }
      else if (before && before.type === "ident") name = before.value;
    }
    // close 取 j（终止符下标）而非 j-1：判定用的是 idx < close，取 j-1 会把最后一个 token 漏掉。
    fns.push({ brace: i - 1, close: j, paramsOpen, paramsClose, name, iife: false, exprBody: true });
  }
  return fns;
}

function isReference(tokens, idx) {
  const t = tokens[idx];
  if (t.type !== "ident" || KEYWORDS.has(t.value)) return false;
  const pv = tokens[idx - 1];
  if (pv && (pv.value === "." || pv.value === "?.")) return false;
  const nx = tokens[idx + 1];
  if (pv && (pv.value === "{" || pv.value === ",") && nx && (nx.value === ":" || nx.value === "," || nx.value === "}")) return false;
  return true;
}

/**
 * 解析绑定名：let/const/var/class 与函数形参。**只收名字，绝不收初始值表达式里的标识符**。
 * 第一版「从关键字扫到分号、凡标识符都算绑定」会把 const x = foo(bar) 里的 foo/bar 也登记，
 * 导致大量假阳性。
 */
function collectBindings(tokens, pair, fns) {
  const bindings = [];   // { name, index, scopeBrace, param?, loop? }
  // 作用域边界：**函数体**（含简洁箭头体）—— 块级作用域（if/for 的花括号）不单独建边界。
  // 为什么：块级 let 的 TDZ 在实践中极少，而把块边界也算进来会制造假阳性
  // （实测 for (const call of ...) 里声明的 call 与循环体内的 call 引用被误配）。
  // 反过来，只按函数体分界时，**同一函数体内**的前向引用就是确定的 TDZ —— 这正是我们要抓的。
  // 作用域边界 = **函数体块 ∪ let/const 块**。
  // 之前只看函数体，导致块级绑定被当成整个函数体的绑定：
  //   if (cond) { let existing = ...; }   // 块内
  //   ... elsewhere in the same function: existing 用法
  // 会被误配（实测 host/llm.ts 的 existing、client/index.ts 的 record、overlay 的 form）。
  // 现在把每个花括号块都当边界，只看**最内层**；这样块级 let 只在自己块内参与顺序判定。
  const blockPairs = [];
  for (const [open, close] of pair.entries()) {
    if (open < close && tokens[open] && tokens[open].value === "{") blockPairs.push([open, close]);
  }
  const blockOf = (idx) => {
    let best = -1;
    for (const [open, close] of blockPairs) {
      if (idx > open && idx < close && open > best) best = open;
    }
    return best;
  };
  // 块的父子关系（用于判断「引用能否看见声明」）。
  const blockClose = new Map(blockPairs);
  const blockParent = new Map();
  for (const [open] of blockPairs) {
    let best = -1;
    for (const [o2, c2] of blockPairs) {
      if (o2 === open) continue;
      if (open > o2 && open < c2 && o2 > best) best = o2;
    }
    blockParent.set(open, best);
  }
  /** declBlock 是否是 refBlock 的**祖先或自身**（即引用能看见该声明）。 */
  const visible = (declBlock, refBlock) => {
    if (declBlock === refBlock) return true;
    let cur = refBlock;
    let guard = 0;
    while (cur !== -1 && cur !== undefined && guard++ < 200) {
      cur = blockParent.get(cur);
      if (cur === declBlock) return true;
      if (cur === undefined) return false;
    }
    return false;
  };
  const scopeOf = (idx) => {
    // 先取最内层块；若这个块是函数体块则返回它，否则再往外找最近函数体块
    const blk = blockOf(idx);
    if (blk !== -1) {
      const isFnBlock = fns.some(x => x.brace === blk);
      if (isFnBlock) return blk;
      // 块级作用域：往上找包含它的最近函数体块
      let best = -1;
      for (const fn of fns) if (idx > fn.brace && idx < fn.close && fn.brace > best) best = fn.brace;
      return best;
    }
    let best = -1;
    for (const fn of fns) if (idx > fn.brace && idx < fn.close && fn.brace > best) best = fn.brace;
    return best;
  };
  // 形参
  for (const fn of fns) {
    if (fn.paramsOpen === undefined) continue;
    for (let k = fn.paramsOpen + 1; k < fn.paramsClose; k++) {
      const t = tokens[k];
      if (t.type !== "ident" || KEYWORDS.has(t.value)) continue;
      const pv = tokens[k - 1];
      if (pv && pv.value === ".") continue;
      const nx = tokens[k + 1];
      if (pv && (pv.value === "{" || pv.value === "[" || pv.value === ",") && nx && nx.value === ":") continue;   // 解构键名
      if (pv && pv.value === ":") { bindings.push({ name: t.value, index: k, scopeBrace: fn.brace, param: true }); continue; }   // 解构别名
      if (nx && (nx.value === "," || nx.value === ")" || nx.value === "=")) bindings.push({ name: t.value, index: k, scopeBrace: fn.brace, param: true });
    }
  }
  // let / const / var / class
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "ident") continue;
    if (!["let", "const", "var", "class"].includes(t.value)) continue;
    const scopeBrace = scopeOf(i);
    if (t.value === "class") { const nm = tokens[i + 1]; if (nm && nm.type === "ident" && !KEYWORDS.has(nm.value)) bindings.push({ name: nm.value, index: i + 1, scopeBrace }); continue; }
    // for (const x of ...) / for (let i = 0; ...) —— 这类绑定的作用域是**循环体**，
    // 不是外层块。若照外层块处理，循环**前面**的同名引用会被误配成「引用后声明」
    // （实测 host/llm.ts 的 for (const [index, call] of ...) 报出 12 条假阳性）。
    // 这里标记 loop，核心判定时整条跳过：循环变量在每次迭代时才绑定，
    // 而「引用出现在循环之前」在实际代码里不构成 TDZ 风险（也极罕见）。
    const inForHead = (() => {
      let depth = 0;
      for (let k = i; k >= 0; k--) {
        const v = tokens[k].value;
        if (v === ")") depth++;
        else if (v === "(") { if (depth === 0) { const before = tokens[k - 1]; return before && before.value === "for"; } depth--; }
        else if (v === ";") return false;
      }
      return false;
    })();
    let j = i + 1, guard = 0;
    const skipInit = () => {
      let depth = 0;
      while (j < tokens.length) {
        const v = tokens[j].value;
        if (v === "(" || v === "[" || v === "{") depth++;
        else if (v === ")" || v === "]" || v === "}") { if (depth === 0) return; depth--; }
        else if ((v === "," || v === ";") && depth === 0) return;
        j++;
      }
    };
    while (j < tokens.length && guard++ < 400) {
      const cur = tokens[j];
      if (cur.value === ";") break;
      if (cur.value === ")" || cur.value === "}") break;
      if (cur.value === "{" || cur.value === "[") {   // 解构绑定
        const cl = pair.get(j);
        if (cl === undefined) break;
        for (let k = j + 1; k < cl; k++) {
          const inner = tokens[k];
          if (inner.type !== "ident" || KEYWORDS.has(inner.value)) continue;
          const pv = tokens[k - 1];
          if (pv && pv.value === ".") continue;
          const nx = tokens[k + 1];
          if (nx && nx.value === ":") continue;                       // 键名
          if (pv && pv.value === ":") { bindings.push({ name: inner.value, index: k, scopeBrace, loop: inForHead }); continue; }
          if (nx && (nx.value === "," || nx.value === "}" || nx.value === "]")) bindings.push({ name: inner.value, index: k, scopeBrace, loop: inForHead });
        }
        j = cl + 1;
        if (tokens[j] && tokens[j].value === "=") { j++; skipInit(); }
        if (tokens[j] && tokens[j].value === ",") { j++; continue; }
        break;
      }
      // ⚠️ 声明名**必须**取紧随 let/const/var 之后的那个标识符（j === i + 1）。
      // KEYWORDS 里混着大量**上下文关键字**（from / of / get / set / async / default /
      // undefined / yield / await ...），它们**合法地**可以当变量名。
      // 早期写法只看 !KEYWORDS.has(...)，于是 `const from = arr.length` 这种声明里
      // 名字 "from" 被跳过，扫描器继续往下、把**初始化式的第一个标识符**（arr）当成了绑定名 ——
      // 于是凭空多出一条「arr 的声明」@ 初始化式处，而所有早于它的引用都被判成 TDZ。
      // 实测：这会在 const from = frozenBlocks.length ? ... 上伪造 4 处假阳性。
      const isDeclNamePosition = j === i + 1;
      if (cur.type === "ident" && (isDeclNamePosition || !KEYWORDS.has(cur.value))) {
        bindings.push({ name: cur.value, index: j, scopeBrace, loop: inForHead });
        j++;
        if (tokens[j] && tokens[j].value === "=") { j++; skipInit(); }
        if (tokens[j] && tokens[j].value === ",") { j++; continue; }
        break;
      }
      j++;
    }
  }
  return bindings;
}

/**
 * inner 这个函数**是否可能在 limit 位置之前真的执行**（递归可达性）。
 *
 * 规则：
 *   · 它自己是 IIFE → 立即执行（前提是它不在别的延后函数里，调用方已先查过）
 *   · 它被某个**早于 limit** 的调用点调用；该调用点若在顶层 → 成立；
 *     若在另一个函数 G 里 → 递归问「G 会不会在 limit 之前执行」
 *   · 找不到调用点 → 不成立（延后调用）
 *
 * 这一条是缺陷1 与 pendingGeometry / selectionStatus 的分水岭：
 *   abortByParent 在顶层被调用（G 为空）⇒ 成立 ⇒ 真 TDZ；
 *   leaveSelectionMode 只在 click/keydown 回调里被调用 ⇒ G 是回调 ⇒ 不成立。
 */
function runsBeforeDecl(inner, limit, tokens, fns, selfBrace) {
  return reachable(inner, limit, tokens, fns, new Set([selfBrace]));
}

function reachable(fn, limit, tokens, fns, seen) {
  if (fn.iife) return true;
  if (!fn.name) return false;
  // 找 fn 在 limit 之前的调用点
  for (let i = 0; i < limit; i++) {
    if (tokens[i].type !== "ident" || tokens[i].value !== fn.name) continue;
    const nx = tokens[i + 1];
    if (!nx || nx.value !== "(") continue;
    const pv = tokens[i - 1];
    if (pv && (pv.value === "." || pv.value === "?." || pv.value === "function")) continue;
    // 这个调用点在哪个函数里？
    const holder = fns
      .filter(x => i > x.brace && i < x.close)
      .sort((a, b) => b.brace - a.brace)[0];
    if (!holder) return true;                    // 顶层调用 ⇒ 会执行
    if (seen.has(holder.brace)) continue;        // 防环
    seen.add(holder.brace);
    if (reachable(holder, limit, tokens, fns, seen)) return true;
  }
  return false;
}

/**
 * 某个函数区段是否**嵌套在另一个延后调用的函数里**。
 *
 * 判据：往上找包含它的外层函数区段；若存在，且外层不是 IIFE，
 * 那么这个区段是「被回调触发」的，不能当成立即执行。
 */
function isDeferredContext(brace, fns) {
  let cur = fns.find(x => x.brace === brace);
  let guard = 0;
  while (cur && guard++ < 100) {
    const parent = fns
      .filter(x => x.brace < cur.brace && cur.close <= x.close)
      .sort((a, b) => b.brace - a.brace)[0];
    if (!parent) return false;                 // 已经没有外层函数 → 属于当前这条语句流
    if (!parent.iife) return true;             // 外层是延后调用的函数 → 延后
    cur = parent;                              // 外层也是 IIFE，继续往上
  }
  return false;
}

/** 是否存在 name 的调用点，位置早于 limit，且 name 是独立函数（不是属性）。 */
function callSiteBefore(name, limit, tokens) {
  for (let i = 0; i < limit; i++) {
    if (tokens[i].type !== "ident" || tokens[i].value !== name) continue;
    const nx = tokens[i + 1];
    if (!nx || nx.value !== "(") continue;
    const pv = tokens[i - 1];
    if (pv && (pv.value === "." || pv.value === "?.")) continue;
    if (pv && pv.value === "function") continue;
    return i;
  }
  return undefined;
}

export function scanSource(src) {
  const tokens = tokenize(src);
  const pair = buildPairs(tokens);
  const fns = findFunctions(tokens, pair);
  const bindings = collectBindings(tokens, pair, fns);
  // 词法块索引（与 collectBindings 里同一套规则，但那是在另一个函数作用域里，
  // 这里要用只能再建一次 —— 刻意保持两份一致，改动时两处都要动）。
  const blockPairs = [];
  for (const [open, close] of pair.entries()) {
    if (open < close && tokens[open] && tokens[open].value === "{") blockPairs.push([open, close]);
  }
  const blockOf = (idx) => {
    let best = -1;
    for (const [open, close] of blockPairs) if (idx > open && idx < close && open > best) best = open;
    return best;
  };
  const blockParent = new Map();
  for (const [open] of blockPairs) {
    let best = -1;
    for (const [o2, c2] of blockPairs) {
      if (o2 === open) continue;
      if (open > o2 && open < c2 && o2 > best) best = o2;
    }
    blockParent.set(open, best);
  }
  const visible = (declBlock, refBlock) => {
    if (declBlock === refBlock) return true;
    let cur = refBlock, guard = 0;
    while (cur !== -1 && cur !== undefined && guard++ < 200) {
      cur = blockParent.get(cur);
      if (cur === declBlock) return true;
      if (cur === undefined) return false;
    }
    return false;
  };
  const scopeOf = (idx) => {
    let best = -1;
    for (const fn of fns) if (idx > fn.brace && idx < fn.close) { if (fn.brace > best) best = fn.brace; }
    return best;
  };
  const fnAt = (idx) => {
    let best;
    for (const fn of fns) if (idx > fn.brace && idx < fn.close) { if (!best || fn.brace > best.brace) best = fn; }
    return best;
  };
  const findings = [];
  const deferred = [];
  const stats = { sameScope: 0, crossScope: 0 };
  // ── 核心判定 ────────────────────────────────────────────────────────
  // 对每个「声明 D(name)」找它**之前**的引用 R(name)，然后回答一个问题：
  //   「R 会在 D 执行之前被求值吗？」 会 ⇒ 确定 TDZ；不确定 ⇒ 记 deferred（不报）。
  //
  // 判据分两档：
  //  · R 与 D 在**同一函数体**（或同在顶层）：同一条语句流，顺序执行 ⇒ 确定 TDZ。
  //  · R 在**内层函数体** F 里、D 在 F 外面：只有当 F 在 D 之前被调用/立即执行时才构成 TDZ。
  //    （这正是缺陷1：abortByParent 在 let aborted 之前被 `if(parent?.aborted)abortByParent()` 调用。）
  //    找不到调用点 ⇒ 延后调用，**不报**（pendingGeometry 那类）。
  // 每个函数区段的**父区段**（谁包含它）。用于回答「ref 是否在 decl 的函数内部」。
  const parentOf = new Map();
  for (const fn of fns) {
    let best = null;
    for (const other of fns) {
      if (other === fn) continue;
      if (fn.brace > other.brace && fn.close <= other.close) {
        if (!best || other.brace > best.brace) best = other;
      }
    }
    parentOf.set(fn, best);
  }
  /** refFn 是否**嵌套在** declFn 内部（含相等）。
   *  这是修正假阳性的关键：函数 612 里的 const e 与函数 76 里的 const e 是两个不同绑定，
   *  局部 const 不会跨到无关函数里去 —— 不做祖先判断就会把它们配成一对（实测 client/api.ts）。 */
  const isInsideOf = (refFn, declFn) => {
    if (refFn === declFn) return true;
    let cur = fns.find(x => x.brace === refFn);
    while (cur) {
      const p = parentOf.get(cur);
      if (!p) return false;
      if (p.brace === declFn) return true;
      cur = p;
    }
    return false;
  };
  const enclosingScope = (idx) => {
    // 找包含 idx 的最内层函数体；不在任何函数体内返回 -1。
    //
    // 判据必须同时覆盖两种函数体形态，否则会把**不同函数**里的同名变量误判为同一作用域：
    //  · 花括号体：fn.brace < idx < fn.close
    //  · 简洁箭头体（exprBody）：brace 字段放的是 => 前一个 token 的下标，close 是语句终止符；
    //    这种区段**没有花括号**，不能用 fn.brace/fn.close 直接比较 token 下标大小
    //    （实测因此把 errorInfo 里的 const e 与另一个函数里的 const e 混为一谈）。
    // 用「区段包含」判定：把 idx 与区段端点都换成 token 位置比较。
    // 边界必须用 fn.brace 本身，**不能**用 fn.brace + 1：
    // 花括号体里紧跟着 { 的第一个 token 就是 idx = brace + 1，
    // 用 idx > brace + 1 会把它排除在外 → 该处引用被当成「不在任何函数体内」→
    // 与顶层声明同作用域 → 误报 TDZ。
    // 最小复现：
    //   const send = button(x, () => { form.requestSubmit() }, {...});
    //   const form = el("form");        // ← 误报 form 在声明前被引用
    // （overlay.tsx:708 就是这条真实形态，是我的构造样例没覆盖到的漏网鱼。）
    let best = null;
    for (const fn of fns) {
      if (idx > fn.brace && idx < fn.close) {
        if (!best || fn.brace > best.brace) best = fn;
      }
    }
    return best ? best.brace : -1;   // 一律返回数字，便于与 declFn 直接比较
  };
  // ⚠️ 一个标识符本身就是**绑定名**时，它不是「引用」。
  // 漏掉这一条会把每条声明自己当成对同名早期绑定的引用：
  //   let existing = calls.find(...)      // ← 新声明
  //   const existing = call.id ? ...      // ← 另一条声明
  // 于是「声明@后」配到「声明@前」，报出一堆假 TDZ（实测 host/llm.ts 绝大多数是这种）。
  const bindingTokens = new Set(bindings.map(b => b.index));
  for (const bind of bindings) {
    const declFn = bind.scopeBrace;   // 声明所在的函数体（-1 = 顶层）
    // 形参永远是「已初始化」的：它在函数体第一行执行之前就绑定好了，
    // 函数体内任何位置引用形参都不可能是 TDZ。所以带 param 标记的绑定整条跳过。
    // （只跳过「同函数体」那一支是不够的 —— 形参被**内层函数**引用时同样安全，
    //   而内层函数恰恰会被判成 called-before-decl，实测 client/api.ts 因此报出 value/signal/url。）
    if (bind.param) continue;
    // 循环变量整条跳过（作用域是循环体自身，见 collectBindings 里的说明）。
    if (bind.loop) continue;
    for (let i = 0; i < bind.index; i++) {
      if (tokens[i].type !== "ident" || tokens[i].value !== bind.name) continue;
      if (bindingTokens.has(i)) continue;   // 它是另一条声明，不是引用
      if (!isReference(tokens, i)) continue;
      // 词法可见性：声明所在的块必须是引用所在块的**祖先或自身**。
      // 这一条同时解决两类假阳性：
      //   · 不同函数里的同名局部；
      //   · **同一函数内不同分支块**里的同名局部 —— 实测 host/llm.ts 的
      //     `if (...) { let existing = ... } else { const existing = ... }`，
      //     两条 existing 分属 if-块与 else-块，互不可见，却被前几版配成一对。
      const refBlock = blockOf(i);
      const declBlock = blockOf(bind.index);
      if (!visible(declBlock, refBlock)) { stats.crossScope++; continue; }
      const refFn = enclosingScope(i);
      if (refFn === declFn) {
        stats.sameScope++;
        findings.push({ name: bind.name, pos: tokens[i].pos, declPos: tokens[bind.index].pos, kind: "same-scope" });
        continue;
      }
      // R 在内层函数体里（refFn 比 declFn 更深）
      const inner = fns.find(x => x.brace === refFn);
      if (!inner) { stats.crossScope++; continue; }
      // 内层函数必须在 D 之前就执行：IIFE 立即执行，或有早于 D 的调用点。
      //
      // ⚠️ 但 IIFE「立即执行」只对**直接位于同一语句流**的 IIFE 成立。
      // 若它本身嵌在另一个**延后调用**的函数里（最典型：.then(cb) / setTimeout(cb) /
      // addEventListener(cb)），那它到底何时跑，取决于外层那个函数何时被调 ——
      // 这时**不能**判成立。实测 client/index.ts 的 pendingGeometry 就是这种：
      //   refreshState = () => callApi(...).then(result => { ...(() => { pendingGeometry.has(...) })() ... })
      //   ... 后面才 const pendingGeometry = new Map()
      // 引用方那个 IIFE 确实立即执行，但它所在的 .then 回调要等网络返回后才执行 ——
      // 而那时 pendingGeometry 早就初始化完了。所以**不是缺陷**（与 Lead 的结论一致）。
      // 引用所在的函数 inner 是否可能在 D 之前**真的跑起来**？
      // 这是递归可达性问题，不能只看「有没有调用点」：
      //   if (flag) abortByParent()        → 顶层调用，D 之前执行 ⇒ 确定 TDZ（缺陷1 的形态）
      //   btn.addEventListener('click', () => leaveSelectionMode())
      //                                     → 调用点在**回调里**，回调何时跑不确定 ⇒ 不是 TDZ
      // 实测 overlay.tsx 的 selectionStatus 就是后一种（659/665 引用，692 才声明）；
      // 只看「有调用点」会把它误报成缺陷。
      if (inner.iife && !isDeferredContext(refFn, fns)) {
        findings.push({ name: bind.name, pos: tokens[i].pos, declPos: tokens[bind.index].pos, kind: "iife", caller: inner.name });
        continue;
      }
      // ⚠️ 引用所在的函数 inner 自己若**嵌在延后调用的函数里**，那它同样不会在 D 之前跑。
      // 真实形态（client/index.ts 的 pendingGeometry）：
      //   refreshState = () => callApi(...).then(r => { ...(() => { pendingGeometry.has(id) })()... })
      //   后面才 const pendingGeometry = new Map()
      // 那个 IIFE 确实立即执行，但它所在的 .then 回调要等网络返回；
      // 而 .then 回调的「调用方」在源码里根本找不到调用点（是 Promise 调的），
      // 早期版本因此把它当成「顶层可达」而误报。这一闸把它挡住。
      if (isDeferredContext(refFn, fns)) {
        deferred.push({ name: bind.name, pos: tokens[i].pos, inFunction: inner.name, why: "所在函数嵌在延后调用的函数里" });
        continue;
      }
      if (runsBeforeDecl(inner, bind.index, tokens, fns, refFn)) {
        findings.push({ name: bind.name, pos: tokens[i].pos, declPos: tokens[bind.index].pos, kind: "called-before-decl", caller: inner.name });
        continue;
      }
      deferred.push({ name: bind.name, pos: tokens[i].pos, inFunction: inner.name });
    }
  }
  const identCount = tokens.filter(t => t.type === "ident" && !KEYWORDS.has(t.value)).length;
  return { findings, deferred, stats, tokenCount: tokens.length, identCount, declCount: bindings.length };
}

/**
 * 先剥掉 TypeScript 类型，再交给 scanSource。
 * 不剥的话**类型空间**会被当成值空间，冒出大量假阳性（实测 record-reason.ts 几十条）。
 * esbuild 的 TS→JS 转换**逐行保留**（不重排），所以剥完再扫，行号与原文件一致。
 */
export async function stripTypes(src, loader) {
  const esbuild = await import("esbuild");
  const out = await esbuild.transform(src, { loader, format: "esm", target: "es2022" });
  return out.code;
}

/** 把 pos 换成 行:列。 */
export function lineCol(src, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i++) if (src[i] === "\n") line++;
  const last = src.lastIndexOf("\n", pos - 1);
  return line + ":" + (pos - last);
}