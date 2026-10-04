import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleFromSource } from './fixtures/runtime.mjs';

const contracts = await moduleFromSource('src/host/contracts.ts');
const routesModule = await moduleFromSource('src/host/routes.ts');
const toolsModule = await moduleFromSource('src/host/tools.ts');

const cjk = (text) => (text.match(/[\u4e00-\u9fff]/g) || []).length;
/** 纯 ASCII 且不含中文，说明是给英文用户看的文案。 */
const isEnglishOnly = (text) => cjk(text) === 0 && /[A-Za-z]{3}/.test(text);

/* ---------------- §11.9 / §6.2 B5：面向非程序员，失败提示必须中文 ---------------- */

test('B5: 契约层所有面向用户的错误文案都是中文', async () => {
  const source = await readFile(new URL('../src/host/contracts.ts', import.meta.url), 'utf8');
  const messages = [...source.matchAll(/ExplainAssistantError\('[A-Z_]+',\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(messages.length >= 5, '至少要能扫到契约层错误文案');
  const english = messages.filter(isEnglishOnly);
  assert.deepEqual(english, [], '仍有英文用户可见文案：' + JSON.stringify(english));
});

test('B5: 路由层所有面向用户的错误文案都是中文', async () => {
  const source = await readFile(new URL('../src/host/routes.ts', import.meta.url), 'utf8');
  const messages = [...source.matchAll(/ExplainAssistantError\('[A-Z_]+',\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(messages.length >= 8, '至少要能扫到路由层错误文案');
  const english = messages.filter(isEnglishOnly);
  assert.deepEqual(english, [], '仍有英文用户可见文案：' + JSON.stringify(english));
});

test('B5: 持久化层所有面向用户的错误文案都是中文', async () => {
  const source = await readFile(new URL('../src/host/persistence.ts', import.meta.url), 'utf8');
  const messages = [
    ...[...source.matchAll(/ExplainAssistantError\('[A-Z_]+',\s*'([^']+)'/g)].map(m => m[1]),
    ...[...source.matchAll(/persistenceError\('([^']+)'/g)].map(m => m[1]),
  ];
  assert.ok(messages.length >= 8, '至少要能扫到持久化层错误文案');
  const english = messages.filter(isEnglishOnly);
  assert.deepEqual(english, [], '仍有英文用户可见文案：' + JSON.stringify(english));
});

test('B5: 只读工具的错误文案都是中文', async () => {
  const source = await readFile(new URL('../src/host/tools.ts', import.meta.url), 'utf8');
  const messages = [...source.matchAll(/bad\('[A-Z_]+',\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(messages.length >= 10, '至少要能扫到工具错误文案');
  const english = messages.filter(isEnglishOnly);
  assert.deepEqual(english, [], '仍有英文用户可见文案：' + JSON.stringify(english));
});

test('B5: 未知错误兜底也是中文，而不是英文占位句', () => {
  const body = contracts.toErrorBody(new Error('boom'));
  assert.equal(isEnglishOnly(body.message), false, '兜底文案必须中文：' + body.message);
  assert.ok(cjk(body.message) > 0);
});

test('B5 真实运行: 无效信封的错误响应体是中文', async () => {
  const routes = routesModule.createExplainAssistantRoutes({ service: { isSessionAllowed: async () => true } });
  const response = await routes.get('/explain-assistant/ask')(new Request('http://t/explain-assistant/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 999, sessionId: 'session-a', operation: 'ask', payload: {} }),
  }));
  const body = await response.json();
  assert.ok(cjk(body.error.message) > 0, '必须给中文原因：' + JSON.stringify(body.error));
});

test('B5 真实运行: 空问题的错误响应体是中文', async () => {
  const routes = routesModule.createExplainAssistantRoutes({ service: { isSessionAllowed: async () => true } });
  const response = await routes.get('/explain-assistant/ask')(new Request('http://t/explain-assistant/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, sessionId: 'session-a', operation: 'ask', payload: { question: '' } }),
  }));
  const text = await response.text();
  const message = (text.match(/"message":"([^"]+)"/) || [])[1] || '';
  assert.ok(cjk(message) > 0, '必须给中文原因：' + text.slice(0, 300));
});

test('B5 真实运行: 工具缺上下文时给中文原因', async () => {
  const result = await toolsModule.executeTool({ sessionId: 's' }, { name: 'explain_list_workspace', arguments: {} });
  assert.equal(result.ok, false);
  assert.ok(cjk(result.message) > 0, '工具错误必须中文：' + result.message);
});

test('B5 真实运行: 路径越界给中文原因且错误码准确', async () => {
  const result = await toolsModule.executeTool({ sessionId: 's', workspace: '/tmp' }, { name: 'explain_read_workspace_file', arguments: { path: '../etc/passwd' } });
  assert.equal(result.ok, false);
  assert.ok(['PATH_INVALID', 'PATH_OUTSIDE_WORKSPACE'].includes(result.code), '错误码要准确：' + result.code);
  assert.ok(cjk(result.message) > 0, '必须中文：' + result.message);
});
