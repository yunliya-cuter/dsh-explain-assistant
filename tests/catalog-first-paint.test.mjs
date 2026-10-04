import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

const client = await moduleFromSource('src/client/index.ts');
const overlay = await moduleFromSource('src/client/overlay.tsx');
const entrySource = readFileSync(new URL('../src/client/entry.ts', import.meta.url), 'utf8');

/**
 * 回归：宿主把模型目录随 /state 一起下发（payload.catalog）。
 * 曾经的缺陷：client open() 只取 records/model/occupancy，catalog 被丢弃，
 * 浮窗首次打开必是「暂时没有可用的模型」空态，必须手点「刷新模型」才出现列表。
 */
test('client: open() persists payload.catalog into store so first paint can list models', async () => {
  const catalog = {
    groups: [
      { provider: 'kimi-coding', models: [{ provider: 'kimi-coding', id: 'k3', name: 'Kimi K3' }] },
      { provider: 'workbuddy', models: [{ provider: 'workbuddy', id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (WorkBuddy)' }] },
    ],
    failures: [{ code: 'MODEL_CATALOG_PARTIAL', message: '模型提供方「deepseek-account」暂时没有可用模型。' }],
  };
  const api = {
    state: async () => ({ payload: { records: [], hasEarlier: false, occupancyKnown: false, catalog } }),
    models: async () => ({ payload: { groups: [], failures: [] } }),
    ask: async () => {}, compact: async () => {}, cancel: async () => {},
  };
  const plugin = client.createClientPlugin({ api, session: { id: 'catalog-first-paint' } });
  try {
    plugin.open();
    await new Promise(resolve => setTimeout(resolve, 0));
    const state = plugin.registry.get('catalog-first-paint');
    assert.ok(state.catalog, 'catalog must be persisted from the state payload');
    assert.equal(state.catalog.groups.length, 2);
    assert.equal(state.catalog.groups[1].models[0].id, 'cn:deepseek-v4.1-flash');
    assert.equal(state.catalog.failures.length, 1);
  } finally {
    plugin.dispose();
    plugin.registry.remove('catalog-first-paint');
  }
});

/** 回归：catalog 缺席时不得伪造一个空目录（保持 undefined，让界面走真实空态分支）。 */
test('client: open() leaves catalog undefined when host omits it', async () => {
  const api = {
    state: async () => ({ payload: { records: [], hasEarlier: false } }),
    ask: async () => {}, compact: async () => {}, cancel: async () => {},
  };
  const plugin = client.createClientPlugin({ api, session: { id: 'catalog-absent' } });
  try {
    plugin.open();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(plugin.registry.get('catalog-absent').catalog, undefined);
  } finally {
    plugin.dispose();
    plugin.registry.remove('catalog-absent');
  }
});

/** 回归：有了 catalog 后，模型区必须渲染出可点的模型按钮，而不是空态文案。 */
test('overlay: populated catalog renders selectable model buttons, not the empty-state text', async () => {
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  const state = baseState({
    catalog: { groups: [
      { provider: 'kimi-coding', models: [{ provider: 'kimi-coding', id: 'k3', name: 'Kimi K3' }] },
      { provider: 'workbuddy', models: [{ provider: 'workbuddy', id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (WorkBuddy)' }] },
    ], failures: [] },
  });
  const plugin = { registry: { update() {}, close() {} }, submit: async () => {}, loadEarlier: async () => {} };
  try {
    const root = overlay.renderOverlay(state, plugin);
    // 模型列表默认折叠：先点开，走一遍真实用户路径。
    const toggle = root.querySelectorAll('button').find(b => /点这里选择模型|换一个模型/.test(b.textContent || ''));
    assert.ok(toggle, '未选模型时必须有一个可见的「选择模型」入口');
    toggle.click();
    const text = collectText(root);
    assert.ok(text.includes('Kimi K3'), 'model option must be rendered');
    assert.ok(text.includes('DeepSeek V4.1 Flash (WorkBuddy)'), 'workbuddy option must be rendered');
    assert.ok(!text.includes('暂时没有可用的模型'), 'empty-state text must not appear when catalog has groups');
  } finally {
    // renderOverlay 内部有一次异步聚焦，等它落地再拆掉假 DOM，否则会在测试结束后触发。
    await new Promise(resolve => setTimeout(resolve, 20));
    dom.restore();
  }
});

/**
 * 回归（真正的根因）：异步到达的 catalog 必须能重画浮窗。
 *
 * 上一版的缺陷链：点「?」时 state 里还没有 catalog（它随 api.state() 异步到达），effect 用空目录
 * 渲染了一次浮窗；随后 catalog 到达触发重渲染，但 effect 依赖没变所以不重跑，
 * DOM 就永远停在「暂时没有可用的模型」——连「刷新模型」也救不回来。
 *
 * 现在的结构是两条 effect 分工，这两条都必须成立：
 *   1. 建骨架的 effect 只依赖 [open, sessionId]——它一旦依赖 catalog，每次目录刷新都会重建整棵 DOM，
 *      把输入框里的草稿、光标和滚动位置一起丢掉；
 *   2. 另有一条**没有依赖数组**的 effect 在每次渲染后调 updateOverlay——这才是 catalog 到达后
 *      能重画的保证。
 * 只锁其中一条都不够：少第一条会丢输入，少第二条会停在空态。
 */
test('entry: 骨架 effect 只依赖 open/sessionId，另有每次渲染都重画的 effect', () => {
  const skeleton = entrySource.match(/React\.useEffect\(\(\) => \{\s*const host = hostRef\.current[\s\S]*?\}, \[([^\]]*)\]\);/);
  assert.ok(skeleton, '必须能定位到建骨架的 effect');
  const deps = skeleton[1];
  assert.ok(deps.includes('open'), '骨架 effect 必须依赖 open');
  assert.ok(deps.includes('sessionId'), '骨架 effect 必须依赖 sessionId');
  assert.ok(!deps.includes('catalog'), '骨架 effect 不得依赖 catalog：否则每次目录刷新都重建 DOM，草稿与滚动位置全丢');
  assert.ok(!deps.includes('draft'), '骨架 effect 不得依赖 draft：否则每敲一个字都重建 DOM，光标被顶到末尾');
  assert.match(entrySource, /updateOverlay\(/, '必须有原地重画入口');
  assert.match(entrySource, /React\.useEffect\(\(\) => \{[\s\S]*?updateOverlay\([\s\S]*?\}\);\n/, '必须存在一条没有依赖数组、每次渲染都重画的 effect');
});

function baseState(extra) {
  return Object.assign({
    sessionId: 's1', open: true, phase: 'idle', draft: '', reasoning: '', text: '', tools: [], records: [],
    hasEarlier: false, loadingEarlier: false, evidence: [], unread: false, occupancyKnown: false,
    quickQuestionsDismissed: false, catalog: { groups: [], failures: [] },
  }, extra || {});
}

function collectText(node) {
  let out = typeof node.textContent === 'string' ? node.textContent : '';
  for (const child of node.children || []) out += ' ' + collectText(child);
  return out;
}
