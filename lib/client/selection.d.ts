import type { EvidenceItem } from './store.js';
/**
 * §6.3 依据分级：**必须区分「记录已证实」「主 agent 的说法」「信息不足」**。
 *
 * 旧实现把每一条依据都硬编码成 `observed` —— 于是三级分级在数据层根本表达不出来，
 * 实际只有一级：不管用户点的是工具的**真实输出**，还是主 agent 的**一句汇报**，
 * 界面和提示词都当成「亲眼所见」，正好踩中 §6.3 明令禁止的那一条
 * （「不得把汇报当验证事实」，§11.7 同）。
 *
 * 分级判据（基于 DSH 真实产出的 DOM 属性，不靠猜）：
 * - 工具卡片（[data-tool]）：data-state 表示这次调用的**真实结局**
 *   （done/ok → 记录已证实；failed/error → 已证实，但证实的是失败；preparing/ongoing/running → 还没定论）；
 * - 助手汇报（[data-chat-flow-kind=assistant-step] 等）：那是主 agent **说的话**，不是执行结果 → 仅据汇报；
 * - 拿不到任何可判定属性，或内容为空 → 信息不足。
 */
export declare function classifyEvidence(element: Element): EvidenceItem['evidenceState'];
export declare function evidenceFromElement(element: Element, sessionId: string): EvidenceItem;
export type SelectionController = {
    dispose(): void;
};
export declare function attachSelection(root: Document, sessionId: string, onSelect: (item: EvidenceItem) => void): SelectionController;
