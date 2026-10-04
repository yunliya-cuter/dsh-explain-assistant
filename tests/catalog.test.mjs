import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource } from './fixtures/runtime.mjs';

const m = await moduleFromSource('src/host/catalog.ts');

function fakeLlm(providers, modelsByProvider) {
  return {
    listProviders: () => providers,
    listModels: async (provider) => {
      const entry = modelsByProvider[provider];
      if (entry instanceof Error) throw entry;
      return entry ?? [];
    },
  };
}

test('正常两 provider 各两模型：分组结构与数量正确', async () => {
  const catalog = await m.discoverCatalog(fakeLlm(
    [{ id: 'alpha', displayName: '甲' }, { id: 'beta' }],
    { alpha: [{ provider: 'alpha', id: 'a1', name: 'A1' }, { provider: 'alpha', id: 'a2', name: 'A2' }],
      beta: [{ provider: 'beta', id: 'b1', name: 'B1' }, { provider: 'beta', id: 'b2', name: 'B2' }] },
  ));
  assert.equal(catalog.groups.length, 2);
  assert.equal(catalog.groups[0].provider, 'alpha');
  assert.equal(catalog.groups[0].displayName, '甲');
  assert.equal(catalog.groups[0].models.length, 2);
  assert.equal(catalog.groups[1].models[1].id, 'b2');
  assert.equal(catalog.failures.length, 0);
});

test('单个 provider 抛错不能拖垮整体，其余 provider 照常返回且 failure 是中文', async () => {
  const catalog = await m.discoverCatalog(fakeLlm(
    [{ id: 'broken' }, { id: 'healthy' }],
    { broken: new Error('boom'), healthy: [{ provider: 'healthy', id: 'h1', name: 'H1' }] },
  ));
  assert.equal(catalog.groups.length, 1, '健康 provider 必须仍然返回');
  assert.equal(catalog.groups[0].provider, 'healthy');
  assert.equal(catalog.groups[0].models[0].id, 'h1');
  assert.equal(catalog.failures.length, 1);
  assert.ok(/[\u4e00-\u9fff]/.test(catalog.failures[0].message), 'failure 文案必须是中文');
  assert.ok(catalog.failures[0].message.includes('broken'));
});

test('llm 缺失或不具备目录能力时不抛异常，只返回失败说明', async () => {
  for (const llm of [null, undefined, {}, { listProviders: () => [] }]) {
    const catalog = await m.discoverCatalog(llm);
    assert.deepEqual(catalog.groups, []);
    assert.ok(catalog.failures.length >= 1);
    assert.ok(/[\u4e00-\u9fff]/.test(catalog.failures[0].message));
  }
});

test('重复 id 去重，非法条目被丢弃且不崩溃', async () => {
  const catalog = await m.discoverCatalog(fakeLlm([{ id: 'p' }], {
    p: [{ provider: 'p', id: 'x', name: 'X' }, { provider: 'p', id: 'x', name: 'X2' }, null, 42, { name: '无id' }],
  }));
  assert.equal(catalog.groups[0].models.length, 1);
  assert.equal(catalog.groups[0].models[0].id, 'x');
});

test('listProviders 同步抛错时不炸，返回中文失败说明', async () => {
  const catalog = await m.discoverCatalog({ listProviders: () => { throw new Error('nope'); }, listModels: async () => [] });
  assert.deepEqual(catalog.groups, []);
  assert.ok(catalog.failures[0].message.includes('nope'));
});

test('关键反例：目录非空但用户未选择时返回 required，且绝不夹带任何默认模型', () => {
  const catalog = { groups: [{ provider: 'deepseek', models: [{ provider: 'deepseek', id: 'deepseek-chat', name: 'x' }] }], failures: [] };
  const result = m.resolveSelection(undefined, catalog);
  assert.equal(result.kind, 'required');
  assert.ok(/[\u4e00-\u9fff]/.test(result.message));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('deepseek'), false, '未选择时结果里不得出现任何默认 provider');
  assert.equal('provider' in result, false, '未选择时不得返回具体 provider');
  assert.equal('model' in result, false, '未选择时不得返回具体 model');
});

test('目录为空时返回 unavailable，且不抛错', () => {
  for (const catalog of [undefined, { groups: [], failures: [] }, { groups: [{ provider: 'p', models: [] }], failures: [] }]) {
    const result = m.resolveSelection(undefined, catalog);
    assert.equal(result.kind, 'unavailable');
    assert.ok(/[\u4e00-\u9fff]/.test(result.message));
  }
});

