import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource, fakeDom, FakeElement } from './fixtures/runtime.mjs';

const routes = await moduleFromSource('src/host/routes.ts');
const overlay = await moduleFromSource('src/client/overlay.tsx');

function service(overrides = {}) {
  const saved = [];
  return {
    saved,
    service: Object.assign({
      loadState: async () => ({}),
      listModels: async () => ({ groups: [], failures: [] }),
      selectModel: async (_id, model) => { saved.push(model); return model; },
      toolContext: async () => ({ sessionId: 's' }),
      buildMessages: async () => [],
      resolveModel: async () => ({ selection: { provider: 'p', model: 'm' } }),
    }, overrides),
  };
}
async function call(handler, url, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  return handler(new Request(url, init));
}

/**
 * 回归：客户端发的是 { schemaVersion, sessionId, operation, payload: { model: { provider, model } } }，
 * 而路由曾经只认顶层 provider/model，于是每次选模型都被拒（英文 "A provider and model are required."）。
 * 界面又靠乐观更新显示「本对话已选」——用户以为选上了，实际一个模型都没落库。
 */
test('select-model 接受客户端实际发送的 { model: { provider, model } } 形状', async () => {
  const { service: svc, saved } = service();
  const handler = routes.createExplainAssistantRoutes({ service: svc }).get('/explain-assistant/select-model');
  const response = await call(handler, 'http://x/api/explain-assistant/select-model?sessionId=s1', {
    schemaVersion: 1, sessionId: 's1', operation: 'select-model', payload: { model: { provider: 'workbuddy', model: 'cn:deepseek-v4.1-flash' } },
  });
  assert.equal(response.status, 200, '客户端实际发的形状必须被接受');
  const body = await response.json();
  assert.equal(body.payload.selected, true);
  assert.deepEqual(saved, [{ provider: 'workbuddy', model: 'cn:deepseek-v4.1-flash' }], '必须真的把选择交给 service');
});

test('select-model 仍然接受顶层 { provider, model }', async () => {
  const { service: svc, saved } = service();
  const handler = routes.createExplainAssistantRoutes({ service: svc }).get('/explain-assistant/select-model');
  const response = await call(handler, 'http://x/api/explain-assistant/select-model?sessionId=s1', {
    schemaVersion: 1, sessionId: 's1', operation: 'select-model', payload: { provider: 'p', model: 'm' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(saved, [{ provider: 'p', model: 'm' }]);
});

test('select-model 缺字段时给中文报错，不再抛英文', async () => {
  const { service: svc } = service();
  const handler = routes.createExplainAssistantRoutes({ service: svc }).get('/explain-assistant/select-model');
  const response = await call(handler, 'http://x/api/explain-assistant/select-model?sessionId=s1', {
    schemaVersion: 1, sessionId: 's1', operation: 'select-model', payload: { model: { provider: 'p' } },
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.ok(/[\u4e00-\u9fff]/.test(body.error.message), '面向非程序员的错误必须是中文：' + body.error.message);
});

/** 回归：选择失败必须回滚乐观更新，否则界面一直停在「本对话已选」的假象上。 */
test('overlay: 选模型失败时回滚已选状态并给出中文错误', async () => {
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  const updates = [];
  const state = {
    sessionId: 's1', open: true, phase: 'idle', draft: '', reasoning: '', text: '', tools: [], records: [],
    hasEarlier: false, loadingEarlier: false, evidence: [], unread: false, occupancyKnown: false,
    quickQuestionsDismissed: true, model: undefined,
    catalog: { groups: [{ provider: 'p', models: [{ provider: 'p', id: 'm', name: 'M' }] }], failures: [] },
  };
  const registry = {
    update: (id, patch) => { updates.push(patch) },
    get: () => ({ model: { provider: 'old', model: 'old-model', source: 'explicit' } }),
    close() {},
  };
  const plugin = {
    registry,
    api: { selectModel: async () => { throw new Error('宿主拒绝了') }, models: async () => ({ payload: {} }) },
    submit: async () => {}, loadEarlier: async () => {},
  };
  try {
    const root = overlay.renderOverlay(state, plugin);
    // 模型列表默认折叠，先点开。
    root.querySelectorAll('button').find(b => /点这里选择模型|换一个模型/.test(b.textContent || ''))?.click();
    const option = root.querySelectorAll('.ea-model-option')[0];
    assert.ok(option, '必须有可选模型按钮');
    option.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    const rollback = updates.find(u => u.model && u.model.provider === 'old');
    assert.ok(rollback, '失败后必须把 model 回滚到选择前的值');
    const errorPatch = updates.find(u => typeof u.error === 'string');
    assert.ok(errorPatch && /选择模型失败/.test(errorPatch.error), '必须给出可读的中文失败原因');
  } finally {
    await new Promise(resolve => setTimeout(resolve, 20));
    dom.restore();
  }
});
