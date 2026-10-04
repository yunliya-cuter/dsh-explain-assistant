import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';

const tools = await moduleFromSource('src/host/tools.ts');
const temp = async (t) => { const p = await mkdtemp(path.join(tmpdir(), 'ea-tools-')); t.after(() => rm(p, { recursive: true, force: true })); return p; };

/**
 * F5 的真实运行时验证。
 *
 * 这里**不** grep 源码，而是真的调用 executeTool，用真实文件系统跑。
 * 修复前的 toolContext 恒为 workspace: undefined 且没有 imageSnapshotRoot，
 * 所以下面这些用例会全部拿到 FILESYSTEM_UNAVAILABLE / IMAGE_UNAVAILABLE。
 */

const run = (ctx, name, args) => tools.executeTool(ctx, { name, arguments: args });

test('F5 真实运行: 有 workspace 时 list_workspace 能列出真实目录', async t => {
  const dir = await temp(t);
  await writeFile(path.join(dir, 'a.txt'), 'hello');
  await mkdir(path.join(dir, 'sub'));
  const result = await run({ sessionId: 's', workspace: dir }, 'explain_list_workspace', {});
  assert.equal(result.ok, true, '必须成功，而不是 FILESYSTEM_UNAVAILABLE：' + JSON.stringify(result));
  assert.ok(Array.isArray(result.value));
  assert.ok(result.value.some(e => e.title === 'a.txt'), '必须列出真实文件');
  assert.ok(result.value.some(e => e.title === 'sub'), '必须列出子目录');
});

test('F5 真实运行: 有 workspace 时 read_workspace_file 能读出真实内容', async t => {
  const dir = await temp(t);
  await writeFile(path.join(dir, 'a.txt'), '真实内容-needle');
  const result = await run({ sessionId: 's', workspace: dir }, 'explain_read_workspace_file', { path: 'a.txt' });
  assert.equal(result.ok, true, '必须成功：' + JSON.stringify(result));
  assert.match(result.value.text, /真实内容-needle/);
});

test('F5 真实运行: 有 workspace 时 search_workspace 能搜到内容', async t => {
  const dir = await temp(t);
  await writeFile(path.join(dir, 'a.txt'), 'unique-needle-xyz');
  const result = await run({ sessionId: 's', workspace: dir }, 'explain_search_workspace', { query: 'unique-needle-xyz' });
  assert.equal(result.ok, true, '必须成功：' + JSON.stringify(result));
  assert.equal(result.value.length, 1);
});

test('F5 真实运行: 有 imageSnapshotRoot 时 read_workspace_image 能生成快照', async t => {
  const dir = await temp(t);
  const root = await temp(t);
  // 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path.join(dir, 'p.png'), png);
  const result = await run({ sessionId: 's', workspace: dir, imageSnapshotRoot: root }, 'explain_read_workspace_image', { path: 'p.png' });
  assert.equal(result.ok, true, '必须成功，而不是 IMAGE_UNAVAILABLE：' + JSON.stringify(result));
  assert.equal(result.value.snapshot.mediaType, 'image/png');
  assert.equal(result.value.snapshot.bytes, png.length);
});

test('F5 真实运行: get_model_context 返回注入的模型上下文', async () => {
  const modelContext = { provider: 'p', id: 'm', context: { contextWindow: 256000 } };
  const result = await run({ sessionId: 's', modelContext }, 'explain_get_model_context', {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, modelContext, '必须返回真实模型上下文，而不是 {available:false}');
});

test('反例: 缺 workspace 时三个工作区工具必须明确报不可用（不得静默成功）', async () => {
  for (const [name, args] of [['explain_list_workspace', {}], ['explain_read_workspace_file', { path: 'a.txt' }], ['explain_search_workspace', { query: 'x' }]]) {
    const result = await run({ sessionId: 's' }, name, args);
    assert.equal(result.ok, false, name + ' 缺 workspace 时不得假装成功');
    assert.equal(result.code, 'FILESYSTEM_UNAVAILABLE', name + ' 应报 FILESYSTEM_UNAVAILABLE');
  }
});

test('反例: 缺 imageSnapshotRoot 时读图必须明确报不可用', async () => {
  const result = await run({ sessionId: 's', workspace: '/tmp' }, 'explain_read_workspace_image', { path: 'x.png' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IMAGE_UNAVAILABLE');
});

test('反例: 工作区工具仍受路径逃逸防护约束（只读边界不倒退）', async t => {
  const dir = await temp(t);
  const result = await run({ sessionId: 's', workspace: dir }, 'explain_read_workspace_file', { path: '../etc/passwd' });
  assert.equal(result.ok, false, '越界路径必须被拒');
  assert.ok(['PATH_INVALID', 'PATH_OUTSIDE_WORKSPACE'].includes(result.code), '必须是路径类拒绝：' + result.code);
});
