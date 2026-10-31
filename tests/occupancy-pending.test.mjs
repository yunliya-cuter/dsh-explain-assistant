import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource, waitFor } from './fixtures/runtime.mjs';

/**
 * 「打开浮窗要等十几秒」的回归。
 *
 * ── 真实现象（3081，2026-10-31）────────────────────────────────────
 * 用户点入口按钮 → 图标进入忙碌态 → 但浮窗迟迟不出现（几秒到十几秒），看起来就是「点了没反应」。
 * 根因：/state 里最贵的一项是把主 agent 上下文读一遍（readSurface），
 * 用户会话已经 44 MB，实测 5.8 秒，冷的时候 17 秒；而浮窗被设计成「等 /state 有结局才出现」。
 *
 * ── 修法 ───────────────────────────────────────────────────────────
 * 宿主：主 agent 上下文最多等 500ms（withDeadline），超时就先不给占用（occupancyPending=true），
 *       后台继续读并把缓存焐热（过期也先用旧值，TTL 30 秒）。
 * 客户端：拿到 occupancyPending 就自动补一次（默认 3 秒后），用户不需要再点。
 *
 * 本文件钉住这两条：deadline 的行为，以及「pending → 自动补一次」这条链。
 */

const deadline = await moduleFromSource('src/host/deadline.ts');
const client = await moduleFromSource('src/client/index.ts');

/* ---------------- 宿主：withDeadline ---------------- */

test('withDeadline: 任务够快就拿到值（不引入额外延迟）', async () => {
  const value = await deadline.withDeadline(Promise.resolve({ ok: 1 }), 500);
  assert.deepEqual(value, { ok: 1 });
});

test('withDeadline: 超过截止时间就返回 undefined（不阻塞调用方）', async () => {
  const started = Date.now();
  const value = await deadline.withDeadline(new Promise(() => { /* 永不结束 */ }), 30);
  assert.equal(value, undefined, '超时必须返回 undefined，让调用方先走');
  assert.ok(Date.now() - started < 400, '必须在截止时间附近返回，实际 ' + (Date.now() - started) + 'ms');
});

test('withDeadline: 迟到的 reject 不能被当成未捕获异常', async () => {
  let late;
  const task = new Promise((_, reject) => { late = reject; });
  const value = await deadline.withDeadline(task.catch(() => undefined), 20);
  assert.equal(value, undefined);
  // 模拟宿主里那条 .catch(() => undefined)：让它 reject 一次，不应抛出
  assert.doesNotThrow(() => late(new Error('late failure')));
  await new Promise(resolve => setTimeout(resolve, 10));
});

/* ---------------- 客户端：pending → 自动补一次 ---------------- */

function apiWithStates(states) {
  let index = 0;
  const calls = [];
  return {
    calls,
    api: {
      state: async (sessionId) => {
        calls.push(sessionId);
        const payload = states[Math.min(index++, states.length - 1)];
        return { payload };
      },
      history: async () => ({ payload: { records: [] } }),
      ask: async () => {},
      compact: async () => {},
      cancel: async () => {},
    },
  };
}

test('占用待补: 宿主说 occupancyPending 时，客户端必须自己再取一次（用户不用再点）', async () => {
  const { api, calls } = apiWithStates([
    { records: [], occupancyPending: true },                       // 第一次：主 agent 上下文没赶上截止时间
    { records: [], occupancy: 42, occupancyKnown: true, occupancyPending: false }, // 第二次：缓存热了，带占用
  ]);
  const plugin = client.createClientPlugin({ api, session: { id: 'occ-1' }, occupancyRetryDelayMs: 0 });
  try {
    plugin.open();
    await waitFor(() => calls.length >= 2, { timeout: 2000 });
    assert.equal(calls.length, 2, '必须自动补取一次 /state，实际 ' + calls.length + ' 次');
    assert.equal(plugin.registry.get('occ-1').occupancy, 42, '补取回来的占用必须写进状态');
  } finally { plugin.dispose(); }
});

test('占用待补: 浮窗已经关掉时不再补取（不做无用请求）', async () => {
  const { api, calls } = apiWithStates([{ records: [], occupancyPending: true }]);
  const plugin = client.createClientPlugin({ api, session: { id: 'occ-2' }, occupancyRetryDelayMs: 40 });
  try {
    plugin.open();
    await waitFor(() => calls.length >= 1, { timeout: 2000 });
    plugin.close();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(calls.length, 1, '关掉之后不得再打 /state，实际 ' + calls.length + ' 次');
  } finally { plugin.dispose(); }
});
