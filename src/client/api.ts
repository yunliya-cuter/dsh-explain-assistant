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

export class AssistantApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly url: string;
  readonly raw?: unknown;
  readonly retryable?: boolean;
  constructor(message: string, options: { code?: string; status?: number; url: string; raw?: unknown; retryable?: boolean } ) {
    super(message);
    this.name = 'AssistantApiError';
    this.code = options.code ?? 'API_ERROR';
    this.status = options.status;
    this.url = options.url;
    this.raw = options.raw;
    this.retryable = options.retryable;
  }
}

function errorInfo(body: unknown): ApiErrorInfo | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  const error = value.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const e = error as Record<string, unknown>;
  return typeof e.message === 'string' ? {
    code: typeof e.code === 'string' ? e.code : 'API_ERROR',
    message: e.message,
    retryable: typeof e.retryable === 'boolean' ? e.retryable : undefined,
    details: e.details && typeof e.details === 'object' && !Array.isArray(e.details) ? e.details as Record<string, unknown> : undefined,
  } : undefined;
}

async function readJsonResponse(response: Response, url: string): Promise<unknown> {
  const text = await response.text().catch(error => {
    throw new AssistantApiError('Failed to read JSON response: ' + (error instanceof Error ? error.message : String(error)), { code: 'JSON_READ_FAILED', status: response.status, url, raw: error });
  });
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch (error) {
    throw new AssistantApiError('Invalid JSON response from ' + url + ': ' + text.slice(0, 512), { code: 'JSON_PARSE_FAILED', status: response.status, url, raw: text.slice(0, 4096) });
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  let response: Response;
  try { response = await fetch(url, { credentials: 'same-origin', ...init }); }
  catch (error) {
    if (error instanceof AssistantApiError) throw error;
    throw new AssistantApiError('Network request failed for ' + url + ': ' + (error instanceof Error ? error.message : String(error)), { code: 'NETWORK_ERROR', url, raw: error });
  }
  const body = await readJsonResponse(response, url);
  const info = errorInfo(body);
  if (!response.ok) throw new AssistantApiError(info?.message || ('Request failed (' + response.status + ') at ' + url), { code: info?.code ?? 'HTTP_ERROR', status: response.status, url, raw: body, retryable: info?.retryable });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AssistantApiError('Invalid JSON envelope from ' + url, { code: 'INVALID_JSON_ENVELOPE', status: response.status, url, raw: body });
  return body as ApiEnvelope<T>;
}

function query(sessionId: string): string { return encodeURIComponent(sessionId); }
function queryParam(name: string, value: string): string { return encodeURIComponent(name) + '=' + encodeURIComponent(value); }

function validateSseEnvelope(value: unknown, url: string): SseEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssistantApiError('Invalid SSE envelope from ' + url, { code: 'SSE_INVALID_ENVELOPE', url, raw: value });
  const e = value as Record<string, unknown>;
  if (typeof e.schemaVersion !== 'number' || typeof e.sessionId !== 'string' || typeof e.requestId !== 'string' || (e.operation !== 'ask' && e.operation !== 'compact') || typeof e.type !== 'string') {
    throw new AssistantApiError('Invalid SSE envelope metadata from ' + url, { code: 'SSE_INVALID_ENVELOPE', url, raw: value });
  }
  return e as SseEnvelope;
}

async function stream(url: string, expectedSessionId: string, requestBody: unknown, signal?: AbortSignal, onEvent?: (event: AskEvent) => void): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(requestBody), signal });
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw new AssistantApiError('SSE request aborted at ' + url, { code: 'ABORTED', url, raw: error });
    throw new AssistantApiError('SSE connection failed for ' + url + ': ' + (error instanceof Error ? error.message : String(error)), { code: 'SSE_CONNECTION_FAILED', url, raw: error });
  }
  if (!response.ok) {
    const body = await readJsonResponse(response, url);
    const info = errorInfo(body);
    throw new AssistantApiError(info?.message || ('SSE request failed (' + response.status + ') at ' + url), { code: info?.code ?? 'HTTP_ERROR', status: response.status, url, raw: body, retryable: info?.retryable });
  }
  if (!response.body) throw new AssistantApiError('SSE response body unavailable at ' + url, { code: 'SSE_BODY_UNAVAILABLE', status: response.status, url });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  const consume = (block: string) => {
    const lines = block.split(/\r?\n/);
    const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!type) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw || '{}'); }
    catch (error) { throw new AssistantApiError('Invalid SSE JSON at ' + url + ': ' + raw.slice(0, 512), { code: 'SSE_JSON_PARSE_FAILED', url, raw: raw.slice(0, 4096) }); }
    const envelope = validateSseEnvelope(parsed, url);
    if (envelope.sessionId !== expectedSessionId) throw new AssistantApiError('SSE session mismatch at ' + url + ': expected ' + expectedSessionId + ', received ' + envelope.sessionId, { code: 'SSE_SESSION_MISMATCH', url, raw: envelope });
    if (envelope.type !== type) throw new AssistantApiError('SSE event type mismatch at ' + url, { code: 'SSE_EVENT_MISMATCH', url, raw: envelope });
    const payload = envelope.payload;
    const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : payload === undefined ? {} : { value: payload };
    const event: AskEvent = { type, data, envelope };
    onEvent?.(event);
    if (type === 'complete' || type === 'aborted' || type === 'error') terminal = true;
    if (type === 'error' || type === 'aborted') {
      const info = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      throw new AssistantApiError(typeof info.message === 'string' ? info.message : 'SSE terminal event: ' + type, { code: typeof info.code === 'string' ? info.code : type === 'aborted' ? 'ABORTED' : 'SSE_ERROR', url, raw: envelope });
    }
  };
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) consume(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } catch (error) {
    if (error instanceof AssistantApiError) throw error;
    if (signal?.aborted) throw new AssistantApiError('SSE request aborted at ' + url, { code: 'ABORTED', url, raw: error });
    throw new AssistantApiError('SSE stream failed at ' + url + ': ' + (error instanceof Error ? error.message : String(error)), { code: 'SSE_STREAM_FAILED', url, raw: error });
  } finally { reader.releaseLock(); }
  if (!terminal) throw new AssistantApiError('SSE stream ended without a terminal event at ' + url, { code: 'SSE_TERMINAL_MISSING', url, raw: buffer.slice(0, 4096) });
}

export function createAssistantApi(base = '/api/explain-assistant'): AssistantApi {
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
    cancel: async (s, id) => { await json(base + '/in-flight?' + queryParam('sessionId', s) + '&' + queryParam('requestId', id), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, sessionId: s, requestId: id, operation: 'cancel', payload: {} }) }); }
  };
}
