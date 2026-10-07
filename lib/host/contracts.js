/** Shared wire and durable contracts for dsh-explain-assistant. */
export const SCHEMA_VERSION = 1;
export class ExplainAssistantError extends Error {
    code;
    retryable;
    details;
    constructor(code, message, options = {}) {
        super(message, { cause: options.cause });
        this.name = 'ExplainAssistantError';
        this.code = code;
        this.retryable = options.retryable ?? false;
        this.details = options.details;
    }
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isModelSelection(value) {
    return isRecord(value) && typeof value.provider === 'string' && value.provider.length > 0 && typeof value.model === 'string' && value.model.length > 0 && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string');
}
export function validateSessionId(sessionId) {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId))
        throw new ExplainAssistantError('INVALID_REQUEST', '会话标识无效。');
}
export function safeSessionId(sessionId) {
    validateSessionId(sessionId);
    return sessionId;
}
export function createEmptyState(sessionId, now = new Date().toISOString()) {
    validateSessionId(sessionId);
    return { schemaVersion: SCHEMA_VERSION, sessionId, historyRevision: 0, records: [], unread: false, archived: false, createdAt: now, updatedAt: now };
}
export function assertState(value, expectedSessionId) {
    if (!isRecord(value) || typeof value.schemaVersion !== 'number' || typeof value.sessionId !== 'string' || !Array.isArray(value.records) || typeof value.historyRevision !== 'number' || typeof value.unread !== 'boolean' || typeof value.archived !== 'boolean')
        throw new ExplainAssistantError('PERSISTENCE_CORRUPT', '本地保存的小助手记录格式不正确。');
    validateSessionId(value.sessionId);
    if (expectedSessionId !== undefined && value.sessionId !== expectedSessionId)
        throw new ExplainAssistantError('PERSISTENCE_CORRUPT', '本地保存的记录属于另一个会话，已拒绝读取。');
}
export function validateEnvelope(value, expectedOperation) {
    if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || typeof value.sessionId !== 'string' || typeof value.operation !== 'string' || !('payload' in value))
        throw new ExplainAssistantError(value && isRecord(value) && value.schemaVersion !== SCHEMA_VERSION ? 'UNSUPPORTED_SCHEMA' : 'INVALID_REQUEST', '请求格式无效或版本不受支持。');
    validateSessionId(value.sessionId);
    if (!['state', 'history', 'history-result', 'models', 'select-model', 'ask', 'compact', 'cancel', 'forget', 'mark-read', 'geometry'].includes(value.operation))
        throw new ExplainAssistantError('INVALID_REQUEST', '未知的操作。');
    if (expectedOperation !== undefined && value.operation !== expectedOperation)
        throw new ExplainAssistantError('INVALID_REQUEST', '操作与请求不匹配。');
    if (value.requestId !== undefined && (typeof value.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.requestId)))
        throw new ExplainAssistantError('INVALID_REQUEST', '请求标识无效。');
}
export function toErrorBody(error, fallbackCode = 'INTERNAL_ERROR') {
    if (error instanceof ExplainAssistantError)
        return { code: error.code, message: error.message, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) };
    return { code: fallbackCode, message: '解释小助手没能完成这次操作，请稍后重试。', retryable: false };
}
export function jsonByteLength(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
