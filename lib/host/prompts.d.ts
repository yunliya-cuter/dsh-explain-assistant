/**
 * 解释小助手的中文系统提示词与消息构造。
 *
 * 设计约束（来自 docs/business-logic.md）：
 * - §6.1 解释一个具体步骤时必须覆盖「四要素」：在干什么 / 为什么做 / 实际产出 / 哪里可以调整。
 * - §6.2 一律白话中文；出现术语要当场用一句人话解释，不能用更多行话糊弄。
 * - §6.3 依据要分级（已观察到 / 仅据汇报 / 无从得知）；信息不足必须原样写出「该步未提供足够信息」。
 * - §5.1 不得默认去读其它会话；缺失的记录不得假装看过。
 *
 * 工程约束：DSH 的 @deepseek-ai/dsh-llm 要求 message.content 必须是**内容块数组**
 * （形如 [{ type: 'text', text }]）。provider 适配器内部会执行 message.content.flatMap(...)，
 * 传字符串会直接抛错、用户问题根本送不进模型。因此本模块只产出数组形态的 content。
 */
import type { EvidenceEnvelope } from './contracts.js';
import type { AssistantMessage } from './llm.js';
/** §6.1 四要素。顺序即推荐的行文顺序。 */
export declare const FOUR_ELEMENTS: readonly ['在干什么', '为什么做', '实际产出', '哪里可以调整'];
/** §6.3 信息不足时的固定表述。原样出现，不得改写成同义词。 */
export declare const INSUFFICIENT_MARKER = "\u8BE5\u6B65\u672A\u63D0\u4F9B\u8DB3\u591F\u4FE1\u606F";
/** §6.3 依据分级用词。 */
export declare const EVIDENCE_TIERS: readonly ['已观察到', '仅据汇报', '无从得知'];
export type TermHint = {
    term: string;
    plain: string;
};
/**
 * 术语即时解释表（§6.2）。命中术语时把对应白话连同术语一起给用户，
 * 避免"用行话解释行话"。新增术语只需在此表加一行，不要散落到提示词正文里。
 */
export declare const TERM_HINTS: readonly TermHint[];
/** 命中则返回白话解释，否则 undefined。大小写不敏感。 */
export declare function describeTerm(term: string): string | undefined;
/** 一句话能塞下的术语解释清单，供提示词正文引用。 */
export declare function termGlossary(): string;
/** 0.2：主 agent 上下文的标题行（分区用，界面与提示词同源）。 */
export declare const MAINLINE_TITLE = "\u3010\u4E3B agent \u7684\u4E0A\u4E0B\u6587\u3011\uFF08\u5C0F\u52A9\u624B\u81EA\u5DF1\u8BFB\u5230\u7684\uFF0C\u4E0D\u662F\u7528\u6237\u63D0\u4F9B\u7684\uFF09";
/** 0.2：小助手自有上下文的标题行。 */
export declare const OWN_TITLE = "\u3010\u5C0F\u52A9\u624B\u81EA\u5DF1\u7684\u4E0A\u4E0B\u6587\u3011";
/**
 * 0.2：把主 agent 的上下文渲染成一个消息块。
 *
 * 用户要求（原话）：「小助手要能分清主 agent 的上下文与自己的上下文」。
 * 做法是在**提示词里分区**（用户给出的选项①）：主 agent 段单独成块、带明确标题，
 * 自有段用另一套标题，系统提示词里再写死两者归属。
 *
 * 这个函数只负责加标题与收尾，内容渲染在 host/session-context.ts（纯函数、有独立测试）。
 */
export declare function renderMainline(mainline: {
    text?: string;
} | undefined): string;
/**
 * 系统提示词正文。写死在这里而不是拼进每个请求，是为了让措辞可被测试逐条断言。
 */
export declare const SYSTEM_PROMPT: string;
/** 依据条目的白话分级标签（§6.3）。 */
export declare function evidenceTier(item: Pick<EvidenceEnvelope, 'evidenceState'>): string;
/**
 * 把选中的依据渲染成中文上下文块。
 * 拿不到摘要 / 状态为 unavailable 的条目**必须**带出「该步未提供足够信息」，
 * 而不是留给模型自行猜测。
 */
export declare function renderEvidence(evidence: readonly unknown[] | undefined): string;
/** 一条既往问答，用于让追问能接上前面的话（§7「用户提问、追问后」）。 */
export type ConversationTurn = {
    question?: string;
    answer?: string;
    /**
     * §10/D1：这条问答**为什么没完成**（'timeout' | 'model_failed' | 'limit'）。
     * 老记录没有该字段 → undefined → 行为与以前完全一样（不附加任何说明）。
     */
    reason?: string;
};
export type BuildMessagesDeps = {
    /** 覆盖系统提示词（测试或将来做用户自定义提示词时用）。 */
    systemPrompt?: string;
    /** §7/§11.6：本会话既往问答，按时间正序。让「那它为什么这么做」这类追问能接上。 */
    history?: readonly ConversationTurn[];
    /** §9.1：压缩摘要。压缩后后续回答参考的是摘要 + 压缩之后的新问答。 */
    compactSummary?: string;
    /** 既往问答最多带几轮，避免「无节制把全部历史交给模型」（§5.1）。 */
    maxHistoryTurns?: number;
    /**
     * 既往回答来自哪个模型。
     *
     * 这是**必需的**：dsh-llm 的 RequestMessage 只允许两种形状 —— 完整的 Message
     * （assistant 必须带 id + source）或「无身份的 user 输入」RequestUserInput。
     * 没有「无身份的 assistant 输入」。此前这里直接压入 { role:'assistant', content }，
     * 适配器读 message.source.kind 时抛 TypeError，请求整个失败；
     * 而当时的上层把「适配器抛错」当成正常结束，于是界面显示成功、内容空白。
     */
    assistantSource?: {
        provider: string;
        model: string;
    };
    /** 给既往消息分配稳定 id 前缀，保证同一次请求内 id 不重复。 */
    idPrefix?: string;
    /**
     * 0.2：主 agent 的当前上下文（小助手自己去读的）。
     *
     * **缺席时消息序列与 0.1.47 逐字节一致**——所以既有测试一条都不用改，
     * 而且读不到主 agent 上下文时行为自动退回旧版（§5.1 的降级）。
     *
     * 放在**最后一条 user 消息之前**单独成一条 user 消息：这样它不会挤进
     * 用户问题那一块，模型看到的分区也最清楚。
     */
    mainline?: {
        text?: string;
    };
};
/**
 * 构造送进模型的消息序列。
 *
 * 纯函数：同样输入必然得到同样输出（不注入当前时间、不读写外部状态）。
 * 每条 message 的 content 都是内容块数组，符合 dsh-llm 的适配器要求。
 */
export declare function buildMessages(question: string, payload?: Record<string, unknown> | null, deps?: BuildMessagesDeps): AssistantMessage[];
