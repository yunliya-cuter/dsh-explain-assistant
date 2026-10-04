import type { EvidenceEnvelope, ImageSnapshotRef, ToolTrace } from './contracts.js';
/**
 * §11.6「依据可展开核查」/ §6.3「依据分级」/ §8：把一次问答的**可核查材料**组装成可落库的
 * evidence / tools / images，并施加大小上限。
 *
 * 为什么需要这个文件：
 * 旧实现里 `routes.ts` 调 `saveRecord` 时只写了 9 个字段（id/kind/status/complete/question/
 * answerText/reasoningText/usage/startedAt/updatedAt），**没写 evidence、没写 tools、没写 images**。
 * 而 `llm.ts` 明明已经算出了 `toolTrace`（工具过程），只是在落库这一步被丢掉了。
 * 后果：界面上「查看完整内容」点开也只能看到回答正文 —— 看不到「这条结论当时读了什么、
 * 跑了哪些工具」，而这正是用户要核对的东西（§11.6）。而且这不是「恰好这几条没有」：
 * 实测 `/home/dsh/.dsh/explain-assistant/sessions/` 下全部 15 个落库文件，带 tools/evidence 的为 0。
 *
 * 三条硬要求：
 * 1. 形状必须沿用 `contracts.ts` 的既有定义（EvidenceEnvelope / ToolTrace / ImageSnapshotRef），
 *    不另造第二套协议；
 * 2. `evidenceState` 不许一律写 `observed`（§6.3）——判定规则与客户端
 *    `src/client/selection.ts` 的 `classifyEvidence` **保持一致**，避免同一件事在两侧叫两个级别；
 * 3. 截断必须留痕：超出上限时把 `truncated` 标在**被保留的最后一条**上，并把丢弃条数写进
 *    `metadata`，绝不悄悄丢。
 */
/** 单条记录里依据与工具过程的条数上限（与 evidence.ts 的 maxItems 同量级）。 */
export declare const RECORD_MAX_EVIDENCE = 200;
export declare const RECORD_MAX_TOOLS = 64;
/** 单条记录里这三组内容加起来的字节上限；超了就从尾部丢并留痕。 */
export declare const RECORD_MAX_CONTENT_BYTES: number;
/** §6.3：认不出来源的状态时，宁可写「无从得知」，也不假装「已观察到」。 */
export declare function normalizeEvidenceState(value: unknown): EvidenceEnvelope['evidenceState'];
/**
 * §6.3：工具执行的真实结局决定分级。
 *
 * 与 `selection.ts:classifyEvidence` 同一条判据：工具卡片的 done/ok/failed/error 都算「记录已证实」
 * （失败证实的也是「这次失败」这个事实）；只有还没定论（preparing/running）才算「无从得知」。
 */
export declare function evidenceStateForToolStatus(status: unknown): EvidenceEnvelope['evidenceState'];
/**
 * 从工具返回的 `result.value` 里挑出依据与图片快照。
 *
 * 三种形态都要认（都是既有代码产出的，不是猜的）：
 * - 单个 EvidenceEnvelope（readWorkspaceText / saveWorkspaceImageSnapshot 的 value.evidence）；
 * - EvidenceEnvelope 数组（listWorkspace / searchWorkspace）；
 * - `{ evidence, snapshot }`（读图工具，snapshot 是 ImageSnapshotRef）。
 * 都不匹配时返回空数组，由调用方决定是否包一层「已观察到工具输出」的依据。
 */
export declare function collectEvidence(value: unknown): {
    evidence: EvidenceEnvelope[];
    images: ImageSnapshotRef[];
};
/**
 * 把 `llm.ts` 返回的 toolTrace 转成落库用的 tools，并顺带抽出依据与图片。
 *
 * toolTrace 的形状本来就与 `contracts.ts` 的 ToolTrace 对齐（tool/callId/arguments/status/result/
 * startedAt/finishedAt/truncated/sentBytes/availableBytes），所以这里只做**白名单拷贝**——
 * 不认识的字段不带进落库文件，避免把将来的内部字段固化进磁盘格式。
 */
export declare function fromToolTrace(trace: readonly unknown[], sessionId: string, now: string): {
    tools: ToolTrace[];
    evidence: EvidenceEnvelope[];
    images: ImageSnapshotRef[];
};
/**
 * 把客户端随请求带上来的「已选择依据」转成 EvidenceEnvelope。
 *
 * §6.3：分级**原样沿用客户端的判定**（selection.ts 的 classifyEvidence），
 * 因为那才是看着真实 DOM 属性分出来的级别；拿不到就退成 unavailable，绝不默认 observed。
 * §5.2：选择结果在选中那一刻就冻结为 selected_frozen，这里保持一致。
 */
export declare function fromSelectedEvidence(selected: unknown, sessionId: string, now: string): EvidenceEnvelope[];
export interface RecordContentInput {
    sessionId: string;
    selectedEvidence?: unknown;
    toolTrace?: readonly unknown[];
    now?: string;
}
/**
 * 组装一条记录的可核查内容。**永不抛异常**：落库是尽力而为，
 * 组装失败不能把已经跑完的问答连累掉（失败时回空数组，各字段仍是合法形状）。
 */
export declare function buildRecordContent(input: RecordContentInput): {
    evidence: EvidenceEnvelope[];
    tools: ToolTrace[];
    images: ImageSnapshotRef[];
};
