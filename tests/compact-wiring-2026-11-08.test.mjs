import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource } from './fixtures/runtime.mjs';

const prompts = await moduleFromSource('src/host/prompts.ts');
const llm = await moduleFromSource('src/host/llm.ts');

const textOf = (content) => Array.isArray(content)
  ? content.map((block) => block.text || '').join('')
  : String(content);

/** 用一个固定文本当模型输出的桩：只关心「模型说了什么」，不关心流式细节。 */
function stubModel(text) {
  return {
    stream() {
      const chunks = [{ type: 'text-delta', text }, { type: 'finish', done: true }];
      return (async function* () { for (const chunk of chunks) yield chunk; })();
    },
  };
}

const TITLES = [...prompts.COMPACT_SECTION_TITLES];

test('压缩请求的系统消息必须是压缩器提示词（七段骨架在里面）', () => {
  const messages = prompts.buildMessages('', null, {
    history: [{ question: '问', answer: '答' }],
    purpose: 'compact',
  });
  const system = textOf(messages[0].content);
  assert.equal(system, prompts.COMPACT_SYSTEM_PROMPT, '压缩模式的 system 消息必须是 COMPACT_SYSTEM_PROMPT');
  assert.equal(TITLES.filter((title) => system.includes(title)).length, 7, '七段标题必须全部在系统消息里');
});

test('反向对照：提问路径仍然用回答问题的提示词，不受压缩改动影响', () => {
  const messages = prompts.buildMessages('现在在干什么', { evidence: [] }, {});
  assert.equal(textOf(messages[0].content), prompts.SYSTEM_PROMPT);
});

test('收尾指令自包含七段标题：即使系统提示丢失，模型也能逐字照抄', () => {
  for (const title of TITLES) {
    assert.ok(prompts.COMPACT_INSTRUCTION.includes(title), '收尾指令缺少标题：' + title);
  }
});

test('整份压缩请求里七个标题 7/7 出现（这道断言本该在 2026-11-07 就存在）', () => {
  const messages = prompts.buildMessages('', null, {
    history: [{ question: '问', answer: '答' }],
    purpose: 'compact',
    compactSummary: '上一份底稿',
  });
  const all = messages.map((message) => textOf(message.content)).join('\n');
  const found = TITLES.filter((title) => all.includes(title));
  assert.equal(found.length, 7, '压缩请求里只找到 ' + found.length + '/7 个标题：' + TITLES.filter((title) => !all.includes(title)).join('、'));
});

test('反例：把系统提示换回「回答问题」的那份，测试必须变红', () => {
  const messages = prompts.buildMessages('', null, {
    history: [{ question: '问', answer: '答' }],
    purpose: 'compact',
    systemPrompt: prompts.SYSTEM_PROMPT,
  });
  const all = messages.map((message) => textOf(message.content)).join('\n');
  // 指令自包含后标题仍在指令里，但系统消息必须不是压缩器提示词 —— 这正是本条要钉死的接线。
  assert.notEqual(textOf(messages[0].content), prompts.COMPACT_SYSTEM_PROMPT);
  assert.equal(TITLES.filter((title) => textOf(messages[0].content).includes(title)).length, 0);
  assert.ok(all.length > 0);
});

test('校验容忍标题格式差异：井号数量、空格、全角括号不影响判定', async () => {
  // 真实样本里出现过 # 与 ## 混用、顿号后多个空格、全角/半角括号混用。
  const sloppy = TITLES.map((title) => title
    .replace(/^##/, '#')
    .replace('、', '、 ')
    .replace(/（/g, '(').replace(/）/g, ')')).join('\n');
  const result = await llm.compactAssistant(
    { llm: stubModel(sloppy), model: { provider: 'p', model: 'm' } },
    [{ role: 'system', content: [{ type: 'text', text: '系统' }] }],
  );
  assert.equal(result.complete, true, '只差井号/空格/括号宽度，不该判不合格');
  assert.equal(result.failure, undefined);
});

test('校验仍然拒绝自编结构，并说清缺哪几段', async () => {
  const invented = '# 一、原始对话核心内容\n# 二、我这一轮做了什么\n# 三、出现的错误';
  const result = await llm.compactAssistant(
    { llm: stubModel(invented), model: { provider: 'p', model: 'm' } },
    [{ role: 'system', content: [{ type: 'text', text: '系统' }] }],
  );
  assert.equal(result.complete, false);
  assert.equal(result.failure?.code, 'INVALID_SUMMARY');
  assert.match(result.failure?.message ?? '', /缺少必要的段落/);
  assert.match(result.failure?.message ?? '', /一、用户与当前意图/, '失败信息要指出缺哪一段，便于用户和日志定位');
});

test('只差一段也必须判不合格（不许把六段当七段收下）', async () => {
  const six = TITLES.slice(0, 6).join('\n');
  const result = await llm.compactAssistant(
    { llm: stubModel(six), model: { provider: 'p', model: 'm' } },
    [{ role: 'system', content: [{ type: 'text', text: '系统' }] }],
  );
  assert.equal(result.complete, false);
  assert.match(result.failure?.message ?? '', /七、已解释术语/);
});
