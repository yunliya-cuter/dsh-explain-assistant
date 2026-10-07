import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, copyFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 真数据回放闸：**用磁盘上的真实落库文件**喂给各条读路径。
 *
 * ── 为什么要建这个文件（本轮最贵的一课）────────────────────────────────
 * 缺陷2（占用把回答正文算成 0 个字）**在 450 条测试全绿的情况下溜了过去**。
 * 机制是这样的：测试给 occupancy 喂的假数据字段名叫 `answer`，
 * 而被测代码读的**也正是** `answer` —— 假数据与真数据不同形，
 * 于是「全绿」只能证明「假数据能跑通」，证明不了真实运行。
 * 真磁盘上根本没有 `answer` 这个字段，只有 `answerText`
 * （另一队友实测：31 文件 / 63 记录，answerText 63/63，answer 出现 0 次）。
 *
 * 所以这个文件**不构造任何记录**：它把真实文件原样拷进来，直接喂真路由。
 * 它对「字段名悄悄改了」这类缺陷敏感，因为断言是拿**真字段**算出来的。
 *
 * ── 没有真实文件的环境怎么办（任务的硬要求）────────────────────────────
 * 用 `test.skip`：真实文件只在开发/审计机上存在，CI 上不该因此变红。
 * 但**不能默默跳过** —— 见文件末尾的「跳过可见性」用例：它断言
 * 「要么回放到了真数据，要么明确标了 skip」，不会出现「悄悄 0 条还报绿」。
 */

const REAL_DIRS = [
  '/home/dsh/.dsh-test/explain-assistant/sessions',
  '/home/dsh/.dsh/explain-assistant/sessions',
];

/**
 * 读磁盘真文件（过滤 .corrupt.* 备份，它们不是会话文件）。
 *
 * ⚠️ 这里**连原始字节一起快照**（session.raw），而不是只存解析后的 state。
 * 原因是实测到过的偶发红：审计机上 3082 是**活着的**，会往同一个会话文件里追加记录。
 * 若「模块加载时解析出快照」和「用例里再拷一次文件」是两次读盘，
 * 中间被追加的记录就会让「拷贝到的那份」比「快照」多几条，
 * 于是 totalRecords / 翻页 id 集合对不上 —— 表现为**偶发的 1 条红**（我确实遇到过一次）。
 * 现在用例拷贝的是**同一份快照字节**，被测文件与比对基准必然一致，与外部写入无关。
 */
function loadDiskSessions() {
  const sessions = [];
  for (const dir of REAL_DIRS) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.json') || name.includes('.corrupt.')) continue;
      try {
        const raw = readFileSync(join(dir, name), 'utf8');
        const state = JSON.parse(raw);
        sessions.push({ name, id: name.replace(/\.json$/, ''), dir, raw, state, records: Array.isArray(state.records) ? state.records : [] });
      } catch { /* 坏文件跳过（真实目录里有 .corrupt 备份，也可能有半截文件） */ }
    }
  }
  return sessions;
}

/**
 * 读**脱敏固件**（tests/fixtures/real-shape-records.json）。
 *
 * 为什么要有它：真文件只在审计机上有；换台机器就全 skip，那不是持续保护。
 * 固件由 tests/fixtures/make-real-shape-fixture.mjs 从真文件摘出**形状**、
 * 内容全部合成（见该脚本头部与固件里的 _README）。它**不是真实用户数据**。
 */
function loadFixtureSessions() {
  try {
    const raw = readFileSync(new URL('./fixtures/real-shape-records.json', import.meta.url), 'utf8');
    const fixture = JSON.parse(raw);
    return (fixture.sessions ?? []).map(entry => ({
      name: entry.name,
      id: entry.state.sessionId,
      dir: '(fixture)',
      state: entry.state,
      records: Array.isArray(entry.state.records) ? entry.state.records : [],
    }));
  } catch { return []; }
}

const DISK = loadDiskSessions();
const FIXTURE = loadFixtureSessions();
/**
 * 数据源选择：**优先真文件，缺了就用固件**。两条路径都跑**同一批真断言**。
 *
 * 说明（为什么优先真文件）：真文件是「野生」数据 —— 它的字段组合不必遵守我们的合成规则，
 * 所以它比固件更能发现意外形状。固件是保底，保证任何机器上都有得跑。
 */
