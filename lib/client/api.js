class AssistantApiError extends Error {
    code;
    status;
    url;
    raw;
    retryable;
    constructor(message, options) {
        super(message);
        this.name = 'AssistantApiError';
        this.code = options.code ?? 'API_ERROR';
        this.status = options.status;
        this.url = options.url;
        this.raw = options.raw;
        this.retryable = options.retryable;
    }
}
function errorInfo(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return undefined;
    const value = body;
    const error = value.error;
    if (!error || typeof error !== 'object' || Array.isArray(error))
        return undefined;
    const e = error;
    return typeof e.message === 'string' ? {
        code: typeof e.code === 'string' ? e.code : 'API_ERROR',
        message: e.message,
        retryable: typeof e.retryable === 'boolean' ? e.retryable : undefined,
        details: e.details && typeof e.details === 'object' && !Array.isArray(e.details) ? e.details : undefined,
    } : undefined;
}
async function readJsonResponse(response, url) {
    const text = await response.text().catch(error => {
        throw new AssistantApiError('读取小助手返回的内容失败。重试一次；一直这样就刷新页面。', { code: 'JSON_READ_FAILED', status: response.status, url, raw: error });
    });
    if (!text.trim())
        return {};
    try {
        return JSON.parse(text);
    }
    catch (error) {
        // 认证中间件 / 代理的错误页返回的是 HTML：别把原文塞进用户界面。
        if (text.trim().slice(0, 1) === '<') {
            throw new AssistantApiError('接口返回的是一个网页而不是数据（HTTP ' + response.status + '）—— 多半是登录页或代理的错误页。刷新页面重新登录后再试。', { code: 'HTML_RESPONSE', status: response.status, url, raw: text.slice(0, 4096) });
        }
        throw new AssistantApiError('接口返回的内容无法解析（HTTP ' + response.status + '）。可以重试一次；一直这样请刷新页面。', { code: 'JSON_PARSE_FAILED', status: response.status, url, raw: text.slice(0, 4096) });
    }
}
async function json(url, init) {
    let response;
    try {
        response = await fetch(url, { credentials: 'same-origin', ...init });
    }
    catch (error) {
        if (error instanceof AssistantApiError)
            throw error;
        throw new AssistantApiError('连不上小助手服务：网络中断，或宿主正在重启。稍等一下再试一次；已经收到的内容不会丢。', { code: 'NETWORK_ERROR', url, raw: error });
    }
    // 401/403 是「登录态没了」，不是「接口返回了坏 JSON」：先按状态码给出可操作的中文，
    // 否则用户看到的是 Invalid JSON response ... <html>login</html> 这种英文 + HTML 片段。
    if (response.status === 401 || response.status === 403) {
        throw new AssistantApiError('登录状态已失效（HTTP ' + response.status + '）。刷新页面重新登录后再试。', { code: 'UNAUTHORIZED', status: response.status, url });
    }
    const body = await readJsonResponse(response, url);
    const info = errorInfo(body);
    if (!response.ok)
        throw new AssistantApiError(info?.message || ('小助手服务返回了错误（HTTP ' + response.status + '）。稍后重试一次。'), { code: info?.code ?? 'HTTP_ERROR', status: response.status, url, raw: body, retryable: info?.retryable });
    if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new AssistantApiError('服务返回的数据格式不对（不是小助手的数据）。刷新页面后再试。', { code: 'INVALID_JSON_ENVELOPE', status: response.status, url, raw: body });
    return body;
}
function queryParam(name, value) { return encodeURIComponent(name) + '=' + encodeURIComponent(value); }
function validateSseEnvelope(value, url) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new AssistantApiError('服务返回的流式数据格式不对。刷新页面后再试。', { code: 'SSE_INVALID_ENVELOPE', url, raw: value });
    const e = value;
    if (typeof e.schemaVersion !== 'number' || typeof e.sessionId !== 'string' || typeof e.requestId !== 'string' || (e.operation !== 'ask' && e.operation !== 'compact') || typeof e.type !== 'string') {
        throw new AssistantApiError('服务返回的流式数据缺了必要的字段（版本/会话/请求号）。刷新页面后再试。', { code: 'SSE_INVALID_ENVELOPE', url, raw: value });
    }
    return e;
}
async function stream(url, expectedSessionId, requestBody, signal, onEvent) {
    let response;
    try {
        response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(requestBody), signal });
    }
    catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError'))
            throw new AssistantApiError('这次解释已中断。', { code: 'ABORTED', url, raw: error });
        throw new AssistantApiError('连不上小助手服务：网络中断，或宿主正在重启。稍等一下再试一次；已经收到的内容不会丢。', { code: 'SSE_CONNECTION_FAILED', url, raw: error });
    }
    if (!response.ok) {
        const body = await readJsonResponse(response, url);
        const info = errorInfo(body);
        throw new AssistantApiError(info?.message || ('小助手服务返回了错误（HTTP ' + response.status + '）。稍后重试一次。'), { code: info?.code ?? 'HTTP_ERROR', status: response.status, url, raw: body, retryable: info?.retryable });
    }
    if (!response.body)
        throw new AssistantApiError('没有拿到回答内容（响应体为空），请重试一次。', { code: 'SSE_BODY_UNAVAILABLE', status: response.status, url });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let terminal = false;
    const consume = (block) => {
        const lines = block.split(/\r?\n/);
        const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        const raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!type)
            return;
        let parsed;
        try {
            parsed = JSON.parse(raw || '{}');
        }
        catch (error) {
            throw new AssistantApiError('服务返回的流式数据无法解析（可能被代理改写了）。重试一次；一直这样就刷新页面。', { code: 'SSE_JSON_PARSE_FAILED', url, raw: raw.slice(0, 4096) });
        }
        const envelope = validateSseEnvelope(parsed, url);
        if (envelope.sessionId !== expectedSessionId)
            throw new AssistantApiError('返回的内容属于另一个主对话，已丢弃（防止串记录）。刷新页面后再试。', { code: 'SSE_SESSION_MISMATCH', url, raw: envelope });
        if (envelope.type !== type)
            throw new AssistantApiError('服务返回的事件类型对不上，这次解释已停止。可以重试一次。', { code: 'SSE_EVENT_MISMATCH', url, raw: envelope });
        const payload = envelope.payload;
        const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : payload === undefined ? {} : { value: payload };
        const event = { type, data, envelope };
        onEvent?.(event);
        if (type === 'complete' || type === 'aborted' || type === 'error')
            terminal = true;
        if (type === 'error' || type === 'aborted') {
            const info = payload && typeof payload === 'object' ? payload : {};
            throw new AssistantApiError(typeof info.message === 'string' ? info.message : '这次解释在服务端结束了，但没给出原因（' + type + '）。可以再问一次。', { code: typeof info.code === 'string' ? info.code : type === 'aborted' ? 'ABORTED' : 'SSE_ERROR', url, raw: envelope });
        }
    };
    try {
        while (true) {
            const read = await reader.read();
            if (read.done)
                break;
            buffer += decoder.decode(read.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || '';
            for (const block of blocks)
                consume(block);
        }
        buffer += decoder.decode();
        if (buffer.trim())
            consume(buffer);
    }
    catch (error) {
        if (error instanceof AssistantApiError)
            throw error;
        if (signal?.aborted)
            throw new AssistantApiError('本次解释已中断。', { code: 'ABORTED', url, raw: error });
        throw new AssistantApiError('读回答的时候连接断了：' + (error instanceof Error ? error.message : String(error)) + '。上面已经收到的内容仍然保留，可以重试一次。', { code: 'SSE_STREAM_FAILED', url, raw: error });
    }
    finally {
        reader.releaseLock();
    }
    if (!terminal)
        throw new AssistantApiError('连接在回答结束前断开了（网络或代理中途掐断）。已经收到的内容保留在上面，可以重试一次。', { code: 'SSE_TERMINAL_MISSING', url, raw: buffer.slice(0, 4096) });
}
export function createAssistantApi(base = '/api/explain-assistant') {
    return {
        state: (s, signal) => json(base + '/state?' + queryParam('sessionId', s), { signal }),
        models: (s, signal) => json(base + '/models?' + queryParam('sessionId', s), { signal }),
        selectModel: (s, model, signal) => json(base + '/select-model?' + queryParam('sessionId', s), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, sessionId: s, operation: 'select-model', payload: { model } }) }),
        history: (s, cursor, signal) => json(base + '/history?' + queryParam('sessionId', s) + (cursor ? '&' + queryParam('cursor', cursor) : ''), { signal }),
        historyResult: (s, id, cursor, signal) => json(base + '/history-result?' + queryParam('sessionId', s) + '&' + queryParam('recordId', id) + (cursor ? '&' + queryParam('cursor', cursor) : ''), { signal }),
        ask: (s, q, signal, evidence, onEvent) => stream(base + '/ask', s, { schemaVersion: 1, sessionId: s, operation: 'ask', payload: { question: q, evidence } }, signal, onEvent),
        compact: (s, signal, onEvent) => stream(base + '/compact', s, { schemaVersion: 1, sessionId: s, operation: 'compact', payload: {} }, signal, onEvent),
        markRead: (s, signal) => json(base + '/mark-read?' + queryParam('sessionId', s), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, sessionId: s, operation: 'mark-read', payload: {} }) }),
        forget: (s, signal) => json(base + '/forget?' + queryParam('sessionId', s), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, sessionId: s, operation: 'forget', payload: {} }) }),
        geometry: (s, geometry, signal) => json(base + '/geometry?' + queryParam('sessionId', s), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, sessionId: s, operation: 'geometry', payload: { geometry } }) }),
        cancel: async (s, id) => { await json(base + '/in-flight?' + queryParam('sessionId', s) + '&' + queryParam('requestId', id), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, sessionId: s, requestId: id, operation: 'cancel', payload: {} }) }); }
    };
}
