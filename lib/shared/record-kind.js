/**
 * 记录的种类：**问答**（ask）与**压缩日志**（compact）。
 *
 * 为什么需要一份共享判定：宿主与客户端都要回答同一个问题——
 * 「这条记录该不该当成对话里的一轮画出来」。
 *
 * 背景（真实数据实测）：`/compact` 成功后宿主会写一条 kind:'compact' 的记录：
 * question 为空、answerText 就是整份摘要。它作为**操作日志**有价值（可追溯压缩发生在哪一刻），
 * 但**不是一轮对话**：画进对话流就是"一段没有问句的回答"，而且同一份摘要会在
 * 「上下文已压缩」那一行之外再出现一次（用户 3081 真实会话：62 条里 3 条是压缩日志）。
 *
 * 判定写成「kind 不是 compact 就算问答」而不是「kind === 'ask' 才算」：
 * 客户端刚追加、还没落库的记录**没有 kind 字段**，它们都是问答，不能被过滤掉。
 */
export const COMPACT_RECORD_KIND = 'compact';
export function isAskRecord(record) {
    const kind = record?.kind;
    return kind !== COMPACT_RECORD_KIND;
}
