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
type SelectionController = {
    enter(): void;
    exit(): void;
    dispose(): void;
};
/**
 * 选择结果的两个出口：选中一条、取消一条。取消按 pickId 走（与卡片上的锚点同源）。
 *
 * select 额外把**被点的那张卡片**传出去：调用方可以立刻在它身上挂高亮，
 * 不等 React 那一轮重画。用户点下去到看见反应之间隔的这几百毫秒（长会话里更明显），
 * 正是「点了没反应」的主要来源。
 */
export type SelectionHandlers = {
    /**
     * 选中一条。
     *
     * @param options.additive true = 加选（Ctrl/⌘+左键）：并进已有的选择；
     *   false / 省略 = 替换（普通左键）：只留这一条。
     *   为什么要区分：用户要求「Ctrl+左键可选择多个内容」，而普通点击在桌面软件里
     *   一直是「换成这一个」的意思 —— 两种语义各占一个手势，别混成一种。
     */
    select(item: EvidenceItem, element: Element, options?: {
        additive?: boolean;
    }): void;
    deselect(pickId: string): void;
};
export declare function attachSelection(root: Document, sessionId: string, handlers: SelectionHandlers): SelectionController;
export {};
