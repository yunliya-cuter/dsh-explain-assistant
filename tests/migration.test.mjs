import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moduleFromSource } from './fixtures/runtime.mjs';
const contracts=await moduleFromSource('src/host/contracts.ts');
const {JsonSessionStore}=await moduleFromSource('src/host/persistence.ts');
const create=async t=>{const root=await mkdtemp(path.join(tmpdir(),'explain-migration-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;};
test('persistence: explicit migration runs on clone and writes current valid version',async t=>{
 const root=await create(t);let count=0;const store=new JsonSessionStore({rootDir:root});store.registerMigration(0,s=>{count++;return {...s,schemaVersion:1};});t.after(()=>store.close());const old={...contracts.createEmptyState('migration'),schemaVersion:0};await mkdir(path.dirname(store.pathFor('migration')),{recursive:true});await writeFile(store.pathFor('migration'),JSON.stringify(old));const result=await store.load('migration');assert.equal(count,1);assert.equal(result.state.schemaVersion,1);assert.equal(JSON.parse(await readFile(store.pathFor('migration'),'utf8')).schemaVersion,1);
});
test('persistence: failed migration keeps original file unchanged',async t=>{
 const root=await create(t);const store=new JsonSessionStore({rootDir:root});store.registerMigration(0,s=>{s.records=[];throw Error('migration failed');});t.after(()=>store.close());const old=JSON.stringify({...contracts.createEmptyState('migration'),schemaVersion:0});await mkdir(path.dirname(store.pathFor('migration')),{recursive:true});await writeFile(store.pathFor('migration'),old);await assert.rejects(store.load('migration'));assert.equal(await readFile(store.pathFor('migration'),'utf8'),old);
});
test('persistence: saving over unknown future version is refused without change',async t=>{
 const root=await create(t);const store=new JsonSessionStore({rootDir:root});t.after(()=>store.close());const future=JSON.stringify({...contracts.createEmptyState('future'),schemaVersion:99});await mkdir(path.dirname(store.pathFor('future')),{recursive:true});await writeFile(store.pathFor('future'),future);await assert.rejects(store.save(contracts.createEmptyState('future')));assert.equal(await readFile(store.pathFor('future'),'utf8'),future);
});
