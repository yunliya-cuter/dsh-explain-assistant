import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 事故回归闸：**0.1.38 一次性误删 30 条已归档会话的小助手记录**。
 * 完整记录：docs/evidence/incident-archive-mass-delete-3082.md
 *
 * ── 事故是什么 ──────────────────────────────────────────────────────
 * 插件 sessions 目录 48 → 18 个文件（删掉 30 条），与 Host archivedSessionIds 的 30 条
 * **数量完全吻合**，现存文件里没有一条属于已归档会话。
 *
 * ── 根因 ────────────────────────────────────────────────────────────
 * DSH 的 workspace client model **在 follow baseline 到达之前**，
 * `archivedSessionIds` 就是一个**合法的空数组**（构造函数 `archivedSessionIds = []`、
 * `phase = 'pending'`；baseline 到达后 `replaceBaseline` 才转 `ready`）。
 * 而旧实现只判 `Array.isArray(...)`，**把未就绪的空数组当成了权威快照**：
 *   ① 插件加载 → sync() 立刻跑 → known = 空集（**假基线**）；
 *   ② baseline 到达（真实 30 条）→ 相对空集**全部**判为「新进入」→ 30 条一次性 forget。
 *
 * ── 教训（写给以后改这个文件的人）──────────────────────────────────
 * 把「未初始化的占位值」当成权威数据，会引发**任意规模**的批量动作
 * （这次 30 条，换成 300 条也一样）。判定就绪必须用**显式的生命周期字段**
 * （`phase === 'ready'`），不能用「数组是否为空」这种间接信号。
 *
 * ── 为什么旧测试没挡住 ──────────────────────────────────────────────
 * 旧的「第一份快照只建基线」测试手工构造的第一份快照**已经是就绪状态**，
 * 恰好绕过了真实运行时的「先 pending 空、后 ready」时序 —— 又一例假绿，而且这次删了数据。
 * 本文件的每条测试都走**真实时序**。
 */

const { createArchiveWatcher } = await moduleFromSource('src/client/archive-watch.ts');

/** 可推快照的假 follow 源，phase 可显式控制。 */
function source(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    push(next) { snapshot = next; for (const l of [...listeners]) l(); },
    get listenerCount() { return listeners.size; },
  };
}

const oldArchived = (n) => Array.from({ length: n }, (_, i) => 'old-archived-' + i);

/* ================================================================== *
 * 1) 事故时序本身：这是 0.1.38 那条路径，必须一条都不删
 * ================================================================== */

test('事故回归: 未就绪(pending/空数组) → 就绪(ready/30条历史归档)，历史归档一条都不许被清理', () => {
  const deleted = [];
  const fake = source({ phase: 'pending', archivedSessionIds: [] });   // 就绪前的**合法空数组**
  const watcher = createArchiveWatcher({ source: fake.source, onArchived: id => { deleted.push(id); } });
  try {
    // ① 插件加载瞬间：读到未就绪的空数组
    assert.deepEqual(deleted, [], '就绪前不得清理任何东西（这条是事故的第一环）');
    // ② Host follow baseline 到达：真实 30 条历史归档
    fake.push({ phase: 'ready', archivedSessionIds: oldArchived(30) });
    // 这就是事故点：旧实现此时会一次性删 30 条
    assert.deepEqual(deleted, [], '就绪后的第一份快照只建基线，30 条历史归档一条都不许删（事故回归）');
    // ③ 再同步一次也不该有任何动静
    assert.deepEqual(watcher.sync(), []);
    assert.deepEqual(deleted, []);
  } finally { watcher.dispose(); }
});

test('事故回归: 30 条历史归档之后，只有真正的新归档才触发清理', () => {
  const deleted = [];
  const fake = source({ phase: 'pending', archivedSessionIds: [] });
  const watcher = createArchiveWatcher({ source: fake.source, onArchived: id => { deleted.push(id); } });
  try {
    fake.push({ phase: 'ready', archivedSessionIds: oldArchived(30) });     // baseline：只建基线
    assert.deepEqual(deleted, [], '30 条历史归档不得触发');
    fake.push({ phase: 'ready', archivedSessionIds: [...oldArchived(30), 'brand-new'] });
    assert.deepEqual(deleted, ['brand-new'], '只有新归档的那一条触发（功能必须仍然有效）');
  } finally { watcher.dispose(); }
});

/* ================================================================== *
 * 2) fail-safe：拿不到 phase 一律不删（宁可漏删，绝不误删）
 * ================================================================== */

