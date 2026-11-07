import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleFromSource } from './fixtures/runtime.mjs';

const prompts = await moduleFromSource('src/host/prompts.ts');
const llm = await moduleFromSource('src/host/llm.ts');

const textOf = (content) => Array.isArray(content) ? content.map(block => block.text || '').join('') : String(content);

/* ==========================================================================
 * 2026-11-07：上下文压缩提示词重写。
 *
 * 目标（用户原话）：「现在的提示词过于简单且缺少约束性…上下文压缩可以参考
 * dsh 的提示词针对我们的需求进行优化」。
 *
 * 这一组测试锁的是**契约**，不是文风：七段骨架、判据、来源分级、逐字保留、
 * 冲突消解、丢弃清单、长度预算、再压缩规则，任何一条被删都会红。
 * ======================================================================== */

test('七段骨架逐字存在，且顺序与层级不变', () => {
  const titles = [
    '## 一、用户与当前意图',
    '## 二、硬约束与偏好（含否定式）',
    '## 三、问过的问题与结论（按时间顺序）',
    '## 四、已更正、已否决与已取代',
    '## 五、未完成与待跟进',
    '## 六、关键锚点（逐字照抄）',
    '## 七、已解释术语（术语 = 当时那句人话）',
  ];
  let cursor = -1;
  for (const title of titles) {
    const at = prompts.COMPACT_SYSTEM_PROMPT.indexOf(title);
    assert.ok(at > cursor, '标题必须存在且按顺序出现：' + title);
    cursor = at;
  }
  assert.deepEqual([...prompts.COMPACT_SECTION_TITLES], titles, '导出的标题常量必须与提示词正文一致');
});

test('唯一职责与可验收判据：五问答不出就算压缩失败', () => {
  const spec = prompts.COMPACT_SYSTEM_PROMPT;
  assert.match(spec, /唯一判据/, '必须把「唯一判据」写成一句可判断的话');
  assert.match(spec, /五项里任何一项答不出，就算这次压缩失败/, '必须有可验收的失败条件');
  for (const item of [
    /用户是谁、现在想解决什么/,
    /明确要求过什么、明确不要什么/,
    /每条结论的依据属于哪一级/,
    /哪些问题没答完/,
    /一字不差地引用/,
  ]) assert.match(spec, item, '判据缺一项：' + item);
  assert.match(spec, /不是续写|不回答用户的问题/, '必须写明它不是续写、不是回答');
});

test('空输入与工具边界：不找资料、不调用工具，七段照写「无」', () => {
  const spec = prompts.COMPACT_SYSTEM_PROMPT;
  assert.match(spec, /如果下面的对话是空的/, '空会话也必须输出合法的七段，而不是拒绝或追问');
  assert.match(spec, /每段写「无」/);
  assert.match(spec, /不调用任何工具/, '压缩器不该去读会话或调用工具');
  assert.match(spec, /不要解释、不要追问、不要去找资料/);
});

test('来源分级：模型断言不得在摘要里升级成事实', () => {
  const spec = prompts.COMPACT_SYSTEM_PROMPT;
  assert.match(spec, /〔已观察到〕/);
  assert.match(spec, /〔仅据汇报〕/);
  assert.match(spec, /〔无从得知〕/);
  assert.match(spec, /该步未提供足够信息/);
  assert.match(spec, /不许把「仅据汇报」升级成「已观察到」/, '这条是过去几轮出错的总根源，必须写死');
  assert.match(spec, /不许把「没看到」写成「没有发生」/);
});

test('逐字保留清单：原话、否定式、路径、命令、数字、报错', () => {
  const spec = prompts.COMPACT_SYSTEM_PROMPT;
  assert.match(spec, /用户原话（逐字引用/);
  assert.match(spec, /否定句、数字、路径必须逐字保留/);
  assert.match(spec, /不许翻译成英文/);
  assert.match(spec, /不许概括成「若干」「一些」「等」/);
  assert.match(spec, /文件与路径：/);
  assert.match(spec, /命令与参数：/);
  assert.match(spec, /报错原文：/);
});

test('冲突消解：以最后一次为准，且留下取代痕迹', () => {
  const spec = prompts.COMPACT_SYSTEM_PROMPT;
  assert.match(spec, /以最后一次为准/);
  assert.match(spec, /已取代：旧说法/);
  assert.match(spec, /不许把互相矛盾的结论并列保留/);
  assert.match(spec, /不许不声不响地删掉旧结论/);
});

