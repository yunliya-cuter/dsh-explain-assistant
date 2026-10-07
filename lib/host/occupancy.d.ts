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
    /**
     * 回答正文。**落库的真实字段名**（routes.ts 写进磁盘的就是它）。
     *
     * 这里曾经只声明 `answer`，而 `answer` 是**客户端本地记录**的字段名，
     * 落库记录里根本没有它 —— 于是占用把每条回答正文都算成 0 个字。
     * 实测（3082 真实文件 session-7e1a8742）：回答正文 1107 字一个没算，
     * ownTokens 601（应为 878）、ownChars 2286（应为 3393）。
     */
    answerText?: string;
    /** 客户端本地追加的记录用的字段名（宿主落库记录没有它），保留以兼容既有形状。 */
    answer?: string;
};
/**
 * 取一条记录的**回答正文**。字段名只能在这一处判定，不许两处各写一遍。
 *
 * 优先级：`answerText` 是字符串就用它（**空串也算数**——那是真实的空回答，
 * 不是"字段缺失"，不能拿 `answer` 去兜底）；`answerText` 不是字符串时才退回 `answer`。
 */
export declare function answerTextOf(record: OccupancyRecord | undefined): string;
export type OccupancyInput = {
    /** 小助手的系统提示词：每次请求都带，必须计入。 */
    systemPrompt: string;
    /** §9.1 压缩摘要：压缩后小助手后续参考的就是它 + 新问答。 */
    compactSummary?: string;
    /** 压缩之后产生的问答记录（压缩之前的已被摘要取代，不再计入，见 §9.2 最后一条）。 */
    records?: readonly OccupancyRecord[];
    /** 适配器自报的上下文容量；缺失或非法时返回 undefined。 */
    contextWindow?: number;
    /**
     * 0.2：主 agent 转移进小助手的那一段的估算 token 数。
     *
     * 为什么必须计入：那一段**确实占用了小助手的上下文**（每次提问都要发给模型）。
     * 不把它算进来，圆环就会少报——用户看到"才 20%"却在提问时撞上容量上限。
     *
     * 但它与"小助手自身占用"是**两块**，所以分开记账（见 Occupancy.parts），
     * 界面悬停时才能分别显示。§9.2「显示小助手自身占用，不使用主 agent 的数值」
     * 约束的是**不能用主 agent 的上下文窗口/百分比冒充小助手的**，
     * 不是"不许把小助手自己发出的请求里含的那部分算进它自己的占用"。
     */
    mainAgentTokens?: number;
    /** 主 agent 段的原始字符数（界面悬停显示绝对量用）。 */
    mainAgentChars?: number;
};
/** 这份上下文的构成：两块各自的量。两块之和 = usedTokens。 */
export type OccupancyParts = {
    /** 主 agent 转移进来的那部分。 */
    mainAgentTokens: number;
    mainAgentChars: number;
    /** 小助手与用户对话产生的部分（含系统提示词与压缩摘要）。 */
    ownTokens: number;
    ownChars: number;
};
export type Occupancy = {
    percent: number;
    usedTokens: number;
    contextWindow: number;
    /** 恒为 true：启发式结果一律标「估算」，不得伪装成精确值。 */
    estimated: true;
    /** 0.2：两块构成。ownTokens + mainAgentTokens === usedTokens。 */
    parts: OccupancyParts;
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
