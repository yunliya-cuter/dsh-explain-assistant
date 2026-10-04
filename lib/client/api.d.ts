export type ApiErrorInfo = {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
};
export type ApiEnvelope<T> = {
    schemaVersion?: number;
    sessionId?: string;
    requestId?: string;
    operation?: string;
    payload?: T;
    error?: ApiErrorInfo;
    [key: string]: unknown;
};
export type SseEnvelope = {
    schemaVersion: number;
    sessionId: string;
    requestId: string;
    operation: 'ask' | 'compact';
    type: string;
    payload?: unknown;
    [key: string]: unknown;
};
/** Event data stays payload-compatible while envelope metadata remains available for validation/debugging. */
export type AskEvent = {
    type: string;
    data: Record<string, unknown>;
    envelope: SseEnvelope;
};
export type AssistantApi = {
    state(sessionId: string, signal?: AbortSignal): Promise<ApiEnvelope<Record<string, unknown>>>;
    models(sessionId: string, signal?: AbortSignal): Promise<ApiEnvelope<Record<string, unknown>>>;
    selectModel(sessionId: string, model: unknown, signal?: AbortSignal): Promise<ApiEnvelope<unknown>>;
    history(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<ApiEnvelope<Record<string, unknown>>>;
    historyResult(sessionId: string, recordId: string, cursor?: string, signal?: AbortSignal): Promise<ApiEnvelope<Record<string, unknown>>>;
    ask(sessionId: string, question: string, signal?: AbortSignal, evidence?: unknown[], onEvent?: (event: AskEvent) => void): Promise<void>;
    compact(sessionId: string, signal?: AbortSignal, onEvent?: (event: AskEvent) => void): Promise<void>;
    cancel(sessionId: string, requestId: string): Promise<void>;
    /** §4/§8 F6：通知宿主清理该会话（归档信号触发）。 */
    forget(sessionId: string, signal?: AbortSignal): Promise<ApiEnvelope<unknown>>;
    /** §10：把该会话标记为已读（打开浮窗后清除未读）。 */
    markRead(sessionId: string, signal?: AbortSignal): Promise<ApiEnvelope<unknown>>;
};
export declare class AssistantApiError extends Error {
    readonly code: string;
    readonly status?: number;
    readonly url: string;
    readonly raw?: unknown;
    readonly retryable?: boolean;
    constructor(message: string, options: {
        code?: string;
        status?: number;
        url: string;
        raw?: unknown;
        retryable?: boolean;
    });
}
export declare function createAssistantApi(base?: string): AssistantApi;
