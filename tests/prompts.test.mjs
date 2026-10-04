import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource } from './fixtures/runtime.mjs';

const m = await moduleFromSource('src/host/prompts.ts');

const cjk = (text) => (text.match(/[\u4e00-\u9fff]/g) || []).length;

test('每条 message 的 content 都是内容块数组（DSH 适配器会 flatMap，传字符串必崩）', () => {
  const messages = m.buildMessages('它现在在干什么？', { evidence: [] });
  assert.ok(Array.isArray(messages) && messages.length >= 2, '至少要有 system 与 user 两条');
  for (const message of messages) {
    assert.ok(Array.isArray(message.content), 'content 必须是数组：' + JSON.stringify(message.content));
    for (const block of message.content) {
      assert.equal(typeof block, 'object');
      assert.equal(block.type, 'text');
      assert.equal(typeof block.text, 'string');
    }
  }
});

test('system 排在 user 之前', () => {
  const messages = m.buildMessages('问题', { evidence: [] });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[messages.length - 1].role, 'user');
});

test('系统提示词是中文（中文字符占比 > 50%）', () => {
  const ratio = cjk(m.SYSTEM_PROMPT) / m.SYSTEM_PROMPT.length;
  assert.ok(ratio > 0.5, '中文字符占比过低：' + ratio);
});

test('系统提示词逐条覆盖四要素', () => {
  for (const element of m.FOUR_ELEMENTS) {
    assert.ok(m.SYSTEM_PROMPT.includes(element), '系统提示词缺少四要素之一：' + element);
  }
  assert.equal(m.FOUR_ELEMENTS.length, 4);
});

test('系统提示词含固定的信息不足表述「该步未提供足够信息」', () => {
  assert.ok(m.SYSTEM_PROMPT.includes('该步未提供足够信息'));
  assert.equal(m.INSUFFICIENT_MARKER, '该步未提供足够信息');
});

test('依据分级三个词都在系统提示词里', () => {
  for (const tier of m.EVIDENCE_TIERS) assert.ok(m.SYSTEM_PROMPT.includes(tier), '缺少依据分级：' + tier);
});

test('没有选中任何依据时，必须明确说信息不足，而不是让模型猜', () => {
  const messages = m.buildMessages('这步在干嘛？', { evidence: [] });
  const userText = messages[1].content[0].text;
  assert.ok(userText.includes('该步未提供足够信息'), '空依据时必须带出固定表述');
  assert.ok(/没有拿到任何步骤依据|用户这次没有选中/.test(userText), '必须明说没有依据');
});

test('反例：证据条目标记为 unavailable 且无摘要时，必须带出「该步未提供足够信息」', () => {
  const messages = m.buildMessages('解释这步', { evidence: [{ id: 'e1', title: '某步骤', evidenceState: 'unavailable' }] });
  const userText = messages[1].content[0].text;
  assert.ok(userText.includes('该步未提供足够信息'));
  assert.ok(userText.includes('无从得知'), 'unavailable 应映射到「无从得知」分级');
});

test('reported_only 映射到「仅据汇报」，observed 映射到「已观察到」', () => {
  assert.equal(m.evidenceTier({ evidenceState: 'observed' }), '已观察到');
  assert.equal(m.evidenceTier({ evidenceState: 'reported_only' }), '仅据汇报');
  assert.equal(m.evidenceTier({ evidenceState: 'unavailable' }), '无从得知');
});

test('截断与未完成的依据会被点名提醒，避免用户以为是全部', () => {
  const messages = m.buildMessages('解释', { evidence: [{ id: 'e', title: 't', summary: '有内容', evidenceState: 'observed', truncated: true, incomplete: true }] });
  const userText = messages[1].content[0].text;
  assert.ok(userText.includes('截断'));
  assert.ok(userText.includes('还没有结束'));
});

test('纯函数：同样输入两次调用结果完全一致', () => {
  const a = m.buildMessages('同一个问题', { evidence: [{ id: 'e', title: 't', summary: 's', evidenceState: 'observed' }] });
  const b = m.buildMessages('同一个问题', { evidence: [{ id: 'e', title: 't', summary: 's', evidenceState: 'observed' }] });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('术语即时解释表可用且有中文白话', () => {
  assert.ok(m.TERM_HINTS.length >= 5);
  for (const hint of m.TERM_HINTS) {
    assert.ok(hint.term && hint.plain, '术语表条目必须成对');
    assert.ok(cjk(hint.plain) > 0, '白话解释必须是中文：' + hint.term);
  }
  assert.ok(m.describeTerm('工具调用'), '应能查到已知术语');
  assert.equal(m.describeTerm('不存在的术语xyz'), undefined);
});

test('用户问题为空时仍给出可执行的追问指令，不产生空 user 消息', () => {
  const messages = m.buildMessages('   ', { evidence: [] });
  assert.ok(messages[1].content[0].text.trim().length > 0);
});
