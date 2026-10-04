/**
 * §10：失败/超时/触及上限的**中文原因**，以及记录落库时用的**原因码**。
 *
 * ── 为什么把文案集中到这一个文件 ──────────────────────────────────────
 * 这三句话原先只写在 routes.ts 的 SSE 分支里，只对「当时正在看界面的人」可见。
 * 但记录**会留在磁盘上**：整页重载后界面重建记录时，只能显示「未完成」，
 * 用户不知道为什么；追问时模型也拿不到原因。
 *
 * 本项目吃过「同一件事两处文案不一致」的亏，所以这里做成**唯一来源**：
 * routes.ts 的事件文案与 overlay.tsx 的记录重建文案**都从这里取**，
 * 并有测试把两处钉死一致（见 tests/record-reason.test.mjs）。
 *
 * ── 向后兼容 ────────────────────────────────────────────────────────
 * 老记录没有 reason 字段 → 按 undefined 处理，界面行为与以前**完全一样**（只显示「未完成」）。
 */
/** 落库用的字段名。 */
export const RECORD_REASON_FIELD = 'reason';
/** 各原因对应的中文提示（**唯一来源**）。 */
export const RECORD_REASON_TEXT = {
    timeout: '这次解释等太久了，已经停下，以免一直占用。你可以缩小问题范围，或换一个更快的模型再试。',
    model_failed: '这次解释没有成功：模型那边返回了错误，已经停下。你可以缩小问题范围，或换一个模型再试。',
    limit: '这次解释触及了安全上限，已停下。小助手不会无限重试，你可以缩小范围后再问。',
    empty_result: '这次整理没有拿到可用的摘要内容，已经停下。上一份可用摘要仍然保留，你可以稍后再试一次。',
    // 用户自己按了「停止」：这**不是失败**，所以文案不能写成「没有成功」，否则等于把用户的决定说成系统出错。
    stopped: '这次解释是按你的要求停止的，没有生成完整回答。你可以重新问一次。',
};
/** 记录重建时给这三句加的**前缀**（让用户明白这句话讲的是「历史里那条」为什么没完成）。 */
export const RECORD_REASON_PREFIX = '这条记录没有完成：';
/**
 * 各原因的**简短事实标签**（给追问上下文用）。
 *
 * 为什么单独一套：用户看到的是「怎么补救」（RECORD_REASON_TEXT），
 * 而模型需要先知道**事实是什么**，才知道该建议「缩小范围」还是「换个模型」。
 * 但两者仍同源 —— 建议那句仍从 RECORD_REASON_TEXT 取，不做第二份拷贝。
 */
export const RECORD_REASON_LABEL = {
    timeout: '超时（等太久，已停止）',
    model_failed: '模型调用失败',
    limit: '触及安全上限（轮次/工具/体积限制）',
    empty_result: '模型没有返回可用的摘要内容',
    stopped: '用户主动停止了这次解释',
};
/** 供追问上下文使用的一句话；原因未知时返回 undefined。 */
export function recordReasonContextLine(value) {
    const reason = normalizeRecordReason(value);
    if (!reason)
        return undefined;
    return RECORD_REASON_LABEL[reason] + '。' + RECORD_REASON_TEXT[reason];
}
/** 老记录（没有 reason 字段）的兜底提示，与既有行为一致。 */
export const RECORD_INCOMPLETE_TEXT = '此记录未完成或未验证';
/**
 * 把落到磁盘的值收敛成合法原因；认不出的一律返回 undefined（**不猜**）。
 * 向后兼容的关键：老记录没有该字段 → undefined → 界面行为与以前完全一样。
 */
export function normalizeRecordReason(value) {
    return value === 'timeout' || value === 'model_failed' || value === 'limit' || value === 'empty_result' || value === 'stopped'
        ? value : undefined;
}
/** 取某个原因对应的中文提示；没有原因时返回 undefined（调用方据此走原有兜底）。 */
export function recordReasonText(value) {
    const reason = normalizeRecordReason(value);
    return reason ? RECORD_REASON_TEXT[reason] : undefined;
}
/**
 * 从一次执行结果推导原因码。**与 routes.ts 的分支顺序严格一致**：
 *   1. 模型调用失败（有 failure）—— 最高优先；
 *      （提供方侧中断 ABORTED 不算失败，走「已停止」，这里返回 undefined 表示「不标注原因」）
 *   2. 超时（timeout === true）
 *   3. 未完成且非超时 → 触及安全上限
 *   4. 完成 → 不标注
 *
 * 抽成函数是为了让它可被单独测试，并且避免 routes.ts 里再写一遍判断（两处判断迟早会不一致）。
 */
/**
 * compact 专用的原因推导：先走通用三分支，再补一个 compact 独有的形态。
 *
 * `empty_result`：模型**正常结束**（complete=true、无 failure、非超时）但**没吐出可用摘要**。
 * 这条路径原先完全不落痕迹 —— 记录被写成 complete=true，重载后看起来「压缩成功了」，
 * 而界面上那次失败提示只活在内存里。判定条件与 routes.ts 调 saveCompact 用的
 * 「summary 非空」**保持同一个判据**（都是 trim 后非空），避免两处判定不一致。
 */
/**
 * 从**抛出的异常**推导原因码（异常路径专用；正常返回走 deriveRecordReason）。
 *
 * 为什么需要它：`routes.ts` 的 `run()` 里，凡是**不走正常返回 result** 的路径
 * （适配器抛异常、用户点停止）原先**连记录都不落** —— 用户重载后连「我问过这句话」都看不到。
 * 这是 D1 家族的第三个程度：a 有记录没原因 → b 有记录但记成成功 → c 连记录都没有。
 *
 * 判据与客户端 `isAbortLike` 一致：**用户主动停止不是失败**，要给不同的话。
 */
export function deriveErrorReason(error) {
    const code = error?.code;
    return code === 'ABORTED' ? 'stopped' : 'model_failed';
}
export function deriveCompactReason(result) {
    const base = deriveRecordReason(result);
    if (base)
        return base;
    if (result?.complete === true && !String(result.summary ?? '').trim())
        return 'empty_result';
    return undefined;
}
export function deriveRecordReason(result) {
    if (!result)
        return undefined;
    const code = result.failure?.code;
    if (code) {
        if (code === 'ABORTED')
            return undefined; // 提供方侧中断：不算「失败」，按既有语义不标注原因
        return 'model_failed';
    }
    if (result.timeout === true)
        return 'timeout';
    if (result.complete === false)
        return 'limit';
    return undefined;
}