test('必须丢弃清单写的是可判断的例子，不是「请精简」', () => {
  const spec = prompts.COMPACT_SYSTEM_PROMPT;
  assert.match(spec, /必须丢掉/);
  for (const item of [/寒暄与客套/, /时间戳采样行/, /我一度怀疑……后来排除/, /已经被取代的旧方案/, /工具的原始输出/]) {
    assert.match(spec, item, '丢弃清单缺一项：' + item);
  }
});

test('不确定即标注；省略优于猜测', () => {
  const spec = prompts.COMPACT_SYSTEM_PROMPT;
  assert.match(spec, /未确认/);
  assert.match(spec, /待核/);
  assert.match(spec, /宁可省略，也不许猜/);
  assert.match(spec, /编造路径、数字或结论，比漏写严重得多/);
});

test('长度与裁剪顺序是明确的数，不是「尽量短」', () => {
  const spec = prompts.COMPACT_SYSTEM_PROMPT;
  assert.match(spec, /不超过 2000 字/);
  assert.match(spec, /不超过原文的 60%/);
  assert.match(spec, /先砍第三段的解释性修饰/);
  assert.match(spec, /第一、二、六段和「未完成」的结论一个字都不许砍/);
});

test('再压缩稳定：旧底稿要被合并，不许原样照抄、也不许丢掉仍成立的锚点', () => {
  const spec = prompts.COMPACT_SYSTEM_PROMPT;
  assert.match(spec, /上一次的整理摘要/);
  assert.match(spec, /不许原样照抄旧摘要/);
  assert.match(spec, /不许丢掉旧摘要里仍然成立的锚点/);
});

test('不许复述系统提示词，也不许把压缩指令写进摘要', () => {
  const spec = prompts.COMPACT_SYSTEM_PROMPT;
  assert.match(spec, /不许写系统提示词里已经有的内容/, '旧摘要里 600 字是系统提示词的复述，必须禁止');
  assert.match(spec, /不许把「压缩指令」本身写进摘要/);
  assert.match(prompts.COMPACT_INSTRUCTION, /这条指令不是对话的一部分/);
});

test('compactAssistant 用独立系统提示词，回答用的系统提示词必须被替换掉', async () => {
  const seen = [];
  const stub = {
    stream(options) {
      seen.push(options);
      return (async function* () {
        yield { type: 'text-delta', text: prompts.COMPACT_SECTION_TITLES.join('\n') };
        yield { type: 'finish' };
      })();
    },
  };
  const result = await llm.compactAssistant({ llm: stub, model: { provider: 'p', model: 'm' } }, [
    { role: 'system', content: [{ type: 'text', text: '回答用的系统提示词' }] },
    { role: 'user', content: [{ type: 'text', text: '用户问过的问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '小助手当时的回答' }], id: 'a1', source: { kind: 'model', provider: 'p', model: 'm' } },
  ]);
  assert.equal(result.complete, true);
  const options = seen[0];
  const messages = options.messages;
  assert.deepEqual(options.tools, [], '压缩请求不得向模型暴露任何工具');
  assert.equal(messages.filter(message => message.role === 'system').length, 1, '只能有一条系统消息');
  assert.equal(textOf(messages[0].content), prompts.COMPACT_SYSTEM_PROMPT, '系统消息必须换成压缩专用提示词');
  assert.equal(messages.some(message => textOf(message.content) === '回答用的系统提示词'), false, '回答提示词不得进入压缩请求');
  assert.equal(textOf(messages[messages.length - 1].content), prompts.COMPACT_INSTRUCTION, '最后一条必须是收尾指令');
  const transcript = messages.slice(1, -1).map(message => textOf(message.content)).join('\n');
  assert.match(transcript, /用户问过的问题/);
  assert.match(transcript, /小助手当时的回答/);
});

test('压缩消息里不再出现「用户没有输入具体问题」「本次没有拿到任何步骤依据」', () => {
  const history = Array.from({ length: 4 }, (_, i) => ({ question: '问题' + i, answer: '回答' + i }));
  const messages = prompts.buildMessages('', { evidence: [{ title: '不该出现的依据' }] }, {
    history,
    purpose: 'compact',
    assistantSource: { provider: 'p', model: 'm' },
  });
  const all = messages.map(message => textOf(message.content)).join('\n');
  assert.equal(/用户没有输入具体问题/.test(all), false, '提问脚手架不得进入压缩输入');
  assert.equal(/本次没有拿到任何步骤依据/.test(all), false, '无依据提示不得进入压缩输入');
  assert.equal(/不该出现的依据/.test(all), false, '证据不得进入压缩输入');
  assert.equal(/用户的问题：/.test(all), false, '压缩输入里不该有「用户的问题」这一层');
});

test('压缩模式回放全部历史，而不是提问用的最近 6 轮', () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ question: '问题' + i, answer: '回答' + i }));
  const messages = prompts.buildMessages('', null, { history, purpose: 'compact', assistantSource: { provider: 'p', model: 'm' } });
  const all = messages.map(message => textOf(message.content)).join('\n');
  assert.match(all, /问题0/, '最早一轮必须进入压缩输入（旧实现只取最近 6 轮）');
  assert.match(all, /问题11/, '最新一轮必须在');
  assert.ok(prompts.COMPACT_MAX_TURNS > 6, '压缩轮次上限必须大于提问的 6 轮');
});

