import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanSource, stripTypes, lineCol } from './fixtures/tdz-scanner.mjs';

/**
 * 「声明后使用（TDZ）」全模块普查。
 *
 * ── 为什么建它 ──────────────────────────────────────────────────────
 * 本轮缺陷1 的根因就是 TDZ：src/host/llm.ts 里 `abortByParent` 引用了**声明在它后面**的
 * `aborted`，命中暂时性死区抛 ReferenceError，被路由转成 INTERNAL_ERROR，
 * 于是「用户点停止」被误报成「模型失败」。这类缺陷平时不可见，只有走到那一条路径才炸。
 * Lead 另外查过第二处疑似（客户端 `pendingGeometry`），判为**不是缺陷**但顺序脆弱。
 * 所以要做一次**系统性**普查，而不是逐个人工看。
 *
 * ── 检查器与规则 ────────────────────────────────────────────────────
 * 检查器在 tests/fixtures/tdz-scanner.mjs（自实现：本机 typescript 7 是 Go 版，
 * 只导出 version，没有 createSourceFile；也没装 acorn/@babel/parser/espree）。
 * 判定三条（详见该文件头部注释）：
 *   A. same-scope        —— 引用与声明在**同一个块**且引用在前 ⇒ 确定 TDZ
 *   B. iife              —— 引用在**立即执行**的函数体里，声明在外层且在后 ⇒ 确定 TDZ
 *   C. called-before-decl —— 引用在函数 F 体内，F 在声明前**确实会执行**（递归可达）⇒ 确定 TDZ
 *   其它（延后调用、找不到调用点、跨块）⇒ 不报，记入 deferred。
 *
 * ── 检查器自身可信度（构造样例）──────────────────────────────────────
 * 见下方「构造样例」区块：真阳性必须检出、真阴性必须不检出。
 * 这一块是**本文件的核心证据** —— 只报「扫完没问题」不算交付。
 */

const SRC_ROOT = new URL('../src/', import.meta.url);
const SRC_ROOT_PATH = SRC_ROOT.pathname;   // join() 只收字符串，不收 URL

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/* ================================================================== *
 * 1) 构造样例：证明检查器不是空转（真阳性 / 真阴性都覆盖）
 * ================================================================== */

const CONSTRUCTED = [
  ['真阳性 A：同作用域引用后声明', 'let x = 1;\nconst y = aborted;\nlet aborted = false;', true],
  ['真阳性 B：缺陷1 的形态（具名函数在声明前被调用）',
    'const abortByParent = () => { aborted = true; };\nif (flag) abortByParent();\nlet aborted = false;', true],
  ['真阳性 C：IIFE 在声明前执行', '(function () { use(aborted); })();\nlet aborted = false;', true],
  ['真阳性 D：IIFE 箭头形', '(() => { console.log(ghost); })();\nlet ghost = 1;', true],
  ['真阴性：延后调用的函数体（pendingGeometry 那类，Lead 判非缺陷）',
    'const read = () => pendingGeometry.has(id);\nconst pendingGeometry = new Map();\nread();', false],
  ['真阴性：函数体前向引用但无调用', 'const f = () => { return later; };\nlet later = 1;', false],
  ['真阴性：属性名不是引用', 'const o = { aborted: 1 };\nlet aborted = false;', false],
  ['真阴性：字符串/注释里的同名不算', '// aborted 说明\nconst s = "aborted";\nlet aborted = false;', false],
  ['真阴性：声明在前、引用在后', 'let aborted = false;\nif (aborted) { x(); }', false],
  ['真阴性：函数被调用但在声明之后', 'const go = () => zed;\nlet zed = 1;\ngo();', false],
  ['真阴性：形参不是 TDZ', 'function f(p) { return p; }\nconst g = p => p;', false],
  ['真阴性：回调里引用（回调何时跑不确定）',
    'const form = el("form");\nel("button", { onclick: () => form.submit() });', false],
  // ↓ 2026-07 由 task-36 补入：实测到的**检查器假阳性**形态
  // （不是放宽断言，是修检查器后钉住它，防止将来又踩回去）。
  // 声明名是「上下文关键字」时（from / of / get / set / async / default / undefined / yield / await…），
  // 旧版扫描器只看 !KEYWORDS.has(name)，于是 const from = arr.length 里的名字 from 被跳过，
  // 继续往下把**初始化式的第一个标识符**（arr）登记成了绑定名 ——
  // 于是凭空多出一条「arr 的声明」，而所有早于它的 arr 引用都被判成 TDZ。
  // 真实触发处：markdown.ts 的 const from = frozenBlocks.length ? ... （伪造 4 处 frozenBlocks 假阳性）。
  // 修法：声明名必须取紧随 let/const/var 之后的那个标识符（j === i + 1），与是否关键字无关。
  ['真阴性：声明名是上下文关键字，初始化式里的标识符不得被当成绑定名',
    'function make() {\n  let arr = [];\n  const render = () => {\n    arr = [1];\n'
    + '    const from = arr.length ? arr[arr.length - 1] : 0;\n    return from;\n  };\n  return render;\n}',
    false],
];