test('事故回归 fail-safe: 快照没有 phase 字段时，一律不建立基线、不清理', () => {
  const deleted = [];
  // 未知/更早版本的快照形状：只有 archivedSessionIds，没有 phase
  const fake = source({ archivedSessionIds: [] });
  const watcher = createArchiveWatcher({ source: fake.source, onArchived: id => { deleted.push(id); } });
  try {
    assert.deepEqual(deleted, [], '没有 phase 一律按「不可用」处理，不得建基线');
    fake.push({ archivedSessionIds: oldArchived(30) });
    assert.deepEqual(deleted, [], '无 phase 时即使带来 30 条，也必须一条都不删（fail-safe）');
  } finally { watcher.dispose(); }
});

test('事故回归 fail-safe: phase 是不认识的值（如 undefined/null/其他字符串）一律不删', () => {
  for (const phase of [undefined, null, '', 'loading', 'idle', 'READY', 1, {}]) {
    const deleted = [];
    const fake = source({ phase, archivedSessionIds: [] });
    const watcher = createArchiveWatcher({ source: fake.source, onArchived: id => { deleted.push(id); } });
    try {
      fake.push({ phase, archivedSessionIds: oldArchived(5) });
      assert.deepEqual(deleted, [], 'phase=' + JSON.stringify(phase) + ' 不是精确的 ready，必须一条都不删');
    } finally { watcher.dispose(); }
  }
});

/* ================================================================== *
 * 3) 中途回退：ready → 非 ready 不得把「空」当成「集合变空了」
 * ================================================================== */

test('事故回归: 就绪后回退到 pending（空数组）再恢复，不得把历史归档判成新归档', () => {
  const deleted = [];
  const fake = source({ phase: 'ready', archivedSessionIds: oldArchived(3) });
  const watcher = createArchiveWatcher({ source: fake.source, onArchived: id => { deleted.push(id); } });
  try {
    assert.deepEqual(deleted, [], '第一份就绪快照只建基线');
    fake.push({ phase: 'pending', archivedSessionIds: [] });               // 连接抖动 → 回退
    assert.deepEqual(deleted, [], '回退到未就绪不得触发任何清理');
    fake.push({ phase: 'ready', archivedSessionIds: oldArchived(3) });     // 恢复
    assert.deepEqual(deleted, [], '恢复后仍是同一批历史归档，不得当成新归档（否则又是一次批量误删）');
    // 真来了新的，仍要触发
    fake.push({ phase: 'ready', archivedSessionIds: [...oldArchived(3), 'really-new'] });
    assert.deepEqual(deleted, ['really-new']);
  } finally { watcher.dispose(); }
});

/* ================================================================== *
 * 4) 边界：未就绪不能把功能整个关掉
 * ================================================================== */

test('事故回归: pending 期间的推送不得污染基线（就绪后第一份仍是基线）', () => {
  const deleted = [];
  const fake = source({ phase: 'pending', archivedSessionIds: [] });
  const watcher = createArchiveWatcher({ source: fake.source, onArchived: id => { deleted.push(id); } });
  try {
    fake.push({ phase: 'pending', archivedSessionIds: ['x'] });     // 未就绪时给了数据也必须忽略
    assert.deepEqual(deleted, [], 'pending 期间不得清理');
    fake.push({ phase: 'ready', archivedSessionIds: ['x', 'y'] });  // 就绪：这份仍是基线
    assert.deepEqual(deleted, [], '未就绪期间的推送不得被当成基线（否则 x 会被误判为新归档）');
  } finally { watcher.dispose(); }
});

test('事故回归: dispose 后未就绪→就绪的时序不得触发（订阅已取消）', () => {
  const deleted = [];
  const fake = source({ phase: 'pending', archivedSessionIds: [] });
  const watcher = createArchiveWatcher({ source: fake.source, onArchived: id => { deleted.push(id); } });
  watcher.dispose();
  fake.push({ phase: 'ready', archivedSessionIds: oldArchived(30) });
  assert.deepEqual(deleted, [], '取消订阅后不得触发任何清理');
});

/* ================================================================== *
 * 5) 接线：真实服务形状必须是 phase 驱动的
 * ================================================================== */

test('事故回归 接线: archive-watch 必须显式判定 phase === ready', async () => {
  const { readFileSync } = await import('node:fs');
  const sourceText = readFileSync(new URL('../src/client/archive-watch.ts', import.meta.url), 'utf8');
  assert.match(sourceText, /snapshot\.phase !== 'ready'/, '必须显式要求 phase === ready 才认权威集合');
  // 反面：不得只靠 Array.isArray 判定就绪（旧实现就是这样被击穿的）
  assert.match(sourceText, /Array\.isArray\(raw\)/, '仍需校验形状');
  assert.ok(sourceText.indexOf("phase !== 'ready'") < sourceText.indexOf('Array.isArray(raw)'),
    'phase 判定必须在数组校验**之前**（先问「就绪了吗」，再问「形状对不对」）');
});
