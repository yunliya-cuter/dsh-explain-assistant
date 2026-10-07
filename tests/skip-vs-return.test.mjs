import test from 'node:test';
import assert from 'node:assert/strict';
import { scanEarlyReturns } from './fixtures/skip-return-scanner.mjs';
import { scanDir } from './fixtures/skip-return-scanner.mjs';

/**
 * 「用提前 return 冒充跳过」的机械闸（task-44）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * node:test 把「test 体内提前 return 且无断言失败」计为 **✔ pass**，不是 skip。
 * 于是「拿 return 当跳过」的写法在**数据不存在**的机器上会报绿，却一次比对都没做 ——
 * 在本机（有数据）完全看不出来，换一台机器就是假绿。
 *
 * 这不是假想：本次就是靠人眼发现了三处同类（real-shape-replay:203、`regression-guards:68`，
 * 以及我自己刚写的 markdown-real-corpus 那条）。其中两处已改。
 * 这条闸让以后**不必再靠人眼**。
 *
 * ── 检查器自身必须先被证明可信 ─────────────────────────────────────
 * 见文件末尾的构造样例：真阳性（assert 前 return）必须检出，
 * 真阴性（回调里的 return、辅助函数里的断言、显式 skip）必须不检出。
 */

const TESTS_DIR = new URL('.', import.meta.url).pathname;

test('[提前 return] 构造样例: 检查器必须先自证可信（真阳性必检出、真阴性必不检出）', () => {
  const CASES = [
    // ── 真阳性：assert 之前就 return（等于把用例变成永远 pass）
    ['真阳性: assert 之前直接 return',
      'test(\'x\', () => {\n  if (!data.length) { return; }\n  assert.ok(data.length);\n});', 1],
    ['真阳性: return 在开头、后面才有 assert',
      'test(\'x\', () => {\n  const d = load();\n  if (!d) return;\n  assert.equal(d.a, 1);\n});', 1],
    ['真阳性: 体内 0 assert 且提前 return',
      'test(\'x\', () => {\n  if (skip) return;\n  doSomething();\n});', 1],
    // ── 真阴性：合法的 return
    ['真阴性: assert 之后的 return（提前成功退出）',
      'test(\'x\', () => {\n  assert.ok(true);\n  if (done) return;\n});', 0],
    ['真阴性: 回调里的 return（forEach 提前跳过）',
      'test(\'x\', () => {\n  list.forEach(item => { if (!item) return; use(item); });\n  assert.ok(true);\n});', 0],
    ['真阴性: 方法简写里的 return（对象字面量回调）',
      'test(\'x\', () => {\n  const o = { subscribe(l) { if (!l) return; use(l); } };\n  assert.ok(o);\n});', 0],
    ['真阴性: generator 方法里的 return',
      'test(\'x\', async () => {\n  const llm = { async *stream() { if (ok) { yield 1; return; } yield 2; } };\n  assert.ok(llm);\n});', 0],
    ['真阴性: 断言在辅助函数里（体内 0 assert）',
      'function check(el) { assert.ok(el); }\ntest(\'x\', () => {\n  check(1);\n  if (a) return;\n});', 0],
    ['真阴性: 显式声明了 skip',
      'test(\'x\', { skip: !has }, () => {\n  if (!has) return;\n  assert.ok(has);\n});', 0],
    ['真阴性: 双斜杠注释里的 return 不算',
      'test(\'x\', () => {\n  // 这里可以先 return 吗\n  assert.ok(true);\n});', 0],
    ['真阴性: 字符串里的 return 不算',
      'test(\'x\', () => {\n  const s = "return;";\n  assert.ok(s);\n});', 0],
  ];
  const bad = [];
  for (const [label, src, expected] of CASES) {
    const got = scanEarlyReturns(src, 'inline.mjs').length;
    if (got !== expected) bad.push(label + '（期望 ' + expected + '，实际 ' + got + '）');
  }
  assert.deepEqual(bad, [], '检查器自证失败，说明它不可信：\n' + bad.join('\n'));
  // 真实性：至少要有 3 条真阳性被检出，否则「全不报」也能骗过上面。
  const positives = CASES.filter(c => c[2] > 0).length;
  assert.ok(positives >= 3, '真阳性样例必须有足够覆盖，实际 ' + positives + ' 条');
});

test('[提前 return] 全仓扫描: 不得有「断言之前就 return 且未显式声明 skip」的用例', () => {
  const found = scanDir(TESTS_DIR);
  const lines = found.map(f => f.file + ':' + f.line + '  （用例起于 :' + f.declLine + '）');
  assert.deepEqual(lines, [],
    '发现 ' + lines.length + ' 处「用提前 return 冒充跳过」。这些用例在数据缺失时会报 ✔ pass，'
    + '却一次断言都没做 —— 换一台机器就是假绿。请改用 test(..., { skip: 条件 }, ...)：\n'
    + lines.join('\n'));
});
