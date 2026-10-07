import { type HistoryResultPayload } from './contracts.js';
import { type AssistantMessage, type AssistantModel } from './llm.js';
import type { ToolContext } from './tools.js';
export interface RouteService {
    loadState?: (id: string, signal?: AbortSignal) => Promise<unknown>;
    loadHistory?: (id: string, cursor?: string, signal?: AbortSignal) => Promise<unknown>;
    /** §5.1/§8：展开单条记录的完整内容（分页）。未实现时路由会给中文错误，不再静默返回空对象。 */
    loadHistoryResult?: (id: string, recordId: string, cursor?: string, signal?: AbortSignal) => Promise<HistoryResultPayload>;
    listModels?: (signal?: AbortSignal) => Promise<unknown>;
    resolveModel?: (id: string, signal?: AbortSignal) => Promise<{
        selection: AssistantModel;
    }>;
    /**
     * 0.2：第 5 个参数是**本次调用属于哪条路径**（'ask' 提问 / 'compact' 压缩）。
     *
     * 为什么必须区分：小助手的 /compact 只应压缩「小助手与用户对话产生的上下文」，
     * 主 agent 转移进来的那部分不得被摘要顶替（用户明确要求）。而 ask 与 compact
     * 共用本函数、且下游 compactAssistant 会把**整份** messages 送去摘要，
     * 所以唯一的隔离点就是「压缩时不把主 agent 段放进来」。
     * 省略该参数时按 'ask' 处理（保持既有调用方与测试的行为不变）。
     */
    buildMessages?: (id: string, question: string, payload: Record<string, unknown>, signal?: AbortSignal, mode?: 'ask' | 'compact') => Promise<AssistantMessage[]>;
    llm?: unknown;
    tokenMeter?: unknown;
    /** §10 调用限额：总超时与空闲超时。省略时用 llm.ts 的默认值。 */
    llmTimeouts?: {
        totalTimeoutMs?: number;
        idleTimeoutMs?: number;
    };
    toolContext?: (id: string, signal?: AbortSignal) => Promise<ToolContext>;
    saveRecord?: (id: string, record: unknown) => Promise<void>;
    /** §9.1 压缩结果落库通道。可选：未实现时压缩仍可用，只是结果不进状态。 */
    saveCompact?: (id: string, compact: {
        summary: string;
        reasoning: string;
        sourceRecordIds: string[];
        model?: unknown;
    }, signal?: AbortSignal) => Promise<void>;
    markUnread?: (id: string) => Promise<void>;
    /** §4/§8 F6：主对话归档时清理本插件为它保存的记录（复用 index.ts 已有的 forget 实现）。 */
    forget?: (id: string) => Promise<unknown>;
    /** §10：把该会话标记为已读（打开浮窗后清除未读）。 */
    markRead?: (id: string) => Promise<void>;
    selectModel?: (id: string, model: unknown, signal?: AbortSignal) => Promise<unknown>;
    /**
     * 记住浮窗的摆放位置与大小。
     *
     * 为什么需要：contracts 里早就有 `AssistantState.geometry` 字段，磁盘上也一直留着它，
     * 但**从来没有任何代码往里写** —— 于是用户每次拖好位置、关掉浮窗再打开，又回到默认位置。
     * 这是「只写了一半」的功能，不是新需求。
     */
    saveGeometry?: (id: string, geometry: unknown, signal?: AbortSignal) => Promise<unknown>;
    isSessionAllowed?: (id: string, signal?: AbortSignal) => Promise<boolean>;
    isArchived?: (id: string, signal?: AbortSignal) => Promise<boolean>;
}
export interface RouteOptions {
    service: RouteService;
    active?: Map<string, {
        requestId: string;
        controller: AbortController;
    }>;
}
type Handler = (request: Request) => Promise<Response>;
export declare function createExplainAssistantRoutes(options: RouteOptions): Map<string, Handler>;
export {};
