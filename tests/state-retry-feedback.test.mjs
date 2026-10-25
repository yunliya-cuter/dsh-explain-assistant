import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDom, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * 「重试按了没反应」这条用户反馈的回归测试（3081）。
 *
 * 两个真问题：
 * 1. 点重试之后界面**什么都不变**，最长 15 秒后才可能再报同样的错 —— 用户看到的就是「按了没反应」；
 * 2. 超时只是"报个错"，底层那次请求仍然挂着，用户每点一次就多堆一条。
 */

const base = {
  sessionId: 's', open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
  tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [],
  occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: true,
  stateReady: true, stateError: '没有读到这个小助手的当前状态：读取小助手状态超时（等了 15 秒没有回应）。',
};

test('点「重试」必须立刻切回加载态（否则用户只会看到界面一动不动）', async () => {
  const dom = fakeDom();
  try {
    const patches = [];
    let retried = 0;
    const plugin = {
      registry: { update: (sessionId, patch) => { patches.push(patch) }, get: () => base, close() {} },
      api: {}, cancel() {}, submit() {}, loadEarlier() {},
      retryState: () => { retried++; return Promise.resolve() },
    };
    const overlay = await moduleFromSource('src/client/overlay.tsx');
    const root = overlay.renderOverlay({ ...base }, plugin);
    const retry = root.querySelector('.ea-state-retry');
    assert.ok(retry, '失败页上必须有重试按钮');
    retry.emit('click');
    assert.equal(retried, 1, '必须真的发起一次重试');
    assert.equal(patches.length >= 1, true, '必须至少改一次状态');
    assert.equal(patches[0].stateReady, false, '必须先把界面切回加载态，让人看到"正在重新读取"');
    assert.equal(patches[0].stateError, undefined, '同时清掉旧的错误文案');
  } finally { await new Promise(r => setTimeout(r, 0)); dom.restore(); }
});

test('超时必须把底层请求 abort 掉（否则每点一次重试就多挂一条）', async () => {
  const dom = fakeDom();
  try {
    const client = await moduleFromSource('src/client/index.ts');
    let captured;
    const plugin = client.createClientPlugin({
      api: { state: (sessionId, signal) => { captured = signal; return new Promise(() => {}) } },
      session: { id: 'retry-abort' },
      stateTimeoutMs: 40,
    });
    try {
      plugin.setSession('retry-abort');
      await plugin.retryState('retry-abort').catch(() => undefined);
      assert.ok(captured, '必须把 signal 传给 api.state');
      assert.equal(captured.aborted, true, '超时后必须 abort 底层请求');
      const state = plugin.registry.get('retry-abort');
      assert.match(String(state.stateError), /超时/, '仍然要给出明确的中文原因');
      assert.match(String(state.stateError), /重试/, '并且告诉用户可以重试');
    } finally { plugin.dispose(); plugin.registry.remove('retry-abort'); }
  } finally { await new Promise(r => setTimeout(r, 0)); dom.restore(); }
});