test('TDZ 普查 检查器自证: 真阳性必检出、真阴性必不检出（证明不是空转）', () => {
  const failures = [];
  for (const [label, src, expectTdz] of CONSTRUCTED) {
    const result = scanSource(src);
    const got = result.findings.length > 0;
    if (got !== expectTdz) {
      failures.push(label + '（期望 ' + expectTdz + '，实际 ' + got + '，findings=' + JSON.stringify(result.findings) + '）');
    }
  }
  assert.deepEqual(failures, [], '构造样例失败，说明检查器本身不可信：\n' + failures.join('\n'));
  // 真实性检查：至少有一个真阳性被检出（否则「全不报」也能骗过上面）
  const positives = CONSTRUCTED.filter(c => c[2]).length;
  assert.ok(positives >= 4, '真阳性样例必须有足够的覆盖，实际 ' + positives + ' 条');
});

test('TDZ 普查 检查器自证: 检查器真的读了代码（token 数与标识符数不为零）', () => {
  const result = scanSource('const a = 1;\nfunction f() { return a; }');
  assert.ok(result.tokenCount > 0, 'token 数必须 > 0');
  assert.ok(result.identCount > 0, '标识符数必须 > 0');
  assert.ok(result.declCount > 0, '登记声明数必须 > 0');
});

/* ================================================================== *
 * 2) 全模块普查：src/** 逐文件扫描
 * ================================================================== */

test('TDZ 普查: src/** 全量扫描，真正命中的必须在此列出并修复', async () => {
  const files = walk(SRC_ROOT_PATH);
  assert.ok(files.length > 0, '必须扫到文件');

  let tokens = 0, idents = 0, decls = 0, deferred = 0;
  const hits = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    // 先剥掉 TS 类型：不剥会把类型空间当成值空间（RecordReason / string 等），
    // 实测第一版因此冒出上千条假阳性。
    const stripped = await stripTypes(raw, file.endsWith('.tsx') ? 'tsx' : 'ts');
    const result = scanSource(stripped);
    tokens += result.tokenCount;
    idents += result.identCount;
    decls += result.declCount;
    deferred += result.deferred.length;
    for (const f of result.findings) {
      hits.push(relative(SRC_ROOT_PATH, file) + ':' + lineCol(stripped, f.pos)
        + '  ' + f.name + ' [' + f.kind + ']' + (f.caller ? ' (调用方 ' + f.caller + ')' : ''));
    }
  }

  // 规模必须可见（任务要求报「扫了多少文件/多少标识符」）
  console.log('  [tdz-sweep] 扫描文件 =', files.length, '| token =', tokens, '| 标识符引用 =', idents,
    '| 登记绑定 =', decls, '| 延后调用（不报）=', deferred);

  assert.deepEqual(hits, [],
    '扫出 ' + hits.length + ' 处「声明后使用」候选。若确认是缺陷，请在对应源码里把声明前移；\n'
    + '若判定为检查器误报，请把该形态补进本文件的 CONSTRUCTED 真阴性样例并说明理由：\n' + hits.join('\n'));
});

/* ================================================================== *
 * 3) 已知案例的明确结论（防止将来「悄悄改回去」）
 * ================================================================== */

test('TDZ 普查 已知案例: 缺陷1 的形态（函数在声明前被调用）必须仍被判为 TDZ', () => {
  // 这条钉住「缺陷1 这类形态仍然会被抓到」，防止为了消掉假阳性把真信号也滤掉。
  const src = 'const abortByParent = () => { aborted = true; };\nif (parent.aborted) abortByParent();\nlet timedOut = false;\nlet aborted = false;';
  const result = scanSource(src);
  assert.ok(result.findings.some(f => f.name === 'aborted'),
    '缺陷1 的形态必须被检出，实际 findings = ' + JSON.stringify(result.findings));
});

test('TDZ 普查 已知案例: pendingGeometry 那种「延后调用」不得被误报（Lead 已判非缺陷）', () => {
  // 用客户端的真实形态做最小复现：
  //   const refreshState = () => callApi(...).then(result => { ...pendingGeometry.has(id)... })
  //   ... 后面才 const pendingGeometry = new Map()
  // refreshState 里的 IIFE 确实立即执行，但它所在的 .then 回调要等网络返回，
  // 那时 pendingGeometry 早已初始化完 —— 不是 TDZ。
  const src = [
    'const refreshState = () => callApi(() => api.state(id)).then(result => {',
    '  return (() => { if (pendingGeometry.has(id)) return {}; return { ok: 1 }; })();',
    '});',
    'const geometryTimers = new Map();',
    'const pendingGeometry = new Map();',
  ].join('\n');
  const result = scanSource(src);
  assert.deepEqual(result.findings.map(f => f.name), [],
    '延后调用上下文里的引用不得被报成 TDZ，实际 = ' + JSON.stringify(result.findings));
  assert.ok(result.deferred.some(d => d.name === 'pendingGeometry'),
    '应当被记为 deferred（保留痕迹，便于人工复核）');
});

test('TDZ 普查 源码卫生: 真 TDZ 已修复处保留显式顺序（llm.ts 的声明必须在 abortByParent 之前）', () => {
  // 缺陷1 的修复方式就是把声明前移。这条用源码顺序钉住它，防止将来被「整理」回去。
  const source = readFileSync(new URL('host/llm.ts', SRC_ROOT), 'utf8');
  const declAt = source.indexOf('let timedOut');
  const fnAt = source.indexOf('const abortByParent');
  assert.ok(declAt !== -1 && fnAt !== -1, '前置：两个声明都必须存在');
  assert.ok(declAt < fnAt,
    '缺陷1 的修复是「把 timedOut/aborted 声明提到 abortByParent 之前」；'
    + '现在顺序反了（声明在 ' + declAt + '，函数在 ' + fnAt + '），会重新触发暂时性死区');
});