test('压缩模式标明「上一次的整理摘要」不是用户说的话', () => {
  const messages = prompts.buildMessages('', null, {
    purpose: 'compact',
    compactSummary: '上一次的底稿正文',
    history: [{ question: '新问题', answer: '新回答' }],
    assistantSource: { provider: 'p', model: 'm' },
  });
  const all = messages.map(message => textOf(message.content)).join('\n');
  assert.match(all, /上一次的整理摘要/);
  assert.match(all, /它不是用户说的话/);
  assert.match(all, /上一次的底稿正文/);
});

test('压缩输入有字数预算：从最旧的轮次开始丢，并显式说明丢了几轮', () => {
  const history = Array.from({ length: 5 }, (_, i) => ({ question: '问题' + i, answer: '答'.repeat(100) }));
  const messages = prompts.buildMessages('', null, {
    history, purpose: 'compact', maxHistoryChars: 250, assistantSource: { provider: 'p', model: 'm' },
  });
  const all = messages.map(message => textOf(message.content)).join('\n');
  assert.match(all, /更早的 3 轮问答/, '丢了 3 轮就必须说 3 轮，不能静默');
  assert.equal(/问题0/.test(all), false, '最旧的一轮必须被丢掉');
  assert.match(all, /问题4/, '最新一轮必须留下');
});

test('反例：提问路径完全不受影响（默认仍是 system + 历史 + 当前问题）', () => {
  const messages = prompts.buildMessages('现在在干什么', { evidence: [] }, {
    history: [{ question: '旧问题', answer: '旧回答' }],
    assistantSource: { provider: 'p', model: 'm' },
  });
  assert.deepEqual(messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  const last = messages[messages.length - 1];
  assert.match(textOf(last.content), /现在在干什么/);
});

test('宿主确实把 purpose 与压缩预算接上了（不是只在纯函数里存在）', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /purpose: mode/, 'buildMessages 必须收到本次是 ask 还是 compact');
  assert.match(source, /maxHistoryTurns: COMPACT_MAX_TURNS/, '压缩必须用压缩自己的轮次上限');
  assert.match(source, /maxHistoryChars: COMPACT_CHAR_BUDGET/, '压缩必须用压缩自己的字数预算');
});

test('模型没按七段骨架输出时判为失败：拒绝或敷衍不得被存成摘要', async () => {
  const stub = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: '抱歉，我做不到。' };
        yield { type: 'finish' };
      })();
    },
  };
  const result = await llm.compactAssistant({ llm: stub, model: { provider: 'p', model: 'm' } }, []);
  assert.equal(result.complete, false, '缺少七段骨架时必须判失败');
  assert.equal(result.failure?.code, 'INVALID_SUMMARY');
  assert.match(result.failure.message, /缺少必要的段落/);
  const reasons = await moduleFromSource('src/shared/record-reason.ts');
  assert.equal(reasons.deriveCompactReason({ complete: false, failure: { code: 'INVALID_SUMMARY' } }), 'invalid_summary', '原因码必须能落库并显示中文');
  assert.match(reasons.RECORD_REASON_TEXT.invalid_summary, /七段格式/);
});

test('空会话使用自包含指令：不依赖「上面有对话」，且自带七段标题', async () => {
  assert.match(prompts.COMPACT_EMPTY_INSTRUCTION, /这次没有历史对话/);
  for (const title of prompts.COMPACT_SECTION_TITLES) {
    assert.ok(prompts.COMPACT_EMPTY_INSTRUCTION.includes(title), '空指令必须自带这个标题：' + title);
  }
  const seen = [];
  const stub = {
    stream(options) {
      seen.push(options);
      return (async function* () {
        yield { type: 'text-delta', text: prompts.COMPACT_SECTION_TITLES.join('\n') };
        yield { type: 'finish' };
      })();
    },
  };
  const result = await llm.compactAssistant({ llm: stub, model: { provider: 'p', model: 'm' } }, []);
  assert.equal(result.complete, true);
  const last = seen[0].messages[seen[0].messages.length - 1];
  assert.equal(textOf(last.content), prompts.COMPACT_EMPTY_INSTRUCTION, '空会话必须用自包含指令');
});
