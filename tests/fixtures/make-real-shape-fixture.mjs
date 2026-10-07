import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 脱敏脚本：把真实落库文件摘成**形状样本**，供 tests/fixtures/real-shape-records.json 使用。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 真数据回放闸（tests/real-shape-replay.test.mjs）的价值取决于真文件在不在。
 * 31 份真文件只在审计机上有，换台机器就全 skip —— 那不是持续保护。
 * 本脚本把它们**脱敏**后固化进仓库，让闸在任何机器上都是真闸。
 *
 * ── 脱敏规则（三条）────────────────────────────────────────────────
 * 1. **内容全部替换**：任何字符串都不原样保留。正文/问题换成
 *    「（合成）第N条…」这类明显假的占位文本。
 * 2. **长度特征保留**：正文长度**不按原长度照抄**，而是归到三档
 *    （short 5-20 / medium 21-80 / long 81+），因为长度本身可能泄露信息
 *    （例如能看出哪条回答特别长），但**保留"有长有短"这个结构特征**对回放有意义。
 * 3. **标识全部合成**：sessionId / recordId 换成 syn-session-NN / syn-record-NNNN；
 *    时间戳换成固定的合成时间轴；路径、provider/model 名一律合成。
 *
 * 用法：node tests/fixtures/make-real-shape-fixture.mjs
 * 输出：tests/fixtures/real-shape-records.json
 */

const REAL_DIRS = [
  '/home/dsh/.dsh-test/explain-assistant/sessions',
  '/home/dsh/.dsh/explain-assistant/sessions',
];

/** 三档长度：保留"有长有短"的结构特征，但不照抄真实长度。 */
export const LENGTH_TIERS = { short: 12, medium: 40, long: 160 };
function tierOf(length) {
  if (length <= 20) return 'short';
  if (length <= 80) return 'medium';
  return 'long';
}
/** 合成正文：明显是假的，且长度落在对应档位。 */
function syntheticText(tier, label, index) {
  const base = '（合成内容）' + label + ' ' + index + ' ';
  const target = LENGTH_TIERS[tier];
  let text = base;
  while (text.length < target) text += '占位文本。';
  return text.slice(0, Math.max(target, base.length));
}

// 固定合成时间轴（不照抄真实时间戳）
function syntheticTime(offsetMinutes) {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  return new Date(base + offsetMinutes * 60_000).toISOString();
}

const sessions = [];
let sessionIndex = 0;
for (const dir of REAL_DIRS) {
  let names = [];
  try { names = readdirSync(dir); } catch { continue; }
  for (const name of names) {
    if (!name.endsWith('.json') || name.includes('.corrupt.')) continue;
    let state;
    try { state = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    sessionIndex++;
    const sessionId = 'syn-session-' + String(sessionIndex).padStart(2, '0');
    let recordIndex = 0;
    const records = (Array.isArray(state.records) ? state.records : []).map(record => {
      recordIndex++;
      const id = 'syn-record-' + String(sessionIndex).padStart(2, '0') + '-' + String(recordIndex).padStart(3, '0');
      const questionTier = tierOf(typeof record.question === 'string' ? record.question.length : 0);
      const answerTier = tierOf(typeof record.answerText === 'string' ? record.answerText.length : 0);
      const reasoningTier = tierOf(typeof record.reasoningText === 'string' ? record.reasoningText.length : 0);
      const out = {
        id,
        kind: record.kind === 'compact' ? 'compact' : 'ask',
        status: typeof record.status === 'string' ? record.status : 'complete',
        complete: record.complete === true,
        question: syntheticText(questionTier, '问题', recordIndex),
        answerText: typeof record.answerText === 'string' && record.answerText ? syntheticText(answerTier, '回答', recordIndex) : '',
        reasoningText: typeof record.reasoningText === 'string' && record.reasoningText ? syntheticText(reasoningTier, '推理', recordIndex) : '',
        startedAt: syntheticTime(sessionIndex * 100 + recordIndex),
        updatedAt: syntheticTime(sessionIndex * 100 + recordIndex + 1),
      };
      // 可选字段：**只保留形状**（有没有这个键），值一律合成
      if (record.usage !== undefined) out.usage = { inputTokens: recordIndex * 10, outputTokens: recordIndex * 5 };
      if (Array.isArray(record.evidence)) out.evidence = record.evidence.map((item, i) => ({
        schemaVersion: 1,
        sessionId,
        kind: 'workspace_file',
        title: '（合成）依据 ' + (i + 1),
        summary: syntheticText('medium', '依据摘要', i + 1),
        source: '（合成）来源路径/文件-' + (i + 1) + '.md',
        evidenceState: typeof item.evidenceState === 'string' ? item.evidenceState : 'observed',
        capturedAt: syntheticTime(sessionIndex * 100 + i),
        truncated: item.truncated === true,
        incomplete: item.incomplete === true,
      }));
      if (Array.isArray(record.tools)) out.tools = record.tools.map((item, i) => ({
        callId: 'syn-call-' + recordIndex + '-' + (i + 1),
        tool: '（合成工具名-' + ((i % 3) + 1) + '）',
        status: typeof item.status === 'string' ? item.status : 'ok',
        arguments: { path: '（合成）路径-' + (i + 1) },
        result: { ok: true, note: '（合成）结果' },
        startedAt: syntheticTime(sessionIndex * 100 + i),
        finishedAt: syntheticTime(sessionIndex * 100 + i + 1),
      }));
      if (Array.isArray(record.images)) out.images = record.images.map((item, i) => ({
        sha256: 'syn-sha256-' + String(i).padStart(64, '0'),
        relativePath: '（合成）图片-' + (i + 1) + '.png',
        mimeType: 'image/png',
        bytes: 1024 + i,
      }));
      if (typeof record.reason === 'string') out.reason = record.reason;
      return out;
    });
    sessions.push({
      name: sessionId + '.json',
      state: {
        schemaVersion: 1,
        sessionId,
        records,
        unread: state.unread === true,
        archived: state.archived === true,
        ...(state.explicitModel ? { explicitModel: { provider: 'syn-provider', model: 'syn-model' } } : {}),
        ...(state.compactState ? { compactState: { status: 'complete', summary: syntheticText('medium', '摘要', 1), createdAt: syntheticTime(sessionIndex * 100) } } : {}),
        createdAt: syntheticTime(sessionIndex * 100),
        updatedAt: syntheticTime(sessionIndex * 100 + 99),
        historyRevision: sessionIndex,
      },
    });
  }
}

const fixture = {
  _README: [
    '这是**脱敏后的真实落库形状样本**，供 tests/real-shape-replay.test.mjs 在没有真文件的机器上跑真断言。',
    '它由 tests/fixtures/make-real-shape-fixture.mjs 从审计机上的真实落库文件（31 份 / 63 条记录）摘出。',
    '脱敏规则：字符串内容全部替换为合成占位；长度归为 short/medium/long 三档（不照抄真实长度，但保留长短结构）；',
    '会话 id、记录 id、时间戳、路径、provider/model 名一律合成。',
    '**它不是真实用户数据**，不包含任何真实对话内容；保留的是字段名、嵌套层级、类型与可选性这些形状特征。',
  ],
  shapeVersion: 1,
  sourceSummary: { files: sessions.length, records: sessions.reduce((n, s) => n + s.state.records.length, 0) },
  sessions,
};

const outPath = join(dirname(fileURLToPath(import.meta.url)), 'real-shape-records.json');
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
console.log('已写出', outPath);
console.log('  会话数 =', sessions.length, '| 记录数 =', fixture.sourceSummary.records);