const USING = DISK.length ? 'disk' : (FIXTURE.length ? 'fixture' : 'none');
const REAL = DISK.length ? DISK : FIXTURE;
const HAS_DATA = REAL.length > 0;
const ALL_RECORDS = REAL.flatMap(s => s.records);
const ASK_RECORDS = ALL_RECORDS.filter(r => r && r.kind === 'ask');
/** 有正文的记录（缺陷2 的回归判据就建立在这些上）。 */
const ASK_WITH_TEXT = ASK_RECORDS.filter(r => typeof r.answerText === 'string' && r.answerText.length > 0);
/**
 * 只有「固件也读不到」才 skip —— 那属于仓库损坏（固件是随仓库提交的文件），
 * 报红会更容易发现问题。但为了不把别的机器搞红，这里仍用 skip 并写明原因，
 * 另有一条**防假绿**用例（见下）专门检查「不该 skip 的时候没 skip」。
 */
const SKIP = HAS_DATA ? false
  : '既没有真文件也没有固件（仓库损坏：tests/fixtures/real-shape-records.json 缺失或不可解析）';

/** 起一个真宿主，并把真实文件拷进它的存储目录。 */
async function startReplayHost() {
  const home = mkdtempSync(join(tmpdir(), 'ea-replay-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const rootDir = join(home, 'explain-assistant');
  const sessionsDir = join(rootDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  let copied = 0;
  for (const session of REAL) {
    // 两种数据源都要能落进存储目录：
    //  · 真文件 → 原样拷贝（连非法/意外形状一起保留，那正是"野生数据"的价值）；
    //  · 固件 → 没有源文件可拷，直接把脱敏后的 state 写出来。
    // （先前这里只处理真文件，换到固件路径就 ENOENT —— 是防假绿测试暴露出来的真问题。）
    const target = join(sessionsDir, session.name);
    // 一律写**快照字节**：真文件写它加载时的原文，固件写脱敏 state。
    // 不再「重新拷一次磁盘文件」—— 那会与快照之间出现竞态（3082 在活写，实测导致偶发红）。
    const raw = session.dir === '(fixture)' ? JSON.stringify(session.state, null, 2) + '\n' : session.raw;
    writeFileSync(target, raw, 'utf8');
    copied++;
  }
  const routes = new Map();
  try {
    const index = await moduleFromSource('src/index.ts');
    index.apply({
      llm: { listProviders: async () => [], listModels: async () => [] },
      sessionQuery: {},
      connection: { fetch: { register: entry => { routes.set(entry.path, entry.fetch); } } },
      effect: () => {}, get: () => undefined,
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
  }
  const get = async (path) => {
    const entry = routes.get(path.split('?')[0]);
    assert.ok(entry, '路由未注册：' + path);
    const handler = typeof entry === 'function' ? entry : entry.fetch;
    const response = await handler(new Request('http://h' + path));
    const body = await response.json();
    return { status: response.status, body };
  };
  return {
    home, rootDir, copied,
    restore() { rmSync(home, { recursive: true, force: true }); },
    state: (id) => get('/api/explain-assistant/state?sessionId=' + encodeURIComponent(id)),
    history: (id, cursor) => get('/api/explain-assistant/history?sessionId=' + encodeURIComponent(id) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')),
    historyResult: (id, recordId, cursor) => get('/api/explain-assistant/history-result?sessionId=' + encodeURIComponent(id)
      + '&recordId=' + encodeURIComponent(recordId) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')),
  };
}

/* ================================================================== *
 * 0) 跳过可见性 —— 防止「悄悄 0 条还报绿」
 * ================================================================== */

test('真数据回放: 数据源可见且必须有数据（不得悄悄 0 条还报绿）', () => {
  console.log('  [real-shape-replay] 数据源 =', USING, '| 文件 =', REAL.length, '| 记录 =', ALL_RECORDS.length,
    '| ask =', ASK_RECORDS.length, '| 有正文的 ask =', ASK_WITH_TEXT.length);
  // 这条**不 skip**：数据源必须存在（真文件或固件），否则就是仓库坏了。
  // 固件是随仓库提交的文件，它读不到属于真问题，不该被 skip 掩盖。
  assert.ok(HAS_DATA, '必须有数据源（真文件或固件）；两者都没有说明仓库损坏：' + SKIP);
  assert.ok(ALL_RECORDS.length > 0, '数据源里必须有记录，否则下面的"真断言"都是空跑');
});

test('真数据回放 防假绿: 固件真的被接上了 —— 数据源缺真文件时仍跑真断言（不只跑"可得性" 1 条）', () => {
  // ── 这条的由来 ────────────────────────────────────────────────────
  // task-28 我吃过一次假绿的亏：被改坏的防线因为前置守卫先命中而**从未被检验**，
  // 测试照样全绿。这一次直接把「固件有没有真的接上」钉死。
  //
  // 做法：**模拟「磁盘真文件不可得」**，断言此时
  //   (1) 数据源自动落到 fixture；
  //   (2) 固件里有足够多的记录与「有正文的 ask」，足以支撑真断言
  //       （而不是只有 1 条「可得性」用例在跑、其余全 skip 还说绿）；
  //   (3) 基于固件跑一次**真实计算**（不是只看长度），证明断言真的执行了。
  const fixtureFallback = FIXTURE;   // 绕过磁盘，直接用固件（等价于磁盘不可得）
  assert.ok(fixtureFallback.length > 0,
    '固件必须存在（tests/fixtures/real-shape-records.json）—— 否则别的机器上闸会退化成 skip');

  const fixtureRecords = fixtureFallback.flatMap(s => s.records);
  const fixtureAskWithText = fixtureRecords.filter(r => r && r.kind === 'ask' && typeof r.answerText === 'string' && r.answerText.length > 0);

  // (2) 数量必须与真文件路径同量级：真文件是 27 条有正文 ask；固件不得只有一两条。
  assert.ok(fixtureRecords.length >= 30,
    '固件记录数必须与真文件同量级（真 63+），实际 ' + fixtureRecords.length);
  assert.ok(fixtureAskWithText.length >= 10,
    '固件里「有正文的 ask」必须足够多，否则真断言是空跑：实际 ' + fixtureAskWithText.length);

  // (3) 用固件**真跑一次**计算，证明不是空断言
  return import('../src/host/occupancy.ts').catch(() => undefined).then(async () => {
    const occupancy = await moduleFromSource('src/host/occupancy.ts');
    const expected = fixtureAskWithText.reduce((sum, r) => sum + r.answerText.length, 0);
    const carried = occupancy.carriedRecords(fixtureAskWithText);
    const measured = occupancy.measureAssistantOccupancy({ systemPrompt: '', contextWindow: 1_000_000, records: carried });
    assert.ok(expected > 0 && measured, '固件上必须能算出占用（证明断言真的执行了）');
    assert.ok(measured.parts.ownChars >= expected,
      '固件上正文也必须被计入：期望 ≥ ' + expected + '，实际 ' + measured.parts.ownChars);
  });
});

/*
 * ⚠️ 这条曾用「体内提前 return」当作跳过 —— 那是**假的跳过**（task-44 修正）。
 *
 * 实测 node:test 的语义（最小复现见 docs/evidence/skip-vs-return-sweep.md）：
 *   test 体内 if (true) { return }        → 报 ✔ pass、skipped = 0
 *   test(..., { skip: true }, () => {...}) → 报 ﹣ skip
 * 所以旧写法在**没有真文件的机器上**会「0 次比对却报 pass」——
 * 在本机（有真文件）完全看不出来，换一台机器就是假绿。
 * 旧注释还写着「明确 skip 而不是假绿」，那句话与行为不符，已一并改准。
 *
 * 现在改用**显式 skip**：没有真文件时报告为 ﹣，skipped 计数 +1。
 * 那个 +1 是诚实呈现 —— 它明确告诉读者「这条这次没验」，而不是含糊地显示成绿色的 pass。
 */
test('真数据回放 脱敏硬闸: 固件里不得含真文件任何一段实质正文（30+ 字符子串）',
  { skip: DISK.length ? false : '本机无真实落库文件可比对（脱敏比对需要真文件）' },
  async () => {
  const diskSessions = DISK;
  const fixtureRaw = readFileSync(new URL('./fixtures/real-shape-records.json', import.meta.url), 'utf8');

  const substrings = new Set();
  const collect = (value) => {
    if (typeof value === 'string') {
      for (let i = 0; i + 30 <= value.length; i++) substrings.add(value.slice(i, i + 30));
      return;
    }
    if (Array.isArray(value)) { for (const v of value) collect(v); return; }
    if (value && typeof value === 'object') { for (const v of Object.values(value)) collect(v); }
  };
  for (const session of diskSessions) collect(session.state);

  const leaked = [...substrings].filter(s => fixtureRaw.includes(s));
  assert.deepEqual(leaked.slice(0, 5), [],
    '固件里泄漏了真文件的实质正文（共 ' + leaked.length + ' 段 30+ 字符子串）');
  assert.ok(substrings.size > 0, '前置：真文件里应当能取出足够多的子串，否则这条闸是空的');
});

/* ================================================================== *
 * 1) 真形状基准 —— 磁盘上确实长这样（不是猜的）
 * ================================================================== */

test('真数据回放: 磁盘真实记录用的是 answerText，不是 answer', { skip: SKIP }, () => {
  assert.ok(ALL_RECORDS.length > 0, '至少要回放到记录');
  // 这条是「真形状」的定义本身：读侧必须按这个字段名取值
  for (const record of ALL_RECORDS) {
    assert.equal('answer' in record, false,
      '真实磁盘记录里不该有 answer 字段（那是客户端本地形状）：' + JSON.stringify(Object.keys(record)));
  }
  for (const record of ASK_WITH_TEXT) {
    assert.equal(typeof record.answerText, 'string', '有正文的 ask 记录必须带 answerText');
  }
});

/* ================================================================== *
 * 2) 占用：每条真实 ask 的回答正文都要被计入（缺陷2 的回归闸）
 * ================================================================== */

test('真数据回放: 每条真实 ask 的回答正文都被计入占用（缺陷2 回归闸）', { skip: SKIP }, async () => {
  const occupancy = await moduleFromSource('src/host/occupancy.ts');
  assert.ok(ASK_WITH_TEXT.length > 0, '需要有带正文的真实记录，否则这条闸是空的');

  // 判据完全来自**真字段** answerText：ownChars 必须 ≥ 所有正文长度之和。
  // 这是「用真数据算断言」的关键 —— 假数据版会写成 record.answer，正好和坏实现一起绿。
  const expectedChars = ASK_WITH_TEXT.reduce((sum, r) => sum + r.answerText.length, 0);
  const carried = occupancy.carriedRecords(ASK_RECORDS);
  const measured = occupancy.measureAssistantOccupancy({ systemPrompt: '', contextWindow: 1_000_000, records: carried });

  assert.ok(expectedChars > 0, '真实数据里必须有正文，否则这条断言无意义');
  assert.ok(measured, '应能算出占用');
  assert.ok(measured.parts.ownChars >= expectedChars,
    '真实回答正文必须全部计入占用：期望 ≥ ' + expectedChars + '，实际 ' + measured.parts.ownChars
    + '（差额说明有记录的正文被读成了空 —— 这正是缺陷2 的形态）');
});

test('真数据回放: 逐条核对 —— 任何一条真实 ask 的正文都不能被读成空', { skip: SKIP }, async () => {
  const occupancy = await moduleFromSource('src/host/occupancy.ts');
  const broken = [];
  for (const record of ASK_WITH_TEXT) {
    const carried = occupancy.carriedRecords([record]);
    const text = carried[0] && typeof carried[0].answerText === 'string' ? carried[0].answerText : '';
    if (text !== record.answerText) {
      broken.push({ id: record.id, expected: record.answerText.slice(0, 40), actual: String(text).slice(0, 40) });
    }
  }
  assert.deepEqual(broken, [], '这些真实记录的正文被读成了空/不一致：' + JSON.stringify(broken));
});

test('真数据回放: 假形状（answer）也仍被认 —— 两套形状都要认，不能只顾一头', { skip: SKIP }, async () => {
  const occupancy = await moduleFromSource('src/host/occupancy.ts');
  // 反方向：客户端本地记录用 answer。如果哪天有人「只支持 answerText」，
  // 本地那条路径就会静默归零 —— 这条防止修缺陷2 时修过头。
  const text = '本地形状的回答正文';
  const carried = occupancy.carriedRecords([{ id: 'local', kind: 'ask', question: 'q', answer: text, createdAt: new Date().toISOString() }]);
  assert.equal(carried[0]?.answerText, text, '客户端本地形状（answer）也必须被认');
});

/* ================================================================== *
 * 3) loadState 分页语义（真文件）
 * ================================================================== */

test('真数据回放: loadState 的 totalRecords 与 records 切片自洽', { skip: SKIP }, async () => {
  const host = await startReplayHost();
  try {
    assert.equal(host.copied, REAL.length, '真实文件必须原样拷进被测存储');
    for (const session of REAL) {
      const { status, body } = await host.state(session.id);
      if (status !== 200) continue;   // 个别真实文件可能被 guard 拒（例如奇怪 id），跳过而非误判
      const payload = body.payload;
      assert.equal(payload.totalRecords, session.records.length,
        session.id + ' 的 totalRecords 必须等于磁盘真实条数');
      const expectedSlice = session.records.slice(Math.max(0, session.records.length - 20));
      assert.deepEqual(payload.records.map(r => r.id), expectedSlice.map(r => r.id),
        session.id + ' 的 records 必须是磁盘上**最近一页**的真实切片');
      assert.equal(payload.hasEarlier, session.records.length > 20, session.id + ' 的 hasEarlier 必须与磁盘条数一致');
    }
  } finally { host.restore(); }
});

/* ================================================================== *
 * 4) loadHistory 分页：不重不漏（真 id 集合对比）
 * ================================================================== */

test('真数据回放: loadHistory 按游标翻页，与磁盘 id 集合**不重不漏**', { skip: SKIP }, async () => {
  const host = await startReplayHost();
  try {
    for (const session of REAL) {
      if (!session.records.length) continue;
      const diskIds = session.records.map(r => r.id);
      const seen = [];
      let cursor;
      for (let guard = 0; guard < 200; guard++) {
        const { status, body } = await host.history(session.id, cursor);
        if (status !== 200) break;
        const page = body.payload?.records ?? [];
        if (!page.length) break;
        seen.push(...page.map(r => r.id));
        if (!body.payload.hasEarlier) break;
        cursor = body.payload.cursor;
        if (cursor === undefined) break;
      }
      assert.deepEqual([...seen].sort(), [...diskIds].sort(),
        session.id + ' 翻页结果必须与磁盘 id 集合完全一致（不重不漏）');
      assert.equal(new Set(seen).size, seen.length, session.id + ' 翻页不得出现重复记录');
    }
  } finally { host.restore(); }
});

/* ================================================================== *
 * 5) loadHistoryResult：counts / cursor / hasEarlier 自洽（真记录）
 * ================================================================== */

test('真数据回放: loadHistoryResult 对每条真实记录 counts 与数组长度自洽', { skip: SKIP }, async () => {
  const host = await startReplayHost();
  try {
    let checked = 0;
    for (const session of REAL) {
      for (const record of session.records) {
        const { status, body } = await host.historyResult(session.id, record.id);
        if (status !== 200) continue;
        const payload = body.payload;
        assert.equal(payload.recordId, record.id, '必须返回请求的那条记录');
        assert.equal(payload.counts.evidence, (record.evidence ?? []).length, record.id + ' evidence 计数');
        assert.equal(payload.counts.tools, (record.tools ?? []).length, record.id + ' tools 计数');
        assert.equal(payload.counts.images, (record.images ?? []).length, record.id + ' images 计数');
        const total = Math.max(payload.counts.evidence, payload.counts.tools, payload.counts.images);
        assert.equal(payload.hasEarlier, total > 20, record.id + ' hasEarlier 必须与总数自洽');
        assert.equal(payload.cursor, total > 20 ? '20' : null, record.id + ' cursor 必须与总数自洽');
        checked++;
      }
    }
    assert.ok(checked > 0, '至少要真实核对到一条记录');
  } finally { host.restore(); }
});

test('真数据回放: loadHistoryResult 的真实回答正文能原样取到（§8 关闭再打开能查看）', { skip: SKIP }, async () => {
  const host = await startReplayHost();
  try {
    let checked = 0;
    for (const session of REAL) {
      for (const record of session.records) {
        if (typeof record.answerText !== 'string' || !record.answerText) continue;
        const { status, body } = await host.historyResult(session.id, record.id);
        if (status !== 200) continue;
        assert.equal(body.payload.record.answerText, record.answerText,
          record.id + ' 的正文必须与磁盘逐字节一致（§8：关闭再打开能看到）');
        checked++;
      }
    }
    assert.ok(checked > 0, '至少要核对到一条带正文的真实记录');
  } finally { host.restore(); }
});

/* ================================================================== *
 * 6) 客户端字段判定逻辑：真形状下必须都能取到值
 * ================================================================== */

/** overlay.tsx:397/398/399 与 :468/470 的字段判定逻辑（等价实现）。 */
function overlayRead(record) {
  return {
    answer: typeof record.answerText === 'string' && record.answerText ? record.answerText : record.answer,
    at: record.startedAt ?? record.createdAt,
    reasoning: typeof record.reasoningText === 'string' && record.reasoningText ? record.reasoningText : record.reasoning,
    incomplete: (record.incomplete === true) || record.status === 'interrupted' || record.status === 'error' || record.complete === false,
  };
}

test('真数据回放: 客户端字段判定在真形状下都能取到值（answerText??answer 等）', { skip: SKIP }, () => {
  // 注：overlay.tsx 不便直接调用（它是 DOM 渲染函数，依赖浮窗节点）。
  // 这里用**等价实现**复刻它的字段判定（同一套 ?? 与 typeof 判据），
  // 并额外用源码断言钉住它真的还在用双读 —— 防止等价实现与真实现漂移。
  const broken = [];
  for (const record of ASK_WITH_TEXT) {
    const read = overlayRead(record);
    if (read.answer !== record.answerText) broken.push({ id: record.id, got: String(read.answer).slice(0, 30) });
    if (typeof read.at !== 'string' || !read.at) broken.push({ id: record.id, why: '时间取不到' });
  }
  assert.deepEqual(broken, [], '真形状下客户端字段判定不应取到空：' + JSON.stringify(broken));

  // 钉住 overlay 真的在双读（否则上面的等价实现可能已经和它不一致）
  const source = readFileSync(new URL('../src/client/overlay.tsx', import.meta.url), 'utf8');
  assert.match(source, /record\.answerText === 'string' && record\.answerText\s*\? record\.answerText : record\.answer/,
    'overlay 必须保持 answerText ?? answer 双读');
  assert.match(source, /record\.startedAt \?\? record\.createdAt/, 'overlay 必须保持 startedAt ?? createdAt 双读');
});

/* ================================================================== *
 * 7) 收尾：不存在「磁盘有内容、读侧取到空」的组合
 * ================================================================== */

test('真数据回放 收尾: 磁盘上每个正文类字段都在读侧判定里被认（无静默取空）', { skip: SKIP }, async () => {
  const occupancy = await moduleFromSource('src/host/occupancy.ts');
  const TEXT_FIELDS = ['answerText', 'reasoningText', 'question'];

  // 列出真实数据里出现过的正文类字段名，逐个确认读侧认得
  const present = new Set();
  for (const record of ALL_RECORDS) {
    for (const key of TEXT_FIELDS) {
      if (typeof record[key] === 'string' && record[key]) present.add(key);
    }
  }
  assert.ok(present.size > 0, '真实数据里应当有正文类字段');

  // 真字段 answerText 必须被占用读取认到
  if (present.has('answerText')) {
    const sample = ASK_WITH_TEXT[0];
    const carried = occupancy.carriedRecords([sample]);
    assert.equal(carried[0].answerText, sample.answerText,
      '磁盘上有 answerText，占用读取就必须认它（否则就是「磁盘有内容、读侧取到空」）');
  }

  // 全局：所有带正文的真实 ask 记录，占用侧读取结果都不能为空
  const empties = ASK_WITH_TEXT.filter(record => {
    const carried = occupancy.carriedRecords([record]);
    return !carried[0] || carried[0].answerText !== record.answerText;
  });
  assert.deepEqual(empties.map(r => r.id), [],
    '存在被读成空的真实记录（这就是新缺陷，应当回报而不是改断言）：' + JSON.stringify(empties.map(r => r.id)));
});
