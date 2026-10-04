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
    buildMessages?: (id: string, question: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<AssistantMessage[]>;
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
