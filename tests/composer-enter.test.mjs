import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource, fakeDom } from './fixtures/runtime.mjs';

/**
 * 输入框的回车语义：Enter 发送、Shift+Enter 换行。
 *
 * 这一组测试刻意打在三处**最容易做坏**的地方，而不是只测"回车能发"：
 * 1. 中文输入法选词的那一下回车（发出去就是半句话）；
 * 2. "发不出去的时候"（处理中/加载中）回车必须**不拦**，否则用户既发不出去也换不了行；
 * 3. 回车必须和点按钮**同一道闸**（canSubmit），不能绕过加载/失败档的拦截。
 */

const baseState = {
  sessionId: 's', open: true, unread: false, draft: '', phase: 'idle', reasoning: '', text: '',
  tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [],
  occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: true, stateReady: true,
};

function fixture(state, calls) {
  const plugin = {
    registry: { update() {}, get: () => state, close() {} },
    api: {}, cancel() {}, loadEarlier() {},
    submit: question => { calls.push(question); return Promise.resolve(); },
  };
  return moduleFromSource('src/client/overlay.tsx')
    .then(overlay => overlay.renderOverlay({ ...state, open: true }, plugin));
}

function pressKey(input, values) {
  return input.emit('keydown', { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13, ...values });
}

async function withOverlay(state, run) {
  const dom = fakeDom();
  try {
    const calls = [];
    const root = await fixture(state, calls);
    const input = root.querySelector('textarea');
    assert.ok(input, '必须有输入框');
    await run({ root, input, calls });
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.restore();
  }
}

test('Enter 直接发送：走表单、发一次、并吞掉默认换行', async () => {
  await withOverlay(baseState, async ({ input, calls }) => {
    input.value = '  它在干什么  ';
    const event = pressKey(input);
    assert.deepEqual(calls, ['它在干什么'], '回车必须把内容发出去（首尾空白去掉）');
    assert.equal(event.defaultPrevented, true, '既然发了，就必须 preventDefault，否则还会多插一个换行');
  });
});

test('Shift+Enter 只换行：不发送、也不拦默认行为', async () => {
  await withOverlay(baseState, async ({ input, calls }) => {
    input.value = '第一行';
    const event = pressKey(input, { shiftKey: true });
    assert.deepEqual(calls, [], 'Shift+Enter 不得发送');
    assert.equal(event.defaultPrevented, false, 'Shift+Enter 必须放行默认行为，否则换不了行');
  });
});

test('输入法选词的回车不得发送（isComposing）', async () => {
  await withOverlay(baseState, async ({ input, calls }) => {
    input.value = 'nihao';
    const event = pressKey(input, { isComposing: true });
    assert.deepEqual(calls, [], '选词回车不得把半截拼音发出去');
    assert.equal(event.defaultPrevented, false, '选词回车要交给输入法处理');
  });
});

test('compositionend 晚于 keydown 的浏览器：只靠 isComposing 会误发，必须靠 composition 状态兜住', async () => {
  await withOverlay(baseState, async ({ input, calls }) => {
    input.value = '你好';
    input.emit('compositionstart');
    // 这一帧 isComposing 已经是 false（真实浏览器的时序就是这样），
    // 只判 isComposing 的实现会在这里把"你好"发出去。
    const whileComposing = pressKey(input, { isComposing: false });
    assert.deepEqual(calls, [], '组合输入尚未结束时的回车不得发送');
    assert.equal(whileComposing.defaultPrevented, false);
    input.emit('compositionend');
    pressKey(input);
    assert.deepEqual(calls, ['你好'], '组合结束之后回车必须恢复发送');
  });
});

test('旧内核的 keyCode 229 也要兜住', async () => {
  await withOverlay(baseState, async ({ input, calls }) => {
    input.value = '测试';
    const event = pressKey(input, { keyCode: 229, isComposing: false });
    assert.deepEqual(calls, [], 'keyCode 229 表示这一下按键属于输入法，不得发送');
    assert.equal(event.defaultPrevented, false);
  });
});

test('空内容不发，也不拦默认换行', async () => {
  await withOverlay(baseState, async ({ input, calls }) => {
    input.value = '   ';
    const event = pressKey(input);
    assert.deepEqual(calls, [], '空白内容不发送');
    assert.equal(event.defaultPrevented, false, '空内容时回车应当照常换行，别让用户觉得按键坏了');
  });
});

test('处理中按回车：不发，但也不拦（保留换行）', async () => {
  await withOverlay({ ...baseState, phase: 'running' }, async ({ input, calls }) => {
    input.value = '下一个问题';
    const event = pressKey(input);
    assert.deepEqual(calls, [], '处理中不得再发一条');
    assert.equal(event.defaultPrevented, false, '发不出去的时候不许把回车吃掉');
  });
});

test('状态没读到时按回车：不得绕过闸门（与点按钮同一条路）', async () => {
  await withOverlay({ ...baseState, stateReady: false }, async ({ input, calls }) => {
    input.value = '加载页也能发吗';
    pressKey(input);
    assert.deepEqual(calls, [], '加载页上回车同样不能发出 /ask');
  });
});

test('Ctrl/⌘+Enter 不接管（留给浏览器与宿主）', async () => {
  await withOverlay(baseState, async ({ input, calls }) => {
    input.value = '有修饰键';
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      const event = pressKey(input, { [modifier]: true });
      assert.equal(event.defaultPrevented, false, modifier + ' + Enter 不得被接管');
    }
    assert.deepEqual(calls, [], '带修饰键的回车不发送');
  });
});
