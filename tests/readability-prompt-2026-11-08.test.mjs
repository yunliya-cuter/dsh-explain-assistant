/**
 * 「小助手说话的方式」（2026-11-08）。
 *
 * 用户原话两段，必须一起读：
 *   ① 「小助手生成的内容经常一大段一大段的，可读性不是很好。有没有什么办法可以增强
 *      可读性并且不丢失必要信息」
 *   ② 「不，我不是要你改渲染方式，而是改小助手说话的方式」
 *
 * 所以这份测试盯的是**模型怎么写**，不是界面怎么画：没有渲染层参与，全部判据都在
 * 发出去的消息里。三条都是踩过坑才写下的：
 *   A. 形状规则必须在系统提示里（一行结论 / 一行一条依据 / 一行建议 / 每行一句 / ≤15 行）；
 *   B. **同一条规则还必须作为用户消息的收尾要求再发一次** —— 只写系统提示时实测 39 行、
 *      单行 215 字；放进用户消息后 9-10 行、单行 ≤49 字。原因见提示词自己的优先级表：
 *      「用户本条消息里的明确指令」高于「默认格式」。
 *   C. 反例：任何「不写小标题」式的旧说法必须已经收回，否则模型会连「结论：」一起不写。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource } from './fixtures/runtime.mjs';

const prompts = await moduleFromSource('src/host/prompts.ts');
const spec = prompts.SYSTEM_PROMPT;

/** 把 buildMessages 的结果拍平成「角色 → 文本」。 */
const flat = messages => messages.map(m => ({ role: m.role, text: (m.content || []).map(part => part.text || '').join('') }));

test('系统提示里写死了回答形状：结论行 / 依据行 / 建议行', () => {
  assert.match(spec, /【回答形状（硬约束）】/);
  assert.match(spec, /第 1 行：结论：/);
  assert.match(spec, /每条一行，以「- 」开头/);
  assert.match(spec, /最后 1 行：建议：/);
});

test('形状规则是可数的：每行一句话、40 字拆句、最多 15 行', () => {
  assert.match(spec, /每一行只写一句话（只许一个句号）/);
  assert.match(spec, /40 字还没句号，就把这句拆成两句/);
  assert.match(spec, /全篇不超过 15 行/);
});

test('两条守恒规则：至少 2 条依据、锚点原样照抄', () => {
  assert.match(spec, /至少给 2 条依据/);
  assert.match(spec, /数字、路径、命令、报错原文照抄原样/);
  assert.match(prompts.OUTPUT_SHAPE_INSTRUCTION, /至少给 2 条依据/);
  assert.match(prompts.OUTPUT_SHAPE_INSTRUCTION, /不许四舍五入/);
});

test('形状带一个正例（模型照形状模仿，不靠猜「简洁」是什么意思）', () => {
  assert.match(spec, /例：/);
  assert.match(spec, /结论：它在装依赖，还没装完。/);
  assert.match(spec, /- 动作：执行了 pnpm install。/);
  assert.match(spec, /建议：等它跑完再看，现在不用动。/);
});

test('反例：会压掉「结论：」标签的旧说法必须已经收回', () => {
  assert.equal(/不写时间线、不写小标题/.test(spec), false, '「不写小标题」和「第 1 行：结论：」直接打架，模型会两个都不写');
  assert.match(spec, /不写大标题（但行首的「结论：」「建议：」这种短标签必须写）/);
});

test('形状不是只躺在系统提示里：用户消息的收尾必须再发一次（这才是它生效的原因）', () => {
  const messages = flat(prompts.buildMessages('它现在在干什么', { evidence: [] }));
  const user = messages.filter(m => m.role === 'user').map(m => m.text).join('\n');
  assert.ok(user.includes(prompts.OUTPUT_SHAPE_INSTRUCTION), '用户消息里没有形状要求 —— 只写系统提示时实测不生效');
  assert.match(prompts.OUTPUT_SHAPE_INSTRUCTION, /【本条输出格式（硬要求，照它写）】/);
  assert.match(prompts.OUTPUT_SHAPE_INSTRUCTION, /第 1 行「结论：/);
  assert.match(prompts.OUTPUT_SHAPE_INSTRUCTION, /最后一行「建议：/);
  assert.match(prompts.OUTPUT_SHAPE_INSTRUCTION, /每一行只写一句话/);
  assert.match(prompts.OUTPUT_SHAPE_INSTRUCTION, /不超过 15 行/);
});

test('形状指令放在最后：模型对「最后一条要求」的遵从度明显更高', () => {
  const messages = flat(prompts.buildMessages('它现在在干什么', { evidence: [] }));
  const user = messages[messages.length - 1];
  assert.equal(user.role, 'user');
  assert.ok(user.text.trimEnd().endsWith(prompts.OUTPUT_SHAPE_INSTRUCTION), '形状要求必须是用户消息的最后一块');
});

test('压缩路径不许带形状指令（压缩有它自己的七段骨架）', () => {
  const messages = flat(prompts.buildMessages('', {}, { purpose: 'compact' }));
  for (const message of messages) {
    assert.equal(message.text.includes('【本条输出格式（硬要求，照它写）】'), false, '压缩请求里混进了问答形状要求');
  }
});

test('提示词仍然够短（太长模型会挑着遵守）', () => {
  const cjk = (spec.match(/[\u4e00-\u9fff]/g) || []).length;
  assert.ok(cjk / spec.length > 0.5, '中文占比过低：' + (cjk / spec.length).toFixed(2));
  assert.ok(spec.length < 3000, '系统提示词太长：' + spec.length);
});
