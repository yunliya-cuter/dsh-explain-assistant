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
export const CHARS_PER_TOKEN = 4;
/** 每个内容块的结构开销（JSON 框、类型标签）。 */
export const BLOCK_OVERHEAD = 4;
/** 每条消息的 role 字段开销。 */
export const ROLE_OVERHEAD = 4;
/** 纯文本的启发式 token 数。 */
export function estimateTextTokens(text) {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}
/**
 * 取一条记录的**回答正文**。字段名只能在这一处判定，不许两处各写一遍。
 *
 * 优先级：`answerText` 是字符串就用它（**空串也算数**——那是真实的空回答，
 * 不是"字段缺失"，不能拿 `answer` 去兜底）；`answerText` 不是字符串时才退回 `answer`。
 */
export function answerTextOf(record) {
    if (!record)
        return '';
    if (typeof record.answerText === 'string')
        return record.answerText;
    return typeof record.answer === 'string' ? record.answer : '';
}
/**
 * 计算小助手自身占用比例。
 *
 * 返回 undefined 表示**没有可信数值**（未选模型、容量未知），
 * 界面据此显示「占用未知」——绝不回退到主 agent 的数字，也绝不编造百分比。
 */
export function measureAssistantOccupancy(input) {
    const window = input.contextWindow;
    if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0)
        return undefined;
    // 自有那部分：系统提示词 + 压缩摘要 + 压缩之后的新问答。
    let ownChars = input.systemPrompt.length;
    let used = estimateTextTokens(input.systemPrompt) + ROLE_OVERHEAD;
    if (input.compactSummary) {
        ownChars += input.compactSummary.length;
        used += estimateTextTokens(input.compactSummary) + BLOCK_OVERHEAD + ROLE_OVERHEAD;
    }
    for (const record of input.records ?? []) {
        const question = typeof record.question === 'string' ? record.question : '';
        // 必须走 answerTextOf：真实落库字段是 answerText，直接读 record.answer 会恒取到空。
        const answer = answerTextOf(record);
        ownChars += question.length + answer.length;
        used += estimateTextTokens(question) + estimateTextTokens(answer) + 2 * (BLOCK_OVERHEAD + ROLE_OVERHEAD);
    }
    // 0.2：主 agent 转移进来的那一段。**分开记账**，但计入总量。
    const mainAgentChars = typeof input.mainAgentChars === 'number' && Number.isFinite(input.mainAgentChars) && input.mainAgentChars > 0
        ? input.mainAgentChars : 0;
    const mainAgentTokens = typeof input.mainAgentTokens === 'number' && Number.isFinite(input.mainAgentTokens) && input.mainAgentTokens > 0
        ? Math.ceil(input.mainAgentTokens) : 0;
    const total = used + mainAgentTokens;
    return {
        percent: Math.min(100, Math.max(0, (total / window) * 100)),
        usedTokens: total,
        contextWindow: window,
        estimated: true,
        parts: { mainAgentTokens, mainAgentChars, ownTokens: used, ownChars },
    };
}
/**
 * 从落库状态里挑出「当前仍参与上下文」的记录。
 *
 * §9.2 最后一条明确：完整保存的历史长度不等于交给模型的上下文长度。
 * 压缩成功后，压缩前的问答已被摘要取代，只应计入压缩之后的新问答。
 */
export function carriedRecords(records, compactCreatedAt) {
    const list = records ?? [];
    // 回答正文一律走 answerTextOf（**唯一判定处**）：落库字段是 answerText，
    // 而客户端本地记录用 answer。两处各写一遍就会再次出现「少算正文」那类缺陷。
    const carry = (record) => ({ question: record.question, answerText: answerTextOf(record) });
    if (!compactCreatedAt)
        return list.map(carry);
    return list
        .filter(record => {
        const at = record.startedAt ?? record.createdAt;
        return typeof at === 'string' && at > compactCreatedAt;
    })
        .map(carry);
}
