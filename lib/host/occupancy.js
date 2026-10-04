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
 * 计算小助手自身占用比例。
 *
 * 返回 undefined 表示**没有可信数值**（未选模型、容量未知），
 * 界面据此显示「占用未知」——绝不回退到主 agent 的数字，也绝不编造百分比。
 */
export function measureAssistantOccupancy(input) {
    const window = input.contextWindow;
    if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0)
        return undefined;
    let used = estimateTextTokens(input.systemPrompt) + ROLE_OVERHEAD;
    if (input.compactSummary)
        used += estimateTextTokens(input.compactSummary) + BLOCK_OVERHEAD + ROLE_OVERHEAD;
    for (const record of input.records ?? []) {
        const question = typeof record.question === 'string' ? record.question : '';
        const answer = typeof record.answer === 'string' ? record.answer : '';
        used += estimateTextTokens(question) + estimateTextTokens(answer) + 2 * (BLOCK_OVERHEAD + ROLE_OVERHEAD);
    }
    return { percent: Math.min(100, Math.max(0, (used / window) * 100)), usedTokens: used, contextWindow: window, estimated: true };
}
/**
 * 从落库状态里挑出「当前仍参与上下文」的记录。
 *
 * §9.2 最后一条明确：完整保存的历史长度不等于交给模型的上下文长度。
 * 压缩成功后，压缩前的问答已被摘要取代，只应计入压缩之后的新问答。
 */
export function carriedRecords(records, compactCreatedAt) {
    const list = records ?? [];
    if (!compactCreatedAt)
        return list.map(record => ({ question: record.question, answer: record.answer }));
    return list
        .filter(record => {
        const at = record.startedAt ?? record.createdAt;
        return typeof at === 'string' && at > compactCreatedAt;
    })
        .map(record => ({ question: record.question, answer: record.answer }));
}
