import type { EvidenceItem } from './store.js';
/**
 * 让卡片上的标记与当前选择一致。可以随便重复调用（每一帧重画都会调）。
 *
 * 两个刻意的选择：
 * 1. 只动**值真的变了**的属性 —— setAttribute 即使写同一个值也会产生一次 mutation，
 *    主对话在流式输出时每帧都在重绘，无谓的 mutation 会拖慢它；
 * 2. 浮窗自己内部的节点一律不碰（选择页/对话页里也有 [data-ea-pick] 的可能性）。
 */
export declare function syncPickMarks(doc: Document, evidence: readonly EvidenceItem[]): void;
