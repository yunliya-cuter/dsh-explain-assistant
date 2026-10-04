import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexPath = new URL('../src/index.ts', import.meta.url);
const source = await readFile(indexPath, 'utf8');

/* ---------------- §6.1 / §7 / §11.6 F5：只读工具的运行上下文 ---------------- */

test('F5: toolContext 不再把 workspace 恒设为 undefined', () => {
  assert.equal(/workspace:\s*undefined/.test(source), false, 'workspace 不得恒为 undefined（5 个工具恒失败的根因）');
});

test('F5: 工作区根取自主会话 header.cwd', () => {
  assert.match(source, /header\?\.cwd|header\.cwd/, '必须从会话 header 读 cwd');
  assert.match(source, /workspace/, '必须把 workspace 传给工具上下文');
});

test('F5: 图片快照根 imageSnapshotRoot 必须提供', () => {
  assert.match(source, /imageSnapshotRoot/, '读图工具需要 imageSnapshotRoot，否则 IMAGE_UNAVAILABLE');
});

test('F5: modelContext 必须提供（explain_get_model_context 依赖它）', () => {
  assert.match(source, /modelContext/, '模型上下文工具需要 modelContext');
  assert.match(source, /resolveModelInfo/, 'modelContext 应取自 llm.resolveModelInfo');
});

test('F5: 每个工具都拿到 sessionQuery（会话读取工具依赖它）', () => {
  assert.match(source, /sessionQuery,/, 'toolContext 必须带 sessionQuery');
});

/* ---------------- 不倒退：只读边界仍然成立 ---------------- */

test('不倒退: 工具集仍是 7 个只读工具，没有新增写能力', async () => {
  const tools = await readFile(new URL('../src/host/tools.ts', import.meta.url), 'utf8');
  const names = tools.match(/export const TOOL_NAMES[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(names, '必须能读到 TOOL_NAMES');
  assert.equal((names[1].match(/'[^']+'/g) || []).length, 7, '工具数必须仍是 7');
  assert.equal(/write|delete|exec|spawn|rm\b/i.test(names[1]), false, '只读工具集不得出现写类动词');
});