test('已显式选择时原样返回，并保留 reasoningEffort', () => {
  const result = m.resolveSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }, undefined);
  assert.deepEqual(result, { kind: 'explicit', provider: 'p', model: 'm', reasoningEffort: 'high' });
});

test('半截选择（缺 model）不算显式选择，会退回 required/unavailable', () => {
  const catalog = { groups: [{ provider: 'p', models: [{ provider: 'p', id: 'm', name: 'M' }] }], failures: [] };
  assert.equal(m.resolveSelection({ provider: 'p' }, catalog).kind, 'required');
  assert.equal(m.resolveSelection({ provider: '  ', model: 'm' }, catalog).kind, 'required');
});


// 回归：真实 DSH llm 返回 Promise<RemoteResult>（{ok:true,value}），不是裸数组。
// 旧代码同步调用且不 await/不解包 → 拿到 Promise → Array.isArray false → 空目录（界面"没有可用的模型"）。
test('回归：listProviders/listModels 返回 Promise<RemoteResult> 时也能解出目录', async () => {
  const remoteLlm = {
    listProviders: async () => ({ ok: true, value: [{ id: 'workbuddy', displayName: 'WorkBuddy' }] }),
    listModels: async (provider) => ({ ok: true, value: [{ id: 'cn:deepseek-v4.1-flash', name: 'V4.1 Flash', provider }] }),
  };
  const catalog = await m.discoverCatalog(remoteLlm);
  assert.equal(catalog.groups.length, 1, 'RemoteResult 必须被解包出 provider 分组');
  assert.equal(catalog.groups[0].provider, 'workbuddy');
  assert.equal(catalog.groups[0].models[0].id, 'cn:deepseek-v4.1-flash');
});

test('回归：RemoteResult 的 error 分支要变成中文失败说明，而不是静默空目录', async () => {
  const remoteLlm = {
    listProviders: async () => ({ ok: false, error: { message: 'gateway down', code: 'UPSTREAM' } }),
    listModels: async () => ({ ok: true, value: [] }),
  };
  const catalog = await m.discoverCatalog(remoteLlm);
  assert.equal(catalog.groups.length, 0);
  assert.ok(catalog.failures.length > 0, 'error 分支必须记录 failures');
  assert.ok(catalog.failures[0].message.includes('gateway down'));
});


// 回归：宿主 llm 是 [Remote] 代理，listProviders/listModels 内部要读 this。
// 旧代码裸调用 service.listProviders() 把 this 剥离成 undefined → 抛 "reading 'adapters'" → 空目录。
test('回归：listProviders/listModels 依赖 this 时也能正确调用（this 不丢失）', async () => {
  class FakeRemoteLlm {
    constructor() { this.adapters = new Map([['workbuddy', { provider: { id: 'workbuddy' } }]]); }
    async listProviders() { return [...this.adapters.values()].map(a => a.provider); } // 读 this.adapters
    async listModels(provider) { return [{ id: 'cn:deepseek-v4.1-flash', name: 'Flash', provider }]; } // 读 this
  }
  const catalog = await m.discoverCatalog(new FakeRemoteLlm());
  assert.equal(catalog.groups.length, 1, 'this 绑定必须保留，否则 adapters 读不到');
  assert.equal(catalog.groups[0].provider, 'workbuddy');
  assert.equal(catalog.groups[0].models[0].id, 'cn:deepseek-v4.1-flash');
});

test('toModelSelection 校验非法输入并抛 INVALID_REQUEST', () => {
  assert.deepEqual(m.toModelSelection({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' });
  assert.deepEqual(m.toModelSelection({ model: { provider: 'p', model: 'm' } }), { provider: 'p', model: 'm' });
  for (const bad of [null, {}, { provider: '', model: 'm' }, { provider: 'p', model: '' }, { provider: 'p' }]) {
    assert.throws(() => m.toModelSelection(bad), (error) => error.code === 'INVALID_REQUEST', '应拒绝：' + JSON.stringify(bad));
  }
});

test('catalogContains 精确匹配 provider 与 model', () => {
  const catalog = { groups: [{ provider: 'p', models: [{ provider: 'p', id: 'm', name: 'M' }] }], failures: [] };
  assert.equal(m.catalogContains(catalog, 'p', 'm'), true);
  assert.equal(m.catalogContains(catalog, 'p', 'other'), false);
  assert.equal(m.catalogContains(catalog, 'q', 'm'), false);
  assert.equal(m.catalogContains(undefined, 'p', 'm'), false);
});
