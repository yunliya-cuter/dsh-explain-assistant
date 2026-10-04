import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// 回归守卫：DSH 启动器把未处理的 Promise 拒绝视为致命错误并 proc.exit(1)，
// 整站会随之白屏（实盘证据 /mnt/d/WSL/logs/dsh-web-3082.err 首行 "dsh: fatal load failure"）。
// 因此插件的路由处理器绝对不能派生无人处理的拒绝。

test('route handler never derives an unhandled rejection (source)', () => {
  const source = readFileSync(join(root, 'src/index.ts'), 'utf8');
  assert.equal(
    /task\.finally\s*\(/.test(source), false,
    'src/index.ts 不得对未 catch 的 task 直接 .finally(...)：会派生未处理拒绝',
  );
  assert.match(source, /task\.catch\(/, 'src/index.ts 必须先用 .catch(...) 收敛拒绝');
  assert.match(source, /route failed/, 'src/index.ts 必须记录路由失败日志，便于定位');
});

test('detached run() in stream route is guarded (source)', () => {
  const source = readFileSync(join(root, 'src/host/routes.ts'), 'utf8');
  assert.equal(
    /\}\s*;\s*void run\(\);/.test(source), false,
    'src/host/routes.ts 不得裸调 void run()：catch 块内的 enqueue 对已关闭流会抛错',
  );
  assert.match(source, /void run\(\)\.catch\(/, '游离的 run() 必须自带 .catch 兜底');
});

test('built host entry carries the same guard', () => {
  let built;
  try {
    built = readFileSync(join(root, 'lib/index.js'), 'utf8');
  } catch {
    return; // 尚未构建时跳过（构建后必查）
  }
  assert.equal(/task\.finally\s*\(/.test(built), false, 'lib/index.js 不得含裸 task.finally(');
  assert.match(built, /settled\.finally\(/, 'lib/index.js 必须使用收敛后的 settled');
});

test('send button actually submits the form (source)', () => {
  const source = readFileSync(join(root, 'src/client/overlay.tsx'), 'utf8');
  // 原本是 makeButton('发送','发送问题',()=>{}) 且 type='button'，点击不会有任何反应
  assert.equal(
    /makeButton\([^)]*'发送问题',\s*\(\)\s*=>\s*\{\s*\}\)/.test(source), false,
    '发送按钮不得是空处理器',
  );
  assert.match(source, /requestSubmit\(\)/, '发送按钮必须能触发 form submit');
});
// dsh-llm 的 stream 用**顶层** provider 字段选适配器路由。
// 只传 { model: { provider, model } } 会让路由解析失败、静默返回空文本，
// 表现为用户在界面上「点了发送没反应」。这条守卫防止它被改回去。
test('llm.stream 必须传顶层 provider（否则静默返回空回答）', () => {
  const source = readFileSync(join(root, 'src/host/llm.ts'), 'utf8');
  assert.match(source, /provider\s*:\s*ctx\.model\?\.provider/, 'stream 调用必须传顶层 provider');
  assert.equal(
    /stream\(\{\s*model\s*:\s*ctx\.model\s*,/.test(source), false,
    '不得退回只传 { model: ctx.model } 的旧写法',
  );
});

// 产物里中文必须是可读 UTF-8，否则无法用 grep 核对，出问题也难排查。
test('客户端产物以 UTF-8 输出中文，而不是 \\uXXXX 转义', () => {
  let built;
  try { built = readFileSync(join(root, 'lib/client.js'), 'utf8'); } catch { return; }
  assert.ok((built.match(/[\u4e00-\u9fff]/g) || []).length > 50, 'lib/client.js 里应有可读中文');
  const buildScript = readFileSync(join(root, 'scripts/build-client.mjs'), 'utf8');
  assert.match(buildScript, /charset:\s*'utf8'/, '构建脚本必须显式声明 charset utf8');
});
