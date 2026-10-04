/**
 * §9.2 小助手自身上下文占用。
 *
 * 硬要求（docs/business-logic.md §9.2）：
 * - 显示**小助手自身**占用，**不使用主 agent 的数值**；
 * - 只有估算时明确标「估算」；
 * - 无可信数值或模型容量时显示未知，不编造百分比；
 * - 完整保存的历史长度，不等于本次交给模型的上下文长度。
 *
 * 为什么只能估算：小助手不是 DSH 会话，宿主 tokenMeter.measure() 只接受 Session
 * （见 @deepseek-ai/dsh-token-meter 的 measure(session, requestHeader?)），
 * 拿主会话去量就等于量了主 agent —— 那正是本模块要消除的错误。
 * 因此自身上下文的规模按固定密度启发式估算，结果**必须**标「估算」。
 *
 * 容量来自宿主 llm.resolveModelInfo(provider, model) 的 context.contextWindow，
 * 这是适配器自报的可信容量；拿不到就返回 undefined，由界面显示「占用未知」。
 */
/** 固定文本密度：与宿主 token-meter 的启发式保持同一口径，避免两处数字互相矛盾。 */
export declare const CHARS_PER_TOKEN = 4;
/** 每个内容块的结构开销（JSON 框、类型标签）。 */
export declare const BLOCK_OVERHEAD = 4;
/** 每条消息的 role 字段开销。 */
export declare const ROLE_OVERHEAD = 4;
/** 纯文本的启发式 token 数。 */
export declare function estimateTextTokens(text: string): number;
/** 一条小助手自己的问答记录（只取参与上下文的两个字段）。 */
export type OccupancyRecord = {
    question?: string;
    answer?: string;
};
export type OccupancyInput = {
    /** 小助手的系统提示词：每次请求都带，必须计入。 */
    systemPrompt: string;
    /** §9.1 压缩摘要：压缩后小助手后续参考的就是它 + 新问答。 */
    compactSummary?: string;
    /** 压缩之后产生的问答记录（压缩之前的已被摘要取代，不再计入，见 §9.2 最后一条）。 */
    records?: readonly OccupancyRecord[];
    /** 适配器自报的上下文容量；缺失或非法时返回 undefined。 */
    contextWindow?: number;
};
export type Occupancy = {
    percent: number;
    usedTokens: number;
    contextWindow: number;
    /** 恒为 true：启发式结果一律标「估算」，不得伪装成精确值。 */
    estimated: true;
};
/**
 * 计算小助手自身占用比例。
 *
 * 返回 undefined 表示**没有可信数值**（未选模型、容量未知），
 * 界面据此显示「占用未知」——绝不回退到主 agent 的数字，也绝不编造百分比。
 */
export declare function measureAssistantOccupancy(input: OccupancyInput): Occupancy | undefined;
/**
 * 从落库状态里挑出「当前仍参与上下文」的记录。
 *
 * §9.2 最后一条明确：完整保存的历史长度不等于交给模型的上下文长度。
 * 压缩成功后，压缩前的问答已被摘要取代，只应计入压缩之后的新问答。
 */
export declare function carriedRecords(records: readonly (OccupancyRecord & {
    startedAt?: string;
    createdAt?: string;
})[] | undefined, compactCreatedAt?: string): OccupancyRecord[];
