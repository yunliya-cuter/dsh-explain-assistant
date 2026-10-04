import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';
const contracts = await moduleFromSource('src/host/contracts.ts');
const evidence = await moduleFromSource('src/host/evidence.ts');
const persistence = await moduleFromSource('src/host/persistence.ts');
const routesModule = await moduleFromSource('src/host/routes.ts');
const temp = async t => { const p = await mkdtemp(path.join(tmpdir(), 'explain-tests-')); t.after(() => rm(p, { recursive: true, force: true })); return p; };
const request = (operation, overrides = {}) => new Request('http://test/explain-assistant/' + operation, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ schemaVersion: 1, sessionId: 'session-a', operation, payload: { question: '解释' }, ...overrides }) });
test('schema: invalid envelope/session and operation are rejected', () => {
  // 断言错误码而不是英文文案：文案已按 §11.9 中文化，绑文案会让测试与本地化互相拖累。
  assert.throws(() => contracts.validateEnvelope({}), (error) => ['INVALID_REQUEST', 'UNSUPPORTED_SCHEMA'].includes(error?.code));
  assert.throws(() => contracts.validateEnvelope({schemaVersion:1, sessionId:'../escape', operation:'ask', payload:{}}, 'ask'));
  assert.throws(() => contracts.validateEnvelope({schemaVersion:1, sessionId:'session-a', operation:'compact', payload:{}}, 'ask'));
});
test('schema: future schema version is rejected, not treated as current', () => {
  assert.throws(() => contracts.validateEnvelope({schemaVersion:999, sessionId:'session-a', operation:'ask', payload:{}}, 'ask'));
});
test('schema: public ask rejects incompatible version before SSE', async () => {
  const routes = routesModule.createExplainAssistantRoutes({service:{isSessionAllowed:async()=>true}});
  const response = await routes.get('/explain-assistant/ask')(request('ask', {schemaVersion:999}));
  assert.equal(response.status, 400); assert.equal(response.headers.get('content-type')?.includes('text/event-stream'), false);
});
test('path: absolute, traversal and symlink reads stay in workspace', async t => {
  const dir = await temp(t); const root = path.join(dir,'root'); await mkdir(root); await writeFile(path.join(dir,'secret'),'secret'); await symlink(path.join(dir,'secret'),path.join(root,'escape'));
  for(const p of ['/etc/passwd','../secret','a/../../secret','..\\secret']) assert.throws(()=>evidence.resolveWorkspacePath(root,p));
  await assert.rejects(evidence.readWorkspaceText(root,'escape'),/ESCAPE/);
});
test('path: search does not disclose content through symlink', async t => {
  const dir=await temp(t); const root=path.join(dir,'root'); await mkdir(root); await writeFile(path.join(dir,'secret'),'unique-secret-needle'); await symlink(path.join(dir,'secret'),path.join(root,'escape'));
  try { const found=await evidence.searchWorkspace(root,'unique-secret-needle'); assert.equal(found.length,0,'searchWorkspace must not read symlink target outside root'); } catch (error) { assert.match(error.message, /ESCAPE|PATH/); }
});
test('evidence: latest content gets different immutable version/time', async t => {
  const dir=await temp(t); await writeFile(path.join(dir,'a'),'one'); const one=await evidence.readWorkspaceText(dir,'a'); await writeFile(path.join(dir,'a'),'two'); const two=await evidence.readWorkspaceText(dir,'a');
  assert.equal(one.text,'one'); assert.equal(two.text,'two'); assert.notEqual(one.version,two.version); assert.equal(two.source,'workspace_latest'); assert.ok(two.capturedAt);
});
test('evidence: UTF8 truncation respects maxBytes', () => {
  const result=evidence.truncateValue('汉'.repeat(1000),{maxBytes:64}); assert.ok(result.truncated); assert.ok(Buffer.byteLength(JSON.stringify(result.value))<=64);
});
test('persistence: atomic file is valid JSON and leaves no temporary residue', async t => {
  const root=await temp(t); const store=new persistence.JsonSessionStore({rootDir:root}); t.after(()=>store.close()); const state=contracts.createEmptyState('session-a'); await store.save(state);
  assert.equal(JSON.parse(await readFile(store.pathFor('session-a'),'utf8')).sessionId,'session-a'); assert.equal((await readdir(path.dirname(store.pathFor('session-a')))).some(p=>p.endsWith('.tmp')),false);
});
test('persistence: queued updates do not lose increments', async t => {
  const root=await temp(t); const store=new persistence.JsonSessionStore({rootDir:root}); t.after(()=>store.close());
  await Promise.all(Array.from({length:12},()=>store.update('session-a',s=>{s.unread=true;}))); const result=await store.load('session-a'); assert.equal(result.state.historyRevision,12);
});
test('persistence: corrupt JSON is quarantined then restored to empty state', async t => {
  const root=await temp(t); const store=new persistence.JsonSessionStore({rootDir:root}); t.after(()=>store.close()); await mkdir(path.dirname(store.pathFor('session-a')),{recursive:true}); await writeFile(store.pathFor('session-a'),'{broken');
  const result=await store.load('session-a'); assert.equal(result.created,true); assert.ok(result.recoveredCorrupt); assert.equal(await readFile(result.recoveredCorrupt,'utf8'),'{broken');
});
test('persistence: future schema is read-only and load does not rewrite bytes', async t => {
  const root=await temp(t); const store=new persistence.JsonSessionStore({rootDir:root}); t.after(()=>store.close()); const state={...contracts.createEmptyState('session-a'),schemaVersion:9}; const raw=JSON.stringify(state); await mkdir(path.dirname(store.pathFor('session-a')),{recursive:true}); await writeFile(store.pathFor('session-a'),raw);
  const result=await store.load('session-a'); assert.equal(result.readOnlyFutureVersion,9); assert.equal(await readFile(store.pathFor('session-a'),'utf8'),raw);
});
test('SSE: semantic start/text/complete frames are correctly delimited', async () => {
  const records=[]; const routes=routesModule.createExplainAssistantRoutes({service:{isSessionAllowed:async()=>true,llm:{async *stream(){yield {text:'白话解释'};}},saveRecord:async(id,r)=>records.push(r)}});
  const response=await routes.get('/explain-assistant/ask')(request('ask')); const text=await response.text(); const frames=text.trim().split(/\n\n/); const events=frames.map(f=>JSON.parse(f.split('\ndata: ')[1]));
  assert.deepEqual(events.map(e=>e.type),['start','text','complete']); assert.ok(events.every(e=>e.sessionId==='session-a'&&e.requestId)); assert.equal(records.length,1);
});
test('SSE: archived session is rejected before stream', async () => {
  const routes=routesModule.createExplainAssistantRoutes({service:{isSessionAllowed:async()=>true,isArchived:async()=>true}}); const response=await routes.get('/explain-assistant/ask')(request('ask')); assert.equal(response.status,409);
});
test('SSE: concurrent conflict preserves existing request lock', async () => {
  const active=new Map([['session-a',{requestId:'existing',controller:new AbortController()}]]); const routes=routesModule.createExplainAssistantRoutes({active,service:{isSessionAllowed:async()=>true}}); const response=await routes.get('/explain-assistant/ask')(request('ask')); assert.equal(response.status,409); assert.equal(active.get('session-a')?.requestId,'existing');
});
