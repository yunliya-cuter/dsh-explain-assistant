import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleFromSource } from './fixtures/runtime.mjs';

const prompts = await moduleFromSource('src/host/prompts.ts');

/**
 * §7「用户提问、追问后，小助手独立调用模型回答」；§11.6「支持持续追问」。
 *
 * 修之前：每次只发 system + user 两条，模型对上一轮一无所知，
 * 「那它为什么这么做」这类追问接不上，用户只能重述背景。
 */

const textOf = (message) => (message.content || []).map(b => b.text || '').join('');

test('F3: 既往问答会作为真实对话轮次带进请求', () => {
  const messages = prompts.buildMessages('那它为什么这么做？', { evidence: [] }, {
    history: [
      { question: '它现在在干什么', answer: '它在读文件' },
      { question: '为什么读文件', answer: '为了确认配置' },
    ],
    assistantSource: { provider: 'p', model: 'm' },
  });
  const roles = messages.map(m => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user', 'assistant', 'user'], '必须按 system→user→assistant…→user 的顺序：' + JSON.stringify(roles));
  // assistant 消息必须带 id 与 source：dsh-llm 的 RequestMessage 只有两种合法形状
  // （完整 Message 或「无身份的 user 输入」），没有「无身份的 assistant」。缺了会让适配器抛错。
  for (const message of messages.filter(m => m.role === 'assistant')) {
    assert.equal(typeof message.id, 'string', 'assistant 必须有 id');
    assert.equal(message.source?.kind, 'model', 'assistant 必须带 source.kind=model');
    assert.equal(typeof message.source.provider, 'string');
    assert.equal(typeof message.source.model, 'string');
  }
  const all = messages.map(textOf).join('\n');
  assert.match(all, /它现在在干什么/, '第一轮的问题必须在');
  assert.match(all, /它在读文件/, '第一轮的回答必须在');
  assert.match(all, /为了确认配置/, '第二轮的回答必须在');
  assert.match(all, /那它为什么这么做/, '当前问题必须在最后');
});

test('F3: 当前问题必须排在最后一条（模型先看到历史再看到提问）', () => {
  const messages = prompts.buildMessages('新问题', { evidence: [] }, { history: [{ question: '旧问题', answer: '旧回答' }] });
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'user');
  assert.match(textOf(last), /新问题/);
});

test('F3: 每条 message 的 content 仍是内容块数组（适配器要求，不能退化成字符串）', () => {
  const messages = prompts.buildMessages('问', { evidence: [] }, { history: [{ question: 'q', answer: 'a' }] });
  for (const message of messages) {
    assert.ok(Array.isArray(message.content), 'content 必须是数组：' + JSON.stringify(message.content));
    for (const block of message.content) {
      assert.equal(block.type, 'text');
      assert.equal(typeof block.text, 'string');
    }
  }
});

test('§5.1: 历史不能无节制全带上，只取最近若干轮', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ question: '问题' + i, answer: '回答' + i }));
  const messages = prompts.buildMessages('最新问题', { evidence: [] }, { history, maxHistoryTurns: 3 });
  const all = messages.map(textOf).join('\n');
  assert.match(all, /问题29/, '最近一轮必须在');
  assert.match(all, /问题27/, '倒数第三轮必须在');
  assert.equal(/问题26/.test(all), false, '更早的轮次必须被截断');
  assert.equal(/问题0/.test(all), false, '最老的轮次必须被截断');
});

test('§9.1: 压缩过之后带的是摘要，不是压缩前的原始问答', () => {
  const messages = prompts.buildMessages('继续问', { evidence: [] }, { compactSummary: '这是整理后的摘要正文' });
  const all = messages.map(textOf).join('\n');
  assert.match(all, /整理摘要/, '必须有摘要标识');
  assert.match(all, /这是整理后的摘要正文/, '摘要正文必须带上');
});

test('F3: 拿不到模型来源时不生成不合契约的 assistant（退回 user 材料）', () => {
  const messages = prompts.buildMessages('追问', { evidence: [] }, { history: [{ question: 'q', answer: 'a' }] });
  const assistants = messages.filter(m => m.role === 'assistant');
  assert.equal(assistants.length, 0, '没有 source 时不得生成 assistant 消息');
  assert.ok(messages.map(m => m.role).includes('user'), '内容仍以 user 材料带进去');
  assert.match(messages.map(m => (m.content || []).map(b => b.text || '').join('')).join('\n'), /a/, '回答正文不能丢');
  for (const message of messages) {
    if (message.role === 'assistant') assert.fail('不得出现 assistant');
    if (message.role !== 'user' && message.role !== 'system') assert.fail('只允许 system/user');
  }
});

test('反例: 没有历史时行为与从前一致（只有 system + user）', () => {
  const messages = prompts.buildMessages('问', { evidence: [] });
  assert.deepEqual(messages.map(m => m.role), ['system', 'user']);
});

test('反例: 空问答的历史条目不得产生空消息', () => {
  const messages = prompts.buildMessages('问', { evidence: [] }, { history: [{ question: '', answer: '' }, { question: '有内容', answer: '' }] });
  assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'user'], '空条目必须被跳过：' + JSON.stringify(messages.map(m => m.role)));
});

test('纯函数性质仍在：同输入两次结果一致', () => {
  const deps = { history: [{ question: 'q', answer: 'a' }], compactSummary: '摘要' };
  const a = prompts.buildMessages('问', { evidence: [] }, deps);
  const b = prompts.buildMessages('问', { evidence: [] }, deps);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('host 侧确实把落库问答接进来了（不是只改了纯函数）', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /history: turns/, '必须把既往问答传进去');
  assert.match(source, /compactSummary: state\?\.compactState\?\.summary/, '必须带上压缩摘要');
  assert.match(source, /compactCreatedAt/, '压缩之前的记录必须被排除（§9.1）');
  assert.match(source, /record\.kind === 'ask'/, '只有问答记录参与对话');
});
