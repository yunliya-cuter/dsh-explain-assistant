window.__ModuleLoader__.load({id:"dsh-explain-assistant",factory:(require)=>{var module={exports:{}};var exports=module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/entry.ts
var entry_exports = {};
__export(entry_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(entry_exports);

// src/client/store.ts
function initial(sessionId, cwd) {
  return { sessionId, cwd, open: false, unread: false, draft: "", phase: "idle", reasoning: "", text: "", tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [], occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: false, compactState: { status: "idle" }, stateReady: false };
}
var AssistantRegistry = class {
  states = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  activeSessionId;
  get(sessionId, cwd) {
    if (!this.states.has(sessionId)) this.states.set(sessionId, initial(sessionId, cwd));
    const state = this.states.get(sessionId);
    if (cwd && !state.cwd) state.cwd = cwd;
    return state;
  }
  get current() {
    return this.activeSessionId ? this.states.get(this.activeSessionId) : void 0;
  }
  get currentSessionId() {
    return this.activeSessionId;
  }
  setCurrent(sessionId) {
    if (this.activeSessionId === sessionId) {
      this.emit();
      return;
    }
    this.activeSessionId = sessionId;
    this.emit();
  }
  update(sessionId, patch) {
    const state = this.get(sessionId);
    if (typeof patch === "function") patch(state);
    else Object.assign(state, patch);
    this.emit();
  }
  open(sessionId, cwd) {
    this.get(sessionId, cwd);
    this.activeSessionId = sessionId;
    this.update(sessionId, { open: true, unread: false });
  }
  close(sessionId) {
    this.update(sessionId, { open: false });
  }
  remove(sessionId) {
    this.states.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = void 0;
    this.emit();
  }
  markUnread(sessionId) {
    this.update(sessionId, { unread: true });
  }
  sessions() {
    return [...this.states.values()];
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  snapshot() {
    return { activeSessionId: this.activeSessionId, states: this.sessions() };
  }
  emit() {
    for (const listener of this.listeners) listener();
  }
};
var assistantRegistry = new AssistantRegistry();

// src/client/api.ts
var AssistantApiError = class extends Error {
  code;
  status;
  url;
  raw;
  retryable;
  constructor(message, options) {
    super(message);
    this.name = "AssistantApiError";
    this.code = options.code ?? "API_ERROR";
    this.status = options.status;
    this.url = options.url;
    this.raw = options.raw;
    this.retryable = options.retryable;
  }
};
function errorInfo(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return void 0;
  const value = body;
  const error = value.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return void 0;
  const e = error;
  return typeof e.message === "string" ? {
    code: typeof e.code === "string" ? e.code : "API_ERROR",
    message: e.message,
    retryable: typeof e.retryable === "boolean" ? e.retryable : void 0,
    details: e.details && typeof e.details === "object" && !Array.isArray(e.details) ? e.details : void 0
  } : void 0;
}
async function readJsonResponse(response, url) {
  const text = await response.text().catch((error) => {
    throw new AssistantApiError("Failed to read JSON response: " + (error instanceof Error ? error.message : String(error)), { code: "JSON_READ_FAILED", status: response.status, url, raw: error });
  });
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    if (text.trim().slice(0, 1) === "<") {
      throw new AssistantApiError("接口返回的是一个网页而不是数据（HTTP " + response.status + "）—— 多半是登录页或代理的错误页。刷新页面重新登录后再试。", { code: "HTML_RESPONSE", status: response.status, url, raw: text.slice(0, 4096) });
    }
    throw new AssistantApiError("接口返回的内容无法解析（HTTP " + response.status + "）。可以重试一次；一直这样请刷新页面。", { code: "JSON_PARSE_FAILED", status: response.status, url, raw: text.slice(0, 4096) });
  }
}
async function json(url, init) {
  let response;
  try {
    response = await fetch(url, { credentials: "same-origin", ...init });
  } catch (error) {
    if (error instanceof AssistantApiError) throw error;
    throw new AssistantApiError("连不上本地服务（" + url + "）。宿主可能正在重启或已经退出，稍等一下再试。", { code: "NETWORK_ERROR", url, raw: error });
  }
  if (response.status === 401 || response.status === 403) {
    throw new AssistantApiError("登录状态已失效（HTTP " + response.status + "）。刷新页面重新登录后再试。", { code: "UNAUTHORIZED", status: response.status, url });
  }
  const body = await readJsonResponse(response, url);
  const info = errorInfo(body);
  if (!response.ok) throw new AssistantApiError(info?.message || "Request failed (" + response.status + ") at " + url, { code: info?.code ?? "HTTP_ERROR", status: response.status, url, raw: body, retryable: info?.retryable });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AssistantApiError("Invalid JSON envelope from " + url, { code: "INVALID_JSON_ENVELOPE", status: response.status, url, raw: body });
  return body;
}
function queryParam(name, value) {
  return encodeURIComponent(name) + "=" + encodeURIComponent(value);
}
function validateSseEnvelope(value, url) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantApiError("Invalid SSE envelope from " + url, { code: "SSE_INVALID_ENVELOPE", url, raw: value });
  const e = value;
  if (typeof e.schemaVersion !== "number" || typeof e.sessionId !== "string" || typeof e.requestId !== "string" || e.operation !== "ask" && e.operation !== "compact" || typeof e.type !== "string") {
    throw new AssistantApiError("Invalid SSE envelope metadata from " + url, { code: "SSE_INVALID_ENVELOPE", url, raw: value });
  }
  return e;
}
async function stream(url, expectedSessionId, requestBody, signal, onEvent) {
  let response;
  try {
    response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(requestBody), signal });
  } catch (error) {
    if (signal?.aborted || error instanceof DOMException && error.name === "AbortError") throw new AssistantApiError("SSE request aborted at " + url, { code: "ABORTED", url, raw: error });
    throw new AssistantApiError("SSE connection failed for " + url + ": " + (error instanceof Error ? error.message : String(error)), { code: "SSE_CONNECTION_FAILED", url, raw: error });
  }
  if (!response.ok) {
    const body = await readJsonResponse(response, url);
    const info = errorInfo(body);
    throw new AssistantApiError(info?.message || "SSE request failed (" + response.status + ") at " + url, { code: info?.code ?? "HTTP_ERROR", status: response.status, url, raw: body, retryable: info?.retryable });
  }
  if (!response.body) throw new AssistantApiError("没有拿到回答内容（响应体为空），请重试一次。", { code: "SSE_BODY_UNAVAILABLE", status: response.status, url });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  const consume = (block) => {
    const lines = block.split(/\r?\n/);
    const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const raw = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!type) return;
    let parsed;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch (error) {
      throw new AssistantApiError("Invalid SSE JSON at " + url + ": " + raw.slice(0, 512), { code: "SSE_JSON_PARSE_FAILED", url, raw: raw.slice(0, 4096) });
    }
    const envelope = validateSseEnvelope(parsed, url);
    if (envelope.sessionId !== expectedSessionId) throw new AssistantApiError("SSE session mismatch at " + url + ": expected " + expectedSessionId + ", received " + envelope.sessionId, { code: "SSE_SESSION_MISMATCH", url, raw: envelope });
    if (envelope.type !== type) throw new AssistantApiError("SSE event type mismatch at " + url, { code: "SSE_EVENT_MISMATCH", url, raw: envelope });
    const payload = envelope.payload;
    const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : payload === void 0 ? {} : { value: payload };
    const event = { type, data, envelope };
    onEvent?.(event);
    if (type === "complete" || type === "aborted" || type === "error") terminal = true;
    if (type === "error" || type === "aborted") {
      const info = payload && typeof payload === "object" ? payload : {};
      throw new AssistantApiError(typeof info.message === "string" ? info.message : "SSE terminal event: " + type, { code: typeof info.code === "string" ? info.code : type === "aborted" ? "ABORTED" : "SSE_ERROR", url, raw: envelope });
    }
  };
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) consume(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } catch (error) {
    if (error instanceof AssistantApiError) throw error;
    if (signal?.aborted) throw new AssistantApiError("本次解释已中断。", { code: "ABORTED", url, raw: error });
    throw new AssistantApiError("读回答的时候连接断了：" + (error instanceof Error ? error.message : String(error)) + "。上面已经收到的内容仍然保留，可以重试一次。", { code: "SSE_STREAM_FAILED", url, raw: error });
  } finally {
    reader.releaseLock();
  }
  if (!terminal) throw new AssistantApiError("连接在回答结束前断开了（网络或代理中途掐断）。已经收到的内容保留在上面，可以重试一次。", { code: "SSE_TERMINAL_MISSING", url, raw: buffer.slice(0, 4096) });
}
function createAssistantApi(base = "/api/explain-assistant") {
  return {
    state: (s, signal) => json(base + "/state?" + queryParam("sessionId", s), { signal }),
    models: (s, signal) => json(base + "/models?" + queryParam("sessionId", s), { signal }),
    selectModel: (s, model, signal) => json(base + "/select-model?" + queryParam("sessionId", s), { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, sessionId: s, operation: "select-model", payload: { model } }) }),
    history: (s, cursor, signal) => json(base + "/history?" + queryParam("sessionId", s) + (cursor ? "&" + queryParam("cursor", cursor) : ""), { signal }),
    historyResult: (s, id, cursor, signal) => json(base + "/history-result?" + queryParam("sessionId", s) + "&" + queryParam("recordId", id) + (cursor ? "&" + queryParam("cursor", cursor) : ""), { signal }),
    ask: (s, q, signal, evidence, onEvent) => stream(base + "/ask", s, { schemaVersion: 1, sessionId: s, operation: "ask", payload: { question: q, evidence } }, signal, onEvent),
    compact: (s, signal, onEvent) => stream(base + "/compact", s, { schemaVersion: 1, sessionId: s, operation: "compact", payload: {} }, signal, onEvent),
    markRead: (s, signal) => json(base + "/mark-read?" + queryParam("sessionId", s), { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, sessionId: s, operation: "mark-read", payload: {} }) }),
    forget: (s, signal) => json(base + "/forget?" + queryParam("sessionId", s), { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, sessionId: s, operation: "forget", payload: {} }) }),
    geometry: (s, geometry, signal) => json(base + "/geometry?" + queryParam("sessionId", s), { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, sessionId: s, operation: "geometry", payload: { geometry } }) }),
    cancel: async (s, id) => {
      await json(base + "/in-flight?" + queryParam("sessionId", s) + "&" + queryParam("requestId", id), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, sessionId: s, requestId: id, operation: "cancel", payload: {} }) });
    }
  };
}

// src/client/index.ts
var EVENT_TYPES = /* @__PURE__ */ new Set(["start", "progress", "reasoning", "text", "tool_start", "tool_result", "usage", "complete", "error", "aborted"]);
function isAbortLike(error, signal, terminal) {
  if (signal?.aborted) return true;
  if (error?.name === "AbortError") return true;
  if (terminal === "aborted") return true;
  return error?.code === "ABORTED";
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function eventParts(event) {
  if (!event || typeof event.type !== "string" || !EVENT_TYPES.has(event.type) || !isObject(event.data)) return void 0;
  const root = event.data;
  const payload = isObject(root.payload) ? root.payload : root;
  return {
    sessionId: typeof root.sessionId === "string" ? root.sessionId : void 0,
    requestId: typeof root.requestId === "string" ? root.requestId : void 0,
    payload
  };
}
function newRecordId(requestId) {
  return requestId || "helper-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}
function phaseBusy(state) {
  return state.phase === "connecting" || state.phase === "running";
}
function createClientPlugin(options = {}) {
  const api = options.api || createAssistantApi();
  const active = /* @__PURE__ */ new Map();
  let disposed = false;
  let selectedSession;
  const session = () => selectedSession || (typeof options.session === "function" ? options.session() : options.session);
  const isCurrent = (request) => !disposed && active.get(request.sessionId)?.token === request.token;
  const terminalEvent = /* @__PURE__ */ new Map();
  const appendRecord = (request, status, answer) => {
    if (request.recorded || request.kind !== "ask") return;
    request.recorded = true;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    assistantRegistry.update(request.sessionId, (current) => {
      const recordId = newRecordId(request.requestId);
      if (current.records.some((record) => record.id === recordId)) return;
      current.liveRecordId = recordId;
      current.records = [...current.records, {
        id: recordId,
        question: request.question,
        answer: answer ?? current.text,
        reasoning: current.reasoning,
        status,
        createdAt: request.startedAt,
        completedAt: status === "complete" ? now : void 0,
        tools: current.tools,
        incomplete: status !== "complete"
      }];
    });
  };
  const applyEvent = (request, event) => {
    const parts = eventParts(event);
    if (!parts || !isCurrent(request)) return;
    if (parts.sessionId && parts.sessionId !== request.sessionId) return;
    const state = assistantRegistry.get(request.sessionId);
    if (state.archived === true) return;
    if (parts.requestId && state.requestId && parts.requestId !== state.requestId) return;
    const data = parts.payload;
    if (event.type === "start") {
      const requestId = parts.requestId || (typeof data.requestId === "string" ? data.requestId : void 0);
      request.requestId = requestId;
      assistantRegistry.update(request.sessionId, { phase: "running", requestId });
      return;
    }
    if (event.type === "reasoning") {
      assistantRegistry.update(request.sessionId, (current) => {
        current.phase = "running";
        if (typeof data.delta === "string") current.reasoning += data.delta;
      });
      return;
    }
    if (event.type === "text") {
      assistantRegistry.update(request.sessionId, (current) => {
        current.phase = "running";
        if (typeof data.delta === "string") current.text += data.delta;
      });
      return;
    }
    if (event.type === "tool_start") {
      const name = String(data.tool || data.name || "tool");
      assistantRegistry.update(request.sessionId, (current) => {
        const id = String(data.toolCallId || data.id || name + "-" + current.tools.length);
        current.tools = [...current.tools, { id, name, label: typeof data.label === "string" ? data.label : void 0, status: "running" }];
      });
      return;
    }
    if (event.type === "tool_result") {
      assistantRegistry.update(request.sessionId, (current) => {
        const id = typeof data.toolCallId === "string" || typeof data.id === "string" ? String(data.toolCallId || data.id) : void 0;
        let index = id ? current.tools.findIndex((tool) => tool.id === id) : -1;
        if (index < 0 && typeof data.tool === "string") index = current.tools.map((tool) => tool.name).lastIndexOf(data.tool);
        if (index < 0) index = current.tools.findIndex((tool) => tool.status === "running");
        const failed = data.ok === false || isObject(data.result) && data.result.ok === false;
        const detail = typeof data.message === "string" ? data.message : isObject(data.result) && typeof data.result.message === "string" ? String(data.result.message) : void 0;
        if (index >= 0) current.tools = current.tools.map((tool, toolIndex) => toolIndex === index ? { ...tool, status: failed ? "error" : "ok", result: data.result, detail } : tool);
      });
      return;
    }
    if (event.type === "usage") {
      const percent = typeof data.percent === "number" ? data.percent : isObject(data.usage) && typeof data.usage.percent === "number" ? data.usage.percent : void 0;
      if (percent !== void 0) assistantRegistry.update(request.sessionId, { occupancy: percent, occupancyKnown: true });
      return;
    }
    if (event.type === "complete") {
      const answer = typeof data.text === "string" ? data.text : void 0;
      const summary = typeof data.summary === "string" ? data.summary : void 0;
      assistantRegistry.update(request.sessionId, (current) => {
        if (request.kind === "compact") {
          if (summary) current.compactState = { ...current.compactState, summary, status: "complete", updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
          else current.compactState = { ...current.compactState, status: "error", error: "模型没有返回可用的摘要内容。" };
        } else {
          if (answer && !current.text) current.text = answer;
        }
        current.phase = "complete";
        current.requestId = void 0;
        current.unread = !current.open;
      });
      appendRecord(request, "complete", answer);
      void refreshState(request.sessionId);
      return;
    }
    if (event.type === "aborted") {
      terminalEvent.set(request.sessionId, "aborted");
      const message = typeof data.message === "string" ? data.message : "请求已中断";
      assistantRegistry.update(request.sessionId, (current) => {
        current.phase = "interrupted";
        current.requestId = void 0;
        current.error = message;
        current.unread = !current.open;
        if (request.kind === "compact") current.compactState = { ...current.compactState, status: "interrupted", error: message };
      });
      appendRecord(request, "interrupted");
      return;
    }
    if (event.type === "error") {
      terminalEvent.set(request.sessionId, "error");
      const message = typeof data.message === "string" ? data.message : "请求失败";
      assistantRegistry.update(request.sessionId, (current) => {
        current.phase = "error";
        current.requestId = void 0;
        current.error = message;
        current.unread = !current.open;
        if (request.kind === "compact") current.compactState = { ...current.compactState, status: "error", error: message };
      });
      appendRecord(request, "interrupted");
    }
  };
  const callApi = (invoke) => {
    try {
      return Promise.resolve(invoke());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  let everOpenedSeq = 0;
  const lastOpenedSeq = /* @__PURE__ */ new Map();
  const hostKnownIds = /* @__PURE__ */ new Map();
  const hostIdsFor = (sessionId) => {
    let set = hostKnownIds.get(sessionId);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      hostKnownIds.set(sessionId, set);
    }
    return set;
  };
  const totalRecordsFor = (payload) => {
    const value = payload.totalRecords;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
  };
  const hostLoadedCount = (sessionId, records) => {
    const known = hostKnownIds.get(sessionId);
    if (!known || known.size === 0) return 0;
    return records.filter((record) => known.has(record?.id)).length;
  };
  const STATE_TIMEOUT_MS = typeof options.stateTimeoutMs === "number" && Number.isFinite(options.stateTimeoutMs) && options.stateTimeoutMs > 0 ? options.stateTimeoutMs : 15e3;
  const READ_TIMEOUT_MS = typeof options.readTimeoutMs === "number" && Number.isFinite(options.readTimeoutMs) && options.readTimeoutMs > 0 ? options.readTimeoutMs : 1e4;
  const withReadTimeout = (task, what) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("读取" + what + "超时（等了 " + Math.round(READ_TIMEOUT_MS / 1e3) + " 秒没有回应）。可以再点一次重试。")), READ_TIMEOUT_MS);
      timer.unref?.();
    });
    return Promise.race([task, timeout]).finally(() => {
      if (timer !== void 0) clearTimeout(timer);
    });
  };
  const withStateTimeout = (task, onTimeout) => new Promise((resolve, reject) => {
    const waited = STATE_TIMEOUT_MS >= 1e3 ? Math.round(STATE_TIMEOUT_MS / 1e3) + " 秒" : STATE_TIMEOUT_MS + " 毫秒";
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
      }
      reject(new Error("读取小助手状态超时（等了 " + waited + "没有回应）。宿主可能正忙，可以点「重试」再试一次。"));
    }, STATE_TIMEOUT_MS);
    timer.unref?.();
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
  const applyStateFailure = (sessionId, error) => {
    if (disposed) return;
    assistantRegistry.update(sessionId, {
      stateReady: true,
      stateError: "没有读到这个小助手的当前状态：" + errorMessage(error) + " 下面的模型列表、历史与占用都还没有取到，请稍后重试。"
    });
  };
  const inFlightState = /* @__PURE__ */ new Map();
  const retryState = (sessionId) => {
    const target = sessionId || session()?.id;
    if (!target) return Promise.resolve();
    return refreshState(target);
  };
  const ensureState = (sessionId) => {
    const target = sessionId || session()?.id;
    if (disposed || !target) return Promise.resolve();
    if (assistantRegistry.get(target).stateReady !== false) return Promise.resolve();
    const flying = inFlightState.get(target);
    if (flying) return flying;
    return refreshState(target);
  };
  const occupancyRefreshTimers = /* @__PURE__ */ new Map();
  const occupancyRefreshAttempts = /* @__PURE__ */ new Map();
  const scheduleOccupancyRefresh = (sessionId) => {
    if (disposed || occupancyRefreshTimers.has(sessionId)) return;
    const used = occupancyRefreshAttempts.get(sessionId) ?? 0;
    if (used >= (options.occupancyRetryMax ?? 2)) return;
    occupancyRefreshAttempts.set(sessionId, used + 1);
    const timer = setTimeout(() => {
      occupancyRefreshTimers.delete(sessionId);
      const state = assistantRegistry.get(sessionId);
      if (disposed || !state?.open || state.occupancyKnown) return;
      void refreshState(sessionId, { keepCleared: true }).catch(() => void 0);
    }, options.occupancyRetryDelayMs ?? 3e3);
    occupancyRefreshTimers.set(sessionId, timer);
  };
  const refreshState = (sessionId, options2) => {
    const controller = new AbortController();
    const task = withStateTimeout(callApi(() => api.state(sessionId, controller.signal)), () => controller.abort()).then((result) => {
      if (disposed) return;
      if (assistantRegistry.get(sessionId).archived === true) return;
      const payload = isObject(result.payload) ? result.payload : {};
      const current = assistantRegistry.get(sessionId);
      const catalog = isObject(payload.catalog) ? payload.catalog : void 0;
      const compactState = isObject(payload.compactState) ? payload.compactState : void 0;
      const incoming = Array.isArray(payload.records) ? payload.records : [];
      const incomingIds = new Set(incoming.map((record) => record?.id));
      const keptEarlier = current.records.filter((record) => !incomingIds.has(record?.id));
      const known = hostIdsFor(sessionId);
      for (const record of incoming) {
        if (record?.id) known.add(record.id);
      }
      const mergedRecords = active.has(sessionId) ? current.records : incoming.length ? [...keptEarlier, ...incoming] : current.records;
      const totalRecords = totalRecordsFor(payload);
      const loadedFromHost = hostLoadedCount(sessionId, mergedRecords);
      const remaining = totalRecords === void 0 ? void 0 : Math.max(0, totalRecords - loadedFromHost);
      const stillHasEarlier = remaining === void 0 ? Boolean(payload.hasEarlier) : remaining > 0;
      const nextCursor = remaining === void 0 ? typeof payload.historyCursor === "string" ? payload.historyCursor : void 0 : remaining > 0 ? String(remaining) : void 0;
      const hostGeometryPatch = (() => {
        const hostGeometry = payload.geometry;
        if (pendingGeometry.has(sessionId)) return {};
        if (!isObject(hostGeometry)) return {};
        const keys = ["x", "y", "width", "height"];
        if (!keys.every((key) => typeof hostGeometry[key] === "number")) return {};
        return { geometry: hostGeometry };
      })();
      const patch = {
        records: mergedRecords,
        hasEarlier: stillHasEarlier,
        historyCursor: nextCursor,
        // H-7：记录文件损坏被宿主隔离过 —— 原样带到界面（见 overlay 的说明条）。
        recoveredCorrupt: payload.recoveredCorrupt === true,
        // ── 「宿主响应不得覆盖更新的本地状态」同类排查（本次）────────────────
        // 下面两个字段原先都是**无条件覆盖**，实测有两种「倒退」：
        //
        // §7 model：宿主没下发 model 时（例如用户刚点选、宿主还没落库；或这次读取拿不到），
        //   旧写法把 model 写成 undefined —— 用户刚选的模型**从界面上消失**，看起来像没选上。
        //   修法：只在宿主**确实给了** model 时采纳。宿主没有 ≠ 用户没选。
        //   （将来若要支持「清除已选模型」，必须做成显式动作，不能靠「字段缺失」表达。）
        ...payload.model ? { model: payload.model } : {},
        //
        // §9.2 占用：回答**进行中**时，本地从 usage 事件学到的占用比宿主那份
        //   （基于落库记录的估算）**更新**。旧写法无条件覆盖 → 刷新一次就把已知占用改回「未知」，
        //   界面圆环在回答过程中熄灭。修法：与 records 同一套守卫 —— 有活动请求时保留本地。
        ...active.has(sessionId) ? {} : {
          occupancy: typeof payload.occupancy === "number" ? payload.occupancy : void 0,
          occupancyKnown: typeof payload.occupancy === "number",
          occupancyEstimated: payload.occupancyEstimated === true,
          // 0.2：两块构成。与 occupancy 用**同一套守卫**（有活动请求时保留本地），
          // 否则回答进行中的一次刷新会把悬停提示清掉。
          occupancyParts: isObject(payload.occupancyParts) ? payload.occupancyParts : void 0
        },
        ...hostGeometryPatch,
        ...catalog ? { catalog } : {},
        // 只在宿主确实给了摘要时覆盖本地状态：正在压缩时不能用旧的落库值盖掉「压缩中」。
        //
        // 宿主的 compactState 是**落库结构**，没有 status 字段（§9.1：只有压缩成功才落库）。
        // 早前这里整份覆盖，导致 status 变 undefined，浮窗把「压缩成功」渲染成「压缩已中断」——
        // 摘要正文明明就在下面。所以这里补回语义：有 summary 即 complete。
        // C2（§9.1「失败清楚提示」）：本次压缩刚失败/中断时，宿主的落库值仍是**上一次成功**的摘要。
        // 若无条件合并，界面会把这次的失败盖成「已压缩」——用户以为成功了，其实没有。
        // 因此：running / error / interrupted 三种进行中或失败态一律保留本地状态，只由新的成功结果改写。
        // §9.1/S1：初次打开（本地还是 idle）或本地已是 complete 时，采用宿主下发的摘要。
        //
        // 旧条件写的是「本地有 status 且不是 complete 才保留本地」，而 store.ts 的初始值恒为
        // { status: 'idle' } —— idle 不是 complete，于是**宿主明明下发了摘要，刷新页面后却被丢成 idle**，
        // 界面回到「没有压缩过」。这正是「压缩结果看不见」在刷新路径上的翻版。
        // 只有本地处于 running / error / interrupted（本次刚发生的状态）才保留本地。
        ...compactState ? {
          compactState: current.compactState && (current.compactState.status === "running" || current.compactState.status === "error" || current.compactState.status === "interrupted") ? current.compactState : {
            ...compactState,
            status: typeof compactState.summary === "string" && compactState.summary ? "complete" : "error",
            // 宿主落库的结构里没有这两个**客户端本地**字段（压缩前占用）。
            // 不显式搬过来的话，压缩成功后紧接着的这次 refreshState 会把它们冲掉，
            // 于是"压缩前 62% → 现在 38%"永远只剩右边一半。
            beforeOccupancy: current.compactState?.beforeOccupancy,
            beforeOccupancyEstimated: current.compactState?.beforeOccupancyEstimated
          }
        } : {},
        // §10/S4：未读是宿主侧的真相（markUnread 落库），刷新后必须恢复，否则徽标消失。
        //
        // 但 §10「打开浮窗后清除」优先：紧随「打开」的那一次刷新**不得**把宿主仍是 true 的值写回来
        // （宿主标记已读可能失败，那时本地清除仍应生效，否则徽标清除后立刻又亮 = 闪烁）。
        // 用**单次标志**而不是持久集合：抑制只针对这次打开引发的刷新，
        // 之后的刷新（例如回答完成后）恢复「宿主为准」，不会把未读永久压住。
        ...typeof payload.unread === "boolean" && !(options2?.keepCleared === true && payload.unread === true) ? { unread: payload.unread } : {},
        // ── 「已就绪」：**成功结局**的置位点。──────────────────────────────────
        // 与上面那批字段写在**同一次** assistantRegistry.update 里，这一点是有意的：
        // 数据与「就绪」必须是一次原子更新，界面才不会出现「已就绪但数据还没写进去」的中间态
        // ——那正是「一次到位」要保证的：要么加载页，要么正常界面，不许有第三种。
        stateReady: true,
        // 成功读到状态 → 上一次的失败原因作废，否则界面会一直显示早已恢复的错误。
        stateError: void 0
      };
      assistantRegistry.update(sessionId, patch);
      if (payload.occupancyPending === true && !active.has(sessionId)) scheduleOccupancyRefresh(sessionId);
    }).catch((error) => {
      applyStateFailure(sessionId, error);
    });
    inFlightState.set(sessionId, task);
    void task.finally(() => {
      if (inFlightState.get(sessionId) === task) inFlightState.delete(sessionId);
    });
    return task;
  };
  const primedUnread = /* @__PURE__ */ new Map();
  const primeUnread = (sessionId) => {
    if (disposed || !sessionId) return Promise.resolve();
    const existing = primedUnread.get(sessionId);
    if (existing) return existing;
    const issuedSeq = everOpenedSeq;
    const task = callApi(() => api.state(sessionId)).then((result) => {
      if (disposed) return;
      const payload = isObject(result.payload) ? result.payload : {};
      if (typeof payload.unread !== "boolean") return;
      if (payload.unread === true && (lastOpenedSeq.get(sessionId) ?? 0) > issuedSeq) return;
      assistantRegistry.update(sessionId, { unread: payload.unread });
    }).catch(() => {
    });
    primedUnread.set(sessionId, task);
    return task;
  };
  const clearUnreadOnHost = (sessionId) => {
    void callApi(() => api.markRead(sessionId)).catch((error) => {
      console.error("[dsh-explain-assistant] 清除未读失败（" + sessionId + "）：", errorMessage(error));
    });
    return refreshState(sessionId, { keepCleared: true }).catch(() => void 0);
  };
  const open = () => {
    if (disposed) return;
    const current = session();
    if (!current) return;
    const sessionId = current.id;
    lastOpenedSeq.set(sessionId, ++everOpenedSeq);
    occupancyRefreshAttempts.delete(sessionId);
    assistantRegistry.open(sessionId, current.cwd);
    void clearUnreadOnHost(sessionId);
  };
  const run = (question, kind) => {
    if (disposed) return Promise.reject(new Error("解释小助手已关闭"));
    const current = session();
    if (!current) return Promise.reject(new Error("当前没有主对话"));
    const sessionId = current.id;
    if (active.has(sessionId) || phaseBusy(assistantRegistry.get(sessionId))) return Promise.reject(new Error("已有解释请求正在处理中"));
    const request = { token: /* @__PURE__ */ Symbol("explain-request"), controller: new AbortController(), sessionId, question, kind, startedAt: (/* @__PURE__ */ new Date()).toISOString(), recorded: false, stoppedByUser: false };
    active.set(sessionId, request);
    const state = assistantRegistry.get(sessionId, current.cwd);
    const evidence = state.evidence.slice();
    const usedPickKeys = new Set(evidence.map((item) => String(item?.pickId || item?.id || "")).filter(Boolean));
    assistantRegistry.update(sessionId, { draft: "", phase: "connecting", reasoning: "", text: "", tools: [], error: void 0, unread: false, question: kind === "ask" ? question : void 0, liveRecordId: void 0, ...kind === "compact" ? {
      compactState: {
        status: "running",
        // 压缩前的占用要**在发起这一刻**记下来：压缩完了再去问就只剩"现在"了。
        beforeOccupancy: state.occupancyKnown && typeof state.occupancy === "number" ? state.occupancy : void 0,
        beforeOccupancyEstimated: state.occupancyEstimated === true
      }
    } : {} });
    const onEvent = (event) => applyEvent(request, event);
    const task = callApi(() => kind === "compact" ? api.compact(sessionId, request.controller.signal, onEvent) : api.ask(sessionId, question, request.controller.signal, evidence, onEvent));
    return task.catch((error) => {
      if (isCurrent(request)) {
        const lastTerminal = terminalEvent.get(sessionId);
        terminalEvent.delete(sessionId);
        const aborted = isAbortLike(error, request.controller.signal, lastTerminal);
        const byUser = request.stoppedByUser === true;
        const message = byUser ? void 0 : aborted && !request.controller.signal.aborted ? errorMessage(error) : aborted ? "请求已中断" : errorMessage(error);
        assistantRegistry.update(sessionId, (current2) => {
          current2.phase = aborted ? "interrupted" : "error";
          current2.requestId = void 0;
          current2.unread = !current2.open;
          if (message !== void 0) current2.error = message;
          if (request.kind === "compact") current2.compactState = { ...current2.compactState, status: aborted ? "interrupted" : "error", ...message !== void 0 ? { error: message } : {} };
        });
        if (aborted) appendRecord(request, "interrupted");
      }
    }).finally(() => {
      if (active.get(sessionId)?.token === request.token) active.delete(sessionId);
      if (request.kind === "ask" && usedPickKeys.size) {
        const latest = assistantRegistry.get(sessionId);
        if (latest.phase !== "error" && latest.phase !== "interrupted") {
          assistantRegistry.update(sessionId, (current2) => {
            const kept = current2.evidence.filter((item) => !usedPickKeys.has(String(item?.pickId || item?.id || "")));
            if (kept.length !== current2.evidence.length) current2.evidence = kept;
          });
        }
      }
    });
  };
  const submit = (question) => {
    const value = question.trim();
    if (!value) return Promise.resolve();
    return run(value, value === "/compact" ? "compact" : "ask");
  };
  const loadEarlier = async () => {
    if (disposed) return;
    const current = session();
    if (!current) return;
    const state = assistantRegistry.get(current.id, current.cwd);
    if (state.loadingEarlier) return;
    assistantRegistry.update(current.id, { loadingEarlier: true });
    try {
      const cursor = assistantRegistry.get(current.id).historyCursor;
      const result = await withReadTimeout(callApi(() => api.history(current.id, cursor)), "更早的历史");
      if (disposed) return;
      const payload = isObject(result.payload) ? result.payload : {};
      const older = Array.isArray(payload.records) ? payload.records : [];
      const known = hostIdsFor(current.id);
      for (const record of older) {
        if (record?.id) known.add(record.id);
      }
      const existing = assistantRegistry.get(current.id).records;
      const existingIds = new Set(existing.map((record) => record?.id));
      const fresh = older.filter((record) => record?.id && !existingIds.has(record.id));
      const merged = [...fresh, ...existing];
      const loadedFromHost = hostLoadedCount(current.id, merged);
      assistantRegistry.update(current.id, {
        records: merged,
        // 有 totalRecords 时以「剩余量」为准（与 refreshState 同一套算法），否则沿用宿主字段。
        ...totalRecordsFor(payload) === void 0 ? { hasEarlier: Boolean(payload.hasEarlier) } : { hasEarlier: Math.max(0, totalRecordsFor(payload) - loadedFromHost) > 0 },
        // 游标必须**显式赋值**（包含赋 undefined）：到底时若不写，就会保留上一次的旧游标。
        // 旧实现是「有 cursor 才写」，于是翻到底后 historyCursor 仍是已加载过的那一页的游标 ——
        // 一旦某条路径再触发一次翻页，就会把那一页重新取回来（重复渲染）。
        historyCursor: totalRecordsFor(payload) === void 0 ? typeof payload.cursor === "string" ? payload.cursor : void 0 : (() => {
          const rem = Math.max(0, totalRecordsFor(payload) - loadedFromHost);
          return rem > 0 ? String(rem) : void 0;
        })(),
        loadingEarlier: false,
        // 错误属于上一次操作：这一次成功了就必须清掉，否则顶部会一直挂着「读取失败」。
        error: void 0
      });
    } catch (error) {
      if (!disposed) assistantRegistry.update(current.id, { loadingEarlier: false, error: errorMessage(error) });
    }
  };
  const openHistoryDetail = async (recordId) => {
    if (disposed) return;
    const current = session();
    if (!current) return;
    const id = current.id;
    if (!recordId) return;
    assistantRegistry.update(id, { historyDetail: { recordId, status: "loading", hasEarlier: false, loadingMore: false } });
    try {
      const result = await withReadTimeout(callApi(() => api.historyResult(id, recordId)), "这条记录的完整内容");
      if (disposed) return;
      if (assistantRegistry.get(id).historyDetail?.recordId !== recordId) return;
      const payload = isObject(result.payload) ? result.payload : {};
      const record = isObject(payload.record) ? payload.record : void 0;
      const counts = isObject(payload.counts) ? payload.counts : void 0;
      if (typeof payload.sessionId === "string" && payload.sessionId !== id) {
        assistantRegistry.update(id, { historyDetail: { recordId, status: "error", hasEarlier: false, loadingMore: false, error: "这份记录属于另一个主对话，已拒绝显示。" } });
        return;
      }
      assistantRegistry.update(id, {
        historyDetail: {
          recordId,
          status: record ? "ready" : "error",
          record,
          counts,
          cursor: typeof payload.cursor === "string" ? payload.cursor : null,
          hasEarlier: payload.hasEarlier === true,
          loadingMore: false,
          ...record ? {} : { error: "服务端没有返回这条记录的内容。" }
        }
      });
    } catch (error) {
      if (!disposed && assistantRegistry.get(id).historyDetail?.recordId === recordId) {
        assistantRegistry.update(id, { historyDetail: { recordId, status: "error", hasEarlier: false, loadingMore: false, error: errorMessage(error) } });
      }
    }
  };
  const loadMoreHistoryDetail = async () => {
    if (disposed) return;
    const current = session();
    if (!current) return;
    const id = current.id;
    const detail = assistantRegistry.get(id).historyDetail;
    if (!detail || !detail.hasEarlier || detail.loadingMore) return;
    const cursor = detail.cursor;
    assistantRegistry.update(id, { historyDetail: { ...detail, loadingMore: true, error: void 0 } });
    try {
      const result = await withReadTimeout(callApi(() => api.historyResult(id, detail.recordId, cursor ?? void 0)), "这条记录的下一页");
      if (disposed) return;
      const payload = isObject(result.payload) ? result.payload : {};
      const record = isObject(payload.record) ? payload.record : {};
      const latest = assistantRegistry.get(id).historyDetail || detail;
      const previous = isObject(latest.record) ? latest.record : {};
      const merge = (key) => {
        const before = Array.isArray(previous[key]) ? previous[key] : [];
        const added = Array.isArray(record[key]) ? record[key] : [];
        const seen = new Set(before.map((item) => isObject(item) ? item.id : void 0).filter((id2) => id2 !== void 0));
        const fresh = added.filter((item) => {
          const id2 = isObject(item) ? item.id : void 0;
          if (id2 === void 0) return true;
          if (seen.has(id2)) return false;
          seen.add(id2);
          return true;
        });
        return [...before, ...fresh];
      };
      assistantRegistry.update(id, {
        historyDetail: {
          ...latest,
          status: "ready",
          record: { ...previous, ...record, evidence: merge("evidence"), tools: merge("tools"), images: merge("images") },
          cursor: typeof payload.cursor === "string" ? payload.cursor : null,
          hasEarlier: payload.hasEarlier === true,
          loadingMore: false
        }
      });
    } catch (error) {
      if (!disposed) {
        const latest = assistantRegistry.get(id).historyDetail || detail;
        assistantRegistry.update(id, { historyDetail: { ...latest, loadingMore: false, error: errorMessage(error) } });
      }
    }
  };
  const closeHistoryDetail = () => {
    const current = session();
    if (!current) return;
    assistantRegistry.update(current.id, { historyDetail: void 0 });
  };
  const forget = async (sessionId) => {
    if (disposed) return;
    if (!sessionId) return;
    const running = active.get(sessionId);
    if (running) {
      running.stoppedByUser = true;
      running.controller.abort();
      active.delete(sessionId);
    }
    try {
      await api.forget(sessionId);
      assistantRegistry.update(sessionId, { records: [], compactState: void 0, unread: false, archived: true, question: void 0, liveRecordId: void 0, text: "", reasoning: "", tools: [], evidence: [], historyDetail: void 0, error: void 0 });
    } catch (error) {
      console.error("[dsh-explain-assistant] 归档清理请求失败（" + sessionId + "）：", errorMessage(error));
    }
  };
  const cancel = () => {
    const current = session();
    if (!current) return;
    const request = active.get(current.id);
    if (!request) return;
    request.stoppedByUser = true;
    request.controller.abort();
    const cancelId = request.requestId;
    if (cancelId) void callApi(() => api.cancel(request.sessionId, cancelId)).catch(() => void 0);
    assistantRegistry.update(request.sessionId, { phase: "interrupted", requestId: void 0, error: "已按你的要求停止本次解释" });
    appendRecord(request, "interrupted");
  };
  const close = () => {
    const current = session();
    if (!current) return;
    assistantRegistry.close(current.id);
    void callApi(() => api.markRead(current.id)).catch(() => void 0);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const request of active.values()) {
      request.controller.abort();
      const cancelId = request.requestId;
      if (cancelId) void callApi(() => api.cancel(request.sessionId, cancelId)).catch(() => void 0);
    }
    active.clear();
    for (const sessionId of [...pendingGeometry.keys()]) flushGeometry(sessionId);
    for (const timer of occupancyRefreshTimers.values()) clearTimeout(timer);
    occupancyRefreshTimers.clear();
    occupancyRefreshAttempts.clear();
    assistantRegistry.sessions().forEach((state) => {
      if (state.open) assistantRegistry.close(state.sessionId);
    });
    assistantRegistry.setCurrent(void 0);
  };
  const geometryTimers = /* @__PURE__ */ new Map();
  const pendingGeometry = /* @__PURE__ */ new Map();
  const flushGeometry = (sessionId) => {
    const timer = geometryTimers.get(sessionId);
    if (timer !== void 0) {
      clearTimeout(timer);
      geometryTimers.delete(sessionId);
    }
    const geometry = pendingGeometry.get(sessionId);
    if (!geometry) return;
    pendingGeometry.delete(sessionId);
    void callApi(() => api.geometry(sessionId, geometry)).catch((error) => {
      console.error("[dsh-explain-assistant] 记住浮窗位置失败（" + sessionId + "）：", errorMessage(error));
    });
  };
  const saveGeometry = (sessionId, geometry) => {
    if (disposed || !sessionId) return;
    if (!geometry || !["x", "y", "width", "height"].every((key) => typeof geometry[key] === "number" && Number.isFinite(geometry[key]))) return;
    pendingGeometry.set(sessionId, geometry);
    const existing = geometryTimers.get(sessionId);
    if (existing !== void 0) clearTimeout(existing);
    geometryTimers.set(sessionId, setTimeout(() => flushGeometry(sessionId), 400));
  };
  const setSession = (id, cwd) => {
    const previous = selectedSession?.id;
    selectedSession = id ? { id, cwd } : void 0;
    assistantRegistry.setCurrent(id);
    if (!previous || previous === id) return;
    const before = assistantRegistry.get(previous);
    if (before.open !== true) return;
    assistantRegistry.update(previous, { open: false });
    if (!id) return;
    assistantRegistry.update(id, { open: true });
  };
  return { api, registry: assistantRegistry, open, close, submit, loadEarlier, cancel, dispose, setSession, openHistoryDetail, loadMoreHistoryDetail, closeHistoryDetail, forget, primeUnread, saveGeometry, retryState, ensureState };
}

// src/client/window.ts
var MIN_WIDTH = 360;
var MIN_HEIGHT = 420;
var GAP = 16;
function viewportSize(width, height) {
  const fallbackWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const fallbackHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  return { width: width ?? fallbackWidth, height: height ?? fallbackHeight };
}
function clampGeometry(input, viewportWidth, viewportHeight) {
  const viewport = viewportSize(viewportWidth, viewportHeight);
  const maxWidth = Math.max(100, viewport.width - GAP * 2);
  const maxHeight = Math.max(100, viewport.height - GAP * 2);
  const minWidth = Math.min(MIN_WIDTH, maxWidth);
  const minHeight = Math.min(MIN_HEIGHT, maxHeight);
  const width = Math.min(Math.max(input?.width ?? 420, minWidth), maxWidth);
  const height = Math.min(Math.max(input?.height ?? 620, minHeight), maxHeight);
  const x = Math.min(Math.max(input?.x ?? viewport.width - width - GAP, 0), Math.max(0, viewport.width - width));
  const y = Math.min(Math.max(input?.y ?? viewport.height - height - GAP, 0), Math.max(0, viewport.height - height));
  return { x, y, width, height };
}
function readAppliedGeometry(element) {
  const style = element?.style;
  if (!style) return void 0;
  const read = (key) => {
    const raw = style[key];
    if (typeof raw !== "string" || !raw.trim()) return void 0;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : void 0;
  };
  const x = read("left");
  const y = read("top");
  const width = read("width");
  const height = read("height");
  if (x === void 0 || y === void 0 || width === void 0 || height === void 0) return void 0;
  return { x, y, width, height };
}
function applyGeometry(root, geometry) {
  root.style.left = geometry.x + "px";
  root.style.top = geometry.y + "px";
  root.style.width = geometry.width + "px";
  root.style.height = geometry.height + "px";
}
function resizeByDirection(start, direction, dx, dy) {
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  const vh = typeof window === "undefined" ? 768 : window.innerHeight;
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (direction.includes("e")) right = start.x + start.width + dx;
  if (direction.includes("w")) left = start.x + dx;
  if (direction.includes("s")) bottom = start.y + start.height + dy;
  if (direction.includes("n")) top = start.y + dy;
  if (direction.includes("e")) right = Math.min(Math.max(right, left + MIN_WIDTH), Math.max(left + MIN_WIDTH, vw - GAP));
  if (direction.includes("w")) left = Math.max(Math.min(left, right - MIN_WIDTH), 0);
  if (direction.includes("s")) bottom = Math.min(Math.max(bottom, top + MIN_HEIGHT), Math.max(top + MIN_HEIGHT, vh - GAP));
  if (direction.includes("n")) top = Math.max(Math.min(top, bottom - MIN_HEIGHT), 0);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
function attachWindowInteractions(root, handle, initial2, onChange, resizeZones) {
  const zones = resizeZones ?? [];
  let geometry = { ...initial2 };
  let mode;
  let direction;
  let pointerId;
  let startX = 0;
  let startY = 0;
  let startGeometry = { ...geometry };
  let disposed = false;
  const applyExternalGeometry = (next) => {
    geometry = { ...next };
    startGeometry = { ...next };
    applyGeometry(root, geometry);
  };
  const finish = (commit) => {
    if (!mode) return;
    const finalGeometry = { ...geometry };
    mode = void 0;
    direction = void 0;
    pointerId = void 0;
    root.removeAttribute("data-resizing");
    if (commit && !disposed) onChange(finalGeometry);
  };
  const begin = (kind, event, dir) => {
    if (disposed || event.button !== 0) return;
    mode = kind;
    direction = dir;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startGeometry = { ...geometry };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
    }
    if (kind === "resize") root.setAttribute("data-resizing", "true");
    event.preventDefault();
  };
  const onDragStart = (event) => {
    const target = event.target instanceof Element ? event.target : void 0;
    if (target?.closest("button, input, textarea, select, a")) return;
    begin("drag", event);
  };
  const onMove = (event) => {
    if (disposed || !mode || pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    geometry = mode === "drag" ? clampGeometry({ ...startGeometry, x: startGeometry.x + dx, y: startGeometry.y + dy }) : resizeByDirection(startGeometry, direction ?? "se", dx, dy);
    applyGeometry(root, geometry);
  };
  const releaseCapture = (event) => {
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
    }
  };
  const onEnd = (event) => {
    if (pointerId !== event.pointerId) return;
    releaseCapture(event);
    finish(true);
  };
  const onCancel = (event) => {
    if (pointerId !== event.pointerId) return;
    releaseCapture(event);
    geometry = { ...startGeometry };
    applyGeometry(root, geometry);
    finish(false);
  };
  const onKeyDown = (event) => {
    if (disposed) return;
    const active = document.activeElement;
    if (active !== handle && !handle.contains(active)) return;
    const step = event.shiftKey ? 10 : 1;
    let next;
    if (event.key === "ArrowLeft") next = { ...geometry, x: geometry.x - step };
    else if (event.key === "ArrowRight") next = { ...geometry, x: geometry.x + step };
    else if (event.key === "ArrowUp") next = { ...geometry, y: geometry.y - step };
    else if (event.key === "ArrowDown") next = { ...geometry, y: geometry.y + step };
    else if (event.key === "Escape" && mode) {
      geometry = { ...startGeometry };
      applyGeometry(root, geometry);
      finish(false);
      return;
    }
    if (!next) return;
    event.preventDefault();
    geometry = clampGeometry(next);
    applyGeometry(root, geometry);
    onChange({ ...geometry });
  };
  const onViewportResize = () => {
    if (disposed || mode) return;
    const next = clampGeometry(geometry);
    if (next.x === geometry.x && next.y === geometry.y && next.width === geometry.width && next.height === geometry.height) return;
    geometry = { ...next };
    startGeometry = { ...next };
    applyGeometry(root, geometry);
    onChange({ ...geometry });
  };
  const viewport = typeof window === "undefined" ? void 0 : window;
  viewport?.addEventListener?.("resize", onViewportResize);
  handle.addEventListener("pointerdown", onDragStart);
  const zoneHandlers = [];
  for (const zone of zones) {
    const handler = (event) => begin("resize", event, zone.direction);
    zoneHandlers.push({ element: zone.element, handler });
    zone.element.addEventListener("pointerdown", handler);
  }
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", onEnd);
  root.addEventListener("pointercancel", onCancel);
  handle.addEventListener("keydown", onKeyDown);
  applyGeometry(root, geometry);
  return {
    isInteracting() {
      return mode !== void 0;
    },
    applyExternal(next) {
      if (!disposed) applyExternalGeometry(next);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pointerId !== void 0) {
        try {
          root.releasePointerCapture?.(pointerId);
        } catch {
        }
      }
      mode = void 0;
      pointerId = void 0;
      handle.removeEventListener("pointerdown", onDragStart);
      for (const zone of zoneHandlers) zone.element.removeEventListener("pointerdown", zone.handler);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onEnd);
      root.removeEventListener("pointercancel", onCancel);
      handle.removeEventListener("keydown", onKeyDown);
      viewport?.removeEventListener?.("resize", onViewportResize);
    }
  };
}

// src/client/markdown.ts
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== void 0) element.textContent = text;
  return element;
}
function appendAll(parent, children) {
  for (const child of children) if (child) parent.appendChild(child);
}
function isSpace(ch) {
  return ch === void 0 || /\s/.test(ch);
}
function isWordChar(ch) {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}
function countRun(src, from, ch) {
  let n = 0;
  while (from + n < src.length && src[from + n] === ch) n++;
  return n;
}
var ESCAPABLE = /* @__PURE__ */ new Set(["\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", "-", ".", "!", ">", "~", "|", '"', "'"]);
function delimCanOpen(src, at, run, ch) {
  const next = src[at + run];
  if (isSpace(next)) return false;
  if (ch === "_" && isWordChar(src[at - 1]) && isWordChar(next)) return false;
  return true;
}
function delimCanClose(src, at, run, ch) {
  const prev = src[at - 1];
  if (isSpace(prev)) return false;
  const next = src[at + run];
  if (ch === "_" && isWordChar(prev) && isWordChar(next)) return false;
  return true;
}
function findClosingBackticks(src, from, run) {
  let i = from;
  while (i < src.length) {
    if (src[i] === "`") {
      const n = countRun(src, i, "`");
      if (n === run) return i;
      i += n;
      continue;
    }
    i++;
  }
  return -1;
}
function skipCodeSpan(src, at) {
  const run = countRun(src, at, "`");
  const close = findClosingBackticks(src, at + run, run);
  return close === -1 ? -1 : close + run;
}
function findClose(src, from, ch, openRun, index) {
  const table = index ?? closeIndexOf(src);
  let i = from;
  let nesting = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      const after = skipCodeSpan(src, i);
      if (after !== -1) {
        i = after;
        continue;
      }
      i += countRun(src, i, "`");
      continue;
    }
    if (c === "[") {
      const link = matchLink(src, i, table);
      if (link) {
        i = link.end;
        continue;
      }
      i++;
      continue;
    }
    if (c !== ch) {
      i++;
      continue;
    }
    const run = countRun(src, i, ch);
    const canOpen = delimCanOpen(src, i, run, ch);
    const canClose = delimCanClose(src, i, run, ch);
    if (canClose && nesting === 0) {
      if (run >= openRun || openRun === 1) return { at: i, len: Math.min(openRun, run) };
    }
    if (canOpen && !canClose) nesting++;
    else if (canClose && nesting > 0) nesting--;
    i += run;
  }
  return void 0;
}
function buildCloseIndex(src) {
  const n = src.length;
  const bracket = new Int32Array(n + 1);
  const paren = new Int32Array(n + 1);
  bracket[n] = -1;
  paren[n] = -1;
  let nextBracket = -1;
  let nextParen = -1;
  for (let i = n - 1; i >= 0; i--) {
    const c = src[i];
    if (c === "\\" && i + 1 < n) {
      bracket[i] = nextBracket;
      paren[i] = nextParen;
      i--;
      bracket[i] = nextBracket;
      paren[i] = nextParen;
      continue;
    }
    if (c === "]") nextBracket = i;
    else if (c === ")") nextParen = i;
    bracket[i] = nextBracket;
    paren[i] = nextParen;
  }
  return { bracket, paren };
}
function nextClose(index, which, from, src) {
  if (from < 0) return -1;
  if (from >= src.length) return -1;
  return (which === "bracket" ? index.bracket : index.paren)[from];
}
var closeIndex = null;
var closeIndexSource = null;
function closeIndexOf(src) {
  if (closeIndex && closeIndexSource === src) return closeIndex;
  closeIndex = buildCloseIndex(src);
  closeIndexSource = src;
  return closeIndex;
}
function matchLink(src, at, index) {
  let i = at;
  const image = src[i] === "!" && src[i + 1] === "[";
  if (image) i++;
  if (src[i] !== "[") return void 0;
  const table = index ?? closeIndexOf(src);
  if (nextClose(table, "bracket", i + 1, src) === -1) return void 0;
  let depth = 0;
  let j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j >= src.length || src[j] !== "]") return void 0;
  const label = src.slice(i + 1, j);
  if (src[j + 1] !== "(") return void 0;
  if (nextClose(table, "paren", j + 2, src) === -1) return void 0;
  let k = j + 2;
  let destDepth = 0;
  let raw = "";
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === "\\") {
      raw += src[k + 1] ?? "";
      k++;
      continue;
    }
    if (c === "(") destDepth++;
    if (c === ")") {
      if (destDepth === 0) break;
      destDepth--;
    }
    raw += c;
  }
  if (k >= src.length || src[k] !== ")") return void 0;
  let dest = raw.trim();
  const titled = /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(dest);
  if (titled) dest = titled[1];
  if (dest.startsWith("<") && dest.endsWith(">")) dest = dest.slice(1, -1);
  return { image, label, dest, end: k + 1 };
}
function safeHref(dest) {
  const value = dest.trim();
  if (!value) return void 0;
  if (/^(https?:|mailto:)/i.test(value)) return value;
  return void 0;
}
function codeSpanText(raw) {
  let text = raw.replace(/\n/g, " ");
  if (text.length > 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim()) text = text.slice(1, -1);
  return text;
}
function renderInlineNodes(src, depth = 0, index) {
  const out = [];
  if (!src) return out;
  let buffer = "";
  const flush = () => {
    if (buffer) {
      out.push(document.createTextNode(buffer));
      buffer = "";
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      buffer += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = countRun(src, i, "`");
      const close = findClosingBackticks(src, i + run, run);
      if (close !== -1) {
        flush();
        out.push(node("code", "ea-md-code", codeSpanText(src.slice(i + run, close))));
        i = close + run;
        continue;
      }
      buffer += src.slice(i, i + run);
      i += run;
      continue;
    }
    if (ch === "<") {
      const end = src.indexOf(">", i + 1);
      if (end !== -1) {
        const inside = src.slice(i + 1, end);
        if (/^(https?:|mailto:)\S*$/i.test(inside)) {
          flush();
          const anchor = node("a", "ea-md-link", inside);
          anchor.setAttribute("href", inside);
          anchor.setAttribute("target", "_blank");
          anchor.setAttribute("rel", "noreferrer noopener");
          out.push(anchor);
          i = end + 1;
          continue;
        }
      }
      buffer += ch;
      i++;
      continue;
    }
    if (ch === "[" || ch === "!" && src[i + 1] === "[") {
      const link = matchLink(src, i);
      if (link) {
        flush();
        const href = safeHref(link.dest);
        if (link.image) {
          if (href) {
            const image = node("img", "ea-md-image");
            image.setAttribute("src", href);
            image.setAttribute("alt", link.label);
            image.setAttribute("loading", "lazy");
            out.push(image);
          } else {
            out.push(node("span", "ea-md-image-alt", link.label));
          }
        } else if (href) {
          const anchor = node("a", "ea-md-link");
          appendAll(anchor, depth >= 8 ? [document.createTextNode(link.label)] : renderInlineNodes(link.label, depth + 1));
          anchor.setAttribute("href", href);
          anchor.setAttribute("target", "_blank");
          anchor.setAttribute("rel", "noreferrer noopener");
          out.push(anchor);
        } else {
          if (depth >= 8) out.push(document.createTextNode(link.label));
          else out.push(...renderInlineNodes(link.label, depth + 1));
        }
        i = link.end;
        continue;
      }
      buffer += ch;
      i++;
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      const run = countRun(src, i, ch);
      if (ch !== "~" || run >= 2) {
        if (delimCanOpen(src, i, run, ch)) {
          const close = findClose(src, i + run, ch, run);
          if (close) {
            flush();
            const inner = src.slice(i + run, close.at);
            const children = depth >= 8 ? [document.createTextNode(inner)] : renderInlineNodes(inner, depth + 1);
            if (ch === "~") {
              const element = node("del", "ea-md-del");
              appendAll(element, children);
              out.push(element);
            } else if (run >= 3 && close.len >= 3) {
              const strong = node("strong", "ea-md-strong");
              const em = node("em", "ea-md-em");
              appendAll(em, children);
              strong.appendChild(em);
              out.push(strong);
            } else {
              const element = node(run >= 2 && close.len >= 2 ? "strong" : "em", run >= 2 && close.len >= 2 ? "ea-md-strong" : "ea-md-em");
              appendAll(element, children);
              out.push(element);
            }
            i = close.at + close.len;
            continue;
          }
        }
      }
      buffer += src.slice(i, i + run);
      i += run;
      continue;
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}
var FENCE = /^ {0,3}(\x60{3,}|~{3,})(.*)$/;
var HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
var HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
var LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
var QUOTE = /^ {0,3}>/;
var BLANK = /^[ \t]*$/;
function splitLines(src, from) {
  const lines = [];
  let i = from;
  for (; ; ) {
    let nl = src.indexOf("\n", i);
    if (nl === -1) nl = src.length;
    let end = nl;
    if (end > i && src[end - 1] === "\r") end--;
    lines.push({ text: src.slice(i, end), start: i, end: nl });
    if (nl >= src.length) break;
    i = nl + 1;
  }
  return lines;
}
var MAX_OPEN_PARAGRAPH = 1500;
var KEEP_OPEN_TAIL = 600;
var DELIM_CELL = /^:?-+:?$/;
function tableCells(text) {
  if (!text.includes("|")) return null;
  let s = text.trim();
  if (!s.includes("|")) return null;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells = [];
  let buf = "";
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") {
      buf += "|";
      k++;
      continue;
    }
    if (ch === "|") {
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf);
  return cells.map((c) => c.trim());
}
function isDelimiterRow(cells) {
  return !!cells && cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}
function isTableStart(lines, k) {
  if (k + 1 >= lines.length) return false;
  const head = tableCells(lines[k].text);
  if (!head || head.length === 0) return false;
  const delim = tableCells(lines[k + 1].text);
  if (!isDelimiterRow(delim)) return false;
  return delim.length === head.length;
}
function alignOf(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}
function scanBlocks(src, from = 0) {
  const lines = splitLines(src, from);
  const blocks = [];
  let i = 0;
  const nextNonBlank = (from2) => {
    let k = from2;
    while (k < lines.length && BLANK.test(lines[k].text)) k++;
    return k;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (BLANK.test(line.text)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line.text);
    if (fence) {
      const marker = fence[1][0];
      const size = fence[1].length;
      let j2 = i + 1;
      let closed2 = false;
      while (j2 < lines.length) {
        const candidate = lines[j2].text;
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(candidate);
        if (close && close[1][0] === marker && close[1].length >= size) {
          closed2 = true;
          break;
        }
        j2++;
      }
      const contentStart = Math.min(line.end + 1, src.length);
      const contentEnd = closed2 ? Math.max(contentStart, lines[j2].start - 1) : src.length;
      blocks.push({
        type: "code",
        start: line.start,
        end: closed2 ? lines[j2].end : src.length,
        closed: closed2,
        info: fence[2].trim(),
        text: src.slice(contentStart, contentEnd)
      });
      i = closed2 ? j2 + 1 : lines.length;
      continue;
    }
    const heading = HEADING.exec(line.text);
    if (heading) {
      blocks.push({ type: "heading", start: line.start, end: line.end, closed: line.end < src.length, level: heading[1].length, text: (heading[2] ?? "").trim() });
      i++;
      continue;
    }
    if (HR.test(line.text)) {
      blocks.push({ type: "hr", start: line.start, end: line.end, closed: line.end < src.length });
      i++;
      continue;
    }
    if (QUOTE.test(line.text)) {
      const inner = [];
      let j2 = i;
      let closed2 = false;
      while (j2 < lines.length) {
        if (BLANK.test(lines[j2].text) || !QUOTE.test(lines[j2].text)) {
          closed2 = true;
          break;
        }
        inner.push(lines[j2].text.replace(/^ {0,3}> ?/, ""));
        j2++;
      }
      blocks.push({ type: "quote", start: line.start, end: lines[j2 - 1].end, closed: closed2, text: inner.join("\n") });
      i = j2;
      continue;
    }
    const item = LIST_ITEM.exec(line.text);
    if (item) {
      const baseIndent = item[1].length;
      const ordered = /\d/.test(item[2]);
      const startNumber = ordered ? parseInt(item[2], 10) : void 0;
      const items = [];
      let current = null;
      let j2 = i;
      let closed2 = false;
      while (j2 < lines.length) {
        const text2 = lines[j2].text;
        const marker = LIST_ITEM.exec(text2);
        if (marker && marker[1].length <= baseIndent && /\d/.test(marker[2]) === ordered) {
          if (current) items.push({ text: current.join("\n") });
          current = [text2.slice(marker[0].length)];
          j2++;
          continue;
        }
        if (BLANK.test(text2)) {
          const next = nextNonBlank(j2);
          if (next >= lines.length) {
            closed2 = true;
            break;
          }
          const nextText = lines[next].text;
          const nextMarker = LIST_ITEM.exec(nextText);
          const nextIndent = nextText.length - nextText.trimStart().length;
          if (nextMarker && nextMarker[1].length <= baseIndent && /\d/.test(nextMarker[2]) === ordered) {
            if (current) current.push("");
            j2 = next;
            continue;
          }
          if (nextIndent > baseIndent && current) {
            current.push("");
            j2 = next;
            continue;
          }
          closed2 = true;
          break;
        }
        if (!current) {
          closed2 = true;
          break;
        }
        const indent = text2.length - text2.trimStart().length;
        if (indent <= baseIndent) {
          closed2 = true;
          break;
        }
        current.push(text2.slice(Math.min(indent, baseIndent + 2)));
        j2++;
      }
      if (current) items.push({ text: current.join("\n") });
      blocks.push({ type: "list", start: line.start, end: lines[j2 - 1].end, closed: closed2, ordered, startNumber, items });
      i = j2;
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = tableCells(line.text);
      const delim = tableCells(lines[i + 1].text);
      const align = delim.map(alignOf);
      const rows = [];
      let j2 = i + 2;
      while (j2 < lines.length) {
        const text2 = lines[j2].text;
        if (BLANK.test(text2)) break;
        const cells = tableCells(text2);
        if (!cells || cells.length === 0) break;
        if (cells.length > header.length) break;
        rows.push(cells);
        j2++;
      }
      blocks.push({
        type: "table",
        start: line.start,
        end: lines[j2 - 1].end,
        closed: j2 < lines.length,
        header,
        align,
        rows
      });
      i = j2;
      continue;
    }
    const start = line.start;
    let j = i;
    let closed = false;
    while (j < lines.length) {
      const text2 = lines[j].text;
      if (BLANK.test(text2)) {
        closed = true;
        break;
      }
      if (j > i && (FENCE.test(text2) || HR.test(text2) || QUOTE.test(text2) || LIST_ITEM.test(text2) || HEADING.test(text2) || isTableStart(lines, j))) {
        closed = true;
        break;
      }
      j++;
    }
    const end = lines[j - 1].end;
    const text = lines.slice(i, j).map((l) => l.text).join("\n");
    if (!closed && text.length > MAX_OPEN_PARAGRAPH) {
      const parts = text.split("\n");
      let cut = 0;
      let acc = 0;
      for (let k = 0; k < parts.length; k++) {
        acc += parts[k].length + 1;
        if (acc >= text.length - KEEP_OPEN_TAIL) break;
        cut = k + 1;
      }
      if (cut > 0) {
        const frozen = parts.slice(0, cut).join("\n");
        blocks.push({ type: "paragraph", start, end: start + frozen.length, closed: true, text: frozen });
        blocks.push({ type: "paragraph", start: start + frozen.length + 1, end, closed: false, text: parts.slice(cut).join("\n") });
        i = j;
        continue;
      }
    }
    blocks.push({ type: "paragraph", start, end, closed, text });
    i = j;
  }
  return blocks;
}
function renderCodeBlock(block) {
  const pre = node("pre", "ea-md-pre");
  const code = node("code", "ea-md-codeblock");
  if (block.info) code.setAttribute("data-lang", block.info);
  code.textContent = block.text ?? "";
  pre.appendChild(code);
  return pre;
}
function renderListItem(item) {
  const li = node("li", "ea-md-li");
  const children = scanBlocks(item.text, 0);
  if (children.length === 1 && children[0].type === "paragraph") {
    appendAll(li, renderInlineNodes(children[0].text ?? ""));
  } else {
    appendAll(li, children.map(renderBlock));
  }
  return li;
}
function renderBlock(block) {
  switch (block.type) {
    case "heading": {
      const level = Math.min(6, Math.max(1, block.level ?? 1));
      const heading = node("h" + level, "ea-md-h ea-md-h" + level);
      appendAll(heading, renderInlineNodes(block.text ?? ""));
      return heading;
    }
    case "code":
      return renderCodeBlock(block);
    case "hr":
      return node("hr", "ea-md-hr");
    case "table": {
      const wrap = node("div", "ea-md-table-wrap");
      const table = node("table", "ea-md-table");
      const head = node("thead", "ea-md-thead");
      const headRow = node("tr", "ea-md-tr");
      const header = block.header ?? [];
      header.forEach((cell, idx) => {
        const th = node("th", "ea-md-th");
        const align = block.align?.[idx] ?? null;
        if (align) th.setAttribute("data-align", align);
        appendAll(th, renderInlineNodes(cell));
        headRow.appendChild(th);
      });
      head.appendChild(headRow);
      table.appendChild(head);
      const body = node("tbody", "ea-md-tbody");
      for (const row of block.rows ?? []) {
        const tr = node("tr", "ea-md-tr");
        for (let c = 0; c < header.length; c++) {
          const td = node("td", "ea-md-td");
          const align = block.align?.[c] ?? null;
          if (align) td.setAttribute("data-align", align);
          appendAll(td, renderInlineNodes(row[c] ?? ""));
          tr.appendChild(td);
        }
        body.appendChild(tr);
      }
      table.appendChild(body);
      wrap.appendChild(table);
      return wrap;
    }
    case "quote": {
      const quote = node("blockquote", "ea-md-quote");
      appendAll(quote, scanBlocks(block.text ?? "", 0).map(renderBlock));
      return quote;
    }
    case "list": {
      const list = node(block.ordered ? "ol" : "ul", "ea-md-list");
      if (block.ordered && block.startNumber !== void 0 && block.startNumber !== 1) list.setAttribute("start", String(block.startNumber));
      appendAll(list, (block.items ?? []).map(renderListItem));
      return list;
    }
    default: {
      const paragraph = node("p", "ea-md-p");
      appendAll(paragraph, renderInlineNodes(block.text ?? ""));
      return paragraph;
    }
  }
}
function renderMarkdownNodes(text) {
  return scanBlocks(text, 0).map(renderBlock).filter((value) => value !== null);
}
function createMarkdownRenderer() {
  let source = "";
  let frozenBlocks = [];
  let frozen = [];
  let tail = [];
  let lastText = null;
  let lastStreaming = false;
  let liveCode = null;
  const stats = { blockRenders: 0, calls: 0, skips: 0, codeAppends: 0, codeChars: 0 };
  const reset = () => {
    source = "";
    frozenBlocks = [];
    frozen = [];
    tail = [];
    lastText = null;
    liveCode = null;
  };
  const render = (text, streaming) => {
    stats.calls++;
    if (text === lastText && streaming === lastStreaming) {
      stats.skips++;
      return [...frozen, ...tail];
    }
    lastText = text;
    lastStreaming = streaming;
    if (!streaming) {
      if (!source) {
        const nodes = renderMarkdownNodes(text);
        stats.blockRenders += nodes.length;
        frozenBlocks = scanBlocks(text, 0);
        frozen = nodes;
        tail = [];
        source = text;
        lastStreaming = false;
        liveCode = null;
        return nodes;
      }
      const blocks2 = scanBlocks(text, 0);
      const rawOf = (block) => block.type + "\0" + text.slice(block.start, block.end);
      let keep = 0;
      while (keep < frozenBlocks.length && keep < blocks2.length && rawOf(frozenBlocks[keep]) === rawOf(blocks2[keep])) keep++;
      const keptNodes = frozen.slice(0, keep);
      const rebuilt = [];
      for (let i = keep; i < blocks2.length; i++) {
        const value = renderBlock(blocks2[i]);
        stats.blockRenders++;
        if (value) rebuilt.push(value);
      }
      frozenBlocks = blocks2;
      frozen = [...keptNodes, ...rebuilt];
      tail = [];
      source = text;
      lastStreaming = false;
      liveCode = null;
      return frozen;
    }
    if (!text.startsWith(source)) {
      reset();
      lastText = text;
      lastStreaming = true;
    }
    const from = frozenBlocks.length ? frozenBlocks[frozenBlocks.length - 1].end + 1 : 0;
    const blocks = [...frozenBlocks, ...scanBlocks(text, Math.min(from, text.length))];
    source = text;
    let index = frozenBlocks.length;
    while (blocks.length - index > 1 && blocks[index].closed) {
      const rendered2 = renderBlock(blocks[index]);
      stats.blockRenders++;
      if (rendered2) frozen.push(rendered2);
      frozenBlocks.push(blocks[index]);
      index++;
    }
    const pending = blocks.slice(frozenBlocks.length);
    const rendered = [];
    for (const block of pending) {
      if (block.type === "code" && !block.closed) {
        const body = block.text ?? "";
        if (liveCode && liveCode.start === block.start && body.startsWith(liveCode.text)) {
          const delta = body.slice(liveCode.text.length);
          if (delta) liveCode.code.appendChild(document.createTextNode(delta));
          liveCode.text = body;
          stats.codeAppends++;
          stats.codeChars += delta.length;
          rendered.push(liveCode.pre);
          continue;
        }
        const fresh = renderCodeBlock(block);
        liveCode = { start: block.start, text: body, code: fresh.querySelector("code"), pre: fresh };
        stats.blockRenders++;
        stats.codeChars += body.length;
        rendered.push(fresh);
        continue;
      }
      const value = renderBlock(block);
      stats.blockRenders++;
      if (value) rendered.push(value);
    }
    tail = rendered;
    return [...frozen, ...tail];
  };
  return {
    render,
    get frozenCount() {
      return frozen.length;
    },
    stats,
    reset
  };
}
var settledCache = /* @__PURE__ */ new Map();
var SETTLED_CACHE_MAX = 40;
var settledCacheParses = 0;
function deliverSettled(nodes) {
  const attached = nodes.some((node2) => node2.parentElement !== null);
  if (!attached) return nodes;
  return nodes.map((node2) => node2.cloneNode(true));
}
function cachedMarkdownNodes(key, text) {
  const cacheKey = key + "\0" + text;
  const hit = settledCache.get(cacheKey);
  if (hit) {
    settledCache.delete(cacheKey);
    settledCache.set(cacheKey, hit);
    return deliverSettled(hit);
  }
  settledCacheParses++;
  const nodes = renderMarkdownNodes(text);
  settledCache.set(cacheKey, nodes);
  if (settledCache.size > SETTLED_CACHE_MAX) settledCache.delete(settledCache.keys().next().value);
  return deliverSettled(nodes);
}
function mountMarkdown(container) {
  const renderer = createMarkdownRenderer();
  let mounted = [];
  const update = (text, streaming) => {
    const nodes = renderer.render(text, streaming);
    let firstDiff = 0;
    while (firstDiff < mounted.length && firstDiff < nodes.length && mounted[firstDiff] === nodes[firstDiff]) firstDiff++;
    if (firstDiff === mounted.length && firstDiff === nodes.length) return;
    for (let i = mounted.length - 1; i >= firstDiff; i--) mounted[i].remove();
    for (let i = firstDiff; i < nodes.length; i++) container.appendChild(nodes[i]);
    mounted = nodes.slice();
  };
  return {
    update,
    get frozenCount() {
      return renderer.frozenCount;
    },
    get stats() {
      return renderer.stats;
    },
    dispose() {
      for (const item of mounted) item.remove();
      mounted = [];
      renderer.reset();
    }
  };
}

// src/shared/record-reason.ts
var RECORD_REASON_TEXT = {
  timeout: "这次解释等太久了，已经停下，以免一直占用。你可以缩小问题范围，或换一个更快的模型再试。",
  model_failed: "这次解释没有成功：模型那边返回了错误，已经停下。你可以缩小问题范围，或换一个模型再试。",
  limit: "这次解释触及了安全上限，已停下。小助手不会无限重试，你可以缩小范围后再问。",
  empty_result: "这次整理没有拿到可用的摘要内容，已经停下。上一份可用摘要仍然保留，你可以稍后再试一次。",
  // 用户自己按了「停止」：这**不是失败**，所以文案不能写成「没有成功」，否则等于把用户的决定说成系统出错。
  stopped: "这次解释是按你的要求停止的，没有生成完整回答。你可以重新问一次。"
};
var RECORD_REASON_PREFIX = "这条记录没有完成：";
var RECORD_INCOMPLETE_TEXT = "此记录未完成或未验证";
function normalizeRecordReason(value) {
  return value === "timeout" || value === "model_failed" || value === "limit" || value === "empty_result" || value === "stopped" ? value : void 0;
}
function recordReasonText(value) {
  const reason = normalizeRecordReason(value);
  return reason ? RECORD_REASON_TEXT[reason] : void 0;
}

// src/shared/record-kind.ts
var COMPACT_RECORD_KIND = "compact";
function isAskRecord(record) {
  const kind = record?.kind;
  return kind !== COMPACT_RECORD_KIND;
}

// src/client/history-window.ts
var HISTORY_WINDOW = 6;
var HISTORY_BATCH = 6;
var HISTORY_WINDOW_MAX = 12;
var idOf = (record) => {
  const value = record?.id;
  return typeof value === "string" ? value : "";
};
function resolveHistoryWindow(records, previous, expand = 0) {
  const total = records.length;
  if (!total) return { start: 0, end: 0, total: 0, items: [], atTail: true };
  let count = Math.min(HISTORY_WINDOW_MAX, Math.max(1, Math.round(previous?.count ?? HISTORY_WINDOW)));
  let start = -1;
  if (previous?.firstId) start = records.findIndex((record) => idOf(record) === previous.firstId);
  if (previous?.atTail && start >= 0) start = Math.max(0, total - count);
  if (start < 0) start = Math.max(0, total - count);
  if (expand > 0 && start > 0) {
    const add = Math.min(expand, start);
    start -= add;
    count = Math.min(HISTORY_WINDOW_MAX, count + add);
  }
  if (start > total - 1) start = Math.max(0, total - 1);
  const end = Math.min(total, start + count);
  return { start, end, total, items: records.slice(start, end), atTail: end >= total };
}

// src/client/text-field.ts
var DEFAULT_CONFIG = {
  // 取自 caret.js:26-35：光标 0.3s、选区 0.2s、淡入 0.12s
  caretResponse: 0.3,
  caretDamping: 1,
  selectionResponse: 0.2,
  selectionFade: 0.12,
  blinkDelayMs: 500,
  substep: 1 / 240,
  maxDt: 0.064
};
function springConfig(response, dampingRatio) {
  const w = 2 * Math.PI / response;
  return { k: w * w, c: 2 * dampingRatio * w };
}
function createSpring(value, response, damping) {
  const { k, c } = springConfig(response, damping);
  return { x: value, v: 0, target: value, k, c };
}
function stepSpring(s, dt, substep) {
  const steps = Math.ceil(dt / substep);
  const h = steps ? dt / steps : 0;
  for (let i = 0; i < steps; i++) {
    s.v += (-s.k * (s.x - s.target) - s.c * s.v) * h;
    s.x += s.v * h;
  }
  if (Math.abs(s.x - s.target) < 1e-3 && Math.abs(s.v) < 0.01) {
    s.x = s.target;
    s.v = 0;
    return false;
  }
  return true;
}
var MAX_BOXES = 24;
var AUTOSIZE_MIN = 52;
var AUTOSIZE_MAX = 150;
var instances = /* @__PURE__ */ new WeakMap();
function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
function round(n) {
  return Math.round(n * 100) / 100;
}
function mountTextField(input, overrides = {}) {
  const existing = instances.get(input);
  if (existing) return existing;
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  const root = document.createElement("div");
  root.className = "ea-field";
  input.parentNode?.insertBefore(root, input);
  root.appendChild(input);
  const mirror = document.createElement("div");
  mirror.className = "ea-field-mirror";
  mirror.setAttribute("aria-hidden", "true");
  const textNode = document.createTextNode("");
  mirror.appendChild(textNode);
  const selectionLayer = document.createElement("div");
  selectionLayer.className = "ea-field-selection";
  selectionLayer.setAttribute("aria-hidden", "true");
  const caret = document.createElement("div");
  caret.className = "ea-field-caret";
  caret.setAttribute("aria-hidden", "true");
  root.append(mirror, selectionLayer, caret);
  const boxes = [];
  for (let i = 0; i < MAX_BOXES; i++) {
    const boxEl = document.createElement("div");
    boxEl.className = "ea-field-sel-box";
    selectionLayer.appendChild(boxEl);
    boxes.push({
      el: boxEl,
      left: createSpring(0, cfg.selectionResponse, 1),
      width: createSpring(0, cfg.selectionResponse, 1),
      visible: false
    });
  }
  const caretX = createSpring(0, cfg.caretResponse, cfg.caretDamping);
  const caretOpacity = createSpring(1, cfg.selectionFade, 1);
  let caretVisible = false;
  let rafId = 0;
  let lastTime = 0;
  let blinkTimer = 0;
  let dead = false;
  let lastAutosize = -1;
  const engineOk = typeof document.createRange === "function" && typeof requestAnimationFrame === "function";
  let active = engineOk && !prefersReducedMotion();
  function autosize() {
    if (input.tagName !== "TEXTAREA") return;
    const element = input;
    const previous = element.style.height;
    element.style.height = "auto";
    const measured = element.scrollHeight || 0;
    const next = Math.max(AUTOSIZE_MIN, Math.min(measured, AUTOSIZE_MAX));
    if (Math.abs(next - lastAutosize) > 0.5) {
      lastAutosize = next;
      element.style.height = next + "px";
    } else {
      element.style.height = previous || next + "px";
    }
  }
  function syncMirror() {
    const cs = getComputedStyle(input);
    mirror.style.width = input.clientWidth + "px";
    mirror.style.padding = cs.padding;
    mirror.style.font = cs.font;
    mirror.style.fontSize = cs.fontSize;
    mirror.style.lineHeight = cs.lineHeight;
    mirror.style.letterSpacing = cs.letterSpacing;
    mirror.style.textAlign = cs.textAlign;
    mirror.style.whiteSpace = input.tagName === "TEXTAREA" ? "pre-wrap" : "pre";
    mirror.style.wordBreak = "break-word";
    mirror.style.transform = "translate(" + -input.scrollLeft + "px," + -input.scrollTop + "px)";
    const data = input.value || "​";
    if (textNode.data !== data) textNode.data = data;
  }
  function caretRect() {
    if (!textNode.data.length) return null;
    const offset = Math.min(Math.max(input.selectionStart ?? 0, 0), textNode.data.length);
    const range = document.createRange();
    range.setStart(textNode, offset);
    range.collapse(true);
    const rects = range.getClientRects();
    return rects.length ? rects[0] : range.getBoundingClientRect();
  }
  function selectionRects() {
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    if (end <= start) return [];
    const range = document.createRange();
    range.setStart(textNode, Math.min(start, textNode.data.length));
    range.setEnd(textNode, Math.min(end, textNode.data.length));
    return Array.from(range.getClientRects());
  }
  function hasSelection() {
    return (input.selectionStart ?? 0) !== (input.selectionEnd ?? 0);
  }
  function hideCaret() {
    window.clearTimeout(blinkTimer);
    caret.classList.remove("is-blinking");
    caret.style.opacity = "0";
    caretVisible = false;
  }
  function restartBlink() {
    window.clearTimeout(blinkTimer);
    caret.classList.remove("is-blinking");
    caret.style.opacity = "1";
    blinkTimer = window.setTimeout(() => {
      if (dead || !caretVisible) return;
      caret.classList.add("is-blinking");
    }, cfg.blinkDelayMs);
  }
  function paintCaret() {
    if (hasSelection()) {
      hideCaret();
      return;
    }
    const r = caretRect();
    if (!r) {
      hideCaret();
      return;
    }
    const fr = root.getBoundingClientRect();
    const cs = getComputedStyle(input);
    const lineHeight = r.height || parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    caret.style.height = round(lineHeight) + "px";
    caret.style.top = round(r.top - fr.top) + "px";
    caretX.target = r.left - fr.left;
    if (!caretVisible) {
      caretX.x = caretX.target;
      caretX.v = 0;
      caretVisible = true;
      caret.style.left = round(caretX.x - 1) + "px";
      caret.style.opacity = "1";
    }
  }
  function paintSelection() {
    const rects = selectionRects().slice(0, MAX_BOXES);
    const fr = root.getBoundingClientRect();
    boxes.forEach((box, i) => {
      const r = rects[i];
      if (!r) {
        if (box.visible) {
          box.visible = false;
          box.el.style.opacity = "0";
        }
        return;
      }
      if (!box.visible) {
        box.visible = true;
        box.left.x = r.left - fr.left;
        box.left.v = 0;
        box.width.x = r.width;
        box.width.v = 0;
        box.el.style.left = round(box.left.x) + "px";
        box.el.style.width = round(box.width.x) + "px";
        box.el.style.opacity = "1";
      }
      box.left.target = r.left - fr.left;
      box.width.target = r.width;
      box.el.style.top = round(r.top - fr.top) + "px";
      box.el.style.height = round(r.height) + "px";
    });
  }
  function frame(now) {
    if (dead) return;
    const dt = Math.min(Math.max((now - lastTime) / 1e3, 0), cfg.maxDt);
    lastTime = now;
    let moving = false;
    if (stepSpring(caretX, dt, cfg.substep)) moving = true;
    caret.style.left = round(caretX.x - 1) + "px";
    for (const box of boxes) {
      if (!box.visible) continue;
      if (stepSpring(box.left, dt, cfg.substep)) moving = true;
      if (stepSpring(box.width, dt, cfg.substep)) moving = true;
      box.el.style.left = round(box.left.x) + "px";
      box.el.style.width = round(box.width.x) + "px";
    }
    if (stepSpring(caretOpacity, dt, cfg.substep)) {
      moving = true;
      caret.style.opacity = String(round(caretOpacity.x));
    }
    rafId = moving ? requestAnimationFrame(frame) : 0;
  }
  function ensureLoop() {
    if (dead || rafId) return;
    lastTime = performance.now();
    rafId = requestAnimationFrame(frame);
  }
  function refresh() {
    if (dead) return;
    if (!active) return;
    autosize();
    syncMirror();
    paintCaret();
    paintSelection();
    if (caretVisible && !hasSelection()) restartBlink();
    ensureLoop();
  }
  function onScroll() {
    if (!active) return;
    syncMirror();
    paintCaret();
    paintSelection();
    ensureLoop();
  }
  function onFocus() {
    if (!active) return;
    caretVisible = false;
    caretOpacity.x = 1;
    caretOpacity.target = 1;
    caret.style.opacity = "1";
    refresh();
  }
  function onBlur() {
    window.clearTimeout(blinkTimer);
    caret.classList.remove("is-blinking");
    caretOpacity.target = 0;
    ensureLoop();
    boxes.forEach((box) => {
      box.visible = false;
      box.el.style.opacity = "0";
    });
  }
  const onSelectionChange = () => {
    if (document.activeElement === input) refresh();
  };
  const onViewportChange = () => refresh();
  const listeners = [
    [input, "input", refresh],
    [input, "keyup", refresh],
    [input, "mouseup", refresh],
    [input, "scroll", onScroll],
    [input, "focus", onFocus],
    [input, "blur", onBlur],
    [input, "compositionstart", refresh],
    [input, "compositionend", refresh],
    [document, "selectionchange", onSelectionChange],
    [window, "resize", onViewportChange]
  ];
  const observer = typeof MutationObserver === "function" ? new MutationObserver(() => {
    if (!root.isConnected) handle.destroy();
  }) : null;
  const sizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    if (!dead && active) refresh();
  }) : null;
  const motionQuery = (() => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return null;
    }
  })();
  const onMotionChange = () => {
    if (dead || !engineOk) return;
    const next = !(motionQuery?.matches ?? false);
    if (next === active) return;
    active = next;
    if (active) {
      root.setAttribute("data-smooth", "on");
      try {
        refresh();
      } catch {
        active = false;
        root.removeAttribute("data-smooth");
      }
      return;
    }
    root.removeAttribute("data-smooth");
    hideCaret();
    boxes.forEach((box) => {
      box.visible = false;
      box.el.style.opacity = "0";
    });
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  };
  if (active) {
    listeners.forEach(([target, name, fn]) => target.addEventListener(name, fn, true));
    observer?.observe(document.body, { childList: true, subtree: true });
    sizeObserver?.observe(input);
    motionQuery?.addEventListener?.("change", onMotionChange);
    root.setAttribute("data-smooth", "on");
    try {
      autosize();
      syncMirror();
      refresh();
    } catch {
      active = false;
      root.removeAttribute("data-smooth");
    }
    try {
      document.fonts?.ready?.then(() => {
        if (!dead && active) refresh();
      });
    } catch {
    }
  }
  const handle = {
    root,
    input,
    get active() {
      return active;
    },
    refresh,
    destroy() {
      if (dead) return;
      dead = true;
      active = false;
      window.clearTimeout(blinkTimer);
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      listeners.forEach(([target, name, fn]) => target.removeEventListener(name, fn, true));
      observer?.disconnect();
      sizeObserver?.disconnect();
      motionQuery?.removeEventListener?.("change", onMotionChange);
      instances.delete(input);
      root.removeAttribute("data-smooth");
      if (root.parentNode) {
        root.parentNode.insertBefore(input, root);
        root.remove();
      }
    }
  };
  instances.set(input, handle);
  return handle;
}

// src/client/page-selection.ts
var PAD_X = 1.5;
var PAD_Y = 1.5;
var SNAP_EPS = 0.05;
var MAX_BLOCKS = 64;
function round2(n) {
  return Math.round(n * 100) / 100;
}
function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}
function reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
function backgroundAlpha(color) {
  const match = /^rgba?\(([^)]+)\)$/.exec(String(color || "").trim());
  if (!match) return 0;
  const parts = match[1].split(/[,/]/).map((part) => parseFloat(part));
  if (parts.length < 4) return 1;
  return Number.isFinite(parts[3]) ? parts[3] : 1;
}
function unavailable() {
  return { layer: document.createElement("div"), refresh() {
  }, destroy() {
  } };
}
function mountPageSelection(root, overrides = {}) {
  if (typeof root.insertBefore !== "function" || typeof document.createTreeWalker !== "function" || typeof NodeFilter === "undefined" || typeof requestAnimationFrame !== "function") {
    return unavailable();
  }
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  const layer = document.createElement("div");
  layer.className = "ea-page-sel-layer";
  layer.setAttribute("aria-hidden", "true");
  root.insertBefore(layer, root.firstChild);
  const blocks = [];
  let rafId = 0;
  let lastTime = 0;
  let active = false;
  let dead = false;
  let dirty = true;
  let rectsCache = null;
  let native = false;
  let overflowed = false;
  const engineOk = typeof document.createRange === "function";
  let enabled = engineOk && !reducedMotion();
  function createBlock() {
    const node2 = document.createElement("div");
    node2.className = "ea-page-sel";
    node2.setAttribute("aria-hidden", "true");
    layer.appendChild(node2);
    return {
      node: node2,
      left: createSpring(0, cfg.selectionResponse, 1),
      width: createSpring(0, cfg.selectionResponse, 1),
      opacity: createSpring(0, cfg.selectionFade, 1),
      alive: false,
      ty: 0
    };
  }
  function ensureBlocks(count) {
    while (blocks.length < count && blocks.length < MAX_BLOCKS) blocks.push(createBlock());
  }
  function clipRectOf(node2) {
    let left = 0;
    let top = 0;
    let right = window.innerWidth || document.documentElement.clientWidth || 0;
    let bottom = window.innerHeight || document.documentElement.clientHeight || 0;
    let el2 = node2.nodeType === 1 ? node2 : node2.parentElement;
    let guard = 0;
    while (el2 && el2 !== document.body && el2 !== document.documentElement && guard++ < 40) {
      const cs = getComputedStyle(el2);
      const oy = cs.overflowY;
      const ox = cs.overflowX;
      const clips = oy && oy !== "visible" || ox && ox !== "visible";
      if (clips && el2.clientHeight > 2 && el2.clientWidth > 2 && (el2.scrollHeight > el2.clientHeight + 1 || el2.scrollWidth > el2.clientWidth + 1)) {
        const r = el2.getBoundingClientRect();
        left = Math.max(left, r.left + el2.clientLeft);
        top = Math.max(top, r.top + el2.clientTop);
        right = Math.min(right, r.left + el2.clientLeft + el2.clientWidth);
        bottom = Math.min(bottom, r.top + el2.clientTop + el2.clientHeight);
        break;
      }
      el2 = el2.parentElement;
    }
    if (right - left < 2 || bottom - top < 2) return null;
    return { left, top, right, bottom };
  }
  function rectUsable(r) {
    return !!r && (r.width > 0 || r.height > 0);
  }
  function probeRect(el2) {
    let r = null;
    try {
      r = el2.getBoundingClientRect();
    } catch {
      r = null;
    }
    if (rectUsable(r)) return r;
    let node2 = el2;
    let depth = 0;
    while (depth++ < 6) {
      const child = node2.firstElementChild;
      if (!child) return r;
      try {
        r = child.getBoundingClientRect();
      } catch {
        return r;
      }
      if (rectUsable(r)) return r;
      node2 = child;
    }
    return r;
  }
  function outsideClip(r, clip) {
    if (!rectUsable(r)) return false;
    return r.bottom < clip.top - 1 || r.top > clip.bottom + 1 || r.right < clip.left - 1 || r.left > clip.right + 1;
  }
  function visibleStartIndex(kids, clip) {
    const n = kids.length;
    if (n <= 24) return 0;
    const probe = (i) => {
      const el2 = kids[i];
      if (!el2 || el2.nodeType !== 1) return null;
      return probeRect(el2);
    };
    const first = probe(0);
    const last = probe(n - 1);
    if (!rectUsable(first) || !rectUsable(last)) return 0;
    if (first.top > last.top) return 0;
    let lo = 0;
    let hi = n - 1;
    let guard = 0;
    while (lo < hi && guard++ < 40) {
      const mid = lo + hi >> 1;
      const r = probe(mid);
      if (!rectUsable(r)) return 0;
      if (r.bottom < clip.top) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }
  function collectVisibleText(el2, clip, out, budget, range) {
    const kids = el2.childNodes;
    const start2 = visibleStartIndex(kids, clip);
    for (let i = start2; i < kids.length; i++) {
      const node2 = kids[i];
      if (node2.nodeType === 3) {
        if (!node2.nodeValue) continue;
        let hit = true;
        try {
          hit = range.intersectsNode(node2);
        } catch {
          hit = false;
        }
        if (!hit) continue;
        out.push(node2);
        if (out.length > budget) return;
        continue;
      }
      if (node2.nodeType !== 1) continue;
      const elNode = node2;
      if (elNode.classList && elNode.classList.contains("ea-page-sel-layer")) continue;
      const r = probeRect(elNode);
      if (outsideClip(r, clip)) {
        if (rectUsable(r) && r.top > clip.bottom + 1 && kids.length > 8) {
          let back = false;
          for (let j = i + 1; j < kids.length && j <= i + 3; j++) {
            if (kids[j].nodeType !== 1) continue;
            try {
              const rj = probeRect(kids[j]);
              if (rectUsable(rj) && rj.top <= clip.bottom + 1) {
                back = true;
                break;
              }
            } catch {
            }
          }
          if (!back) return;
        }
        continue;
      }
      collectVisibleText(elNode, clip, out, budget, range);
      if (out.length > budget) return;
    }
  }
  function syncNativeAttribute() {
    if (!enabled || native) root.removeAttribute("data-page-selection");
    else root.setAttribute("data-page-selection", "on");
  }
  function setNative(on) {
    if (on === native) return;
    native = on;
    syncNativeAttribute();
  }
  function selectionScope() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const ranges = [];
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      if (range.collapsed) continue;
      const node2 = range.commonAncestorContainer;
      const elNode = node2.nodeType === 1 ? node2 : node2.parentElement;
      if (elNode?.closest?.(".ea-field")) continue;
      let intersects = false;
      try {
        intersects = range.intersectsNode(root);
      } catch {
        intersects = false;
      }
      if (!intersects) continue;
      ranges.push(range);
    }
    return ranges.length ? ranges : null;
  }
  function coveredByPaint(range) {
    const inside = (node2) => Boolean(node2 && (node2 === root || root.contains(node2)));
    const anchor = inside(range.startContainer) ? range.startContainer : inside(range.endContainer) ? range.endContainer : null;
    if (!anchor) return false;
    let element = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    let guard = 0;
    while (element && element !== root && guard < 64) {
      guard++;
      let color = "";
      try {
        color = getComputedStyle(element).backgroundColor;
      } catch {
        color = "";
      }
      if (backgroundAlpha(color) >= 0.5) return true;
      element = element.parentElement;
    }
    return false;
  }
  function coveredBy(list, r) {
    for (const c of list) {
      const cLeft = c.left + PAD_X;
      const cTop = c.top + PAD_Y;
      const cRight = cLeft + c.width - PAD_X * 2;
      const cBottom = cTop + c.height - PAD_Y * 2;
      if (r.left >= cLeft - 2 && r.top >= cTop - 2 && r.right <= cRight + 2 && r.bottom <= cBottom + 2) return true;
    }
    return false;
  }
  function collectRects(ranges) {
    overflowed = false;
    const out = [];
    const budget = MAX_BLOCKS * 6;
    for (const range of ranges) {
      const clip = clipRectOf(range.startContainer);
      if (!clip) continue;
      const scope = range.commonAncestorContainer;
      const scopeEl = scope.nodeType === 1 ? scope : scope.parentElement;
      if (!scopeEl) continue;
      const nodes = [];
      collectVisibleText(scopeEl, clip, nodes, budget, range);
      for (const text of nodes) {
        const parent = text.parentElement;
        if (parent?.closest?.(".ea-field, .ea-page-sel-layer, .ea-model-search")) continue;
        const part = document.createRange();
        part.setStart(text, text === range.startContainer ? range.startOffset : 0);
        part.setEnd(text, text === range.endContainer ? range.endOffset : text.length);
        if (part.collapsed) continue;
        const list = part.getClientRects();
        for (const r of Array.from(list)) {
          if (r.width <= 0 || r.height <= 0) continue;
          const left = Math.max(r.left - PAD_X, clip.left);
          const top = Math.max(r.top - PAD_Y, clip.top);
          const right = Math.min(r.right + PAD_X, clip.right);
          const bottom = Math.min(r.bottom + PAD_Y, clip.bottom);
          if (right - left <= 0.5 || bottom - top <= 0.5) continue;
          if (coveredBy(out, { left, top, right, bottom })) continue;
          out.push({ left, width: right - left, top, height: bottom - top });
        }
        if (out.length >= MAX_BLOCKS) {
          overflowed = true;
          return null;
        }
      }
    }
    return out.length ? out : null;
  }
  function frameBlock(block, dt, rect, origin) {
    let moving = false;
    if (rect) {
      block.alive = true;
      if (block.opacity.x < SNAP_EPS) {
        block.left.x = rect.left;
        block.left.v = 0;
        block.width.x = rect.width;
        block.width.v = 0;
      }
      block.left.target = rect.left;
      block.width.target = rect.width;
      block.ty = round2(rect.top - origin.top);
      block.node.style.height = round2(rect.height) + "px";
      if (stepSpring(block.left, dt, cfg.substep)) moving = true;
      if (stepSpring(block.width, dt, cfg.substep)) moving = true;
      block.node.style.transform = "translate3d(" + round2(block.left.x - origin.left) + "px," + block.ty + "px,0)";
      block.node.style.width = round2(Math.max(block.width.x, 0)) + "px";
      block.opacity.target = 1;
    } else {
      block.opacity.target = 0;
    }
    if (stepSpring(block.opacity, dt, cfg.substep)) moving = true;
    block.node.style.opacity = String(round2(clamp(block.opacity.x, 0, 1) * 1e3) / 1e3);
    if (!rect && block.opacity.x <= 1e-3 && Math.abs(block.opacity.v) < 0.01) block.alive = false;
    return moving;
  }
  function measure() {
    const ranges = selectionScope();
    if (!ranges) {
      setNative(false);
      active = false;
      rectsCache = null;
      return;
    }
    const rects = collectRects(ranges);
    const covered = ranges.some((range) => coveredByPaint(range));
    if (overflowed || covered || !rects || rects.length === 0) {
      setNative(true);
      active = false;
      rectsCache = null;
      return;
    }
    setNative(false);
    active = true;
    rectsCache = rects;
  }
  function tick(now) {
    if (dead) return;
    const dt = clamp((now - lastTime) / 1e3, 0, cfg.maxDt);
    lastTime = now;
    if (dirty) {
      dirty = false;
      measure();
    }
    const rects = rectsCache;
    if (rects) ensureBlocks(rects.length);
    const origin = layer.getBoundingClientRect();
    let moving = false;
    for (let i = 0; i < blocks.length; i++) {
      const rect = rects && i < rects.length ? rects[i] : null;
      if (frameBlock(blocks[i], dt, rect, origin)) moving = true;
    }
    rafId = moving ? requestAnimationFrame(tick) : 0;
  }
  function start() {
    if (dead || rafId || !enabled) return;
    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
  }
  function refresh() {
    if (dead || !enabled) return;
    dirty = true;
    start();
  }
  const onSelectionChange = () => refresh();
  const onPointerDown = () => {
    if (active) start();
  };
  const onPointerUp = () => refresh();
  const onScroll = () => {
    if (active) start();
  };
  const onViewportChange = () => refresh();
  const listeners = [
    [document, "selectionchange", onSelectionChange, false],
    [document, "pointerdown", onPointerDown, true],
    [window, "pointerup", onPointerUp, true],
    [window, "resize", onViewportChange, false],
    [root, "scroll", onScroll, true],
    [window, "scroll", onScroll, true]
  ];
  if (enabled) {
    listeners.forEach(([target, name, fn, capture]) => target.addEventListener(name, fn, capture));
    syncNativeAttribute();
  }
  const motionQuery = (() => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return null;
    }
  })();
  const onMotionChange = () => {
    if (dead || !engineOk) return;
    const next = !(motionQuery?.matches ?? false);
    if (next === enabled) return;
    enabled = next;
    if (!enabled) {
      setNative(true);
      active = false;
      blocks.forEach((block) => {
        block.node.style.opacity = "0";
      });
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      syncNativeAttribute();
      return;
    }
    setNative(false);
    syncNativeAttribute();
    refresh();
  };
  motionQuery?.addEventListener?.("change", onMotionChange);
  const observer = typeof MutationObserver === "function" ? new MutationObserver(() => {
    if (!root.isConnected) handle.destroy();
  }) : null;
  observer?.observe(document.body, { childList: true, subtree: true });
  const handle = {
    layer,
    refresh,
    destroy() {
      if (dead) return;
      dead = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      listeners.forEach(([target, name, fn, capture]) => target.removeEventListener(name, fn, capture));
      motionQuery?.removeEventListener?.("change", onMotionChange);
      observer?.disconnect();
      root.removeAttribute("data-page-selection");
      layer.remove();
    }
  };
  return handle;
}

// src/client/overlay.tsx
var CATALOG_UNAVAILABLE_CODE = "MODEL_CATALOG_UNAVAILABLE";
function hasLoadedContent(state) {
  return Boolean(
    state.records.length || state.text || state.tools.length || state.evidence.length || state.model || state.historyDetail || state.compactState?.summary || // 目录：有模型组才算内容；失败条目里**只有非目录级**的（例如 MODEL_CATALOG_PARTIAL）
    // 才算「读到了但有 provider 出问题」。
    // 目录级失败（MODEL_CATALOG_UNAVAILABLE）不是内容，而是「这次没读到目录」——
    // 把它算成内容会让界面判为 ready，从而把「没读到」渲染成一批「真的没有」的结论
    // （t6 评审的 F2）。
    state.catalog && ((state.catalog.groups?.length ?? 0) > 0 || (state.catalog.failures || []).some((failure) => failure?.code !== CATALOG_UNAVAILABLE_CODE))
  );
}
function readFailure(state) {
  if (typeof state.stateError === "string" && state.stateError) {
    return { title: "没有读到小助手的当前状态", message: state.stateError };
  }
  const catalog = state.catalog;
  if (!catalog || (catalog.groups?.length ?? 0) > 0) return void 0;
  const failure = (catalog.failures || []).find((item) => item?.code === CATALOG_UNAVAILABLE_CODE && item.message);
  if (!failure) return void 0;
  return { title: "没有读到模型目录", message: String(failure.message) };
}
function canSubmit(state) {
  return surfaceGate(state) === "ready" && !isBusy(state);
}
function sendLabel(state, gate) {
  if (gate === "loading") return "读取中…";
  if (gate === "failed") return "暂时不可用";
  return isBusy(state) ? "停止" : "发送";
}
function surfaceGate(state) {
  if (state.stateReady === false) return "loading";
  if (readFailure(state) && !hasLoadedContent(state)) return "failed";
  return "ready";
}
function loadingNodes() {
  return [el(
    "section",
    { class: "ea-loading", "aria-label": "正在加载" },
    el(
      "div",
      { class: "ea-loading-row", role: "status", "aria-live": "polite" },
      el("span", { class: "ea-spinner", "aria-hidden": "true" }),
      el("span", { class: "ea-loading-text", text: "正在读取小助手的当前状态…" })
    ),
    el("p", { class: "ea-loading-hint", text: "模型列表、历史记录与上下文占用会在数据到位后一次性显示出来。这里现在什么都没有显示，是因为还没读到，不是因为你没有数据。" }),
    // 第一次打开确实比后面慢：要读主 agent 这一段的过程、算占用、拉一次模型目录。
    // 写出来，用户才知道"等"是正常的、不是卡死（读一次之后有缓存，再打开就是秒开）。
    el("p", { class: "ea-loading-hint ea-loading-slow", text: "第一次打开可能要几秒：需要先把主 agent 最近这一段的过程读一遍、再算上下文占用。读到之后会缓存，之后再打开就是秒开。" })
  )];
}
function stateErrorNodes(state, plugin, failure) {
  const info = failure || readFailure(state) || { title: "没有读到小助手的当前状态", message: state.stateError };
  return [el(
    "section",
    { class: "ea-state-error ea-card", "aria-label": "状态读取失败" },
    el("h3", { class: "ea-card-title", text: info.title }),
    el("p", { class: "ea-state-error-reason ea-error", role: "alert", text: info.message }),
    el("p", { class: "ea-state-error-hint", text: "注意：这不是「没有内容」。模型列表、历史记录与上下文占用这次都没有取到，所以下面不显示空的列表或「还没有历史」这类结论 —— 那会把「没读到」说成「真的没有」。" }),
    button("重试", "重新读取小助手状态", () => {
      if (!plugin.retryState) return;
      plugin.registry.update(state.sessionId, { stateReady: false, stateError: void 0 });
      void plugin.retryState(state.sessionId);
    }, { class: "ea-btn ea-btn-primary ea-state-retry" })
  )];
}
var previouslyFocused = null;
function appendChildren(node2, children) {
  for (const child of children) {
    if (child === null || child === void 0 || child === false) continue;
    node2.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}
function fill(node2, children) {
  node2.replaceChildren(...children.filter((child) => child !== null && child !== void 0 && child !== false));
}
function el(tag, props = {}, ...children) {
  const node2 = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === void 0 || value === null || value === false) continue;
    if (key === "class") node2.className = String(value);
    else if (key === "text") node2.textContent = String(value);
    else if (key === "style") Object.assign(node2.style, value);
    else if (key === "dataset") Object.assign(node2.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node2.addEventListener(key.slice(2).toLowerCase(), value);
    else node2.setAttribute(key, value === true ? "" : String(value));
  }
  appendChildren(node2, children);
  return node2;
}
function button(label, aria, handler, options = {}) {
  return el("button", {
    type: "button",
    class: options.class || "ea-btn",
    "aria-label": aria,
    title: options.title,
    disabled: options.disabled,
    "aria-pressed": options.pressed === void 0 ? void 0 : String(options.pressed),
    "aria-expanded": options.expanded === void 0 ? void 0 : String(options.expanded),
    onClick: handler
  }, label);
}
function isBusy(state) {
  return state.phase === "running" || state.phase === "connecting";
}
function phaseLabel(state) {
  if (state.phase === "connecting") return "正在连接";
  if (state.phase === "running") return "正在解释";
  if (state.phase === "complete") return "已完成";
  if (state.phase === "error") return "出错";
  if (state.phase === "interrupted") return "已停止";
  return "";
}
function timeText(value) {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function currentStatusNodes(state, plugin) {
  if (!isBusy(state) || state.text) return [];
  return [el(
    "div",
    { class: "ea-running", role: "status" },
    el("span", { class: "ea-spinner", "aria-hidden": "true" }),
    el("span", { text: state.phase === "connecting" ? "正在连接模型…" : "正在解释…" }),
    button("停止", "停止本次解释", () => plugin.cancel?.(), { class: "ea-btn ea-btn-quiet" })
  )];
}
function currentDetailNodes(state) {
  const nodes = [];
  if (state.reasoning) {
    nodes.push(el(
      "details",
      { class: "dsh-explain-assistant-reasoning ea-disclosure" },
      el("summary", {}, "推理过程（原始内容，默认折叠）"),
      // 推理过程同样是模型写出来的文字，会带 Markdown 记号；走缓存渲染，避免每次重画重解析。
      // 键里带上推理正文的指纹：换一次提问、推理内容一变就自然失效，
      // 免得两次提问拿到同一份旧节点。
      el("div", { class: "ea-disclosure-body ea-md-scope" }, ...cachedMarkdownNodes("live-reasoning#" + contentKey(state.reasoning), state.reasoning))
    ));
  }
  if (state.tools.length) {
    const rows = state.tools.map((tool) => el(
      "details",
      { class: "dsh-explain-assistant-tool ea-tool" },
      el("summary", {}, (tool.label || tool.name) + " · " + (tool.status === "running" ? "进行中" : tool.status === "error" ? "失败" : "完成")),
      el(
        "div",
        { class: "ea-tool-body" },
        tool.detail ? el("p", { class: "ea-tool-detail", text: tool.detail }) : null,
        tool.result !== void 0 ? el("pre", { class: "ea-pre", text: typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result, null, 2) }) : null
      )
    ));
    nodes.push(el(
      "section",
      { class: "ea-tools dsh-explain-assistant-tools", "aria-label": "工具过程" },
      el("h3", { class: "ea-card-title", text: "工具过程" }),
      ...rows
    ));
  }
  return nodes;
}
function offlineFallbackNodes(state) {
  const available = state.phase === "error" || state.phase === "interrupted";
  if (!available) return [];
  const nodes = [];
  const evidence = state.evidence.filter((item) => item?.summary || item?.title);
  const tools = state.tools;
  if (evidence.length) {
    nodes.push(el(
      "section",
      { class: "ea-offline ea-card", "aria-label": "仍可查看的依据" },
      el("h3", { class: "ea-card-title", text: "这些依据仍然可以查看" }),
      el(
        "ul",
        { class: "ea-offline-list" },
        ...evidence.map((item) => el("li", {
          class: "ea-offline-evidence",
          text: (item.title || "未命名步骤") + "：" + String(item.summary || "").slice(0, 120)
        }))
      )
    ));
  }
  const steps = tools.length;
  const failed = tools.filter((tool) => tool.status === "error").length;
  const running = tools.filter((tool) => tool.status === "running").length;
  const lines = [];
  if (steps) {
    lines.push("上一次解释过程中记录到 " + steps + " 个步骤。");
    if (failed) lines.push("其中 " + failed + " 个是失败的。");
    if (running) lines.push("其中 " + running + " 个当时还在进行中。");
    if (!failed && !running) lines.push("它们当时都已完成。");
  }
  if (evidence.length) lines.push("你选中了 " + evidence.length + " 条依据，内容见上面。");
  if (state.records.length) lines.push("你的历史问答记录仍然完整保留，可以在下面的「历史」里翻看，一条都没有丢。");
  if (!lines.length) lines.push("这个小助手还没有拿到任何具体步骤。你可以先在主对话里点一条步骤卡片，再回来提问。");
  nodes.push(el(
    "section",
    { class: "ea-offline ea-card", "aria-label": "基本说明" },
    el("h3", { class: "ea-card-title", text: "现在能告诉你的基本说明" }),
    ...lines.map((line) => el("p", { class: "ea-offline-line", text: line })),
    // §7 最后一条：基本说明不能冒充完整智能回答。
    el("p", { class: "ea-offline-note", text: "这一小段是小助手在没有模型的情况下，根据已记录的内容直接整理的，不是模型对你想问的问题给出的解释。模型恢复后重新提问，就能拿到完整回答。" })
  ));
  return nodes;
}
var QUICK_QUESTIONS = ["它现在在干什么", "这一步为什么这么做", "这步实际产出了什么", "哪里可以调整"];
function quickNodes(state, plugin) {
  if (state.quickQuestionsDismissed || state.records.length || isBusy(state)) return [];
  return [el(
    "section",
    { class: "dsh-explain-assistant-quick ea-quick", "aria-label": "快捷问题" },
    el("h3", { class: "ea-card-title", text: "你可以直接点一个问：" }),
    el(
      "div",
      { class: "dsh-explain-assistant-quick-row ea-quick-row" },
      ...QUICK_QUESTIONS.map((question) => button(question, "快捷提问：" + question, () => {
        plugin.registry.update(state.sessionId, { quickQuestionsDismissed: true });
        void plugin.submit(question);
      }, { class: "ea-btn ea-chip" }))
    )
  )];
}
function heroNodes(state, ctx) {
  if (state.text || state.records.length || state.error || isBusy(state)) return [];
  return [el(
    "section",
    { class: "ea-hero", "aria-label": "使用说明" },
    el("p", { class: "ea-hero-title", text: "小助手在旁边看着主 agent，随时把「它正在干什么」讲成白话。" }),
    el(
      "ul",
      { class: "ea-hero-list" },
      el("li", { text: "点右上角「选择主对话内容」，再点主对话里的一条内容，就能针对它提问；再点同一张卡片可以取消。" }),
      el("li", { text: "也可以直接在下面输入问题，或者点上面的快捷问题。" }),
      el("li", { text: "小助手只读：不改主 agent、不执行命令、不碰主对话的输入框。" })
    ),
    // 第一次打开的人不知道标题栏那排按钮能点 —— 教程入口必须出现在这里，而不只在标题栏。
    button("第一次用？看 30 秒教程 →", "打开使用教程", () => openTutorial(ctx), { class: "ea-btn ea-btn-soft ea-hero-tutorial" })
  )];
}
function catalogUnavailable(state) {
  if ((state.catalog?.groups?.length ?? 0) > 0) return void 0;
  return (state.catalog?.failures || []).find((item) => item?.code === CATALOG_UNAVAILABLE_CODE && item?.message);
}
function catalogEntries(state) {
  const entries = [];
  for (const group of state.catalog?.groups || []) {
    for (const entry of group.models || []) {
      const provider = String(entry.provider || group.provider || "");
      const id = String(entry.id || "");
      if (!provider || !id) continue;
      entries.push({ provider, id, name: String(entry.name || id), group: String(group.displayName || group.provider || "未命名提供方") });
    }
  }
  return entries;
}
function isSelectedModel(state, entry) {
  return Boolean(state.model && state.model.provider === entry.provider && state.model.model === entry.id);
}
function modelTriggerLabel(state) {
  if (catalogUnavailable(state)) return "模型目录未读到";
  if (!state.model) return "选择模型";
  const entry = catalogEntries(state).find((item) => isSelectedModel(state, item));
  return entry?.name || state.model.model;
}
var MODEL_PANEL_ID = "ea-model-panel";
function buildModelTrigger(getCtx) {
  const prefix = el("span", { class: "ea-model-trigger-prefix", "aria-hidden": "true", text: "模型" });
  const label = el("span", { class: "ea-model-trigger-label" });
  const warn = el("span", { class: "ea-model-trigger-warn", "aria-hidden": "true", text: "⚠" });
  const caret = el("span", { class: "ea-model-trigger-caret", "aria-hidden": "true", text: "▾" });
  const root = el("button", {
    type: "button",
    class: "ea-btn ea-btn-soft ea-model-trigger",
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
    "aria-controls": MODEL_PANEL_ID,
    // 未就绪/没读到之前不出现：见文件里「三档界面」的说明。
    hidden: true,
    onClick: () => {
      const ctx = getCtx();
      if (!ctx) return;
      if (ctx.modelOpen) closeModelPanel(ctx);
      else openModelPanel(ctx);
    }
  }, prefix, label, warn, caret);
  return { root, prefix, label, warn, caret };
}
function resetModelTrigger(ctx) {
  const trigger = ctx.modelTrigger;
  trigger.root.hidden = true;
  trigger.label.textContent = "";
  trigger.warn.textContent = "";
  trigger.prefix.textContent = "";
  trigger.caret.textContent = "";
  trigger.prefix.hidden = true;
  trigger.root.removeAttribute("data-unselected");
  trigger.root.removeAttribute("data-warn");
  trigger.root.setAttribute("aria-expanded", "false");
  trigger.root.setAttribute("aria-label", "模型选择（数据读取中不可用）");
  trigger.root.setAttribute("title", "模型选择（数据读取中不可用）");
}
function syncModelTrigger(ctx) {
  const state = ctx.state;
  const trigger = ctx.modelTrigger;
  const unavailable2 = catalogUnavailable(state);
  const failures = (state.catalog?.failures || []).filter((failure) => failure?.message);
  const warn = Boolean(failures.length) || Boolean(unavailable2);
  trigger.label.textContent = modelTriggerLabel(state);
  trigger.prefix.hidden = !state.model || Boolean(unavailable2);
  trigger.prefix.textContent = "模型";
  trigger.caret.textContent = "▾";
  trigger.warn.hidden = !warn;
  trigger.warn.textContent = warn ? "⚠" : "";
  trigger.root.setAttribute("data-unselected", state.model ? "false" : "true");
  trigger.root.setAttribute("data-warn", warn ? "true" : "false");
  trigger.root.setAttribute("aria-expanded", ctx.modelOpen ? "true" : "false");
  const detail = unavailable2 ? "没有读到模型目录，点开查看" : state.model ? "已选 " + state.model.provider + " / " + state.model.model + "，点开换一个" : "还没有选择模型，点这里选一个";
  const others = unavailable2 ? failures.length - 1 : failures.length;
  const extra = others > 0 ? "；另有 " + others + " 条提供方读取失败" : "";
  trigger.root.setAttribute("aria-label", "模型：" + detail + extra);
  trigger.root.setAttribute("title", "模型：" + detail + extra);
}
function buildModelPanel(getCtx) {
  const count = el("span", { class: "ea-count ea-model-panel-count" });
  const current = el("p", { class: "ea-model-panel-current" });
  const search = el("input", {
    type: "search",
    class: "ea-model-search",
    placeholder: "按名称筛选，例如 flash",
    "aria-label": "按名称筛选模型",
    autocomplete: "off"
  });
  const list = el("div", { class: "ea-model-list ea-model-panel-list", role: "group", "aria-label": "可选模型列表" });
  const failures = el("div", { class: "ea-model-panel-failures" });
  const refresh = button("刷新", "重新读取可用模型列表（绕开缓存）", () => {
    const ctx = getCtx();
    if (!ctx || !ctx.plugin.api?.models) return;
    refresh.disabled = true;
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("读取模型目录超时（等了 10 秒没有回应）。可以再点一次刷新。")), 1e4);
    });
    void Promise.race([ctx.plugin.api.models(), timeout]).then((result) => {
      const payload = result.payload || {};
      ctx.plugin.registry.update(ctx.state.sessionId, { catalog: payload });
    }).catch((error) => ctx.plugin.registry.update(ctx.state.sessionId, {
      error: error instanceof Error ? error.message : String(error)
    })).finally(() => {
      refresh.disabled = false;
    });
  }, { class: "ea-btn ea-btn-soft ea-model-panel-refresh" });
  const back = button("← 返回", "关闭模型选择，回到对话", () => {
    const ctx = getCtx();
    if (ctx) closeModelPanel(ctx);
  }, { class: "ea-btn ea-btn-quiet ea-model-panel-back" });
  const root = el(
    "section",
    {
      class: "ea-model-panel",
      id: MODEL_PANEL_ID,
      role: "dialog",
      "aria-modal": "false",
      "aria-labelledby": "ea-model-panel-title"
    },
    el(
      "div",
      { class: "ea-model-panel-head" },
      back,
      el("h3", { class: "ea-model-panel-title", id: "ea-model-panel-title", text: "选择模型" }),
      count,
      refresh
    ),
    current,
    el("div", { class: "ea-model-panel-filter" }, search),
    list,
    failures
  );
  search.addEventListener("input", () => {
    const ctx = getCtx();
    if (!ctx) return;
    ctx.modelQuery = search.value;
    renderModelList(ctx);
  });
  return { root, count, current, search, list, failures, refresh };
}
function ensureModelPanel(ctx) {
  if (!ctx.modelPanel) {
    ctx.modelPanel = buildModelPanel(() => ctx);
    ctx.modelPanelSlot.appendChild(ctx.modelPanel.root);
  }
  return ctx.modelPanel;
}
var MODEL_EXIT_MS = 220;
function prefersReducedMotion2() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function openModelPanel(ctx) {
  if (ctx.tutorialOpen) closeTutorial(ctx, { focus: false });
  ctx.modelCloseToken++;
  const panel = ensureModelPanel(ctx);
  if (panel.root.hasAttribute("data-closing")) {
    panel.root.removeAttribute("data-closing");
    panel.root.removeAttribute("aria-hidden");
  }
  ctx.modelQuery = "";
  if (panel.search.value) panel.search.value = "";
  ctx.modelOpen = true;
  ctx.root.removeAttribute("data-returning");
  ctx.root.setAttribute("data-view", "model");
  ctx.modelTrigger.root.setAttribute("aria-expanded", "true");
  renderModelPanel(ctx);
  queueMicrotask(() => {
    try {
      panel.search.focus({ preventScroll: true });
    } catch {
    }
  });
}
function closeModelPanel(ctx, options = {}) {
  const wasOpen = ctx.modelOpen;
  const panel = ctx.modelPanel;
  ctx.modelOpen = false;
  ctx.modelTrigger.root.setAttribute("aria-expanded", "false");
  ctx.root.setAttribute("data-view", ctx.tutorialOpen ? "tutorial" : "chat");
  const animate = options.animate !== false && Boolean(panel) && wasOpen && !prefersReducedMotion2();
  if (animate && panel) {
    panel.root.setAttribute("data-closing", "true");
    panel.root.setAttribute("aria-hidden", "true");
    const token = ++ctx.modelCloseToken;
    setTimeout(() => {
      if (ctx.modelCloseToken !== token || ctx.modelPanel !== panel) return;
      fill(ctx.modelPanelSlot, []);
      ctx.modelPanel = void 0;
    }, MODEL_EXIT_MS);
  } else {
    fill(ctx.modelPanelSlot, []);
    ctx.modelPanel = void 0;
  }
  if (wasOpen) {
    ctx.root.setAttribute("data-returning", "true");
  }
  if (wasOpen && options.focus !== false) ctx.modelTrigger.root.focus?.({ preventScroll: true });
}
function selectModelFromPanel(ctx, provider, id) {
  if (!ctx.plugin.api?.selectModel) return;
  const previous = ctx.plugin.registry.get(ctx.state.sessionId)?.model;
  ctx.plugin.registry.update(ctx.state.sessionId, { model: { provider, model: id, source: "explicit" }, error: void 0 });
  closeModelPanel(ctx);
  void ctx.plugin.api.selectModel(ctx.state.sessionId, { provider, model: id }).catch((error) => ctx.plugin.registry.update(ctx.state.sessionId, {
    model: previous,
    error: "选择模型失败：" + (error instanceof Error ? error.message : String(error))
  }));
}
function catalogNoticeNodes(ctx) {
  const recovered = ctx.state.recoveredCorrupt === true ? [el(
    "div",
    { class: "ea-catalog-note", role: "status" },
    el("span", { class: "ea-catalog-note-icon", "aria-hidden": "true", text: "⚠" }),
    el(
      "div",
      { class: "ea-catalog-note-text" },
      el("small", { class: "ea-model-failure", text: "这条对话的小助手记录文件损坏了：已把它改名备份到同目录（.corrupt.*），并从这里重新开始记录。备份文件还在，可以找回来。" })
    )
  )] : [];
  const failures = (ctx.state.catalog?.failures || []).filter((failure) => failure?.message);
  if (!failures.length) return recovered;
  return [...recovered, el(
    "div",
    { class: "ea-catalog-note", role: "status" },
    el("span", { class: "ea-catalog-note-icon", "aria-hidden": "true", text: "⚠" }),
    el(
      "div",
      { class: "ea-catalog-note-text" },
      ...failures.map((failure) => el("small", { class: "ea-model-failure", text: String(failure.message) }))
    ),
    button("查看", "打开模型选择页，查看各提供方的状态", () => openModelPanel(ctx), { class: "ea-btn ea-btn-quiet ea-catalog-note-open" })
  )];
}
function renderModelPanel(ctx) {
  const state = ctx.state;
  const panel = ensureModelPanel(ctx);
  const failures = (state.catalog?.failures || []).filter((failure) => failure?.message);
  panel.current.textContent = state.model ? "本对话已选 · " + state.model.provider + " / " + state.model.model : "还没有选择模型：请先选一个，小助手不会自动替你挑";
  panel.current.setAttribute("data-unselected", state.model ? "false" : "true");
  fill(panel.failures, failures.map((failure) => el("small", { class: "ea-model-failure", text: String(failure.message) })));
  panel.failures.hidden = failures.length === 0;
  renderModelList(ctx);
}
function renderModelList(ctx) {
  const state = ctx.state;
  const panel = ensureModelPanel(ctx);
  const entries = catalogEntries(state);
  const keyword = ctx.modelQuery.trim().toLowerCase();
  const matched = keyword ? entries.filter((entry) => entry.name.toLowerCase().includes(keyword) || entry.id.toLowerCase().includes(keyword) || entry.provider.toLowerCase().includes(keyword)) : entries;
  const groups = /* @__PURE__ */ new Map();
  for (const entry of matched) {
    const bucket = groups.get(entry.group);
    if (bucket) bucket.push(entry);
    else groups.set(entry.group, [entry]);
  }
  const nodes = [];
  for (const [name, bucket] of groups) {
    nodes.push(el(
      "div",
      { class: "ea-model-group" },
      el(
        "div",
        { class: "ea-model-group-name" },
        el("span", { text: name }),
        el("span", { class: "ea-count", text: String(bucket.length) })
      ),
      el("div", { class: "ea-model-options" }, ...bucket.map((entry) => {
        const selected = isSelectedModel(state, entry);
        return el(
          "button",
          {
            type: "button",
            class: "ea-btn ea-model-option",
            "aria-pressed": String(selected),
            "aria-label": (selected ? "当前已选：" : "选择模型 ") + entry.provider + "/" + entry.id,
            title: entry.provider + " / " + entry.id,
            onClick: () => selectModelFromPanel(ctx, entry.provider, entry.id)
          },
          el("span", { class: "ea-model-option-name", text: entry.name }),
          el("span", { class: "ea-model-option-id", text: entry.id }),
          el("span", { class: "ea-model-option-check", "aria-hidden": "true", text: selected ? "✓" : "" })
        );
      }))
    ));
  }
  if (!entries.length && !catalogUnavailable(state)) {
    nodes.push(el("p", { class: "ea-empty ea-model-empty", text: "暂时没有可用的模型，请先检查模型配置" }));
  } else if (!matched.length) {
    nodes.push(el("p", { class: "ea-empty ea-model-empty", text: "没有匹配「" + ctx.modelQuery.trim() + "」的模型。换个关键词，或清空筛选框。" }));
  }
  fill(panel.list, nodes);
  const unavailable2 = catalogUnavailable(state);
  const total = entries.length;
  if (unavailable2) {
    panel.count.textContent = "没有读到模型目录";
  } else if (keyword) {
    panel.count.textContent = "筛选出 " + matched.length + " / " + total + " 个";
  } else {
    panel.count.textContent = "共 " + total + " 个";
  }
}
function compactStatusOf(compact) {
  const status = compact.status ?? (compact.summary ? "complete" : "error");
  return status;
}
function compactNodes(state, ctx) {
  const compact = state.compactState;
  if (!compact) return [];
  const status = compactStatusOf(compact);
  if (status === "idle") return [];
  const running = status === "running";
  const failed = status === "error";
  const summary = typeof compact.summary === "string" ? compact.summary : "";
  const open = ctx.compactOpen === true && !running;
  const title = running ? "正在压缩上下文" : status === "complete" ? "上下文已压缩" : failed ? "上下文压缩失败" : "上下文压缩已中断";
  const line = running ? "正在整理小助手自己的上下文…" + (state.text ? "（已收到 " + state.text.length + " 字）" : "") : status === "complete" ? firstLineOf(summary) || "点击查看压缩摘要" : compact.error || "没有拿到可用的摘要";
  const row = el("section", {
    class: "ea-compact-row",
    "data-status": running ? "running" : status === "complete" ? "complete" : failed ? "error" : "interrupted",
    "data-open": open ? "true" : "false",
    "aria-label": "小助手上下文压缩"
  });
  const head = el("button", {
    type: "button",
    class: "ea-compact-head",
    "aria-expanded": open ? "true" : "false"
  });
  head.append(
    el("span", { class: "ea-compact-chevron", "aria-hidden": "true", text: "▸" }),
    el("span", { class: "ea-compact-title", text: title }),
    el("span", { class: "ea-compact-sep", "aria-hidden": "true" }),
    el("span", { class: "ea-compact-line", text: line })
  );
  if (running) head.setAttribute("disabled", "");
  else head.addEventListener("click", () => {
    const next = !(ctx.compactOpen === true);
    ctx.compactOpen = next;
    row.setAttribute("data-open", next ? "true" : "false");
    head.setAttribute("aria-expanded", next ? "true" : "false");
    if (next && typeof row.getBoundingClientRect === "function") {
      const r = row.getBoundingClientRect();
      const b = ctx.body.getBoundingClientRect();
      if (r.height > 0 && b.height > 0) ctx.body.scrollTop += r.top - b.top - 6;
    }
  });
  row.appendChild(head);
  const metaBits = [];
  if (compact.updatedAt) metaBits.push("压缩时间 " + timeText(compact.updatedAt));
  const before = typeof compact.beforeOccupancy === "number" ? compact.beforeOccupancy : void 0;
  const after = state.occupancyKnown && typeof state.occupancy === "number" ? state.occupancy : void 0;
  const beforeRounded = before !== void 0 ? Math.round(before) : void 0;
  const afterRounded = after !== void 0 ? Math.round(after) : void 0;
  if (beforeRounded !== void 0 && afterRounded !== void 0 && (beforeRounded > 0 || afterRounded > 0)) {
    metaBits.push("占用 " + beforeRounded + "% → " + afterRounded + "%");
  } else if (beforeRounded !== void 0 && beforeRounded > 0) {
    metaBits.push("压缩前占用 " + beforeRounded + "%");
  }
  const body = [];
  if (metaBits.length) body.push(el("small", { class: "ea-meta ea-compact-meta", text: metaBits.join(" · ") }));
  if (!running && status !== "complete") {
    body.push(el("p", {
      class: "ea-compact-error",
      role: "alert",
      text: (failed ? "压缩失败：" : "压缩已中断：") + (compact.error || "没有拿到可用的摘要")
    }));
    if (summary) body.push(el("small", { class: "ea-meta", text: "下面是上一次成功压缩的摘要，仍然可用。" }));
  }
  if (summary) body.push(el("div", { class: "ea-compact-summary ea-md-scope" }, ...cachedMarkdownNodes("compact-" + (compact.updatedAt || contentKey(summary)), summary)));
  else if (!running) body.push(el("p", { class: "ea-compact-hint", text: failed || status === "interrupted" ? "这次没有拿到可用的摘要。" : "没有可用的摘要正文。" }));
  if (status === "complete") body.push(el("div", { class: "ea-compact-actions" }, compactAction("重新压缩", "再压缩一次小助手上下文", ctx), compactCopyAction(summary)));
  else if (!running) body.push(el("div", { class: "ea-compact-actions" }, compactAction(failed ? "重试压缩" : "继续压缩", "再尝试压缩一次小助手上下文", ctx)));
  row.appendChild(el("div", { class: "ea-compact-body" }, ...body));
  return [row];
}
function recordStartedAt(input) {
  const record = input || {};
  const at = record.startedAt ?? record.createdAt;
  return typeof at === "string" ? at : "";
}
function compactBoundaryIndex(state, items) {
  const compact = state.compactState;
  if (!compact) return -1;
  const status = compactStatusOf(compact);
  if (status === "idle") return -1;
  if (status === "running") return items.length;
  const createdAt = typeof compact.createdAt === "string" ? compact.createdAt : "";
  if (!createdAt) return items.length;
  const index = items.findIndex((item) => {
    const at = recordStartedAt(item);
    return Boolean(at) && at > createdAt;
  });
  return index < 0 ? items.length : index;
}
function firstLineOf(text) {
  const plain = text.replace(/[#>*_`-]+/g, " ").replace(/\s+/g, " ").trim();
  return plain.length > 80 ? plain.slice(0, 80) : plain;
}
function compactAction(label, aria, ctx) {
  return button(label, aria, () => {
    if (!canSubmit(ctx.state)) return;
    void ctx.plugin.submit("/compact");
  }, { class: "ea-btn ea-btn-soft ea-compact-action" });
}
function compactCopyAction(summary) {
  const node2 = button("复制摘要", "把这份摘要复制到剪贴板", () => {
    const clipboard = (typeof navigator === "object" ? navigator : void 0)?.clipboard;
    const say = (text) => {
      node2.textContent = text;
      setTimeout(() => {
        node2.textContent = "复制摘要";
      }, 1600);
    };
    if (!clipboard?.writeText) {
      say("无法复制");
      return;
    }
    clipboard.writeText(summary).then(() => say("已复制"), () => say("复制失败"));
  }, { class: "ea-btn ea-btn-soft ea-compact-action" });
  return node2;
}
function tutorialNodes(ctx) {
  const rows = [];
  rows.push(el(
    "header",
    { class: "ea-tut-head" },
    el("h2", { class: "ea-tut-title", text: "解释小助手 · 使用教程" }),
    el("p", { class: "ea-tut-lead", text: "它就站在主对话旁边：读主 agent 的记录，把「它正在干什么、为什么错、下一步建议」讲成人话。" })
  ));
  rows.push(el(
    "section",
    { class: "ea-tut-sec" },
    el("h3", { class: "ea-tut-h", text: "先说三条边界" }),
    el(
      "ul",
      { class: "ea-tut-list" },
      el("li", { text: "只读：不改主对话、不替你发消息、不执行任何命令。" }),
      el("li", { text: "不独立干活：它不会自己去查主机或跑测试，讲的是主对话里已经发生的事。" }),
      el("li", { text: "拿不准就说「信息不足」，不猜、不编。" })
    )
  ));
  rows.push(el(
    "section",
    { class: "ea-tut-sec" },
    el("h3", { class: "ea-tut-h", text: "三步上手" }),
    el(
      "ol",
      { class: "ea-tut-steps" },
      el(
        "li",
        { class: "ea-tut-step" },
        el("strong", { text: "选一段内容（可选）" }),
        el("p", { text: "点右上角「选择主对话内容」，浮窗会让开；再点主对话里的步骤或工具卡片即可。想选多条就按住 Ctrl（Mac 是 ⌘）再点。Esc 或「完成」结束选择。" })
      ),
      el(
        "li",
        { class: "ea-tut-step" },
        el("strong", { text: "提问" }),
        el("p", { text: "在下面的输入框里问，或者点快捷问题。Enter 发送，Shift+Enter 换行。" })
      ),
      el(
        "li",
        { class: "ea-tut-step" },
        el("strong", { text: "看回答里的依据" }),
        el("p", { text: "每条结论后面都标着它凭什么这么说 —— 见下一节。" })
      )
    )
  ));
  rows.push(el(
    "section",
    { class: "ea-tut-sec" },
    el("h3", { class: "ea-tut-h", text: "「依据分级」是什么" }),
    el(
      "ul",
      { class: "ea-tut-tiers" },
      el("li", {}, el("span", { class: "ea-evidence-tier ea-tier-observed", text: "已观察到" }), el("span", { text: "真的跑出来的结果（工具输出、命令返回），有记录可查。" })),
      el("li", {}, el("span", { class: "ea-evidence-tier ea-tier-reported", text: "仅据汇报" }), el("span", { text: "只是主 agent 自己说它做了什么，还没看到实际结果。" })),
      el("li", {}, el("span", { class: "ea-evidence-tier ea-tier-unavailable", text: "信息不足" }), el("span", { text: "记录里没有能判定的内容 —— 这时它会直说，而不是编一个。" }))
    ),
    el("p", { class: "ea-tut-note", text: "为什么必须分三级：主 agent 说「已完成」和「真的跑完了」是两件事。前者只是它的话。" })
  ));
  rows.push(el(
    "section",
    { class: "ea-tut-sec" },
    el("h3", { class: "ea-tut-h", text: "标题栏那几颗按钮" }),
    el(
      "dl",
      { class: "ea-tut-keys" },
      el("dt", { text: "模型" }),
      el("dd", { text: "现在是哪个模型，点开可以换一个（只影响小助手自己）。" }),
      el("dt", { text: "选择主对话内容" }),
      el("dd", { text: "进出选择模式；选中的内容会钉在输入框上方，问完自动清掉。" }),
      el("dt", { text: "/compact" }),
      el("dd", { text: "把「小助手自己的上下文」压成一份摘要，省上下文；不影响主对话，摘要默认折叠。" }),
      el("dt", { text: "?" }),
      el("dd", { text: "就是这一页。" }),
      el("dt", { text: "×" }),
      el("dd", { text: "关闭（Esc）。关掉不丢记录，下次打开还在。" })
    )
  ));
  rows.push(el(
    "section",
    { class: "ea-tut-sec" },
    el("h3", { class: "ea-tut-h", text: "键盘" }),
    el(
      "dl",
      { class: "ea-tut-keys" },
      el("dt", {}, el("kbd", { text: "Enter" })),
      el("dd", { text: "发送" }),
      el("dt", {}, el("kbd", { text: "Shift" }), el("span", { text: " + " }), el("kbd", { text: "Enter" })),
      el("dd", { text: "换行" }),
      el("dt", {}, el("kbd", { text: "Esc" })),
      el("dd", { text: "退出选择模式 / 关闭浮窗" }),
      el("dt", {}, el("kbd", { text: "Ctrl" }), el("span", { text: " / " }), el("kbd", { text: "⌘" }), el("span", { text: " + 点击" })),
      el("dd", { text: "多选内容" }),
      el("dt", { text: "方向键" }),
      el("dd", { text: "标题栏获得焦点时移动窗口" }),
      el("dt", { text: "拖边 / 拖角" }),
      el("dd", { text: "像普通窗口一样改大小" })
    )
  ));
  rows.push(el(
    "section",
    { class: "ea-tut-sec" },
    el("h3", { class: "ea-tut-h", text: "上下文与占用" }),
    el(
      "div",
      { class: "ea-tut-two" },
      el(
        "div",
        {},
        el("strong", { text: "会被算进上下文的" }),
        el(
          "ul",
          { class: "ea-tut-list" },
          el("li", { text: "主 agent 最近这一段的过程（超长会被截断）" }),
          el("li", { text: "你和小助手的问答" }),
          el("li", { text: "你选中的那几条内容" })
        )
      ),
      el(
        "div",
        {},
        el("strong", { text: "不进上下文的" }),
        el(
          "ul",
          { class: "ea-tut-list" },
          el("li", { text: "主对话的全部历史" }),
          el("li", { text: "小助手的旧记录（除非你自己翻出来问）" }),
          el("li", { text: "它读不到的文件" })
        )
      )
    ),
    el("p", { class: "ea-tut-note", text: "输入框左边那个圆环是当前占用；标着「估算」表示是推算值。鼠标移上去可以看到两块各占多少。" })
  ));
  const faq = [
    ["它说「信息不足」是什么意思？", "记录里没有能判定这件事的内容。这时它不会猜 —— 你可以先选中相关的那一步，再问一次。"],
    ["会不会动我的文件或命令？", "不会。它只读主对话的记录；工具和命令都是主 agent 在跑。"],
    ["会不会花我很多 token？", "每一问都会带上一段上下文，圆环显示当前占用。觉得太高就按 /compact 压成一份摘要。"],
    ["关掉浮窗后记录还在吗？", "在。记录按会话保存，重新打开还是那些内容；会话归档后会被清掉。"]
  ];
  rows.push(el(
    "section",
    { class: "ea-tut-sec" },
    el("h3", { class: "ea-tut-h", text: "常见问题" }),
    el(
      "div",
      { class: "ea-tut-faq" },
      ...faq.map(([question, answer]) => el(
        "details",
        { class: "ea-tut-q" },
        el("summary", { text: question }),
        el("p", { class: "ea-tut-a", text: answer }),
        button("问它一句", "把这个问题发给小助手", () => {
          if (!canSubmit(ctx.state)) return;
          closeTutorial(ctx, { focus: false });
          void ctx.plugin.submit(question);
        }, { class: "ea-btn ea-btn-soft ea-tut-ask" })
      ))
    )
  ));
  rows.push(el(
    "footer",
    { class: "ea-tut-foot" },
    el("small", { class: "ea-meta", text: "解释小助手 v0.3.0 · 只读 · 记录留在本机" }),
    button("回到对话", "关闭教程，回到对话", () => closeTutorial(ctx), { class: "ea-btn ea-btn-soft" })
  ));
  return rows;
}
function buildTutorialPanel(getCtx) {
  const body = el("div", { class: "ea-tut-body" });
  const back = button("返回对话", "关闭使用教程", () => {
    const ctx = getCtx();
    if (ctx) closeTutorial(ctx);
  }, { class: "ea-btn ea-btn-soft ea-tut-back" });
  const root = el(
    "section",
    { class: "ea-page ea-tutorial-panel", "aria-label": "使用教程", tabindex: "-1" },
    el("header", { class: "ea-tut-bar" }, el("span", { class: "ea-tut-bar-title", text: "使用教程" }), back),
    body
  );
  return { root, body, back };
}
function ensureTutorialPanel(ctx) {
  if (!ctx.tutorialPanel) {
    ctx.tutorialPanel = buildTutorialPanel(() => ctx);
    ctx.tutorialSlot.appendChild(ctx.tutorialPanel.root);
  }
  return ctx.tutorialPanel;
}
function renderTutorial(ctx) {
  const panel = ensureTutorialPanel(ctx);
  fill(panel.body, tutorialNodes(ctx));
}
function openTutorial(ctx) {
  if (ctx.modelOpen) closeModelPanel(ctx, { focus: false, animate: false });
  ctx.tutorialCloseToken++;
  const panel = ensureTutorialPanel(ctx);
  if (panel.root.hasAttribute("data-closing")) {
    panel.root.removeAttribute("data-closing");
    panel.root.removeAttribute("aria-hidden");
  }
  ctx.tutorialOpen = true;
  ctx.tutorialBtn.setAttribute("aria-expanded", "true");
  ctx.root.removeAttribute("data-returning");
  ctx.root.setAttribute("data-view", "tutorial");
  renderTutorial(ctx);
  queueMicrotask(() => {
    try {
      panel.back.focus({ preventScroll: true });
    } catch {
    }
  });
}
function closeTutorial(ctx, options = {}) {
  const wasOpen = ctx.tutorialOpen;
  ctx.tutorialOpen = false;
  ctx.tutorialBtn.setAttribute("aria-expanded", "false");
  ctx.root.setAttribute("data-view", ctx.modelOpen ? "model" : "chat");
  const panel = ctx.tutorialPanel;
  if (wasOpen && panel && !prefersReducedMotion2()) {
    panel.root.setAttribute("data-closing", "true");
    panel.root.setAttribute("aria-hidden", "true");
    const token = ++ctx.tutorialCloseToken;
    setTimeout(() => {
      if (ctx.tutorialCloseToken !== token || ctx.tutorialPanel !== panel) return;
      fill(ctx.tutorialSlot, []);
      ctx.tutorialPanel = void 0;
    }, MODEL_EXIT_MS);
  } else {
    fill(ctx.tutorialSlot, []);
    ctx.tutorialPanel = void 0;
  }
  if (wasOpen) ctx.root.setAttribute("data-returning", "true");
  if (wasOpen && options.focus !== false) {
    try {
      ctx.tutorialBtn.focus({ preventScroll: true });
    } catch {
    }
  }
}
function evidenceTierOf(item) {
  if (item.evidenceState === "observed") {
    return { key: "observed", label: "已观察到", hint: "这是实际跑出来的结果或输出，有记录可查。" };
  }
  if (item.evidenceState === "reported_only") {
    return { key: "reported", label: "仅据汇报", hint: "这只是主 agent 自己说它做了什么，还没有看到实际结果。" };
  }
  if (item.evidenceState === "unavailable") {
    return { key: "unavailable", label: "无从得知", hint: "这条当时还没结束，或者拿不到可读内容，不能当作已验证。" };
  }
  return { key: "unknown", label: "未分级", hint: "这条依据没有带分级信息。" };
}
function evidenceLabel(item) {
  const title = (item.title || "").trim();
  if (!title) return "正文片段";
  if (title === "assistant-step") return "助手汇报";
  if (title === "turn-tail") return "本轮汇报";
  if (title === "turn-process") return "处理过程";
  if (title === "tool-call") return "工具调用";
  if (title === "user" || title === "input-message" || title === "request-prompt") return "你的提问";
  return "工具 · " + title;
}
function evidenceSnippet(item, max = 28) {
  const text = String(item.summary || "").replace(/\s+/g, " ").trim();
  if (!text) return "（没有可见摘要）";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
function pickKeyOf(item) {
  return String(item.pickId || item.id || "");
}
function pickChipsOf(state) {
  return state.evidence.filter((item) => item && (item.title || item.summary)).map((item) => ({ key: pickKeyOf(item), item, label: evidenceLabel(item), snippet: evidenceSnippet(item), tier: evidenceTierOf(item) }));
}
function removePick(ctx, item) {
  const key = pickKeyOf(item);
  ctx.plugin.registry.update(ctx.state.sessionId, (current) => {
    current.evidence = current.evidence.filter((existing) => pickKeyOf(existing) !== key);
  });
}
var PICK_CHIP_EXIT_MS = 180;
var chipEntries = /* @__PURE__ */ new WeakMap();
function syncSelectBar(ctx, state) {
  const text = "已选 " + state.evidence.length + " 条";
  if (ctx.selectBarCount.textContent !== text) ctx.selectBarCount.textContent = text;
}
function renderPickRow(ctx) {
  const row = ctx.targetBar;
  const chips = pickChipsOf(ctx.state);
  let live = chipEntries.get(row);
  if (!live) {
    live = /* @__PURE__ */ new Map();
    chipEntries.set(row, live);
  }
  const map = live;
  const wanted = new Set(chips.map((chip) => chip.key));
  for (const [key, entry] of Array.from(map)) {
    if (wanted.has(key) || entry.timer) continue;
    if (prefersReducedMotion2()) {
      entry.node.remove();
      map.delete(key);
      continue;
    }
    entry.node.setAttribute("data-leaving", "true");
    entry.timer = setTimeout(() => {
      entry.node.remove();
      map.delete(key);
      if (!map.size) {
        row.replaceChildren();
        row.setAttribute("data-has-target", "false");
      }
    }, PICK_CHIP_EXIT_MS);
  }
  if (chips.length && !row.querySelector(".ea-pick-lead")) {
    row.appendChild(el("span", { class: "ea-pick-lead", text: "这一问围绕" }));
  }
  chips.forEach((chip, index) => {
    let entry = map.get(chip.key);
    if (!entry) {
      const indexEl = el("span", { class: "ea-pick-index" });
      const labelEl = el("span", { class: "ea-pick-label" });
      const snippetEl = el("span", { class: "ea-pick-snippet" });
      const node2 = el(
        "span",
        { class: "ea-pick-chip" },
        indexEl,
        labelEl,
        snippetEl,
        button("×", "取消这条选择", () => removePick(ctx, chip.item), { class: "ea-pick-remove" })
      );
      entry = { node: node2, index: indexEl, label: labelEl, snippet: snippetEl };
      map.set(chip.key, entry);
      row.appendChild(node2);
    } else if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = void 0;
      entry.node.removeAttribute("data-leaving");
    }
    entry.node.setAttribute("data-tier", chip.tier.key);
    entry.node.setAttribute("title", chip.label + "：" + chip.snippet + "\n" + chip.tier.label + " · " + chip.tier.hint);
    entry.index.textContent = String(index + 1);
    entry.label.textContent = chip.label;
    entry.snippet.textContent = chip.snippet;
  });
  const leaving = Array.from(map.values()).some((entry) => entry.timer);
  row.setAttribute("data-has-target", chips.length || leaving ? "true" : "false");
  if (!chips.length && !leaving) {
    row.replaceChildren();
    map.clear();
  }
}
function resetPickRow(ctx) {
  const map = chipEntries.get(ctx.targetBar);
  if (map) {
    for (const entry of map.values()) if (entry.timer) clearTimeout(entry.timer);
    map.clear();
  }
  ctx.targetBar.replaceChildren();
  ctx.targetBar.removeAttribute("data-has-target");
}
function evidenceNodes(state, plugin) {
  if (!state.evidence.length) return [];
  const rows = state.evidence.map((item) => {
    const tier = evidenceTierOf(item);
    return el(
      "article",
      { class: "dsh-explain-assistant-evidence-row ea-evidence-row" },
      el(
        "div",
        { class: "ea-row-head" },
        el("strong", { class: "ea-evidence-title", text: evidenceLabel(item) }),
        el("span", { class: "ea-evidence-tier ea-tier-" + tier.key, text: tier.label, title: tier.hint }),
        button("移除", "移除这条依据", () => plugin.registry.update(state.sessionId, (current) => {
          current.evidence = current.evidence.filter((existing) => existing.id !== item.id);
        }), { class: "ea-btn ea-btn-quiet" })
      ),
      el("small", { class: "ea-meta", text: [item.source, item.capturedAt ? new Date(item.capturedAt).toLocaleTimeString("zh-CN") : ""].filter(Boolean).join(" · ") }),
      el("p", { class: "ea-evidence-summary", text: item.summary || "没有可见摘要" }),
      el("small", { class: "ea-evidence-tier-hint", text: tier.hint })
    );
  });
  return [el(
    "details",
    { class: "dsh-explain-assistant-evidence ea-card ea-evidence-details" },
    el(
      "summary",
      { class: "ea-evidence-fold" },
      el("span", { class: "ea-card-title", text: "已选依据" }),
      el("span", { class: "ea-count ea-count-inline", text: String(state.evidence.length) }),
      el("small", { class: "ea-evidence-fold-hint", text: "展开看原文与分级" })
    ),
    ...rows
  )];
}
function contentKey(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}
var TURN_FOLD_CHARS = 420;
function recordAnswerText(record) {
  const value = record;
  const text = typeof value?.answerText === "string" && value.answerText ? value.answerText : value?.answer;
  return typeof text === "string" ? text : "";
}
function recordReasoningText(record) {
  const value = record;
  const text = typeof value?.reasoningText === "string" && value.reasoningText ? value.reasoningText : value?.reasoning;
  return typeof text === "string" ? text : "";
}
function recordIdOf(record) {
  const value = record?.id;
  return typeof value === "string" ? value : "";
}
function historyTurnNodes(input, ctx, newestId) {
  const record = input || {};
  const id = recordIdOf(record);
  const question = String(record.question || "");
  const answer = recordAnswerText(record);
  const reasoning = recordReasoningText(record);
  const at = record.startedAt ?? record.createdAt;
  const status = String(record.status || "");
  const incomplete = record.incomplete === true || status === "interrupted" || status === "error" || record.complete === false;
  const reasonText = recordReasonText(record.reason);
  const warnText = incomplete ? reasonText ? RECORD_REASON_PREFIX + reasonText : RECORD_INCOMPLETE_TEXT : "";
  const expanded = ctx.expandedIds.has(id);
  const longEnough = answer.length > TURN_FOLD_CHARS;
  const folded = Boolean(answer) && longEnough && !expanded && id !== newestId;
  const nodes = [];
  if (question) nodes.push(el("div", { class: "ea-turn-q", text: question }));
  const time = timeText(at);
  if (time) nodes.push(el("div", { class: "ea-turn-meta", text: time }));
  if (answer) {
    const key = id || "turn#" + contentKey(question + "\0" + answer);
    nodes.push(el("div", {
      class: "ea-turn-a ea-md-scope",
      "data-folded": folded ? "true" : "false"
    }, ...cachedMarkdownNodes(key, answer)));
  }
  if (reasoning) {
    nodes.push(el(
      "details",
      { class: "ea-turn-reason ea-disclosure" },
      el("summary", {}, "推理过程"),
      el("div", { class: "ea-disclosure-body ea-md-scope" }, ...cachedMarkdownNodes(id || "turn-reasoning#" + contentKey(reasoning), reasoning))
    ));
  }
  const tools = Array.isArray(record.tools) ? record.tools : [];
  if (tools.length) {
    const failedCount = tools.filter((tool) => tool?.status === "error").length;
    nodes.push(el(
      "details",
      { class: "ea-turn-tools ea-disclosure" },
      el("summary", {}, "工具过程 · " + tools.length + " 步" + (failedCount ? "（" + failedCount + " 个失败）" : "")),
      el(
        "div",
        { class: "ea-disclosure-body ea-tool-list" },
        ...tools.map((tool) => {
          const status2 = tool?.status === "running" ? "进行中" : tool?.status === "error" ? "失败" : "完成";
          const name = String(tool?.label || tool?.name || "工具");
          const detail = typeof tool?.detail === "string" ? tool.detail : "";
          return el(
            "div",
            { class: "ea-tool-row", "data-status": tool?.status === "error" ? "error" : "ok" },
            el("span", { class: "ea-tool-row-name", text: name }),
            el("span", { class: "ea-tool-row-status", text: status2 }),
            detail ? el("p", { class: "ea-tool-detail", text: detail }) : null
          );
        })
      )
    ));
  }
  const foot = [];
  const toggleFold = () => {
    const turn = findHistoryTurn(ctx, id);
    const answer2 = turn ? turn.querySelector(".ea-turn-a") : null;
    const toggle = turn ? turn.querySelector(".ea-turn-more") : null;
    const expand = Boolean(answer2 && answer2.getAttribute("data-folded") === "true");
    if (expand) ctx.expandedIds.add(id);
    else ctx.expandedIds.delete(id);
    if (!answer2 || !toggle || typeof answer2.animate !== "function" || prefersReducedMotion2()) {
      ctx.rerender();
      return;
    }
    if (ctx.lastWin) ctx.historySig = historySignature(ctx, ctx.state, ctx.lastWin);
    animateFold(answer2, toggle, expand, () => {
      scheduleFoldCheck(ctx);
    });
  };
  if (folded) foot.push(button("展开全文", "展开这条回答的全文", () => {
    toggleFold();
  }, { class: "ea-turn-more", expanded: false }));
  else if (expanded && longEnough) foot.push(button("收起", "收起这条回答", () => {
    toggleFold();
  }, { class: "ea-turn-more", expanded: true }));
  const hasMaterial = recordMaterialCount(record) > 0;
  if (id && hasMaterial && ctx.state.historyDetail?.recordId !== id) {
    foot.push(button("查看完整内容", "查看这条记录的依据与工具过程", () => {
      void ctx.plugin.openHistoryDetail?.(id);
    }, { class: "ea-turn-detail" }));
  }
  if (warnText) foot.push(el("span", { class: "ea-warn ea-turn-warn", text: warnText }));
  if (foot.length) nodes.push(el("div", { class: "ea-turn-foot" }, ...foot));
  return nodes;
}
function placeDetailPanel(ctx) {
  const body = ctx.body;
  const turn = ctx.root.querySelector('.ea-turn[data-detail-open="true"]');
  const row = turn && turn.querySelector(".ea-turn-foot") || turn;
  const panel = turn && turn.querySelector(".dsh-explain-assistant-detail") || ctx.detailSlot.querySelector(".dsh-explain-assistant-detail");
  if (typeof body.getBoundingClientRect !== "function" || !row || typeof row.getBoundingClientRect !== "function" || !panel || typeof panel.getBoundingClientRect !== "function") return false;
  const view = body.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const rect = panel.getBoundingClientRect();
  const margin = 14;
  const top = view.top + margin;
  const bottom = view.bottom - margin;
  if (rect.top >= top && rect.bottom <= bottom) return true;
  let delta;
  if (rect.height <= bottom - top) {
    delta = rect.bottom > bottom ? rect.bottom - bottom : rect.top - top;
    if (rowRect.top - delta < top) delta = rowRect.top - top;
  } else {
    delta = rowRect.top - top;
  }
  if (Math.abs(delta) >= 1) body.scrollTop += delta;
  return true;
}
function scrollDetailIntoView(ctx) {
  if (!placeDetailPanel(ctx)) ctx.body.scrollTop = 0;
}
function historyOlderNode(state, plugin, ctx, win) {
  const known = win.start;
  const askHost = known === 0 && state.hasEarlier;
  if (known === 0 && !askHost) return null;
  const loading = state.loadingEarlier === true;
  const label = loading ? "正在加载…" : known > 0 ? "更早的 " + known + " 条" : "加载更早的记录";
  return el(
    "div",
    { class: "ea-conv-older" },
    button(label, "往前翻更早的历史", () => {
      if (loading) return;
      const remember = () => {
        const body = ctx.body;
        if (typeof body.getBoundingClientRect !== "function") return;
        const bodyTop = body.getBoundingClientRect().top;
        const turns = Array.from(ctx.historySlot.querySelectorAll(".ea-turn"));
        const first = turns.find((turn) => {
          const rect = turn.getBoundingClientRect();
          return rect.bottom > bodyTop + 4;
        }) || turns[0];
        const id = first?.getAttribute("data-record-id") || "";
        if (id) ctx.anchor = { id, top: first.getBoundingClientRect().top };
      };
      if (askHost) {
        void Promise.resolve(plugin.loadEarlier?.()).then(() => {
          ctx.pendingOlder = HISTORY_BATCH;
          remember();
          ctx.rerender();
        }).catch(() => void 0);
      } else {
        ctx.pendingOlder = HISTORY_BATCH;
        remember();
        ctx.rerender();
      }
    }, { class: "ea-conv-older-btn", disabled: loading })
  );
}
function historyJumpNode(ctx) {
  return button("↓", "回到最近的历史", () => {
    ctx.historyWindow = void 0;
    ctx.scrollToTail = true;
    ctx.rerender();
  }, { class: "ea-conv-jump-btn", title: "回到最近" });
}
function historyNodes(state, plugin, ctx, win) {
  const compactAt = compactBoundaryIndex(state, win.items);
  const compactSlot = compactAt >= 0 ? ctx.compactSlot : null;
  if (!state.records.length) {
    return [
      compactSlot,
      el("p", { class: "dsh-explain-assistant-empty ea-empty", text: "还没有小助手历史" })
    ];
  }
  const hasJump = win.end < win.total;
  const children = [
    el(
      "div",
      { class: "ea-conv-head" },
      el("span", { class: "ea-conv-title", text: "历史" }),
      el("span", { class: "ea-conv-count", text: win.total + " 条" })
    ),
    historyOlderNode(state, plugin, ctx, win)
  ];
  const newestId = recordIdOf(win.items[win.items.length - 1]);
  for (let index = 0; index < win.items.length; index++) {
    if (index === compactAt) children.push(ctx.compactSlot);
    const record = win.items[index];
    const id = recordIdOf(record);
    const nodes = historyTurnNodes(record, ctx, newestId);
    const detailOpen = Boolean(id) && state.historyDetail?.recordId === id;
    if (detailOpen) {
      ctx.detailInline = true;
      nodes.push(...historyDetailNodes(state, plugin, { inlineOfTurn: true }));
    }
    children.push(el("article", {
      class: "ea-turn",
      "data-record-id": id || void 0,
      "data-detail-open": detailOpen ? "true" : void 0,
      // 只有「刚落地的那一条」进场时动一下；后续重画不重播（由 ctx.enteredTurnId 控制）。
      "data-enter": ctx.pendingEnterId && ctx.pendingEnterId === id ? "true" : void 0
    }, ...nodes));
  }
  if (compactSlot && compactAt >= win.items.length) children.push(ctx.compactSlot);
  if (hasJump) children.push(historyJumpNode(ctx));
  return [el("section", { class: "dsh-explain-assistant-history ea-conv" + (hasJump ? " has-jump" : ""), "aria-label": "历史问答" }, ...children)];
}
function recordMaterialCount(record) {
  const value = record || {};
  const size = (item) => Array.isArray(item) ? item.length : 0;
  return size(value.evidence) + size(value.tools) + size(value.images);
}
function historyDetailNodes(state, plugin, options = {}) {
  const detail = state.historyDetail;
  if (!detail) return [];
  const record = detail.record || {};
  const counts = detail.counts || {};
  const evidence = Array.isArray(record.evidence) ? record.evidence : [];
  const tools = Array.isArray(record.tools) ? record.tools : [];
  const images = Array.isArray(record.images) ? record.images : [];
  const total = Math.max(counts.evidence || 0, counts.tools || 0, counts.images || 0);
  const rows = [el(
    "div",
    { class: "ea-card-head" },
    el("h3", { class: "ea-card-title", text: "这条记录的完整内容" }),
    button("收起", "收起完整内容", () => plugin.closeHistoryDetail?.(), { class: "ea-btn ea-btn-quiet" })
  )];
  const detailCard = (all) => el(
    "section",
    { class: "dsh-explain-assistant-detail ea-card ea-detail" },
    all[0],
    el("div", { class: "ea-detail-scroll" }, ...all.slice(1))
  );
  if (detail.status === "loading" && !evidence.length && !tools.length && !images.length) {
    rows.push(el("p", { class: "ea-detail-status", role: "status", text: "正在读取这条记录的完整内容…" }));
    return [detailCard(rows)];
  }
  if (detail.status === "error") {
    rows.push(el("p", { class: "ea-detail-error ea-error", role: "alert", text: detail.error || "这条记录的完整内容没有取到。" }));
    return [detailCard(rows)];
  }
  if (record.question && !options.inlineOfTurn) rows.push(el("p", { class: "ea-detail-question", text: "问题：" + String(record.question) }));
  const answer = typeof record.answerText === "string" && record.answerText ? record.answerText : record.answer;
  if (answer && !options.inlineOfTurn) rows.push(el("article", { class: "ea-detail-answer ea-md-scope" }, ...cachedMarkdownNodes("detail-" + (detail.recordId || "rec#" + contentKey(String(answer))), String(answer))));
  const reasoning = typeof record.reasoningText === "string" && record.reasoningText ? record.reasoningText : record.reasoning;
  if (reasoning && !options.inlineOfTurn) rows.push(el(
    "details",
    { class: "ea-disclosure" },
    el("summary", {}, "完整推理过程"),
    el("div", { class: "ea-disclosure-body ea-md-scope" }, ...cachedMarkdownNodes("detail-reasoning-" + (detail.recordId || "rec#" + contentKey(String(reasoning))), String(reasoning)))
  ));
  if (evidence.length) {
    rows.push(el("h4", { class: "ea-detail-subtitle", text: "完整依据（共 " + (counts.evidence || evidence.length) + " 条，已显示 " + evidence.length + " 条）" }));
    for (const item of evidence) {
      rows.push(el(
        "article",
        { class: "ea-detail-evidence" },
        el("strong", { text: String(item?.title || item?.kind || "未命名依据") }),
        el("small", { class: "ea-meta", text: [item?.source, item?.evidenceState, item?.capturedAt].filter(Boolean).join(" · ") }),
        item?.summary ? el("p", { text: String(item.summary) }) : null,
        item?.command ? el("pre", { class: "ea-pre", text: String(item.command) }) : null,
        item?.output !== void 0 ? el("pre", { class: "ea-pre", text: typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2) }) : null,
        item?.truncated ? el("small", { class: "ea-warn", text: "原始依据仍有未取回的部分" }) : null
      ));
    }
  }
  if (tools.length) {
    rows.push(el("h4", { class: "ea-detail-subtitle", text: "完整工具过程（共 " + (counts.tools || tools.length) + " 个，已显示 " + tools.length + " 个）" }));
    for (const tool of tools) {
      rows.push(el(
        "article",
        { class: "ea-detail-tool" },
        el("strong", { text: String(tool?.tool || "工具") + " · " + (tool?.status === "error" ? "失败" : tool?.status === "ok" ? "完成" : String(tool?.status || "")) }),
        tool?.arguments !== void 0 ? el("pre", { class: "ea-pre", text: JSON.stringify(tool.arguments, null, 2) }) : null,
        tool?.result !== void 0 ? el("pre", { class: "ea-pre", text: typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result, null, 2) }) : null
      ));
    }
  }
  if (images.length) {
    rows.push(el("h4", { class: "ea-detail-subtitle", text: "图片快照（共 " + (counts.images || images.length) + " 张，已显示 " + images.length + " 张）" }));
    for (const image of images) {
      rows.push(el("p", { class: "ea-detail-image", text: [image?.relativePath, image?.mediaType, image?.bytes !== void 0 ? image.bytes + " 字节" : ""].filter(Boolean).join(" · ") }));
    }
  }
  if (!evidence.length && !tools.length && !images.length && (!answer || options.inlineOfTurn)) {
    rows.push(el("p", { class: "ea-empty", text: "这条记录里没有可展开的依据或工具过程。" }));
  }
  if (detail.hasEarlier) {
    rows.push(button(detail.loadingMore ? "正在加载…" : "继续加载完整内容", "继续加载这条记录剩下的完整内容", () => {
      if (!detail.loadingMore) void plugin.loadMoreHistoryDetail?.();
    }, { class: "ea-btn ea-btn-quiet ea-detail-more", disabled: detail.loadingMore, title: total ? "共 " + total + " 项，还有一些没显示" : void 0 }));
  } else if (total > 0) {
    rows.push(el("small", { class: "ea-meta", text: "这条记录的完整内容已经全部显示。" }));
  }
  if (detail.error) rows.push(el("p", { class: "ea-detail-error ea-error", role: "alert", text: detail.error }));
  return [detailCard(rows)];
}
function occupancyPartsText(parts) {
  if (!parts || typeof parts !== "object") return void 0;
  const main = typeof parts.mainAgentTokens === "number" && Number.isFinite(parts.mainAgentTokens) ? Math.max(0, parts.mainAgentTokens) : 0;
  const own = typeof parts.ownTokens === "number" && Number.isFinite(parts.ownTokens) ? Math.max(0, parts.ownTokens) : 0;
  const total = main + own;
  if (total <= 0) return void 0;
  const short = (value) => value >= 1e3 ? (value / 1e3).toFixed(1) + "k" : String(value);
  const mainPercent = Math.round(main / total * 100);
  const ownPercent = 100 - mainPercent;
  const extra = parts.mainlineTruncated ? "（主 agent 部分已截断到上限）" : "";
  return "主 agent 转移 " + short(main) + " / 小助手对话 " + short(own) + "，约 " + mainPercent + "% / " + ownPercent + "%" + extra;
}
function ringNode(state) {
  const box = el("div", { class: "dsh-explain-assistant-ring ea-ring" });
  const known = Boolean(state.occupancyKnown) && typeof state.occupancy === "number";
  const percent = known ? Math.min(100, Math.max(0, Math.round(state.occupancy))) : 0;
  const partsText = occupancyPartsText(state.occupancyParts);
  if (partsText) box.setAttribute("title", partsText);
  box.setAttribute("role", "img");
  const baseLabel = known ? "上下文占用约 " + percent + "%" + (state.occupancyEstimated ? "（估算值）" : "") : "上下文占用未知";
  box.setAttribute("aria-label", partsText ? baseLabel + "。构成：" + partsText : baseLabel);
  if (state.occupancyEstimated && known) box.setAttribute("data-estimated", "true");
  if (!known) box.setAttribute("data-unknown", "true");
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.setAttribute("width", "30");
  svg.setAttribute("height", "30");
  svg.setAttribute("class", "dsh-explain-assistant-ring-svg");
  const RADIUS = 15.9155;
  const track = document.createElementNS(NS, "circle");
  track.setAttribute("cx", "18");
  track.setAttribute("cy", "18");
  track.setAttribute("r", String(RADIUS));
  track.setAttribute("fill", "none");
  track.setAttribute("stroke-width", "4.2");
  track.setAttribute("class", "dsh-explain-assistant-ring-track");
  svg.appendChild(track);
  if (known) {
    const arc = document.createElementNS(NS, "circle");
    arc.setAttribute("cx", "18");
    arc.setAttribute("cy", "18");
    arc.setAttribute("r", String(RADIUS));
    arc.setAttribute("fill", "none");
    arc.setAttribute("stroke-width", "4.2");
    arc.setAttribute("stroke-linecap", "round");
    arc.setAttribute("class", "dsh-explain-assistant-ring-arc");
    arc.setAttribute("stroke-dasharray", percent + " " + (100 - percent));
    arc.setAttribute("transform", "rotate(-90 18 18)");
    svg.appendChild(arc);
  }
  box.append(svg, el("span", { class: "dsh-explain-assistant-ring-label ea-ring-label", text: known ? percent + "%" : "占用未知" }));
  if (known && state.occupancyEstimated) box.appendChild(el("small", { class: "dsh-explain-assistant-ring-estimated ea-ring-estimated", text: "估算" }));
  return box;
}
var contexts = /* @__PURE__ */ new WeakMap();
function renderOverlay(state, plugin, initialGeometry) {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : previouslyFocused;
  const like = plugin;
  const root = el("section", {
    class: "dsh-explain-assistant-overlay ea-overlay",
    role: "dialog",
    "aria-modal": "false",
    "aria-labelledby": "dsh-explain-assistant-title"
  });
  root.tabIndex = -1;
  mountPageSelection(root);
  const titlebar = el("header", { class: "dsh-explain-assistant-titlebar ea-header", "data-drag-handle": "true", tabindex: "0", "aria-label": "拖动解释小助手窗口；使用方向键移动" });
  const phase = el("span", { class: "dsh-explain-assistant-status ea-phase", "aria-live": "polite" });
  const close = button("×", "关闭解释小助手", () => {
    const current = contexts.get(root);
    if (current?.plugin.close) current.plugin.close();
    else current?.plugin.registry.close(state.sessionId);
    previouslyFocused?.focus();
    previouslyFocused = null;
  }, { class: "dsh-explain-assistant-close ea-close", title: "关闭（Esc）" });
  const leaveSelectionMode = () => {
    if (!root.hasAttribute("data-selection-mode")) return;
    root.removeAttribute("data-selection-mode");
    select.setAttribute("aria-pressed", "false");
    select.textContent = "选择主对话内容";
    selectionStatus.textContent = "";
    document.removeEventListener("keydown", escapeWhileSelecting, true);
    document.documentElement?.removeAttribute("data-ea-selecting");
    selectBar.remove();
    queueMicrotask(() => {
      try {
        select.focus({ preventScroll: true });
      } catch {
      }
    });
    document.dispatchEvent(new CustomEvent("dsh-explain-assistant:select-exit", { detail: { sessionId: state.sessionId } }));
  };
  const escapeWhileSelecting = (event) => {
    if (event.key !== "Escape" || !root.hasAttribute("data-selection-mode")) return;
    event.preventDefault();
    event.stopPropagation();
    leaveSelectionMode();
  };
  const enterSelectionMode = () => {
    root.setAttribute("data-selection-mode", "true");
    select.setAttribute("aria-pressed", "true");
    select.textContent = "退出选择模式";
    selectionStatus.textContent = "";
    document.documentElement?.setAttribute("data-ea-selecting", "true");
    document.addEventListener("keydown", escapeWhileSelecting, true);
    document.body?.appendChild(selectBar);
    const active = document.activeElement;
    if (active && typeof root.contains === "function" && root.contains(active)) {
      try {
        active.blur();
      } catch {
      }
    }
    queueMicrotask(() => {
      try {
        selectBarDone.focus({ preventScroll: true });
      } catch {
      }
    });
    document.dispatchEvent(new CustomEvent("dsh-explain-assistant:select", { detail: { sessionId: state.sessionId } }));
  };
  const select = button("选择主对话内容", "选择主对话中的步骤或工具卡片", () => {
    if (root.hasAttribute("data-selection-mode")) leaveSelectionMode();
    else enterSelectionMode();
  }, { class: "ea-btn ea-btn-soft", pressed: false });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.hasAttribute("data-selection-mode")) leaveSelectionMode();
  }, true);
  const tutorialBtn = button("?", "使用教程", () => {
    const current = contexts.get(root);
    if (!current) return;
    if (current.tutorialOpen) closeTutorial(current);
    else openTutorial(current);
  }, { class: "ea-btn ea-btn-soft ea-tutorial-trigger", expanded: false });
  const compactBtn = button("/compact", "压缩小助手上下文", () => {
    const current = contexts.get(root);
    if (current && !isBusy(current.state)) void current.plugin.submit("/compact");
  }, { class: "ea-btn ea-btn-soft", title: "整理小助手自己的上下文；不影响主对话" });
  const modelTrigger = buildModelTrigger(() => contexts.get(root));
  titlebar.append(
    el("strong", { id: "dsh-explain-assistant-title", class: "ea-title", text: "解释小助手" }),
    phase,
    el("div", { class: "ea-header-actions" }, modelTrigger.root, select, compactBtn, tutorialBtn, close)
  );
  const selectionStatus = el("span", { class: "dsh-explain-assistant-selection-status ea-selection-status", role: "status" });
  const selectBarCount = el("strong", { class: "ea-select-bar-count", role: "status", "aria-live": "polite", text: "已选 0 条" });
  const selectBarDone = button("完成", "结束选择，回到解释小助手", () => leaveSelectionMode(), { class: "ea-btn ea-select-bar-done" });
  const selectBarClear = button("清空", "清空已选内容，继续选择", () => {
    const current = contexts.get(root);
    if (!current) return;
    current.plugin.registry.update(current.state.sessionId, (state2) => {
      state2.evidence = [];
    });
  }, { class: "ea-btn ea-select-bar-clear" });
  const selectBar = el(
    "div",
    { class: "ea-select-bar", role: "group", "aria-label": "选择主对话内容" },
    el("span", { class: "ea-select-bar-dot", "aria-hidden": "true" }),
    selectBarCount,
    el("span", { class: "ea-select-bar-hint", text: "Ctrl+点击 可加选 · Esc 完成" }),
    selectBarClear,
    selectBarDone
  );
  const body = el("div", { class: "dsh-explain-assistant-content ea-body" });
  body.addEventListener("scroll", () => {
    const current = contexts.get(root);
    if (!current) return;
    const node2 = current.body;
    const max = (node2.scrollHeight ?? 0) - (node2.clientHeight ?? 0);
    if (!(max > 0)) return;
    if (current.programmaticTop !== void 0 && Math.abs((node2.scrollTop ?? 0) - current.programmaticTop) <= 2) return;
    current.followPos = void 0;
    if ((node2.scrollTop ?? 0) >= max - FOLLOW_NEAR_BOTTOM) {
      current.followPaused = false;
      return;
    }
    if (isBusy(current.state) && current.state.text) current.followPaused = true;
  });
  const errorSlot = el("div", { class: "ea-slot" });
  const errorTailSlot = el("div", { class: "ea-slot ea-error-tail-slot" });
  const currentSlot = el("div", { class: "ea-slot" });
  const answerSlot = el("article", { class: "dsh-explain-assistant-answer ea-answer", "aria-label": "小助手回答" });
  const answerView = mountMarkdown(answerSlot);
  const heroSlot = el("div", { class: "ea-slot" });
  const quickSlot = el("div", { class: "ea-slot" });
  const catalogNoteSlot = el("div", { class: "ea-slot ea-catalog-note-slot" });
  const modelPanelSlot = el("div", { class: "ea-slot ea-model-panel-slot" });
  const tutorialSlot = el("div", { class: "ea-slot ea-tutorial-panel-slot" });
  const evidenceSlot = el("div", { class: "ea-slot" });
  const compactSlot = el("div", { class: "ea-slot ea-compact-slot" });
  const historySlot = el("div", { class: "ea-slot ea-conv-slot" });
  const liveQuestion = el("div", { class: "ea-turn-q ea-live-q" });
  const liveTurn = el("section", { class: "ea-conv-live", "aria-label": "当前这一问" });
  liveTurn.append(el("article", { class: "ea-turn ea-turn-live" }, liveQuestion, currentSlot, answerSlot));
  const detailSlot = el("div", { class: "ea-slot" });
  const loadingSlot = el("div", { class: "ea-slot ea-loading-slot" });
  const stateErrorSlot = el("div", { class: "ea-slot ea-state-error-slot" });
  body.append(stateErrorSlot, loadingSlot, catalogNoteSlot, detailSlot, errorSlot, heroSlot, quickSlot, historySlot, liveTurn, errorTailSlot, evidenceSlot, selectionStatus);
  const input = el("textarea", { class: "ea-input", placeholder: "问小助手主 agent 正在做什么…", "aria-label": "向解释小助手提问", rows: "2" });
  const field = mountTextField(input);
  const send = button(sendLabel(state, "ready"), isBusy(state) ? "停止本次解释" : "发送问题", () => {
    const current = contexts.get(root);
    if (current && isBusy(current.state)) {
      current.plugin.cancel?.();
      return;
    }
    form.requestSubmit();
  }, { class: "ea-btn ea-btn-primary ea-send" });
  send.setAttribute("data-stop", isBusy(state) ? "true" : "false");
  const ringSlot = el("div", { class: "ea-ring-slot" });
  const targetBar = el("div", { class: "ea-target-bar", role: "status", "aria-live": "polite" });
  const form = el("form", { class: "dsh-explain-assistant-form ea-composer" });
  form.append(targetBar, field.root, el("div", { class: "ea-composer-actions" }, ringSlot, send));
  const RESIZE_DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
  const resizeZones = RESIZE_DIRECTIONS.map((direction) => ({
    direction,
    element: el("div", {
      class: "ea-resize-edge ea-resize-" + direction,
      "data-resize-direction": direction,
      // 热区是纯装饰性拖拽面：读屏与键盘仍走标题栏的方向键（见 attachWindowInteractions）。
      "aria-hidden": "true"
    })
  }));
  const geometry = clampGeometry(state.geometry ?? initialGeometry, window.innerWidth, window.innerHeight);
  root.style.left = geometry.x + "px";
  root.style.top = geometry.y + "px";
  root.style.width = geometry.width + "px";
  root.style.height = geometry.height + "px";
  const main = el("div", { class: "ea-main" });
  main.append(body, form, modelPanelSlot, tutorialSlot);
  root.append(titlebar, main, ...resizeZones.map((zone) => zone.element));
  let lastBodyHeight = 0;
  const measureBodyHeight = () => {
    const height = body.clientHeight;
    if (height > 0 && Math.abs(height - lastBodyHeight) > 4) {
      lastBodyHeight = height;
      root.style.setProperty("--ea-body-h", height + "px");
    }
  };
  measureBodyHeight();
  const bodyObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => measureBodyHeight()) : void 0;
  bodyObserver?.observe(body);
  const ctx = {
    state,
    plugin: like,
    body,
    phase,
    selectionStatus,
    controller: void 0,
    appliedGeometry: void 0,
    // 见 updateOverlay：用来判断「后面来的几何值是不是新值」。
    // 不这样做的话，每次重画都会把用户刚拖好的位置按旧值拽回去。
    errorSlot,
    errorTailSlot,
    currentSlot,
    answerSlot,
    answerView,
    heroSlot,
    quickSlot,
    evidenceSlot,
    compactSlot,
    historySlot,
    detailSlot,
    ringSlot,
    targetBar,
    catalogNoteSlot,
    modelPanelSlot,
    modelTrigger,
    selectBar,
    selectBarCount,
    selectBarDone,
    compactBtn,
    tutorialBtn,
    tutorialSlot,
    tutorialOpen: false,
    tutorialCloseToken: 0,
    liveTurn,
    liveQuestion,
    expandedIds: /* @__PURE__ */ new Set(),
    sessionId: state.sessionId,
    loadingSlot,
    stateErrorSlot,
    root,
    // 默认折叠模型列表：一开就摊开 33 个模型会把「使用说明 + 快捷问题」顶出可视区。
    // 未选模型时由摘要行 + 醒目的提示承担「先选一个」的引导（§7/§11.8）。
    form,
    input,
    field,
    send,
    modelOpen: false,
    modelQuery: "",
    modelCloseToken: 0,
    rerender: () => updateOverlay(root, ctx.state, ctx.plugin)
  };
  contexts.set(root, ctx);
  root.setAttribute("data-view", "chat");
  input.value = state.draft;
  input.addEventListener("input", () => {
    const current = contexts.get(root);
    if (current) current.plugin.registry.update(current.state.sessionId, { draft: input.value });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const current = contexts.get(root);
    if (!current) return;
    if (!canSubmit(current.state)) return;
    const question = input.value.trim();
    if (question) void current.plugin.submit(question);
  });
  let composing = false;
  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
  });
  input.addEventListener("blur", () => {
    composing = false;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const legacyIme = event.keyCode === 229;
    if (composing || event.isComposing || legacyIme) return;
    const current = contexts.get(root);
    if (!current || !canSubmit(current.state) || !input.value.trim()) return;
    event.preventDefault();
    form.requestSubmit();
  });
  updateOverlay(root, state, like);
  const focusable = () => {
    const inPanel = (element) => Boolean(element.closest(".ea-model-panel-slot"));
    const inTutorial = (element) => Boolean(element.closest(".ea-tutorial-panel-slot"));
    const live = contexts.get(root);
    const panelOpen = Boolean(live?.modelOpen);
    const tutorialOpen = Boolean(live?.tutorialOpen);
    return Array.from(root.querySelectorAll('button, textarea, input, select, summary, [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0 && !element.hidden).filter((element) => panelOpen ? inPanel(element) : !inPanel(element)).filter((element) => tutorialOpen ? inTutorial(element) : !inTutorial(element));
  };
  const keydown = (event) => {
    if (event.key === "Escape") {
      const legacyIme = event.keyCode === 229;
      if (composing || event.isComposing || legacyIme) return;
      event.preventDefault();
      const current = contexts.get(root);
      if (current?.tutorialOpen) {
        closeTutorial(current);
        return;
      }
      if (current?.modelOpen) {
        closeModelPanel(current);
        return;
      }
      close.click();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable();
    if (!items.length) {
      event.preventDefault();
      root.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  root.addEventListener("keydown", keydown);
  root.addEventListener("dsh-explain-assistant:dispose", () => root.removeEventListener("keydown", keydown), { once: true });
  const controller = attachWindowInteractions(root, titlebar, geometry, (next) => {
    const current = contexts.get(root);
    if (!current) return;
    current.plugin.registry.update(current.state.sessionId, { geometry: next });
    current.plugin.saveGeometry?.(current.state.sessionId, next);
  }, resizeZones);
  ctx.controller = controller;
  root.addEventListener("dsh-explain-assistant:dispose", () => {
    stopFollowLoop(ctx);
    controller.dispose();
    answerView.dispose();
    bodyObserver?.disconnect();
    document.removeEventListener("keydown", escapeWhileSelecting, true);
    document.documentElement?.removeAttribute("data-ea-selecting");
    selectBar.remove();
  }, { once: true });
  queueMicrotask(() => {
    (input || root).focus({ preventScroll: true });
    body.scrollTop = 0;
  });
  return root;
}
function scheduleFoldCheck(ctx) {
  const run = () => {
    const slot = ctx.historySlot;
    if (typeof slot.querySelectorAll !== "function") return;
    const nodes = Array.from(slot.querySelectorAll(".ea-turn-a"));
    for (const node2 of nodes) {
      if (node2.getAttribute("data-folded") !== "true") continue;
      const client = node2.clientHeight;
      const scroll = node2.scrollHeight;
      if (typeof client !== "number" || typeof scroll !== "number" || !client) continue;
      if (scroll <= client + 2) {
        node2.setAttribute("data-folded", "false");
        const turn = node2.closest?.(".ea-turn");
        const more = turn?.querySelector?.(".ea-turn-more");
        if (more) more.hidden = true;
      }
    }
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}
function historyDetailSignature(detail) {
  if (!detail) return "";
  const record = detail.record || {};
  const size = (value) => Array.isArray(value) ? value.length : 0;
  const text = (value) => typeof value === "string" ? value.length : 0;
  const counts = detail.counts || {};
  return [
    detail.recordId || "",
    detail.status || "",
    detail.hasEarlier ? 1 : 0,
    detail.loadingMore ? 1 : 0,
    detail.error || "",
    size(record.evidence),
    size(record.tools),
    size(record.images),
    text(record.answerText ?? record.answer),
    text(record.reasoningText ?? record.reasoning),
    Number(counts.evidence || 0),
    Number(counts.tools || 0),
    Number(counts.images || 0)
  ].join(":");
}
var FOLD_HEIGHT_FALLBACK = 220;
var FOLD_EASE_EXPAND = "cubic-bezier(.16,1,.3,1)";
var FOLD_EASE_COLLAPSE = "cubic-bezier(.4,0,.2,1)";
function foldDuration(distance) {
  return Math.round(Math.min(640, Math.max(220, 150 + distance * 0.42)));
}
function findHistoryTurn(ctx, id) {
  const slot = ctx.historySlot;
  if (typeof slot.querySelectorAll !== "function") return null;
  const turns = Array.from(slot.querySelectorAll(".ea-turn"));
  return turns.find((turn) => turn.getAttribute("data-record-id") === id) || null;
}
function foldHeightOf(node2) {
  if (typeof getComputedStyle !== "function") return FOLD_HEIGHT_FALLBACK;
  const parsed = Number.parseFloat(getComputedStyle(node2).getPropertyValue("--ea-fold-height"));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : FOLD_HEIGHT_FALLBACK;
}
function animateFold(answer, toggle, expand, onDone) {
  const measured = typeof answer.getBoundingClientRect === "function" ? answer.getBoundingClientRect().height : 0;
  const from = measured > 0 ? measured : answer.clientHeight;
  answer.setAttribute("data-folded", expand ? "false" : "true");
  answer.setAttribute("data-fold-anim", expand ? "expand" : "collapse");
  const to = expand ? answer.scrollHeight : foldHeightOf(answer);
  const finish = () => {
    answer.removeAttribute("data-fold-anim");
    answer.style.removeProperty("--ea-fold-fade");
    answer.style.removeProperty("transition");
    onDone?.();
  };
  if (!from || !to || Math.abs(to - from) < 2) {
    finish();
    return;
  }
  const distance = Math.abs(to - from);
  const duration = foldDuration(distance);
  const fadeDuration = Math.round(expand ? duration * 0.6 : duration * 0.85);
  answer.style.setProperty("--ea-fold-fade", expand ? "34px" : "0px");
  answer.style.transition = "--ea-fold-fade " + fadeDuration + "ms cubic-bezier(.4,0,.2,1)";
  const settleFade = () => answer.style.setProperty("--ea-fold-fade", expand ? "0px" : "34px");
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(settleFade);
  else setTimeout(settleFade, 0);
  toggle.textContent = expand ? "收起" : "展开全文";
  toggle.setAttribute("aria-label", expand ? "收起这条回答" : "展开这条回答的全文");
  toggle.setAttribute("aria-expanded", expand ? "true" : "false");
  if (typeof toggle.animate === "function") {
    toggle.animate(
      [{ opacity: 0, transform: "translateY(-2px)" }, { opacity: 1, transform: "none" }],
      { duration: 200, delay: 70, easing: "cubic-bezier(.2,.7,.3,1)" }
    );
  }
  const animation = answer.animate(
    [{ height: from + "px" }, { height: to + "px" }],
    { duration, easing: expand ? FOLD_EASE_EXPAND : FOLD_EASE_COLLAPSE, fill: "none" }
  );
  const done = animation && animation.finished;
  if (done && typeof done.then === "function") done.then(finish, finish);
  else finish();
}
function compactSignatureOf(state, win) {
  const compact = state.compactState;
  if (!compact) return "-";
  const status = compactStatusOf(compact);
  if (status === "idle") return "-";
  return [status, compact.createdAt || "", compact.updatedAt || "", String(compactBoundaryIndex(state, win.items))].join(":");
}
function historySignature(ctx, state, win) {
  return [
    win.start,
    win.end,
    win.total,
    state.hasEarlier ? 1 : 0,
    state.loadingEarlier ? 1 : 0,
    compactSignatureOf(state, win),
    historyDetailSignature(state.historyDetail),
    [...ctx.expandedIds].sort().join("+"),
    // 只算问答记录：压缩日志不进历史（见 renderHistory 的说明），它的变化不该触发整段重挂。
    state.records.filter(isAskRecord).map((record) => recordIdOf(record) + ":" + String(record?.status || "") + ":" + recordAnswerText(record).length).join(",")
  ].join("|");
}
function renderHistory(ctx, state) {
  const expand = ctx.pendingOlder || 0;
  ctx.pendingOlder = 0;
  const records = state.records.filter(isAskRecord);
  const win = resolveHistoryWindow(records, ctx.historyWindow, expand);
  if (win.total) {
    const firstId = recordIdOf(win.items[0]);
    ctx.historyWindow = { ...firstId ? { firstId } : {}, count: Math.max(1, win.end - win.start), atTail: win.atTail };
  } else {
    ctx.historyWindow = void 0;
  }
  const newestId = recordIdOf(records[records.length - 1]);
  const justLanded = Boolean(state.liveRecordId) && state.liveRecordId === newestId;
  if (!justLanded && newestId && ctx.enteredTurnId !== void 0 && newestId !== ctx.enteredTurnId) ctx.pendingEnterId = newestId;
  ctx.enteredTurnId = newestId || void 0;
  ctx.lastWin = win;
  const sig = historySignature(ctx, state, win);
  if (sig === ctx.historySig) return;
  ctx.historySig = sig;
  fill(ctx.historySlot, historyNodes(state, ctx.plugin, ctx, win));
  ctx.pendingEnterId = void 0;
  scheduleFoldCheck(ctx);
}
function scrollToNewestOnOpen(ctx, state) {
  if (ctx.autoScrolled) return;
  if (!state.records.length) {
    ctx.autoScrolled = true;
    return;
  }
  if (ctx.tutorialOpen || ctx.modelOpen) return;
  const body = ctx.body;
  const hist = ctx.historySlot;
  if (typeof body.getBoundingClientRect !== "function" || typeof hist.getBoundingClientRect !== "function") return;
  const bodyRect = body.getBoundingClientRect();
  const histRect = hist.getBoundingClientRect();
  if (!bodyRect.height || !histRect.height) {
    const tries = (ctx.autoScrollTries || 0) + 1;
    ctx.autoScrollTries = tries;
    if (tries > 3) return;
    const retry = () => {
      if (!ctx.autoScrolled) scrollToNewestOnOpen(ctx, ctx.state);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(retry);
    else setTimeout(retry, 16);
    return;
  }
  ctx.autoScrollTries = 0;
  ctx.autoScrolled = true;
  setTimeout(() => {
    const b = ctx.body;
    const h = ctx.historySlot;
    if (typeof b.getBoundingClientRect !== "function" || typeof h.getBoundingClientRect !== "function") return;
    const br = b.getBoundingClientRect();
    const hr = h.getBoundingClientRect();
    const delta = hr.bottom - br.bottom + 14;
    if (Number.isFinite(delta) && delta > 0) b.scrollTop += delta;
  }, 0);
}
function followStreaming(ctx, state, wasAtBottom) {
  const body = ctx.body;
  if (!(isBusy(state) && state.text)) {
    ctx.followPaused = false;
    ctx.followTurnKey = void 0;
    stopFollowLoop(ctx);
    return;
  }
  const key = state.question || state.liveRecordId || "";
  if (ctx.followTurnKey !== key) {
    ctx.followTurnKey = key;
    ctx.followPaused = false;
    wasAtBottom = true;
  }
  if (ctx.followPaused) return;
  const question = ctx.liveQuestion;
  if (typeof question.getBoundingClientRect === "function" && typeof body.getBoundingClientRect === "function") {
    const qr = question.getBoundingClientRect();
    const br = body.getBoundingClientRect();
    if (qr.height > 0 && br.height > 0 && qr.top <= br.top + 4) {
      ctx.followPaused = true;
      return;
    }
  }
  if (!wasAtBottom) return;
  startFollowLoop(ctx);
}
var FOLLOW_NEAR_BOTTOM = 120;
function stopFollowLoop(ctx) {
  if (ctx.followRaf !== void 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(ctx.followRaf);
  ctx.followRaf = void 0;
  ctx.followPos = void 0;
}
function startFollowLoop(ctx) {
  const bodyForFallback = ctx.body;
  if (typeof requestAnimationFrame !== "function") {
    const height = (bodyForFallback.scrollHeight ?? 0) - (bodyForFallback.clientHeight ?? 0);
    if (Number.isFinite(height) && height >= 0) bodyForFallback.scrollTop = height;
    return;
  }
  if (ctx.followRaf !== void 0) return;
  let lastTs = 0;
  const step = (ts) => {
    ctx.followRaf = void 0;
    const streaming = isBusy(ctx.state) && Boolean(ctx.state.text);
    if (!streaming || ctx.followPaused) {
      ctx.followPos = void 0;
      return;
    }
    const body = ctx.body;
    const now = typeof ts === "number" ? ts : typeof performance === "object" && performance && typeof performance.now === "function" ? performance.now() : Date.now();
    const dt = lastTs ? Math.min(0.05, Math.max(1e-3, (now - lastTs) / 1e3)) : 0.016;
    lastTs = now;
    const target = (body.scrollHeight ?? 0) - (body.clientHeight ?? 0);
    if (!Number.isFinite(target) || target < 0) {
      ctx.followRaf = requestAnimationFrame(step);
      return;
    }
    if (ctx.followPos === void 0) ctx.followPos = body.scrollTop ?? 0;
    const delta = target - ctx.followPos;
    if (delta > 0.05) {
      const alpha = 1 - Math.exp(-dt / 0.1);
      const move = Math.min(delta, Math.min(delta * alpha + 0.05, 3200 * dt));
      ctx.followPos += move;
      ctx.programmaticTop = ctx.followPos;
      body.scrollTop = ctx.followPos;
    } else if (delta < -1) {
      ctx.followPos = target;
    }
    ctx.followRaf = requestAnimationFrame(step);
  };
  ctx.followRaf = requestAnimationFrame(step);
}
function updateOverlay(root, state, plugin) {
  const ctx = contexts.get(root);
  if (!ctx) return;
  ctx.state = state;
  ctx.plugin = plugin;
  const bodyForScroll = ctx.body;
  const bodyMax = (bodyForScroll.scrollHeight ?? 0) - (bodyForScroll.clientHeight ?? 0);
  const wasAtBottom = bodyMax > 0 && (bodyForScroll.scrollTop ?? 0) >= bodyMax - FOLLOW_NEAR_BOTTOM;
  const handoffAnchor = (() => {
    if (wasAtBottom) return void 0;
    const id = state.liveRecordId;
    if (!id) return void 0;
    const live = ctx.liveTurn;
    if (!live || live.hidden) return void 0;
    if (typeof live.getBoundingClientRect !== "function") return void 0;
    const rect = live.getBoundingClientRect();
    return rect && rect.height > 0 ? { id, top: rect.top } : void 0;
  })();
  if (state.geometry && ctx.controller && !ctx.controller.isInteracting()) {
    const next = clampGeometry(state.geometry, window.innerWidth, window.innerHeight);
    const prev = ctx.appliedGeometry;
    if (!prev || prev.x !== next.x || prev.y !== next.y || prev.width !== next.width || prev.height !== next.height) {
      ctx.controller.applyExternal(next);
      ctx.appliedGeometry = next;
    }
  }
  if (ctx.sessionId !== state.sessionId) {
    ctx.sessionId = state.sessionId;
    ctx.historyWindow = void 0;
    ctx.historySig = void 0;
    ctx.expandedIds = /* @__PURE__ */ new Set();
    ctx.enteredTurnId = void 0;
    ctx.pendingEnterId = void 0;
    ctx.pendingOlder = 0;
    ctx.anchor = void 0;
    ctx.scrollToTail = false;
    ctx.autoScrolled = false;
    ctx.autoScrollTries = 0;
    ctx.compactSig = void 0;
    ctx.followPaused = false;
    ctx.followTurnKey = void 0;
    stopFollowLoop(ctx);
  }
  ctx.phase.textContent = phaseLabel(state);
  const gate = surfaceGate(state);
  ctx.root.setAttribute("data-surface", gate);
  if (gate === "loading") {
    ctx.errorSlot.replaceChildren();
    ctx.errorTailSlot.replaceChildren();
    ctx.currentSlot.replaceChildren();
    ctx.answerSlot.hidden = true;
    ctx.answerView.update("", false);
    resetModelTrigger(ctx);
    closeModelPanel(ctx, { focus: false, animate: false });
    fill(ctx.catalogNoteSlot, []);
    fill(ctx.evidenceSlot, []);
    fill(ctx.compactSlot, []);
    fill(ctx.historySlot, []);
    ctx.historySig = void 0;
    ctx.pendingOlder = 0;
    ctx.liveTurn.hidden = true;
    ctx.liveQuestion.textContent = "";
    fill(ctx.detailSlot, []);
    ctx.ringSlot.replaceChildren();
    fill(ctx.heroSlot, []);
    fill(ctx.quickSlot, []);
    ctx.send.textContent = sendLabel(state, "loading");
    ctx.send.disabled = true;
    ctx.send.setAttribute("data-stop", "false");
    ctx.send.setAttribute("aria-label", "发送问题");
    ctx.compactBtn.disabled = true;
    fill(ctx.loadingSlot, loadingNodes());
    resetPickRow(ctx);
    return;
  }
  fill(ctx.loadingSlot, []);
  ctx.errorSlot.replaceChildren();
  ctx.errorTailSlot.replaceChildren();
  const currentErrorText = state.stateError && gate === "ready" ? state.stateError : state.error || "";
  const errorEntering = Boolean(currentErrorText) && ctx.lastErrorText !== currentErrorText;
  const errorClass = "dsh-explain-assistant-error ea-error" + (errorEntering ? " ea-error-enter" : "");
  ctx.lastErrorText = currentErrorText || void 0;
  const turnError = state.error && (state.phase === "error" || state.phase === "interrupted") ? el("div", { class: errorClass, role: "alert", text: state.error }) : null;
  if (state.stateError && gate === "ready") ctx.errorSlot.appendChild(el("div", { class: errorClass, role: "alert", text: state.stateError }));
  else if (state.error && !turnError) ctx.errorSlot.appendChild(el("div", { class: errorClass, role: "alert", text: state.error }));
  if (turnError) ctx.errorTailSlot.appendChild(turnError);
  if (gate === "failed") {
    ctx.currentSlot.replaceChildren();
    ctx.answerSlot.hidden = true;
    ctx.answerView.update("", false);
    resetModelTrigger(ctx);
    closeModelPanel(ctx, { focus: false, animate: false });
    fill(ctx.catalogNoteSlot, []);
    fill(ctx.evidenceSlot, []);
    fill(ctx.compactSlot, []);
    fill(ctx.historySlot, []);
    ctx.historySig = void 0;
    ctx.pendingOlder = 0;
    ctx.liveTurn.hidden = true;
    ctx.liveQuestion.textContent = "";
    fill(ctx.detailSlot, []);
    ctx.ringSlot.replaceChildren();
    fill(ctx.heroSlot, []);
    fill(ctx.quickSlot, []);
    ctx.send.textContent = sendLabel(state, "failed");
    ctx.send.disabled = true;
    ctx.send.setAttribute("data-stop", "false");
    ctx.send.setAttribute("aria-label", "发送问题");
    ctx.compactBtn.disabled = true;
    fill(ctx.stateErrorSlot, stateErrorNodes(state, ctx.plugin, readFailure(state)));
    resetPickRow(ctx);
    return;
  }
  fill(ctx.stateErrorSlot, []);
  const landed = Boolean(state.liveRecordId) && state.records.some((record) => recordIdOf(record) === state.liveRecordId);
  const compacting = state.compactState?.status === "running";
  const showLive = !compacting && !landed && Boolean(state.question || state.text || isBusy(state));
  ctx.liveTurn.hidden = !showLive;
  ctx.liveQuestion.textContent = showLive ? state.question || "" : "";
  fill(ctx.currentSlot, [...currentStatusNodes(state, ctx.plugin), ...currentDetailNodes(state), ...offlineFallbackNodes(state)]);
  ctx.answerSlot.hidden = !state.text;
  if (state.text) ctx.answerView.update(state.text, isBusy(state));
  else ctx.answerView.update("", false);
  fill(ctx.heroSlot, heroNodes(state, ctx));
  fill(ctx.quickSlot, quickNodes(state, ctx.plugin));
  ctx.modelTrigger.root.hidden = false;
  syncModelTrigger(ctx);
  fill(ctx.catalogNoteSlot, catalogNoticeNodes(ctx));
  if (ctx.modelOpen) renderModelPanel(ctx);
  fill(ctx.evidenceSlot, evidenceNodes(state, ctx.plugin));
  const compactRenderSig = [
    compactStatusOf(state.compactState || { status: "idle" }),
    ctx.compactOpen === true ? 1 : 0,
    state.compactState?.updatedAt || "",
    state.compactState?.error || "",
    typeof state.occupancy === "number" ? Math.round(state.occupancy) : "",
    state.compactState?.status === "running" ? Math.floor(state.text.length / 40) : ""
  ].join("|");
  if (compactRenderSig !== ctx.compactRenderSig) {
    ctx.compactRenderSig = compactRenderSig;
    fill(ctx.compactSlot, compactNodes(state, ctx));
  }
  ctx.detailInline = false;
  renderHistory(ctx, state);
  if (handoffAnchor) {
    const turns = Array.from(ctx.historySlot.querySelectorAll(".ea-turn"));
    const node2 = turns.find((turn) => turn.getAttribute("data-record-id") === handoffAnchor.id);
    if (node2 && typeof node2.getBoundingClientRect === "function") {
      const delta = node2.getBoundingClientRect().top - handoffAnchor.top;
      if (Number.isFinite(delta) && Math.abs(delta) > 1) ctx.body.scrollTop += delta;
    }
  }
  const compactSig = [state.compactState?.status, state.compactState?.updatedAt, state.compactState?.error].join("|");
  const compactFirstSight = ctx.compactSig === void 0;
  if (ctx.compactSig !== compactSig) {
    ctx.compactSig = compactSig;
    const shouldScrollToRow = !compactFirstSight && !ctx.tutorialOpen && !ctx.modelOpen;
    const rowAt = () => ctx.compactSlot.querySelector?.(".ea-compact-row");
    const scrollToRow = () => {
      const row = rowAt();
      if (!row || typeof row.getBoundingClientRect !== "function") return;
      const r = row.getBoundingClientRect();
      const b = ctx.body.getBoundingClientRect();
      if (!(r.height > 0 && b.height > 0)) return;
      if (r.bottom > b.bottom) ctx.body.scrollTop += r.bottom - b.bottom + 10;
      else if (r.top < b.top) ctx.body.scrollTop -= b.top - r.top + 10;
    };
    if (shouldScrollToRow) {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => scrollToRow());
      else scrollToRow();
      setTimeout(scrollToRow, 150);
    }
  }
  fill(ctx.detailSlot, ctx.detailInline ? [] : historyDetailNodes(state, ctx.plugin));
  const detailId = state.historyDetail?.recordId;
  if (detailId && detailId !== ctx.detailRecordId) {
    ctx.detailRecordId = detailId;
    ctx.detailFit = true;
    scrollDetailIntoView(ctx);
  } else if (!detailId) {
    ctx.detailRecordId = void 0;
    ctx.detailFit = false;
  } else if (ctx.detailFit && state.historyDetail?.status !== "loading") {
    ctx.detailFit = false;
    placeDetailPanel(ctx);
  }
  ctx.ringSlot.replaceChildren(ringNode(state));
  renderPickRow(ctx);
  syncSelectBar(ctx, state);
  if (ctx.input.value !== state.draft) {
    ctx.input.value = state.draft;
    ctx.field?.refresh();
  }
  const stopping = isBusy(state);
  ctx.send.textContent = sendLabel(state, "ready");
  ctx.send.disabled = stopping ? false : !canSubmit(state);
  ctx.send.setAttribute("data-stop", stopping ? "true" : "false");
  ctx.send.setAttribute("aria-label", stopping ? "停止本次解释" : "发送问题");
  ctx.compactBtn.disabled = !canSubmit(state);
  ctx.compactBtn.setAttribute("title", canSubmit(state) ? "整理小助手自己的上下文；不影响主对话" : "正在处理中，等这一次结束再压缩");
  if (ctx.anchor) {
    const anchor = ctx.anchor;
    ctx.anchor = void 0;
    const turns = Array.from(ctx.historySlot.querySelectorAll(".ea-turn"));
    const node2 = turns.find((turn) => turn.getAttribute("data-record-id") === anchor.id);
    if (node2) {
      const now = node2.getBoundingClientRect().top;
      const delta = now - anchor.top;
      if (Number.isFinite(delta) && Math.abs(delta) > 1) ctx.body.scrollTop += delta;
    }
  }
  if (ctx.scrollToTail) {
    ctx.scrollToTail = false;
    const height = ctx.body.scrollHeight;
    if (typeof height === "number" && Number.isFinite(height)) ctx.body.scrollTop = height;
  }
  scrollToNewestOnOpen(ctx, state);
  followStreaming(ctx, state, wasAtBottom);
}

// src/client/selection.ts
var TARGETS = "[data-tool], [data-chat-node-key]";
var PICKED = "[data-ea-picked]";
function insideChat(node2) {
  const chat = node2.closest("[data-conversation-scroll], [data-chat-root], [data-chat-flow-kind]");
  return Boolean(chat && !node2.closest(".dsh-explain-assistant-overlay, [data-shell-overlay]"));
}
function nearest(target) {
  if (!(target instanceof Element)) return void 0;
  const node2 = target.closest(TARGETS);
  return node2 && insideChat(node2) ? node2 : void 0;
}
function classifyEvidence(element) {
  const summary = (element.textContent || "").trim();
  if (!summary) return "unavailable";
  const tool = element.closest("[data-tool]");
  if (tool) {
    const state = (tool.getAttribute("data-state") || "").toLowerCase();
    if (state === "done" || state === "ok" || state === "failed" || state === "error") return "observed";
    if (state === "preparing" || state === "ongoing" || state === "running") return "unavailable";
    return "observed";
  }
  const kind = element.getAttribute("data-chat-flow-kind");
  if (kind) {
    if (kind === "input-message" || kind === "request-prompt") return "unavailable";
    return "reported_only";
  }
  return "unavailable";
}
var pickSeq = 0;
function ensurePickId(element) {
  const existing = element.getAttribute("data-ea-pick");
  if (existing) return existing;
  const next = "p" + ++pickSeq;
  element.setAttribute("data-ea-pick", next);
  return next;
}
function evidenceFromElement(element, sessionId) {
  const tool = element.closest("[data-tool]");
  const source = "selected_frozen";
  const state = (element.getAttribute("data-state") || "").toLowerCase();
  const pickId = ensurePickId(element);
  const rawSummary = (element.textContent || "").trim();
  const summaryLimit = 4e3;
  return { id: element.getAttribute("data-chat-node-key") || pickId, pickId, title: tool?.getAttribute("data-tool") || element.getAttribute("data-chat-flow-kind") || void 0, summary: rawSummary.slice(0, summaryLimit), source, capturedAt: (/* @__PURE__ */ new Date()).toISOString(), evidenceState: classifyEvidence(element), sessionId, version: element.getAttribute("data-version") || null, truncated: rawSummary.length > summaryLimit, incomplete: state === "running" || state === "ongoing" || state === "preparing" };
}
var CLICK_SLOP_PX = 5;
function attachSelection(root, sessionId, handlers) {
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      ;
      event.stopImmediatePropagation();
    }
  };
  let mode = false;
  const pickedIdOf = (node2) => {
    const marked = node2.closest(PICKED);
    if (!marked || !insideChat(marked)) return void 0;
    return marked.getAttribute("data-ea-picked") || void 0;
  };
  const context = (event) => {
    const node2 = nearest(event.target);
    if (!node2) return;
    const picked = pickedIdOf(node2);
    if (picked) {
      swallow(event);
      handlers.deselect(picked);
      return;
    }
    if (!mode) return;
    swallow(event);
    handlers.select(evidenceFromElement(node2, sessionId), node2);
  };
  let pressed;
  const click = (event) => {
    if (event.button !== 0) return;
    if (event.shiftKey || event.altKey) return;
    const additive = event.ctrlKey || event.metaKey;
    if (!mode && additive) return;
    const node2 = nearest(event.target);
    if (!node2) return;
    if (pressed && pressed.node === node2) {
      const moved = Math.abs(event.clientX - pressed.x) + Math.abs(event.clientY - pressed.y);
      if (moved > CLICK_SLOP_PX) return;
      const selection = typeof root.getSelection === "function" ? root.getSelection() : null;
      if (selection && String(selection).trim().length > 0) return;
    }
    const picked = pickedIdOf(node2);
    if (picked) {
      swallow(event);
      handlers.deselect(picked);
      return;
    }
    if (!mode) return;
    swallow(event);
    handlers.select(evidenceFromElement(node2, sessionId), node2, { additive });
  };
  const pointerdown = (event) => {
    if (event.button !== 0) return;
    const node2 = nearest(event.target);
    pressed = node2 ? { x: event.clientX, y: event.clientY, node: node2 } : void 0;
  };
  const keydown = (event) => {
    if (!(event.shiftKey && event.key === "Enter")) return;
    const node2 = nearest(document.activeElement);
    if (!node2) return;
    const picked = pickedIdOf(node2);
    if (picked) {
      swallow(event);
      handlers.deselect(picked);
      return;
    }
    if (!mode) return;
    swallow(event);
    handlers.select(evidenceFromElement(node2, sessionId), node2);
  };
  root.addEventListener("contextmenu", context, true);
  root.addEventListener("click", click, true);
  root.addEventListener("mousedown", pointerdown, true);
  root.addEventListener("keydown", keydown, true);
  return {
    enter() {
      mode = true;
    },
    exit() {
      mode = false;
    },
    dispose() {
      mode = false;
      root.removeEventListener("contextmenu", context, true);
      root.removeEventListener("click", click, true);
      root.removeEventListener("mousedown", pointerdown, true);
      root.removeEventListener("keydown", keydown, true);
    }
  };
}

// src/client/pick-marks.ts
var MARK = "data-ea-picked";
var INDEX = "data-ea-pick-index";
var ANCHOR = "data-ea-pick";
var PICK_OUT_MS = 200;
var leavingNodes = /* @__PURE__ */ new WeakMap();
function findByAttr(doc, name, value) {
  return Array.from(doc.querySelectorAll("[" + name + "]")).filter((node2) => node2.getAttribute(name) === value);
}
function findNode(doc, anchor, item) {
  const direct = findByAttr(doc, ANCHOR, anchor)[0];
  if (direct) return direct;
  const key = typeof item.id === "string" && item.id && item.id !== anchor ? item.id : "";
  if (!key) return null;
  const byKey = findByAttr(doc, "data-chat-node-key", key);
  return byKey.length === 1 ? byKey[0] : null;
}
function mark(node2, anchor, index) {
  const pending = leavingNodes.get(node2);
  if (pending) {
    clearTimeout(pending.timer);
    leavingNodes.delete(node2);
  }
  if (node2.getAttribute(ANCHOR) !== anchor) node2.setAttribute(ANCHOR, anchor);
  if (node2.getAttribute(MARK) !== anchor) node2.setAttribute(MARK, anchor);
  const text = String(index + 1);
  if (node2.getAttribute(INDEX) !== text) node2.setAttribute(INDEX, text);
}
function unmark(node2) {
  if (node2.getAttribute(MARK) === "leaving" || leavingNodes.has(node2)) return;
  node2.setAttribute(MARK, "leaving");
  const timer = setTimeout(() => {
    leavingNodes.delete(node2);
    if (node2.getAttribute(MARK) !== "leaving") return;
    node2.removeAttribute(MARK);
    node2.removeAttribute(INDEX);
  }, PICK_OUT_MS);
  leavingNodes.set(node2, { timer });
}
function syncPickMarks(doc, evidence) {
  const items = Array.isArray(evidence) ? evidence : [];
  const alive = /* @__PURE__ */ new Set();
  items.forEach((item, index) => {
    const anchor = typeof item?.pickId === "string" ? item.pickId : "";
    if (!anchor) return;
    const node2 = findNode(doc, anchor, item);
    if (!node2) return;
    if (node2.closest(".dsh-explain-assistant-overlay, [data-shell-overlay]")) return;
    alive.add(anchor);
    mark(node2, anchor, index);
  });
  for (const node2 of Array.from(doc.querySelectorAll("[" + MARK + "]"))) {
    const value = node2.getAttribute(MARK) || "";
    if (value === "leaving" || alive.has(value)) continue;
    unmark(node2);
  }
}

// src/client/archive-watch.ts
function diffNewlyArchived(previous, next) {
  if (previous === void 0) return [];
  if (!Array.isArray(next)) return [];
  const seen = /* @__PURE__ */ new Set();
  const fresh = [];
  for (const raw of next) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (previous.has(id)) continue;
    fresh.push(id);
  }
  return fresh;
}
function readArchivedIds(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return void 0;
  if (snapshot.phase !== "ready") return void 0;
  const raw = snapshot.archivedSessionIds;
  if (!Array.isArray(raw)) return void 0;
  const set = /* @__PURE__ */ new Set();
  for (const item of raw) {
    const id = typeof item === "string" ? item.trim() : "";
    if (id) set.add(id);
  }
  return set;
}
function createArchiveWatcher(options) {
  let known;
  let disposed = false;
  const log = options.logger;
  const sync = () => {
    if (disposed) return [];
    let snapshot;
    try {
      snapshot = options.source?.getSnapshot?.();
    } catch (error) {
      log?.("读取归档集合失败，已保留全部记录：" + (error instanceof Error ? error.message : String(error)));
      return [];
    }
    const next = readArchivedIds(snapshot);
    if (!next) {
      log?.("归档集合尚未就绪或不可用（phase 非 ready / 缺少字段），已保留全部记录。");
      return [];
    }
    const fresh = diffNewlyArchived(known, [...next]);
    known = next;
    for (const id of fresh) {
      try {
        const result = options.onArchived(id);
        if (result && typeof result.then === "function") {
          result.catch((error) => {
            log?.("归档清理失败（" + id + "）：" + (error instanceof Error ? error.message : String(error)));
          });
        }
      } catch (error) {
        log?.("归档清理失败（" + id + "）：" + (error instanceof Error ? error.message : String(error)));
      }
    }
    return fresh;
  };
  let unsubscribe;
  try {
    unsubscribe = options.source?.subscribe?.(() => {
      sync();
    }) ?? void 0;
  } catch (error) {
    log?.("订阅归档信号失败，已跳过（周期检查仍会兜底）：" + (error instanceof Error ? error.message : String(error)));
  }
  sync();
  return {
    sync,
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe?.();
      } catch {
      }
      unsubscribe = void 0;
    }
  };
}

// src/client/exit-anim.ts
var EXIT_MS = 220;
function prefersReducedMotion3() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function beginExit(host, element, options = {}) {
  if (!element || options.animate === false || prefersReducedMotion3()) return false;
  if (host.firstElementChild !== element) return false;
  element.setAttribute("data-leaving", "true");
  element.setAttribute("aria-hidden", "true");
  if (element.style) element.style.pointerEvents = "none";
  const parent = element.parentElement;
  setTimeout(() => {
    if (parent && element.parentElement === parent) element.remove();
  }, EXIT_MS);
  return true;
}

// src/client/header-badge.ts
var HEADER_GLYPH_OUTLINE = "M5 2.5H11A2.5 2.5 0 0 1 13.5 5V9A2.5 2.5 0 0 1 11 11.5H6.5L2.5 13.5V5A2.5 2.5 0 0 1 5 2.5Z";
var HEADER_GLYPH_LINES = ["M5 5.5H11", "M5 8.5H8.5"];
var HEADER_GLYPH_PATHS = [HEADER_GLYPH_OUTLINE, ...HEADER_GLYPH_LINES];
var HEADER_RING_RADIUS = 6;
var HEADER_ICON_SIZE = 16;
function createHeaderContent(h) {
  const glyph = h("svg", {
    className: "ea-hbtn-glyph",
    width: HEADER_ICON_SIZE,
    height: HEADER_ICON_SIZE,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    focusable: "false"
  }, ...HEADER_GLYPH_PATHS.map((d) => h("path", { d, key: d })));
  const ring = h("svg", {
    className: "ea-hbtn-ring",
    width: HEADER_ICON_SIZE,
    height: HEADER_ICON_SIZE,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1,
    strokeLinecap: "round",
    "aria-hidden": "true",
    focusable: "false"
  }, h("circle", {
    cx: 8,
    cy: 8,
    r: HEADER_RING_RADIUS,
    strokeDasharray: "13 24.7",
    strokeDashoffset: "10"
  }));
  const dot = h("span", { className: "ea-hbtn-dot" });
  return h("span", { className: "ea-hbtn" }, glyph, ring, dot);
}
function headerButtonTitle(unread) {
  return unread === true ? "解释小助手有新内容" : "打开解释小助手";
}
function headerButtonAriaLabel(unread) {
  return unread === true ? "解释小助手（有新内容）" : "打开解释小助手";
}
function headerButtonState(unread, busy) {
  const hasUnread = unread === true;
  return {
    unread: hasUnread,
    busy: busy === true,
    title: headerButtonTitle(hasUnread),
    ariaLabel: headerButtonAriaLabel(hasUnread)
  };
}
function watchUnread(registry, sessionId, onChange) {
  if (!sessionId) return () => {
  };
  let last = false;
  try {
    last = registry.get(sessionId)?.unread === true;
  } catch {
    last = false;
  }
  let disposed = false;
  let unsubscribe;
  try {
    unsubscribe = registry.subscribe(() => {
      if (disposed) return;
      let next = false;
      try {
        next = registry.get(sessionId)?.unread === true;
      } catch {
        return;
      }
      if (next === last) return;
      last = next;
      onChange(next);
    });
  } catch {
    return () => {
    };
  }
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      unsubscribe();
    } catch {
    }
  };
}

// src/client/busy-gate.ts
var BUSY_APPEAR_DELAY_MS = 150;
var BUSY_MIN_VISIBLE_MS = 300;
function createBusyGate(timers, onChange) {
  const setTimer = timers.setTimeout;
  const clearTimer = timers.clearTimeout;
  let wanted = false;
  let visible = false;
  let showHandle;
  let hideHandle;
  let shownAt = 0;
  let disposed = false;
  const now = () => timers.now ? timers.now() : Date.now();
  function emit(next) {
    if (disposed || next === visible) return;
    visible = next;
    if (next) shownAt = now();
    onChange(next);
  }
  function sync() {
    if (wanted) {
      if (hideHandle !== void 0) {
        clearTimer(hideHandle);
        hideHandle = void 0;
      }
      if (visible || showHandle !== void 0) return;
      showHandle = setTimer(() => {
        showHandle = void 0;
        if (wanted) emit(true);
      }, BUSY_APPEAR_DELAY_MS);
      return;
    }
    if (showHandle !== void 0) {
      clearTimer(showHandle);
      showHandle = void 0;
    }
    if (!visible) return;
    const remaining = BUSY_MIN_VISIBLE_MS - (now() - shownAt);
    if (remaining <= 0) {
      emit(false);
      return;
    }
    if (hideHandle !== void 0) return;
    hideHandle = setTimer(() => {
      hideHandle = void 0;
      if (!wanted) emit(false);
    }, remaining);
  }
  return {
    set(next) {
      if (disposed) return;
      if (next === wanted) return;
      wanted = next;
      sync();
    },
    dispose() {
      disposed = true;
      if (showHandle !== void 0) {
        clearTimer(showHandle);
        showHandle = void 0;
      }
      if (hideHandle !== void 0) {
        clearTimer(hideHandle);
        hideHandle = void 0;
      }
    },
    get visible() {
      return visible;
    }
  };
}

// src/client/open-gate.ts
function isOpening(state) {
  return state?.open === true && state?.stateReady === false;
}
function openingTitle() {
  return "正在打开解释小助手，正在读取当前状态…";
}
function shouldMountOverlay(input) {
  if (input.open !== true) return false;
  if (input.stateReady !== false) return true;
  return input.currentlyVisible === true;
}
function watchOpening(registry, sessionId, onChange) {
  if (!sessionId) return () => {
  };
  let last = false;
  try {
    last = isOpening(registry.get(sessionId));
  } catch {
    last = false;
  }
  let disposed = false;
  let unsubscribe;
  try {
    unsubscribe = registry.subscribe(() => {
      if (disposed) return;
      let next = false;
      try {
        next = isOpening(registry.get(sessionId));
      } catch {
        return;
      }
      if (next === last) return;
      last = next;
      onChange(next);
    });
  } catch {
    return () => {
    };
  }
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      unsubscribe();
    } catch {
    }
  };
}

// src/client/styles.css
var styles_default = `/* ==================================================================
 * 解释小助手 · 界面样式
 *
 * 设计取向：贴着 DSH 宿主既有的观感走（同一套 --dsw-alias-* 变量），
 * 不另立一套配色，免得和页面其它部分打架。
 *
 * 上一版为什么"不可用"，这几条是直接原因，改动都针对它们：
 *   1. 标题栏把「选择内容」「/compact」「×」和标题挤在一行，文字被压、按钮贴边；
 *   2. 33 个模型平铺成一个换行流，把浮窗整个吃掉，用户要滚很久才看得到输入框；
 *   3. 占用圆环绝对定位在右下角，和「发送」按钮重叠；
 *   4. 没有正文滚动区和固定输入区的分层，滚动时按钮跟着跑；
 *   5. 行高、间距、字号没有层级，一段回答和一堆按钮长得一样重。
 * ================================================================== */

/* ---------- 外壳 ---------- */
/* 液态玻璃外壳。配方起于 setup 的安装向导面板（半透明底 + 背景模糊 + 内侧高光 + 大投影），
   再按 DSH 的深色环境改了几处 —— 照抄浅色那套在深色页面上会「灰得发脏」，原因见下面深色覆盖。

   玻璃的观感由三件事构成，缺一件就会退化成「一块半透明塑料」：
     1) 透过去的背景是**糊的**（backdrop-filter），不是清楚的；
     2) 边缘有一圈**反光**：顶边最亮、侧边次之、底边压暗，像玻璃的厚度在吃光；
     3) 面上有一道**斜向的亮泽**（sheen），从左上来、右下收，玻璃才会显得是「一片」而不是「一层色」。
   所以这里不是只改个 rgba：底色、亮泽、边缘反光三样都写成了变量，深浅两套各自配。 */
.dsh-explain-assistant-overlay{container-type:inline-size;
  position:fixed;z-index:30;
  display:flex;flex-direction:column;box-sizing:border-box;
  min-width:360px;min-height:420px;
  /* 审计 2026-10-31：窄屏（<392px）时上面那两个最小值会把浮窗顶出视口 ——
     这两条在支持的引擎里覆盖它；不支持 min() 的引擎仍用上面的兜底值。 */
  min-width:min(360px,calc(100vw - 16px));min-height:min(420px,calc(100vh - 16px));
  /* 浅色：接近 setup 的白玻璃（62% 白 + 强白边）。 */
  --ea-glass-fill:rgba(248,249,251,.62);
  --ea-glass-sheen:linear-gradient(155deg,rgba(255,255,255,.5) 0%,rgba(255,255,255,.14) 26%,rgba(255,255,255,0) 52%,rgba(255,255,255,.28) 100%);
  --ea-glass-shadow:
    inset 0 0 0 1px rgba(255,255,255,.55),
    inset 0 1.5px 0 0 rgba(255,255,255,.85),
    inset 0 -.5px 0 0 rgba(0,0,0,.07),
    inset 0 0 46px rgba(255,255,255,.22),
    0 34px 90px rgba(0,0,0,.26),
    0 2px 10px rgba(0,0,0,.10);
  --ea-band-fill:rgba(127,127,127,.08);
  /* 输入框不再用实心底：深色下 --dsw-alias-bg-base 就是纯黑，压在半透明玻璃上会变成一块黑砖。
     改成「比玻璃略深一点的凹槽」+ 一圈细边，既有输入区的边界，又不把玻璃挖掉一块。 */
  --ea-field-fill:rgba(255,255,255,.55);
  --ea-field-border:rgba(0,0,0,.12);
  /* 审计 2026-10-31：宿主的 warn/tertiary/error 是按大面积色块设计的，压在这层玻璃上不够读。
     实测（WCAG 2.x，背景取合成后的 #fbfbfd / #fafafc）：
       warn #f59e0b 2.06:1、tertiary #81858c 3.59:1、error #ec1313 4.35:1 —— 都是 11~12.5px 小字，阈值 4.5。
     这里换成算过的深色版（warn #a15c00 5.09:1、tertiary #6b7075 4.9:1、error #c4161c 5.96:1），
     只改插件自己的变量，不动宿主 token。 */
  --ea-warn:#a15c00;
  --ea-warn-border:rgba(161,92,0,.45);
  --ea-danger:#c4161c;
  --ea-text-tertiary:#6b7075;
  /* 行内代码不再用宿主那块 markdown 代码底色：深色主题下它是不透明的深灰，
     贴在玻璃上就是一个个「黑框」（用户截图里圈出来的就是这些）。改成很淡的一层亮底。 */
  --ea-code-fill:rgba(127,127,127,.14);
  --ea-code-block-fill:rgba(127,127,127,.10);
  /* 模型选择页是叠在对话之上的一层玻璃：比外壳更糊一点，免得下面的对话字透上来抢注意力。 */
  --ea-glass-pane:rgba(250,250,252,.84);
  background:var(--ea-glass-sheen),var(--ea-glass-fill);
  -webkit-backdrop-filter:blur(28px) saturate(170%);
  backdrop-filter:blur(28px) saturate(170%);
  color:var(--dsw-alias-label-primary,#111);
  border:0;
  border-radius:26px;
  box-shadow:var(--ea-glass-shadow);
  overflow:hidden;pointer-events:auto;
  font-size:13px;line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
/* 深色不是把浅色的数值调暗就算完，试过两版才定成现在这样：
   · 白边按 0.5 直接搬过来会「掉漆」（深底上白边过曝），所以顶边压到 0.24、侧边 0.10；
   · 底色用比页面(#141414)亮一档的中性灰(#34373d)而不是纯黑 —— 玻璃要「浮起来」，
     和页面同色只会变黑；55% 的填充刚好让背后的字化成软影，又不至于读不清正文；
   · 投影加深到 0.55，否则边缘在深色页面上看不出是独立的一层。 */
body[data-ds-dark-theme] .dsh-explain-assistant-overlay{
  --ea-glass-fill:rgba(72,77,86,.56);
  --ea-glass-sheen:linear-gradient(155deg,rgba(255,255,255,.11) 0%,rgba(255,255,255,.04) 22%,rgba(255,255,255,0) 46%,rgba(255,255,255,0) 76%,rgba(255,255,255,.05) 100%);
  --ea-glass-shadow:
    inset 0 1px 0 0 rgba(255,255,255,.24),
    inset 1px 0 0 0 rgba(255,255,255,.09),
    inset 0 -1px 0 0 rgba(0,0,0,.42),
    inset 0 0 0 1px rgba(255,255,255,.08),
    inset 0 0 46px rgba(255,255,255,.045),
    0 32px 80px rgba(0,0,0,.55),
    0 2px 12px rgba(0,0,0,.4);
  --ea-band-fill:rgba(255,255,255,.06);
  --ea-field-fill:rgba(0,0,0,.20);
  --ea-field-border:rgba(255,255,255,.14);
  /* 深色下 tertiary 本来就够（#adb2b8 对 #32343a 是 5.83:1），只有错误红偏暗（3.78:1），
     提亮成 #ff8a8a（5.38:1）；警告用 #f0b429（7.1:1）。 */
  --ea-warn:#f0b429;
  --ea-warn-border:rgba(240,180,41,.5);
  --ea-danger:#ff8a8a;
  --ea-text-tertiary:#b3b8be;
  --ea-code-fill:rgba(255,255,255,.075);
  --ea-code-block-fill:rgba(255,255,255,.05);
  --ea-glass-pane:rgba(60,65,73,.70);
  /* 深色页面本身几乎没有明暗差，只靠 blur 看不出「糊了什么」。给背景抬 12% 亮度，
     背后的字才会化成可见的软影，而不是被一层灰吃掉。 */
  -webkit-backdrop-filter:blur(28px) saturate(170%) brightness(1.12);
  backdrop-filter:blur(28px) saturate(170%) brightness(1.12);
}
/* 没有 backdrop-filter 的引擎：退回实心底。宁可少一层玻璃，也不能糊成一片看不清字。 */
@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){
  .dsh-explain-assistant-overlay{background:var(--dsw-alias-bg-base,#fff)}
  body[data-ds-dark-theme] .dsh-explain-assistant-overlay{background:var(--dsw-alias-bg-base,#141414)}
}
.dsh-explain-assistant-overlay *,.dsh-explain-assistant-overlay *::before,.dsh-explain-assistant-overlay *::after{box-sizing:border-box}

/* ---------- 标题栏 ---------- */
.dsh-explain-assistant-titlebar{
  display:flex;align-items:center;gap:10px;flex:0 0 auto;
  min-height:46px;padding:0 10px 0 14px;
  cursor:move;user-select:none;
  border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));
  background:var(--ea-band-fill,rgba(127,127,127,.06));
}
.dsh-explain-assistant-titlebar .ea-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600;letter-spacing:.02em}
.dsh-explain-assistant-status{flex:1 1 auto;min-width:0;font-size:12px;color:var(--ea-text-tertiary,#777);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ea-header-actions{
  display:flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;
  /* 必须压在八个 resize 热区（z-index:3）之上 —— 热区是绝对定位、DOM 里排在标题栏后面，
     不这样会被它们盖住。实测过：420px 宽的面板里，右上角那个 24×24 的 NE 热区
     正好压住「×」的中心左侧，点关闭变成"开始拖拽改大小"，窗根本关不掉。 */
  position:relative;z-index:4;
}
/* 按钮组里只有「模型」按钮参与收缩（它最能缩）。其余按钮 flex:0 0 auto，
   否则窗口一窄，「选择主对话内容」会先被压扁、先被挤出可视区。 */
.ea-header-actions > .ea-btn:not(.ea-model-trigger),
.ea-header-actions > .dsh-explain-assistant-close{flex:0 0 auto}
.dsh-explain-assistant-close{
  font-size:20px;line-height:1;background:none;border:0;padding:4px 8px;cursor:pointer;
  border-radius:8px;color:var(--dsw-alias-label-secondary,#444);
}
.dsh-explain-assistant-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}

/* ---------- 通用按钮 ---------- */
.ea-btn{
  font:inherit;line-height:1.2;
  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));
  border-radius:8px;
  background:var(--dsw-alias-bg-base,#fff);
  color:var(--dsw-alias-label-primary,#111);
  padding:6px 11px;cursor:pointer;
  white-space:nowrap;
  transition:background .12s ease,border-color .12s ease;
}
.ea-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ea-btn:disabled{opacity:.5;cursor:not-allowed}
.ea-btn-soft{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));border-color:transparent;padding:5px 10px;font-size:12px}
.ea-btn-quiet{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary,#555);padding:4px 8px;font-size:12px}
.ea-btn-quiet:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.ea-btn-primary{
  background:var(--dsw-alias-button-primary-fill,#2f6bff);
  border-color:var(--dsw-alias-button-primary-fill,#2f6bff);
  color:var(--dsw-alias-label-primary-inverted,#fff);
  font-weight:600;padding:9px 18px;
}
.ea-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#245bdd);border-color:var(--dsw-alias-button-primary-hover,#245bdd)}

/* ---------- 正文滚动区 ---------- */
/* 浮窗的中间层：正文 + 输入区。模型选择页绝对定位盖在它上面（见下），
   这样「输入区隐藏」造成的重排发生在遮挡物后面，看不见。 */
.ea-main{position:relative;display:flex;flex:1 1 auto;flex-direction:column;min-height:0}
.dsh-explain-assistant-content{
  display:flex;flex:1 1 auto;flex-direction:column;gap:12px;
  min-height:0;overflow-y:auto;overflow-x:hidden;
  padding:14px;
  scrollbar-width:thin;
  /* 跟随期间**关掉浏览器的滚动锚定**（用户 2026-10-31：「A. 一顿一顿」）。
     锚定会在内容变化时自己改 scrollTop，与我们每帧的写操作抢同一个值 ——
     两边各推一次，看起来就是规律性的顿挫。位置补偿我们自己做了
     （翻页用 ctx.anchor、落地用 handoffAnchor），不需要浏览器再插一手。 */
  overflow-anchor:none;
}
.ea-slot{display:flex;flex-direction:column;gap:12px}
.ea-slot:empty{display:none}

/* ---------- 首次打开的引导 ---------- */
.ea-hero{
  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));
  border-radius:10px;padding:12px 14px;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));
}
.ea-hero-title{margin:0 0 8px;font-size:13px;color:var(--dsw-alias-label-secondary,#444)}
.ea-hero-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#555)}
.ea-hero-list li{line-height:1.65}

/* ---------- 卡片 ---------- */
.ea-card{
  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));
  border-radius:10px;padding:11px 12px;
  display:flex;flex-direction:column;gap:8px;
}
.ea-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ea-card-title{margin:0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#3a3a3a);flex:0 0 auto}
.ea-count{
  display:inline-block;min-width:18px;text-align:center;
  font-size:11px;line-height:16px;padding:0 5px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16));
  color:var(--ea-text-tertiary,#666);
}
.ea-count-inline{margin-left:auto}

/* ---------- 回答 / 运行中 ---------- */
/* 回答正文。
   注意这里**刻意不再写 white-space:pre-wrap**：正文现在按 Markdown 渲染成真正的
   块级元素（<p>/<h2>/<ul>/<pre>…），块与块之间的换行由 margin 表达；
   若还留着 pre-wrap，源码里那些换行会再被当成可见空行，段距会翻倍。
   排版细节统一交给下面的 .ea-md-* 一组规则。 */
.ea-answer{
  word-break:break-word;
  font-size:13.5px;line-height:1.75;
  padding:12px 14px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));
}
.ea-answer[hidden]{display:none}

/* ---------- 正文里的 Markdown 排版 ---------- */
/* .ea-md-scope 是「这里面的文字是模型写的、要按 Markdown 排版」的标记类。
   压缩摘要、推理过程这类地方用它 —— 排版规则与正文一致，但作用域不止正文，
   所以下面这组规则统一挂 .ea-md-scope 而不是 .ea-answer。 */
.ea-md-scope .ea-md-p{margin:0 0 7px}
.ea-md-scope .ea-md-p:last-child{margin-bottom:0}
.ea-md-scope .ea-md-h{margin:10px 0 5px;font-size:13px;font-weight:650;line-height:1.4}
.ea-md-scope .ea-md-list{margin:0 0 7px;padding-left:20px}
.ea-md-scope .ea-md-code{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,Menlo,Consolas,monospace);font-size:.92em;padding:1px 4px;border-radius:4px;background:var(--ea-code-fill,rgba(127,127,127,.16))}
.ea-md-scope .ea-md-pre{margin:0 0 7px;padding:8px 10px;border-radius:7px;background:var(--ea-code-block-fill,rgba(127,127,127,.13));overflow-x:auto}
.ea-md-scope .ea-md-codeblock{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,Menlo,Consolas,monospace);font-size:11.5px;line-height:1.6;white-space:pre;display:block;min-width:max-content}
.ea-md-scope .ea-md-link{color:var(--dsw-alias-link,#2f6bff);text-decoration:underline}
.ea-md-scope .ea-md-quote{margin:0 0 7px;padding-left:9px;border-left:3px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16))}
.ea-md-scope .ea-md-strong{font-weight:650}
.ea-md-scope .ea-md-del{text-decoration:line-through}
/* Markdown 表格（0.2.12）。**长期允许**：提示词里表格那一项不随临时放宽收回（见 src/host/prompts.ts）。
   渲染器产出 table/thead/tr/th/td，这里给它们排版。横向溢出用 wrap 兜住，
   免得一张宽表把整个浮窗撑破（浮窗宽度是用户自己拖的，不能假设够宽）。 */
.ea-md-scope .ea-md-table-wrap{margin:0 0 8px;overflow-x:auto}
.ea-md-scope .ea-md-table{border-collapse:collapse;font-size:12.5px;line-height:1.5}
.ea-md-scope .ea-md-th,.ea-md-scope .ea-md-td{padding:4px 8px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14));text-align:left;vertical-align:top}
.ea-md-scope .ea-md-th{font-weight:650;background:var(--ea-code-block-fill,rgba(127,127,127,.10))}
.ea-md-scope .ea-md-th[data-align=center],.ea-md-scope .ea-md-td[data-align=center]{text-align:center}
.ea-md-scope .ea-md-th[data-align=right],.ea-md-scope .ea-md-td[data-align=right]{text-align:right}

.ea-answer .ea-md-p{margin:0 0 9px}
.ea-answer .ea-md-p:last-child{margin-bottom:0}
.ea-answer .ea-md-h{margin:14px 0 8px;line-height:1.4;font-weight:650}
.ea-answer .ea-md-h:first-child{margin-top:0}
.ea-answer .ea-md-h1{font-size:17px}
.ea-answer .ea-md-h2{font-size:15.5px}
.ea-answer .ea-md-h3{font-size:14.5px}
.ea-answer .ea-md-h4,.ea-answer .ea-md-h5,.ea-answer .ea-md-h6{font-size:13.5px}
.ea-answer .ea-md-list{margin:0 0 9px;padding-left:22px}
.ea-answer .ea-md-list:last-child{margin-bottom:0}
.ea-answer .ea-md-li{margin:2px 0}
.ea-answer .ea-md-quote{
  margin:0 0 9px;padding:2px 0 2px 11px;
  border-left:3px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));
  color:var(--dsw-alias-label-secondary,#555);
}
.ea-answer .ea-md-quote:last-child{margin-bottom:0}
.ea-answer .ea-md-quote .ea-md-p{margin-bottom:6px}
.ea-answer .ea-md-hr{margin:12px 0;border:0;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12))}
/* 行内代码 */
.ea-answer .ea-md-code{
  font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
  font-size:.92em;padding:1px 5px;border-radius:4px;
  background:var(--ea-code-fill,rgba(127,127,127,.16));
  word-break:break-word;
}
/* 代码块：长行横向滚动，不要撑破浮窗 */
.ea-answer .ea-md-pre{
  margin:0 0 9px;padding:10px 12px;border-radius:8px;
  background:var(--ea-code-block-fill,rgba(127,127,127,.13));
  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));
  overflow-x:auto;
}
.ea-answer .ea-md-pre:last-child{margin-bottom:0}
.ea-answer .ea-md-codeblock{
  font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
  font-size:12px;line-height:1.6;white-space:pre;
  display:block;min-width:max-content;
}
.ea-answer .ea-md-link{color:var(--dsw-alias-link,#2f6bff);text-decoration:underline;text-underline-offset:2px}
.ea-answer .ea-md-strong{font-weight:650}
.ea-answer .ea-md-del{text-decoration:line-through;color:var(--dsw-alias-label-secondary,#666)}
/* 正文里的表格（.ea-answer 作用域）：与 .ea-md-scope 同规则，只是选择器前缀不同 ——
   两处都必须写，因为浮窗正文走 .ea-answer，压缩摘要/推理/历史走 .ea-md-scope。 */
.ea-answer .ea-md-table-wrap{margin:0 0 9px;overflow-x:auto}
.ea-answer .ea-md-table{border-collapse:collapse;font-size:12.5px;line-height:1.5}
.ea-answer .ea-md-th,.ea-answer .ea-md-td{padding:4px 8px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14));text-align:left;vertical-align:top}
.ea-answer .ea-md-th{font-weight:650;background:var(--ea-code-block-fill,rgba(127,127,127,.10))}
.ea-answer .ea-md-th[data-align=center],.ea-answer .ea-md-td[data-align=center]{text-align:center}
.ea-answer .ea-md-th[data-align=right],.ea-answer .ea-md-td[data-align=right]{text-align:right}
.ea-answer .ea-md-image{max-width:100%;height:auto;border-radius:6px}
.ea-answer .ea-md-image-alt{color:var(--ea-text-tertiary,#777);font-style:italic}
/* ---------- 加载页（未就绪）----------
   未就绪期间界面上只有这一段，所以它必须**一眼被读成「正在加载」**：
   有转圈、有明确的进行中文案，并且额外写清「这里现在什么都没有，是因为还没读到，
   不是因为你没有数据」—— 空态文案（「暂时没有可用的模型」「还没有小助手历史」）
   在这段时间里一个都不会出现。 */
.ea-loading{padding:18px 4px;display:flex;flex-direction:column;gap:9px}
.ea-loading-row{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--dsw-alias-label-secondary,#555)}
.ea-loading-text{font-weight:600}
.ea-loading-hint{margin:0;font-size:12px;line-height:1.6;color:var(--ea-text-tertiary,#777)}

/* ---------- 从不可见到可见的那一次（t4）----------
 * 浮窗现在等 /state 有结局才挂载，所以它**第一次出现在页面上时就已经是最终形态**：
 * 最终几何 + 真实内容。此时唯一还需要的过渡就是「淡入」——让出现这件事不显得生硬。
 *
 * 三条硬约束（对应验收判据 2/9）：
 *   1. **只做透明度，不做位置/尺寸**：不得出现补间动画。from/to 里没有
 *      left/top/width/height/transform，窗口的几何从第一帧起就是最终值、此后不变。
 *   2. **不得影响布局与命中测试**：opacity 不参与布局，所以第一帧的
 *      getBoundingClientRect 就已经等于最终几何（几何不因动画而改变）。
 *   3. **reduced-motion 下不动画**：见文件末尾的媒体查询。 */
@keyframes ea-overlay-in{
  from{opacity:0}
  to{opacity:1}
}
.dsh-explain-assistant-overlay{animation:ea-overlay-in 140ms ease-out}
/* 关闭浮窗：真节点已释放，留下的是**克隆体**（见 exit-anim.ts）在播这一段。
   用户这一轮的要求是「优化关闭小助手后的动画」—— 之前它是一帧之内消失。
   只动 opacity/transform/filter，不动 left/top/width/height：窗口几何从不参与动画，
   于是关闭过程不会连带改变任何布局；pointer-events:none 保证退场的 180ms 绝不拦下一次点击。 */
/* 退场只动 opacity 与 translateY：
   · 不去 blur：对一整块带 backdrop-filter 的玻璃做 filter，会让它每帧重新栅格化；
   · 不去 scale：缩放同样迫使 backdrop 重算，420×620 上实测掉帧。
   两者叠加就是用户说的"卡卡的"。will-change 提前把它提成合成层，动画期间只改不透明度。 */
.ea-overlay[data-leaving=true]{
  pointer-events:none;
  will-change:opacity,transform;
  /* 这里**没有**关掉 backdrop-filter：试过，帧间隔的改善在噪声范围内（47ms → 44ms），
     但代价是这 180ms 里整块面板会变得明显更透（玻璃底色只有 56%），
     看起来像"闪了一下"。宁可留着那一两毫秒，也不要这个观感。 */
  animation:ea-overlay-out 180ms cubic-bezier(.32,.72,0,1) both;
}
@keyframes ea-overlay-out{
  from{opacity:1;transform:translateY(0)}
  to{opacity:0;transform:translateY(6px)}
}
/* 「状态没读到」的错误页：与加载页互斥，是失败结局的出路（含重试）。 */
.ea-state-error{display:flex;flex-direction:column;gap:9px;align-items:flex-start}
.ea-state-error-reason{margin:0}
.ea-state-error-hint{margin:0;font-size:12px;line-height:1.6;color:var(--ea-text-tertiary,#777)}
.ea-state-retry{align-self:flex-start}
.ea-running{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#555)}
.ea-spinner{
  width:14px;height:14px;flex:0 0 auto;border-radius:50%;
  border:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.2));
  border-top-color:var(--dsw-alias-button-primary-fill,#2f6bff);
  animation:ea-spin .8s linear infinite;
}
@keyframes ea-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){
  .ea-spinner{animation:none}
  /* 关闭：减少动态偏好下不做退场动画（克隆体仍会在 EXIT_MS 之后被摘掉，只是不播）。 */
  .ea-overlay[data-leaving=true]{animation:none;opacity:0}
  /* 选择模式：让开这件事本身也不做过渡，直接到位。 */
  .ea-overlay .ea-header,.ea-overlay .ea-main,/* 深色主题那条规则（body[data-ds-dark-theme] .dsh-explain-assistant-overlay，0,2,1）
   在后文重新声明了 backdrop-filter，比上面那条（0,2,0）高 —— 不显式盖一次，
   选择模式下会留下一块**磨砂**的玻璃板（实测：底色已透明，但背后的内容仍然被模糊）。 */
body[data-ds-dark-theme] .dsh-explain-assistant-overlay[data-selection-mode=true]{-webkit-backdrop-filter:none;backdrop-filter:none}
.ea-overlay[data-selection-mode=true] .ea-header,.ea-overlay[data-selection-mode=true] .ea-main{transition:none}
  /* t4：减少动态偏好下**不做**淡入，但落点不变 —— 浮窗仍是直接以最终几何出现。
     关的只是动画，不是「不显示」：不会因此空白，也不会跳位或露错值。 */
  .dsh-explain-assistant-overlay{animation:none}
}

/* ---------- 错误 ---------- */
.dsh-explain-assistant-error,.ea-error{
  color:var(--ea-danger,#b42318);
  background:var(--dsw-alias-bg-layer-1,rgba(180,35,24,.08));
  border:1px solid var(--ea-danger,rgba(180,35,24,.3));
  padding:9px 11px;border-radius:9px;font-size:12.5px;
  white-space:pre-wrap;word-break:break-word;
}

/* ---------- 快捷问题 ---------- */
.ea-quick{
  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));
  border-radius:10px;padding:11px 12px;
  display:flex;flex-direction:column;gap:9px;
}
.ea-quick-row{display:flex;flex-wrap:wrap;gap:7px}
.ea-chip{
  border-radius:999px;padding:6px 13px;font-size:12.5px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));
  border-color:transparent;
}
.ea-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}

/* ---------- 模型：标题栏按钮 ---------- */
/* 模型选择不再是正文里的一张卡片，而是标题栏里的一个按钮：恒显示「现在用哪个模型」。 */
.ea-model-trigger{
  display:inline-flex;align-items:center;gap:6px;
  /* min-width 是「地板」：窗口缩到最小宽度 360px 时，它至少还剩下
     「模型」两个字 + 下拉箭头（约 52px），而不是被压成一条 18px 的空白条。
     再窄的部分由 .ea-title 让位（它可以省略成「解释小助…」）。 */
  flex:0 1 auto;min-width:52px;max-width:56%;
  padding:5px 8px;font-size:12px;overflow:hidden;
}
/* 未就绪/没读到时不出现（见 overlay.tsx 的三档界面）。作者样式会盖掉 UA 的 [hidden] */
.ea-model-trigger[hidden]{display:none}
.ea-model-trigger-prefix{flex:0 0 auto;font-size:11px;color:var(--ea-text-tertiary,#777)}
.ea-model-trigger-prefix[hidden]{display:none}
.ea-model-trigger-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ea-model-trigger-caret{flex:0 0 auto;font-size:9px;line-height:1;opacity:.65;transition:transform var(--ea-page-in-dur,220ms) var(--ea-page-ease,cubic-bezier(.2,.85,.25,1))}
.ea-model-trigger[aria-expanded=true] .ea-model-trigger-caret{transform:rotate(180deg)}
.ea-model-trigger-warn{flex:0 0 auto;font-size:11px;color:var(--ea-warn,#b45309)}
.ea-model-trigger-warn[hidden]{display:none}
/* 未选模型：这不是「设置入口」，而是一件必须先做的事 —— 做成实心主色，一眼能看到。 */
.ea-model-trigger[data-unselected=true]{
  background:var(--dsw-alias-button-primary-fill,#2f6bff);
  border-color:transparent;font-weight:600;
  color:var(--dsw-alias-label-primary-inverted,#fff);
  max-width:100%;
}
.ea-model-trigger[data-unselected=true]:hover{background:var(--dsw-alias-button-primary-hover,#245bdd)}
/* 有提供方读取失败：不打开选择页也要看得出「这里有东西没读到」。 */
.ea-model-trigger[data-warn=true]{border-color:var(--ea-warn,#b45309)}
/* 选择页开着时按钮是「还按着」的状态（写在最后一条，靠后者生效）。 */
.ea-model-trigger[aria-expanded=true]{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16))}
/* 关掉选择页会把焦点还给它（键盘用户需要）。但**鼠标**用户不该看到一个焦点框：
   只在 :focus-visible（键盘/读屏）时画。 */
.ea-model-trigger:focus:not(:focus-visible){outline:none}

/*
 * 窄宽度（浮窗被拖到 420px 甚至最小 360px）时的标题栏。
 *
 * 用**容器查询**而不是媒体查询：看的是**浮窗自己的宽度**，不是浏览器窗口 ——
 * 浮窗可以被拖到任意大小，媒体查询在这种场景下完全答非所问。
 * 这里做的事：去掉「模型」二字（按钮里还有模型名，语义仍清楚）、收紧间距，
 * 把省下来的宽度还给「解释小助手」标题与模型名（它们被截断才是真的难看）。
 */
@container (max-width: 470px){
  .dsh-explain-assistant-titlebar{gap:7px;padding:0 8px 0 10px}
  .ea-header-actions{gap:4px}
  .ea-model-trigger-prefix{display:none}
  .ea-model-trigger{max-width:62%;padding:5px 7px}
  /* 多了「?」教程入口之后，这一行在 420px 宽度上已经很紧：
     实测按钮总宽 317px、标题 71px，而面板只有 420px —— 模型按钮被压到 69px，
     里面只显示得下「选择…」。这里把每颗按钮的横向内边距各收 2~3px，
     省出来的十几像素刚好让模型按钮显示出完整文案。 */
  .ea-header-actions .ea-btn{padding-left:8px;padding-right:8px}
  .ea-header-actions .ea-btn{font-size:11.5px}
  /* 窄宽度下状态文字让位：它和标题、五个按钮抢同一条 420px 的线，
     结果是标题被压成「解释小…」、模型按钮被压成「Dee…」——两样都比状态更该读。
     状态本身在正文里都看得到（运行中那一行、压缩徽章），这里不丢信息。 */
  .dsh-explain-assistant-status{display:none}
  .ea-header .ea-title{font-size:13px}
  .ea-model-trigger{max-width:84px}
  .ea-header-actions .ea-tutorial-trigger{padding:0;width:24px;min-width:24px;font-size:12px}
  .ea-header-actions .dsh-explain-assistant-close{padding-left:5px;padding-right:5px}
}

/* ---------- 目录提示条（有提供方读失败时才有） ---------- */
/* 这几句是宿主明确告诉我们的事实，必须**不开选择页**也看得见（见 catalogNoticeNodes）。 */
.ea-catalog-note{
  display:flex;align-items:flex-start;gap:8px;
  padding:8px 10px;border-radius:9px;
  border:1px solid var(--ea-warn,rgba(180,83,9,.35));
  background:rgba(180,83,9,.07);
}
.ea-catalog-note-icon{flex:0 0 auto;font-size:12px;line-height:1.5;color:var(--ea-warn,#b45309)}
.ea-catalog-note-text{display:flex;flex:1 1 auto;flex-direction:column;gap:2px;min-width:0}
.ea-catalog-note-open{flex:0 0 auto;align-self:flex-start}
.ea-catalog-note-slot:empty{display:none}

/* ---------- 模型：选择页 ---------- */
/*
 * 为什么是「覆盖正文区的整页」而不是「锚定在按钮下方的小弹层」：
 * 浮窗可以被拖到屏幕任意位置，高度还可能只剩 420px；锚定弹层一旦比剩余空间高，
 * 就要么被裁掉、要么自己再滚一层，而它还要跟标题栏拖动、八向拖边热区抢指针事件。
 * 整页没有这些约束：一页只做一件事，关掉就回到对话。
 */
/* 页面槽：绝对定位盖住「正文 + 输入区」，自身不参与点击（里面那层才接事件）。 */
.ea-model-panel-slot{position:absolute;inset:0;z-index:3;pointer-events:none;background:var(--ea-glass-pane,var(--dsw-alias-bg-base,#fff));-webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%)}
.ea-overlay[data-view=model] .ea-model-panel-slot{pointer-events:auto}
/* 输入区只是「看不见」不是「不存在」：保留占位，避免打开瞬间正文高度跳一下。 */
.ea-overlay[data-view=model] .ea-composer{visibility:hidden}
.ea-overlay[data-view=model] .ea-body{pointer-events:none}
.ea-model-panel[data-closing=true]{pointer-events:none}
.ea-model-panel{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;height:100%}

/*
 * 两页切换的过渡。
 *
 * 为什么是「进来的那一页做动画」而不是「让旧页面滑走」：旧页面在切换那一刻就被
 * display:none 了（见上面 [data-view=model] 的规则），display 不可过渡；要让旧页面
 * 滑走就得把整页留在 DOM 里再等动画结束才摘 —— 那会引出「动画期间还能点到上一页的按钮」
 * 和「动画没播完就切回来」的一堆竞态。只给新页面一段 180ms 的淡入+轻抬，
 * 观感是连续的，代价接近零，也不存在中间态。
 *
 * 尊重系统的「减少动态效果」：开了该选项就完全不动画。
 */
/*
 * ── 两页切换的动效（这一版是照着动作本身设计的，不是随手加个淡入）────────────
 *
 * 动作是什么：标题栏上按了一下 → 内容从「对话」换成「模型选择」。这是**前进一层**，
 * 关掉是**退回一层**。所以：
 *   进：新页面从右往左 20px 就位（ease-out，先快后慢，像被推上来）
 *       旧页面同时往左退 12px 并淡出（更快、加速曲线，像被推走）
 *   回：反过来。新页面（对话）从左边 12px 就位，旧页面（模型页）往右退 20px 淡出。
 * 两页**同时**动，方向相反 —— 这才是「换页」，不是「弹出一个框」。
 *
 * 为什么不是上下滑：标题栏在上面，页面本来就从标题栏下面展开，纵向位移表达不出
 * 「又开了一层」（那更像提示条）。横向位移是导航的通用语汇。
 *
 * 时长/曲线分成两组，进入比退出慢一点（退出快一点才不挡路）：
 *   进 220ms cubic-bezier(.2,.85,.25,1)   —— 减速，收尾稳
 *   出 160ms cubic-bezier(.4,0,.9,.5)     —— 加速，干脆
 * 只动 transform / opacity，不动 width/height/left，避免每帧重排。
 *
 * 退出动画需要「先播完再摘节点」，所以关页面时 JS 会挂 data-closing，
 * 播完（160ms 后）才把节点摘掉 —— 摘早了你只会看到它凭空消失。
 */
.ea-overlay{
  --ea-page-in-dur:220ms;--ea-page-out-dur:160ms;
  /* 选择相关的动效时长：进 180ms / 退 140ms。
     与页面切换（220/160）同一族但更快 —— 选一条内容是个小动作，
     用整页的时长会显得拖；用同样的曲线族才不会像另一套东西。 */
  --ea-pick-in-dur:180ms;--ea-pick-out-dur:140ms;
  --ea-page-ease:cubic-bezier(.2,.85,.25,1);
  --ea-page-ease-out:cubic-bezier(.4,0,.9,.5);
}
@media (prefers-reduced-motion: no-preference){
  /* 进：模型页就位 */
  .ea-overlay[data-view=model] .ea-model-panel{animation:ea-page-in var(--ea-page-in-dur) var(--ea-page-ease) both}
  /* 进：对话页被推走 */
  .ea-overlay[data-view=model] .ea-body{animation:ea-chat-recede var(--ea-page-out-dur) var(--ea-page-ease-out) both}
  /* 回：对话页回到原位（由 JS 在关闭时挂 data-returning，只在这一刻播） */
  .ea-overlay[data-returning=true] .ea-body{animation:ea-chat-return var(--ea-page-in-dur) var(--ea-page-ease) both}
  /* 回：模型页退场（JS 挂 data-closing） */
  .ea-model-panel[data-closing=true]{animation:ea-page-out var(--ea-page-out-dur) var(--ea-page-ease-out) both}
}
.ea-model-panel{position:relative}
/* 层叠感：新页面「压在」旧页面上面。左缘一道很淡的渐变阴影，随页面就位淡掉 ——
   没有它，两页只是交叉淡入淡出，看的人分不出哪一层在上面（那就是「随便做的」的观感来源）。
   用伪元素 + opacity 而不是动 box-shadow：仍然只动合成层，不重绘。 */
.ea-model-panel::before{
  content:'';position:absolute;left:-16px;top:0;bottom:0;width:16px;pointer-events:none;
  background:linear-gradient(to right,rgba(0,0,0,.12),rgba(0,0,0,0));
}
.ea-overlay[data-view=model] .ea-model-panel::before{animation:ea-edge-fade var(--ea-page-in-dur) var(--ea-page-ease) both}
@keyframes ea-edge-fade{from{opacity:1}to{opacity:0}}
/* 内容比容器晚一点点落位（70ms）：页面先到、内容再坐稳。
   只给列表做主次，不逐个给每一行加延迟 —— 那在小窗口里会显得碎。 */
.ea-overlay[data-view=model] .ea-model-panel-list{animation:ea-settle 200ms var(--ea-page-ease) 70ms both}
@keyframes ea-settle{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
@keyframes ea-page-in{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}
@keyframes ea-page-out{from{opacity:1;transform:none}to{opacity:0;transform:translateX(24px)}}
@keyframes ea-chat-recede{from{opacity:1;transform:none}to{opacity:0;transform:translateX(-14px)}}
@keyframes ea-chat-return{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}
.ea-model-panel-head{
  display:flex;align-items:center;gap:8px;flex:0 0 auto;
  padding:8px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));
  background:var(--ea-band-fill,rgba(127,127,127,.05));
}
.ea-model-panel-back{flex:0 0 auto}
.ea-model-panel-title{margin:0;font-size:13px;font-weight:600;flex:0 0 auto}
.ea-model-panel-count{margin-left:auto;flex:0 0 auto}
.ea-model-panel-refresh{flex:0 0 auto}
.ea-model-panel-current{
  margin:0;padding:9px 12px 0;flex:0 0 auto;
  font-size:12px;line-height:1.6;word-break:break-all;
  color:var(--dsw-alias-label-secondary,#555);
}
/* 未选模型：这句话是**结论性提示**，不能只是灰字。 */
.ea-model-panel-current[data-unselected=true]{color:var(--ea-warn,#b45309);font-weight:600}
.ea-model-panel-filter{padding:9px 12px;flex:0 0 auto}
.ea-model-search{
  width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;padding:7px 10px;border-radius:8px;
  border:0;
  background:var(--ea-field-fill,rgba(255,255,255,.55));
  box-shadow:inset 0 1px 2px rgba(0,0,0,.14);color:var(--dsw-alias-label-primary,#111);
}
.ea-model-list{
  display:flex;flex:1 1 auto;flex-direction:column;gap:12px;
  min-height:0;overflow-y:auto;padding:0 12px 12px;
  scrollbar-width:thin;
}
.ea-model-group{display:flex;flex-direction:column;gap:4px}
.ea-model-group-name{
  display:flex;align-items:center;gap:7px;
  position:sticky;top:0;padding:6px 2px;
  font-size:11.5px;font-weight:600;letter-spacing:.02em;
  color:var(--ea-text-tertiary,#666);
  background:var(--ea-glass-pane,var(--dsw-alias-bg-base,#fff));-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)
}
.ea-model-options{display:flex;flex-direction:column;gap:2px}
/* 一行一个模型：名字 + 模型 id（等宽小字，用来核对「到底是哪一个」）+ 选中勾。 */
.ea-model-option{
  display:flex;align-items:baseline;gap:8px;width:100%;box-sizing:border-box;
  text-align:left;padding:7px 9px;border-radius:8px;font-size:12.5px;
  background:transparent;border-color:transparent;
}
.ea-model-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ea-model-option-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ea-model-option-id{
  flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:11px;color:var(--ea-text-tertiary,#777);
}
.ea-model-option-check{flex:0 0 auto;width:1em;font-size:12px;color:transparent}
.ea-model-option[aria-pressed=true]{
  background:var(--dsw-alias-bg-layer-2,rgba(47,107,255,.1));
  border-color:transparent;font-weight:600;
  color:var(--dsw-alias-button-primary-fill,#2f6bff);
}
.ea-model-option[aria-pressed=true] .ea-model-option-check{color:var(--dsw-alias-button-primary-fill,#2f6bff)}
.ea-model-option[aria-pressed=true] .ea-model-option-id{color:inherit;opacity:.8}
.ea-model-panel-failures{
  display:flex;flex:0 0 auto;flex-direction:column;gap:3px;
  padding:8px 12px 12px;
  border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));
}
.ea-model-panel-failures[hidden]{display:none}
.ea-model-failure{display:block;font-size:11.5px;color:var(--ea-warn,#a15c00);line-height:1.5}

/* ---------- 依据 ---------- */
.ea-evidence-row{display:flex;flex-direction:column;gap:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1))}
.ea-evidence-row:first-of-type{border-top:0;padding-top:0}
.ea-row-head{display:flex;align-items:baseline;gap:8px;justify-content:space-between}
.ea-evidence-title{font-size:12.5px;word-break:break-all}
.ea-meta{font-size:11px;color:var(--ea-text-tertiary,#777);white-space:nowrap;flex:0 0 auto}
.ea-evidence-summary{margin:2px 0 0;font-size:12.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#444)}
/* 明细默认收起：输入框上方那排标签已经回答了「选了哪几条」，
   想看原文/分级再展开 —— 上一版这张卡是常驻的，4000 字原文把答案顶出可视区。 */
.ea-evidence-details{padding:0}
.ea-evidence-fold{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;list-style:none}
.ea-evidence-fold::-webkit-details-marker{display:none}
.ea-evidence-fold::before{content:'▸';font-size:10px;color:var(--ea-text-tertiary,#777);transition:transform 160ms cubic-bezier(.2,.85,.25,1)}
.ea-evidence-details[open] .ea-evidence-fold::before{transform:rotate(90deg)}
.ea-evidence-fold-hint{margin-left:auto;font-size:11px;color:var(--ea-text-tertiary,#777)}
.ea-evidence-details[open] .ea-evidence-fold-hint{display:none}
.ea-evidence-details .ea-evidence-row{padding:0 12px 10px}

/* ---------- 历史：对话式（问句右气泡 / 回答左正文） ---------- */
/* 尺寸与配色对着 dsh 的对话量出来：气泡圆角 20px、内边距 10×16、正文 14/22、
   气泡最大宽度是内容宽的 70.2%、气泡底色取 --dsw-specific-bubble。
   浮窗比主对话窄，字号按 13px 收一档，比例不变。 */
.ea-conv{display:flex;flex-direction:column;gap:18px}
/* 有「回到最近」时给底部留出它占的高度：按钮是 sticky 的，不预留就会压住最后一行字。 */
.ea-conv.has-jump{padding-bottom:44px}
.ea-conv-head{display:flex;align-items:center;gap:8px;margin-bottom:-6px;font-size:11.5px;line-height:16px;color:var(--ea-text-tertiary,#777)}
.ea-conv-head::after{content:'';flex:1 1 auto;height:1px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.ea-conv-title{font-weight:600;color:var(--dsw-alias-label-secondary,#555)}
.ea-conv-older{display:flex;justify-content:center}
.ea-conv-older-btn{border:0;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#555);font-size:12px;line-height:18px;padding:4px 12px;cursor:pointer;transition:background-color 120ms ease}
.ea-conv-older-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.2))}
.ea-conv-older-btn:disabled{cursor:default;opacity:.7}
.ea-turn{display:flex;flex-direction:column;gap:10px;min-width:0}
/* 问句：右对齐、20px 圆角、气泡底色跟着宿主主题走（浅色 #fdf4e7 / 深色 #272727）。 */
.ea-turn-q{align-self:flex-end;max-width:72%;border-radius:20px;padding:9px 14px;background:var(--dsw-specific-bubble,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14)));color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:21px;white-space:pre-wrap;word-break:break-word}
.ea-turn-meta{align-self:flex-end;margin-top:-6px;font-size:11px;line-height:16px;color:var(--ea-text-tertiary,#888);white-space:nowrap}
/* 回答：左对齐、无气泡、正文主色（灰色读起来像「次要说明」，对话里回答是主角）。 */
.ea-turn-a{font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary,#111);word-break:break-word;--ea-fold-height:220px;--ea-fold-fade:0px}
/* ---------- 折叠 / 展开全文 ---------- */
/* 折叠：默认只展开最新一轮，其余超过 10 行的收起来，末尾渐隐表示还有。
   渐隐宽度走 --ea-fold-fade（下面用 @property 注册成 <length>）——
   它可被过渡，展开时把渐隐收到 0、收起时再放回 34px，边缘就不会「啪」地一下切换。 */
@property --ea-fold-fade{syntax:'<length>';inherits:false;initial-value:0px}
.ea-turn-a[data-folded="true"]{
  max-height:var(--ea-fold-height,220px);
  overflow:hidden;
  --ea-fold-fade:34px;
  -webkit-mask-image:linear-gradient(180deg,#000 calc(100% - var(--ea-fold-fade)),transparent 100%);
  mask-image:linear-gradient(180deg,#000 calc(100% - var(--ea-fold-fade)),transparent 100%);
}
/* 动画期间（由 overlay.tsx 打上 data-fold-anim）：
   ① max-height 必须让位 —— 收起时高度是从整段往 220px 收，若还压着 220 的上限，画面会一动不动；
   ② 遮罩继续在，只改 --ea-fold-fade 的宽度做过渡；过渡时长由 JS 按距离写进内联样式。 */
.ea-turn-a[data-fold-anim]{
  max-height:none;
  overflow:hidden;
  -webkit-mask-image:linear-gradient(180deg,#000 calc(100% - var(--ea-fold-fade)),transparent 100%);
  mask-image:linear-gradient(180deg,#000 calc(100% - var(--ea-fold-fade)),transparent 100%);
  transition:--ea-fold-fade 240ms cubic-bezier(.4,0,.2,1);
}
.ea-turn-a .ea-md-h1{font-size:16px}
.ea-turn-a .ea-md-h2{font-size:14.5px}
.ea-turn-a .ea-md-h3{font-size:13.5px}
.ea-turn-reason{margin-top:-2px}
.ea-turn-foot{display:flex;align-items:center;gap:12px;margin-top:-4px;font-size:11.5px;line-height:16px;color:var(--ea-text-tertiary,#888);flex-wrap:wrap}
.ea-turn-foot button{border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer}
.ea-turn-foot button:hover{color:var(--dsw-alias-label-secondary,#555)}
.ea-turn-foot .ea-warn{font-size:11.5px}
/* 「回到最近」：往上翻过之后才出现，贴在可视区右下角。
   sticky 挂在按钮本身，再用负 margin 抵掉它占的高度 —— 这样它既固定在视野里，
   又不会把下面的内容推开。 */
.ea-conv-jump-btn{position:sticky;bottom:10px;align-self:flex-end;margin-top:-44px;z-index:2;width:34px;height:34px;border-radius:50%;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14));background:var(--dsw-alias-button-floating-fill,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-label-primary,#111);box-shadow:var(--dsw-elevation-panel,0 3px 8px rgba(0,0,0,.12));cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;transform:translateY(-6px)}
.ea-conv-jump-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.16))}
/* 当前这一问：与历史同一套样式，位置贴在输入框上方。 */
.ea-conv-live{display:flex;flex-direction:column;min-width:0}
.ea-conv-live[hidden]{display:none}
.ea-conv-live .ea-answer{padding:0;border:0;background:none;border-radius:0;font-size:13px;line-height:22px;color:var(--dsw-alias-label-primary,#111)}
.ea-conv-live .ea-slot{gap:8px}
/* 刚落地的那一条：180ms 淡入 + 上移 6px（与「标签进场」同一族曲线，动作更小、更快）。 */
@keyframes ea-turn-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ea-turn[data-enter="true"]{animation:ea-turn-in 180ms cubic-bezier(.2,.85,.25,1)}
@media (prefers-reduced-motion: reduce){.ea-turn[data-enter="true"]{animation:none}}
/* ---------- 「查看完整内容」面板：限高，自己滚 ---------- */
/* 记录能有多长就有多长（整段回答 + 依据 + 工具过程）。旧样式让它按内容长，
   于是在不高的窗口里它会一路长到输入框上沿、被那条边「切一刀」：面板没有下边框，
   最后一行字直接贴着输入框，看起来像界面坏了（用户 2026-10-25 的截图：点开完整内容后正文被切断）。
   现在按正文区高度封顶（--ea-body-h 由 overlay.tsx 量出来写在浮窗根元素上），
   超出部分由面板自己滚：面板有一条完整的圆角下边框，下面还露出「历史 N 条」——
   用户看得见这是一块能滚的记录，也看得见对话还在下面。 */
.dsh-explain-assistant-detail{
  max-height:calc(var(--ea-body-h, 640px) - 56px);
  overflow:hidden;
}
/* 卡片内部真正的滚区：标题行留在外面，滚的只有正文。
   最后 16px 做淡出（底部已经留了 18px 内边距，所以内容不长时淡出落在留白上，
   不会把最后一行字淡掉）；滚到中间时下一行是「渐隐」而不是被直线切断。 */
.ea-detail-scroll{
  flex:1 1 auto;min-height:0;overflow-y:auto;scrollbar-width:thin;
  display:flex;flex-direction:column;gap:8px;
  padding-bottom:18px;
  -webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 16px),transparent 100%);
  mask-image:linear-gradient(to bottom,#000 calc(100% - 16px),transparent 100%);
}

/* 详情面板（「查看完整内容」）的正文排版：与主回答同一套规则，不再各写一份。 */
.ea-detail-answer .ea-md-p{margin:0 0 8px}
.ea-detail-answer .ea-md-code{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,Menlo,Consolas,monospace);font-size:.92em;padding:1px 4px;border-radius:4px;background:var(--ea-code-fill,rgba(127,127,127,.16))}
.ea-detail-answer .ea-md-pre{margin:0 0 8px;padding:8px 10px;border-radius:7px;background:var(--ea-code-block-fill,rgba(127,127,127,.13));overflow-x:auto}
.ea-detail-answer .ea-md-codeblock{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,Menlo,Consolas,monospace);font-size:11.5px;line-height:1.6;white-space:pre;display:block;min-width:max-content}
.ea-detail-answer .ea-md-h{margin:10px 0 6px;font-weight:650}
/* 标题分级：补 ea-md-scope 后会被基础规则的 13px 接管；若放任，二级标题会与正文几乎一样粗
   （页面实测过的可见降级），所以按正文的比例补回来。 */
.ea-detail-answer .ea-md-h1{font-size:17px}
.ea-detail-answer .ea-md-h2{font-size:15.5px}
.ea-detail-answer .ea-md-h3{font-size:14.5px}
.ea-detail-answer .ea-md-h4,.ea-detail-answer .ea-md-h5,.ea-detail-answer .ea-md-h6{font-size:13.5px}
.ea-warn{font-size:11.5px;color:var(--ea-warn,#a15c00)}
.ea-empty{color:var(--ea-text-tertiary,#777);font-size:12.5px;margin:0}
/* ---------- 折叠块 ---------- */
.ea-disclosure>summary,.ea-tool>summary{
  cursor:pointer;font-size:12.5px;
  color:var(--dsw-alias-label-secondary,#444);
  padding:4px 0;
}
.ea-disclosure-body{
  max-height:260px;overflow:auto;
  white-space:pre-wrap;word-break:break-word;
  font-size:12px;line-height:1.65;
  padding:8px 10px;border-radius:8px;
  background:var(--ea-band-fill,rgba(127,127,127,.06));
  color:var(--dsw-alias-label-secondary,#555);
}
.ea-tool{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));padding-top:4px}
.ea-tool:first-of-type{border-top:0}
.ea-tool-body{display:flex;flex-direction:column;gap:6px;padding:4px 0 6px}
.ea-tool-detail{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#555)}
.ea-pre{
  margin:0;max-height:200px;overflow:auto;
  white-space:pre-wrap;word-break:break-word;
  font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  padding:8px 10px;border-radius:8px;
  background:var(--ea-code-fill,rgba(127,127,127,.1));
  color:var(--dsw-alias-label-secondary,#444);
}
.ea-tools{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));padding-top:10px}

/* ---------- 底部输入区（固定，不随正文滚动） ---------- */
.dsh-explain-assistant-form{
  display:flex;flex-direction:column;gap:9px;flex:0 0 auto;
  padding:11px 13px 12px;
  border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));
  background:var(--ea-band-fill,rgba(127,127,127,.05));
}
/* ---------- 输入框：白底板 + 平滑光标 + 蓝色选区 ----------
   移植自 More 设置向导 2026-10-25 版（见 text-field.ts）。
   底板（底色、圆角、内阴影）从输入框挪到外层 .ea-field：
   这样蓝色选区可以垫在底板之上、文字之下 —— 字本身一个像素都不会被染色。
   输入框自身透明、无阴影，只负责接收输入与原生选区。 */
.ea-field{
  position:relative;display:block;
  border-radius:12px;
  background:var(--ea-field-fill,rgba(255,255,255,.55));
  box-shadow:inset 0 1px 2px rgba(0,0,0,.16);
  /* 圆角裁切：选区与光标不会溢出圆角 */
  overflow:hidden;
}
.ea-field-mirror{
  position:absolute;left:0;top:0;box-sizing:border-box;
  margin:0;border:0;visibility:hidden;pointer-events:none;z-index:0;
}
.ea-field-selection{position:absolute;inset:0;pointer-events:none;z-index:1}
.ea-field-sel-box{
  position:absolute;left:0;top:0;width:0;height:0;border-radius:4px;
  background:var(--ea-selection,rgba(47,107,255,.28));
  opacity:0;transition:opacity .12s ease-out;
}
.ea-field-caret{
  position:absolute;left:0;top:0;width:2px;height:18px;border-radius:2px;
  background:var(--ea-caret,var(--dsw-alias-button-primary-fill,#2f6bff));
  pointer-events:none;z-index:3;opacity:0;
  transition:opacity .36s ease-in-out;
}
.ea-field-caret.is-blinking{animation:ea-caret-blink 1.2s ease-in-out infinite}
@keyframes ea-caret-blink{0%{opacity:1}30%{opacity:0}70%{opacity:0}100%{opacity:1}}
/* 原生光标让位给自绘光标；原生选中色让位给自绘蓝色矩形。
   只关背景不关文字色：选中时字仍然是原色，不会变成白字。 */
.ea-field[data-smooth="on"] .ea-input{caret-color:transparent}
.ea-field[data-smooth="on"] .ea-input::selection{background:transparent;color:inherit}
.ea-field[data-smooth="on"] .ea-input::-moz-selection{background:transparent;color:inherit}
@media (prefers-reduced-motion: reduce){
  .ea-field-caret{display:none}
  .ea-page-sel{display:none}
}

/* ---------- 正文选区的动画高亮（见 page-selection.ts） ----------
   z-index:-1 + 浮窗自身的层叠上下文：高亮排在浮窗背景之上、所有内容之下，
   于是它只染色底板，不覆盖任何字形（盖住字会让选中的字看起来变粗）。
   整层 pointer-events:none，拖选/双击/Ctrl+A/复制一概不受影响。 */
.ea-page-sel-layer{
  position:absolute;inset:0;z-index:-1;
  pointer-events:none;overflow:hidden;
  border-radius:inherit;
  contain:layout paint;
}
.ea-page-sel{
  position:absolute;left:0;top:0;width:0;height:0;
  border-radius:4px;
  background:var(--ea-selection,rgba(47,107,255,.28));
  opacity:0;
  /* 位置走 transform（见 page-selection.ts frameBlock）：left/top 是布局属性，
     每帧改一次就是一次布局，块多时单帧要好几毫秒。 */
  will-change:transform,width,opacity;
}
/* 自绘高亮在场时，把原生选中底色关掉（只关底色，字色保持原样，不会变成白字） */
.dsh-explain-assistant-overlay[data-page-selection="on"] ::selection{background:transparent;color:inherit}

/* 输入框本体：一个**真正的壳**。
   这里的每一条都是为了让可见边界只剩外层 .ea-field 那一条：
   display:block —— textarea 默认是 inline-block，会坐在基线上，
                   于是它比外层底板矮 4px，底下漏出一条底板的边，看起来就是「两层」；
   box-sizing    —— 不写的话 width:100% 会再把 padding 加一遍，横向胀出一圈；
   border-radius:0 / box-shadow:none / outline:none —— 圆角、阴影、焦点环统一交给底板。 */
.ea-input{
  position:relative;z-index:2;
  display:block;box-sizing:border-box;
  width:100%;min-height:52px;max-height:150px;
  /* 审计 2026-10-31：这里原本是 resize:vertical，右下角因此长出一条斜纹拖拽柄，
     还被 12px 圆角切掉一半；而窗口本身已经能拖边改大小，这条柄只会让人误以为在拖输入框。 */
  resize:none;
  padding:9px 11px;
  font:inherit;line-height:1.55;
  color:var(--dsw-alias-label-primary,#111);
  background:transparent;
  border:0;
  border-radius:0;
  box-shadow:none;
  outline:none;
}
.ea-input::placeholder{color:var(--ea-text-tertiary,#888)}
/* 右侧留出 18px：让「发送」按钮的命中区与右下角的热区**不相交**（原来重叠约 5×6px，
   发送按钮的右下角压在 ◢ 的左上角上）。13(表单右内边距)+18 = 31px，已让开 12px 的角热区。 */
.ea-composer-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-right:18px}
/* ---------- 「发送」：一颗玻璃胶囊 ---------- */
/* 参考项目：D:\\qq文件数据\\setup 的 .btn / .btn-bg / .btn-label（设置向导的「返回 / 继续」）。
   那颗按钮的观感是四件事叠出来的，这里照搬这四件：
     ① 外形：999px 胶囊 + 一层贴身投影（参考是 drop-shadow(0 10px 20px rgba(0,0,0,.5))），
        按钮浮在表面上，不是贴上去的；
     ② 表面：从上到下由亮到暗的一道竖向渐变 —— 顶上是受光面、底边收进暗部，才有厚度；
     ③ 边缘：顶沿一条 1.2px 亮线（光从上面来）、四周 1px 反光、顶沿内侧一道很浅的折射光、
        底沿一条暗线、最外 0.5px 一圈暗边（把浅色胶囊从底色上「切」出来）；
     ④ 文字：压在表面之上，带 1px 柔光字影（参考里 .btn-label 那条）。
   照着抄之后按我们的场景改了三处（都是实测定下来的）：
     · 尺寸：96×44 / 17px 是登录向导的；这里按 14.5px 收到 40px 高、92px 起宽，
       字高 / 按钮高 ≈ 0.36，与参考同比例；起宽刚好容下「处理中」，切忙碌态不跳宽
       （旧版这一行会跳 13px，左边那颗占用圆环跟着抖）；
     · 配色：不写死那条蓝，用宿主主题的 button-primary（深色主题是浅灰白、浅色主题是近黑），
       深浅两套各自的边缘反光写在下面的 dark 段里；
     · 透明度：底色取 88%（与参考的主按钮 .btn-primary 一致）。这一条试过三版：
       真按参考那颗次要按钮的 35% 做，在深灰带上会糊成一块灰塑料、字也发灰；
       完全做实（100%）又成了白瓷片。88% 保住一点「透」，字也够黑。
   为什么不用伪元素做底板：内阴影必须压在「填充之上、文字之下」，只有元素自己的 box-shadow
   同时满足这两条；高光渐变放进 background-image，同样在文字之下。 */
.ea-send{
  /* --ea-send-tint 是这颗胶囊的「本色」：底色、渐变中段、悬停/按下的提亮都从它派生，
     换主题只换这一个变量。 */
  --ea-send-tint:var(--dsw-alias-button-primary-fill,#0f1115);
  --ea-send-fill:color-mix(in srgb,var(--ea-send-tint) 88%,transparent);
  --ea-send-grad:linear-gradient(180deg,
      color-mix(in srgb,var(--ea-send-tint) 70%,#fff) 0%,
      var(--ea-send-tint) 48%,
      color-mix(in srgb,var(--ea-send-tint) 88%,#000) 100%);
  /* 浅色主题：宿主的 primary 是近黑，于是这是一颗黑玻璃胶囊（白字）。
     白边压在近黑上会过曝，所以顶沿 .62、四周 .30；底沿一道更深的黑，厚度才读得出来。 */
  --ea-send-rim:
    inset 0 0 0 1px rgba(255,255,255,.30),
    inset 0 1.2px 0 0 rgba(255,255,255,.62),
    inset 0 3px 5px -3px rgba(255,255,255,.30),
    inset .5px .5px 0 0 rgba(255,255,255,.35),
    inset 0 -1px 1px rgba(0,0,0,.45),
    0 0 0 .5px rgba(0,0,0,.10);
  --ea-send-label:var(--dsw-alias-label-primary-inverted,#fff);
  --ea-send-text-shadow:0 1px 2px rgba(0,0,0,.35);
  --ea-send-lift-y:6px;--ea-send-lift-blur:14px;--ea-send-lift-spread:-5px;--ea-send-lift-alpha:.45;
  display:inline-flex;align-items:center;justify-content:center;
  height:40px;min-width:92px;padding:0 22px;
  border:0;border-radius:999px;
  font-size:14.5px;font-weight:600;line-height:1;letter-spacing:.02em;
  color:var(--ea-send-label);
  background-color:var(--ea-send-fill);
  background-image:var(--ea-send-grad);
  text-shadow:var(--ea-send-text-shadow);
  box-shadow:var(--ea-send-rim),
             0 1px 2px rgba(0,0,0,.35),
             0 var(--ea-send-lift-y) var(--ea-send-lift-blur) var(--ea-send-lift-spread) rgba(0,0,0,var(--ea-send-lift-alpha));
  /* 94% 的底 + 背景模糊：玻璃的「透」还剩一点，但不会把底下的纹理带进字里。 */
  -webkit-backdrop-filter:blur(18px) saturate(150%);
  backdrop-filter:blur(18px) saturate(150%);
  transition:background-color .14s ease,box-shadow .16s ease,
             transform .1s cubic-bezier(.2,.7,.3,1),color .5s ease,text-shadow .5s ease;
}
/* 深色主题：宿主的 primary 是浅灰白 —— 同一套结构，按「光打在浅色玻璃上」重配边缘：
   顶沿亮线 .88、四周反光 .50、内侧折射 .65、底沿暗线 .12、外面一圈暗边 .26。 */
body[data-ds-dark-theme] .ea-send{
  --ea-send-tint:var(--dsw-alias-button-primary-fill,#dfe1e6);
  --ea-send-fill:color-mix(in srgb,var(--ea-send-tint) 88%,transparent);
  --ea-send-grad:linear-gradient(180deg,
      color-mix(in srgb,var(--ea-send-tint) 74%,#fff) 0%,
      var(--ea-send-tint) 48%,
      color-mix(in srgb,var(--ea-send-tint) 90%,#000) 100%);
  --ea-send-rim:
    inset 0 0 0 1px rgba(255,255,255,.50),
    inset 0 1.2px 0 0 rgba(255,255,255,.88),
    inset 0 3px 5px -3px rgba(255,255,255,.65),
    inset .5px .5px 0 0 rgba(255,255,255,.55),
    inset 0 -1px 1px rgba(0,0,0,.12),
    0 0 0 .5px rgba(0,0,0,.26);
  --ea-send-label:var(--dsw-alias-label-primary-inverted,#1b1d21);
  --ea-send-text-shadow:0 1px 0 rgba(255,255,255,.60);
  --ea-send-lift-alpha:.55;
}
/* 悬停：本色提亮一档（同一种材料被照得更亮，不是换一套颜色）、抬 1px、投影摊开。
   参考里没有这一步（向导的按钮不动），但输入区这颗每次提问都要点。 */
.ea-send:hover:not(:disabled){
  --ea-send-tint:color-mix(in srgb,var(--dsw-alias-button-primary-hover,#d2d4d8) 90%,#fff);
  --ea-send-lift-y:9px;--ea-send-lift-blur:18px;--ea-send-lift-spread:-6px;--ea-send-lift-alpha:.58;
  transform:translateY(-1px);
}
/* 按下：本色压暗一点、回原位、缩 1.5%、投影收窄、60ms 收 ——
   手感是「按进这颗玻璃里」，不是「按钮跳了一下」。 */
.ea-send:active:not(:disabled){
  --ea-send-tint:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#dfe1e6) 94%,#000);
  --ea-send-lift-y:2px;--ea-send-lift-blur:5px;--ea-send-lift-spread:-3px;--ea-send-lift-alpha:.45;
  transform:translateY(0) scale(.985);
  transition-duration:.06s;
}
/* 不可提交（读取中 / 暂时不可用 / 回答进行中）：不是把整颗按钮打到半透明 ——
   那样浅底上的字会一起糊掉，文案就看不见了。改成「只剩边缘反光的玻璃」：
   填充收到 10%、字回次要色、浮动投影撤掉，形状还在、字也清楚。
   这里直接写 background-color / background-image / box-shadow：
   深色那段是 body[data-ds-dark-theme] .ea-send（0,2,1），比 .ea-send:disabled（0,2,0）高，
   只改 --ea-send-* 变量会被它盖回去（第一版实测就是这么失效的）。 */
.ea-send:disabled{
  background-color:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#dfe1e6) 10%,transparent);
  background-image:none;
  color:var(--dsw-alias-label-secondary,#555);
  text-shadow:none;
  box-shadow:var(--ea-send-rim);
  opacity:1;
  transform:none;
  cursor:not-allowed;
}
/* 减少动态偏好：抬升、缩放这类位移一律不做（颜色与阴影的差别还在，状态照样看得出来）。 */
@media (prefers-reduced-motion: reduce){
  .ea-send{transition:none}
  .ea-send:hover:not(:disabled),.ea-send:active:not(:disabled){transform:none}
}
.ea-ring-slot{display:flex;align-items:center;min-width:0}

/* ---------- 选中模式提示 ---------- */
.ea-selection-status{font-size:12px;color:var(--ea-text-tertiary,#666);line-height:1.5;min-height:0}
.ea-selection-status:empty{display:none}
/* ---------- 选择模式：浮窗让开，把主对话让出来 ----------
 * 用户原话：「进入选择模式后，解释小助手暂时不显示，方便用户选择」。
 * 为什么不是 display:none：display 不可过渡，而且会让键盘焦点一起消失（Esc 就没人接了）；
 * 而且 opacity:0 的元素**仍然可以聚焦**，用户 Tab 会掉进看不见的按钮里 ——
 * 所以 visibility 延迟 140ms 再 hidden，既让淡出看得见，又把它从 Tab 序列里摘出去。
 * 浮窗整体 pointer-events:none：它盖住的那块主对话因此可以直接点。 */
.ea-overlay{transition:opacity 140ms ease,visibility 0s}
.ea-overlay[data-selection-mode=true]{
  pointer-events:none;outline:none;
  /* 整块浮窗（连玻璃带投影）一起淡出并隐藏。
     只藏 header/main 是不够的：根节点自己还有玻璃底色 + backdrop-filter，
     实测屏幕上会剩一块**磨砂灰板**，正好盖住用户要选的内容。
     用 visibility 而不是删背景：它同时也把里面所有控件从 Tab 序列里摘了出去。 */
  opacity:0;visibility:hidden;
  transition:opacity 140ms ease,visibility 0s linear 140ms;
  /* 关键：整块玻璃的底色/投影/毛玻璃也必须一起撤掉。
     第一版只藏了 header 与 main，结果屏幕右侧留下一块**空白的灰色玻璃板**——
     比不藏还糟：它挡住的正是用户要选的内容。 */
  background:transparent;
  box-shadow:none;
  -webkit-backdrop-filter:none;backdrop-filter:none;
}
.ea-overlay .ea-header,.ea-overlay .ea-main{transition:opacity 140ms ease,transform 140ms ease,visibility 0s}
.ea-overlay[data-selection-mode=true] .ea-header,
.ea-overlay[data-selection-mode=true] .ea-main{
  opacity:0;transform:scale(.985);pointer-events:none;visibility:hidden;
  transition:opacity 140ms ease,transform 140ms ease,visibility 0s linear 140ms;
}
/* 选择模式的浮动条：只在这个模式下存在（挂到 body 上、退出即摘，见 overlay.tsx）。
   它是「正在选 / 选了几条 / 怎么退出」的唯一可见载体 —— 浮窗让开之后，
   没有它就是"点了几张卡片、然后不知道怎么办"。 */
.ea-select-bar{
  position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147481000;
  display:flex;align-items:center;gap:10px;
  padding:6px 8px 6px 14px;border-radius:999px;max-width:min(92vw,560px);
  font-size:12.5px;line-height:1.4;color:var(--dsw-alias-label-primary,#111);
  background:var(--ea-select-bar-fill,rgba(255,255,255,.84));
  -webkit-backdrop-filter:blur(18px) saturate(180%);backdrop-filter:blur(18px) saturate(180%);
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,.6),
    inset 0 1px 0 0 rgba(255,255,255,.9),
    0 10px 30px rgba(0,0,0,.18),
    0 2px 6px rgba(0,0,0,.10);
  animation:ea-select-bar-in 160ms cubic-bezier(.2,.85,.25,1) both;
}
body[data-ds-dark-theme] .ea-select-bar{
  --ea-select-bar-fill:rgba(52,56,63,.86);
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,.16),
    inset 0 1px 0 0 rgba(255,255,255,.30),
    0 12px 34px rgba(0,0,0,.55),
    0 2px 8px rgba(0,0,0,.40);
}
@keyframes ea-select-bar-in{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}
.ea-select-bar-dot{
  width:7px;height:7px;flex:0 0 auto;border-radius:50%;
  background:var(--ea-pick-accent,#2f6bff);
  animation:ea-select-dot 1.6s ease-in-out infinite;
}
@keyframes ea-select-dot{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}
.ea-select-bar-count{font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap}
.ea-select-bar-hint{color:var(--ea-text-tertiary,#777);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ea-select-bar .ea-btn{height:26px;min-width:0;padding:0 12px;border-radius:999px;font-size:12px;line-height:1;white-space:nowrap}
.ea-select-bar-done{
  border:0;
  background:var(--dsw-alias-button-primary-fill,#0f1115);
  color:var(--dsw-alias-label-primary-inverted,#fff);
  font-weight:600;
}
.ea-select-bar-done:hover{background:var(--dsw-alias-button-primary-hover,#2a2d33)}
/* 窄窗先牺牲那句提示语，保住计数与两颗按钮（提示语里的操作在教程页也写了）。 */
@media (max-width:520px){.ea-select-bar-hint{display:none}}
@media (prefers-reduced-motion:reduce){.ea-select-bar,.ea-select-bar-dot{animation:none}}

/* ---------- 占用圆环（§9.2） ---------- */
.dsh-explain-assistant-ring{
  display:flex;align-items:center;gap:7px;
  font-size:11px;color:var(--ea-text-tertiary,#666);
}
.dsh-explain-assistant-ring svg{display:block;flex:0 0 auto}
.dsh-explain-assistant-ring-track{stroke:var(--dsw-alias-border-l3,rgba(0,0,0,.18))}
.dsh-explain-assistant-ring-arc{stroke:var(--dsw-alias-button-primary-fill,#2f6bff)}
.dsh-explain-assistant-ring[data-estimated=true] .dsh-explain-assistant-ring-arc{stroke:var(--ea-warn,#f59e0b)}
.dsh-explain-assistant-ring[data-unknown=true] .dsh-explain-assistant-ring-track{stroke-dasharray:2 3}
.dsh-explain-assistant-ring-label{white-space:nowrap}
.dsh-explain-assistant-ring-estimated{color:var(--ea-warn,#f59e0b);font-size:10px}

/* ---------- /compact 的结果：对话流里的一行「压缩事件」 ----------
 * 参考宿主（@deepseek-ai/dsh-client-ui-chat 的 compactionRow）：一行 24px 高的安静长条
 *   [箭头] 上下文已压缩 · 摘要首行…（单行省略）
 * 点开就在原位往下长出正文（缩进 22px、次要色）；展开时头部 sticky 在滚动区顶部。
 *
 * 为什么不做成卡片（用户原话）：
 *   「我不希望上下文压缩是这样的卡片的形式，因为用户这样子看不见（在上下文最上方）」
 *   —— 卡片钉在正文顶部时，用户按完 /compact 正滚在对话底部，屏幕上什么都不会变；
 *   "报告感"的排版还会让人以为这里是个设置面板，而不是对话里刚发生的一件事。
 */
.ea-compact-row{padding:2px 0}
.ea-compact-head{
  width:100%;height:26px;display:flex;align-items:center;
  padding:0 6px;border:0;border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-secondary,#555);text-align:left;cursor:pointer;
  transition:background-color .1s,color .1s;
}
.ea-compact-head:not([disabled]):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#111)}
.ea-compact-head[disabled]{cursor:default;color:var(--ea-text-tertiary,#777)}
.ea-compact-chevron{flex:none;width:14px;font-size:9px;line-height:1;opacity:.7;transition:transform 160ms cubic-bezier(.2,.85,.25,1)}
.ea-compact-row[data-open=true] .ea-compact-chevron{transform:rotate(90deg)}
.ea-compact-title{flex:none;font-size:12.5px;line-height:1.4}
.ea-compact-sep{flex:none;width:2px;height:2px;border-radius:1px;background:var(--dsw-alias-label-caption,#9aa0a6);margin:0 8px}
.ea-compact-line{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--ea-text-tertiary,#777)}
.ea-compact-row[data-status=error] .ea-compact-line{color:var(--ea-danger,#dc2626)}
.ea-compact-body{display:none;padding:2px 0 6px 22px}
.ea-compact-row[data-open=true] .ea-compact-body{display:block}
/* 展开长摘要时头部固定在滚动区顶部：滚到一半也能知道"上面这一坨是什么"（宿主同做法）。 */
.ea-compact-row[data-open=true] .ea-compact-head{
  position:sticky;top:0;z-index:2;border-radius:0;
  background:var(--ea-glass-pane,var(--dsw-alias-bg-base,#fff));
}
.ea-compact-meta{display:block;margin:0 0 4px}
.ea-compact-summary{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#444)}
.ea-compact-hint{margin:0;font-size:12px;line-height:1.6}
.ea-compact-actions{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap}
@media (prefers-reduced-motion:reduce){.ea-compact-chevron{transition:none}}

/* ---------- 改大小：像普通窗口一样拖「边」和「角」 ---------- */
/* 用户对上一版（只有一个角落字符 ◢）的定性，原话是：
     「不是，意思是这个设计不符合操作直觉，不是说它看不到用不了。」
   也就是说：他嫌的**不是**字号小或颜色淡，而是「要去角落找一个符号才能改大小」这件事本身
   不合他平时用窗口的经验 —— 普通窗口是**拖边、拖角**就能改。
   所以这一版把入口形态换掉：四周各一条边 + 四个角，都是拖拽热区，方向与鼠标指针一致。
   角落那个 ◢ 之后按用户要求删掉了（他说那元素已经没用）—— 角上就是 24×24 热区，指针形状即告示。 */

/* 四条边 + 四个角：透明热区，只负责指针形状与拖拽。
   厚度 7px 是权衡：再薄不好抓，再厚会压到下面的按钮。 */
.ea-resize-edge{
  position:absolute;z-index:3;
  background:transparent;border:0;padding:0;
  /* 这里**刻意不锁死触摸滚动**。
     曾经加过一条「禁用触摸手势」的声明来保证按下不被当成滚动，但撞上了一条既有闸：
     tests/scroll-stability.test.mjs「防抽搐: 不得用禁用滚动/拦截滚轮来换平静」——
     那条闸是对的（保护用户的滚动体验），**不该为了我的便利放宽它**。
     改用别的方式让拖拽不被滚动抢走：见 window.ts 的 pointerdown 里已有 setPointerCapture。 */
}
/* 上/下边：横向铺满，两端各让开 24px（= 角的宽度），避免两层热区抢同一次按下。 */
.ea-resize-n,.ea-resize-s{left:24px;right:24px;height:7px;cursor:ns-resize}
.ea-resize-n{top:0}
.ea-resize-s{bottom:0}
/* 左/右边：纵向铺满，同样让开 24px 的角。 */
.ea-resize-e,.ea-resize-w{top:24px;bottom:24px;width:7px;cursor:ew-resize}
.ea-resize-e{right:0}
.ea-resize-w{left:0}
/* 四个角：**24×24**（不是 12×12）。
   原因是一条闸查出来的（tests/ui-affordance.test.mjs）：
   四角是「关键动作控件」（拖拽改窗口几何），命中区不得小于 24×24（WCAG 2.5.8 Target Size Minimum）。
   12×12 时实测被判不合格 —— 用户拖到一半脱手的概率明显更高。
   角放到 24 之后，边热区两端各让开 24（见上），避免两个热区抢同一次按下。 */
.ea-resize-ne,.ea-resize-nw,.ea-resize-se,.ea-resize-sw{width:24px;height:24px}
.ea-resize-nw{top:0;left:0;cursor:nwse-resize}
.ea-resize-se{bottom:0;right:0;cursor:nwse-resize}
.ea-resize-ne{top:0;right:0;cursor:nesw-resize}
.ea-resize-sw{bottom:0;left:0;cursor:nesw-resize}
/* 拖动时给整个浮窗一个「正在改大小」的可见反馈，松手即恢复。 */
.dsh-explain-assistant-overlay[data-resizing=true]{user-select:none}
.dsh-explain-assistant-overlay[data-resizing=true]::after{
  content:'';position:absolute;inset:0;pointer-events:none;
  border:2px solid var(--dsw-alias-button-primary-fill,#2f6bff);border-radius:inherit;
}



/* ---------- 焦点可见 ---------- */
/* 输入框的焦点提示：全局那条是 2px 外描边（用的是宿主 primary 色，在深色主题里就是白色）——
   输入框在打开浮窗时会被自动聚焦，于是一进来就是一个「黑底 + 白框」的方盒子，正是用户说丑的那个。
   输入框改成本身已经凹进去的一块，焦点提示也改成**内侧一圈很淡的亮边**，不再套外框；
   caret 与占位文字已经足够说明「这里可以打字」，键盘用户仍能看到焦点位置的细微变化。 */
/* 焦点环画在**底板**上：输入框已经是透明的壳，再在它身上画一圈内阴影，
   就会和底板的边贴成两条并排的线（用户看到的就是「两层」）。 */
.dsh-explain-assistant-overlay .ea-field:has(.ea-input:focus-visible){
  /* 审计 2026-10-31：原来那圈 rgba(0,0,0,.18) 实测只有 1.53:1（深色 2.05:1），
     键盘 Tab 到这里基本看不出焦点在哪。改用品牌色 2px 内环（浅色 4.4:1 / 深色 3.4:1）。 */
  box-shadow:
    inset 0 1px 2px rgba(0,0,0,.16),
    inset 0 0 0 2px var(--dsw-alias-button-primary-fill,#2f6bff);
}
.dsh-explain-assistant-overlay .ea-model-search:focus-visible{
  outline:none;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.18),inset 0 0 0 2px var(--dsw-alias-button-primary-fill,#2f6bff);
}
.dsh-explain-assistant-overlay button:focus-visible,
.dsh-explain-assistant-overlay textarea:focus-visible,
.dsh-explain-assistant-overlay summary:focus-visible,
.dsh-explain-assistant-overlay [tabindex]:focus-visible{
  outline:2px solid var(--dsw-alias-button-primary-fill,#2f6bff);
  outline-offset:1px;
}
/* 上面那条全局规则会给 textarea 套一圈 2px 蓝框。输入框包进 .ea-field 之后，
   这圈框会落在底板里面，和底板的边贴成「两条线」——正是用户说的「两层」。
   输入框的焦点提示改由底板的 :has() 规则给（见文件上方 .ea-field:has(...)）。
   审计 2026-10-31：这条 outline:none 必须包在 @supports 里 —— 不支持 :has() 的引擎
   会同时丢掉 :has 那条规则和这条 outline，输入框直接没有任何焦点提示。 */
@supports selector(:has(*)) {
  .dsh-explain-assistant-overlay .ea-field .ea-input:focus-visible{
    outline:none;
  }
}
/* ---------- §5.2 「这一问围绕哪几条」（输入框上方常驻） ----------
   上一版这里只有一句话：「正在围绕这条内容提问：assistant-step  取消」。
   三个问题：英文标识看不懂、只能一次清空全部、看不出对应主对话里的哪一块。
   现在每条一个标签：编号 + 中文类型 + 摘要 + ×；整行随条数增减做高度过渡，
   第一枚出现时不会把上面的正文顶得一跳。 */
.ea-target-bar{
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  margin:0 0 6px;padding:6px 9px;
  font-size:12px;line-height:1.5;
  color:var(--dsw-alias-label-primary,#111);
  background:var(--dsw-alias-bg-layer-1,rgba(47,107,255,.08));
  border-left:3px solid var(--dsw-alias-button-primary-fill,#2f6bff);
  border-radius:0 7px 7px 0;
  /* 只过渡 max-height（有界值）：过渡 height:auto 浏览器做不到，而逐帧量高度会让整列重排 */
  /* 审计 2026-10-31：原来 max-height:120px + overflow:hidden，第 4 行之后的标签直接看不见，
     而"取消这一条"的唯一入口就在标签的 × 上 —— 选多了就再也撤不回来。改成可滚动。 */
  max-height:120px;overflow-y:auto;overflow-x:hidden;
  transition:max-height var(--ea-pick-in-dur,180ms) var(--ea-page-ease,cubic-bezier(.2,.85,.25,1)),
             opacity var(--ea-pick-in-dur,180ms) var(--ea-page-ease,cubic-bezier(.2,.85,.25,1)),
             padding var(--ea-pick-in-dur,180ms) var(--ea-page-ease,cubic-bezier(.2,.85,.25,1)),
             margin-bottom var(--ea-pick-in-dur,180ms) var(--ea-page-ease,cubic-bezier(.2,.85,.25,1));
}
.ea-target-bar:empty{display:none}
/* 收起态由 JS 写 data-has-target=false：留一个「还有标签在退场」的空档，
   等最后一条淡出播完再真正收起来。 */
.ea-target-bar[data-has-target=false]{
  max-height:0;opacity:0;padding-top:0;padding-bottom:0;margin-bottom:0;border-left-width:0;
}
.ea-pick-lead{flex:0 0 auto;color:var(--dsw-alias-label-secondary,#555);white-space:nowrap}
.ea-pick-chip{
  display:inline-flex;align-items:center;gap:6px;max-width:100%;
  padding:2px 3px 2px 6px;
  background:var(--dsw-alias-bg-base,#fff);
  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14));
  border-radius:999px;
  box-shadow:0 1px 2px rgba(0,0,0,.05);
}
/* 分级（§6.3）：这个小圆点说明「这条是实际结果还是主 agent 的说法」，颜色与正文折叠区一致 */
.ea-pick-chip::before{
  content:'';flex:0 0 auto;width:7px;height:7px;border-radius:50%;
  background:var(--ea-text-tertiary,#8a8f98);
}
.ea-pick-chip[data-tier=observed]::before{background:var(--dsw-alias-state-success-primary,#15803d)}
.ea-pick-chip[data-tier=reported]::before{background:var(--ea-warn,#b45309)}
.ea-pick-index{
  flex:0 0 auto;min-width:16px;height:16px;padding:0 3px;border-radius:999px;
  display:inline-flex;align-items:center;justify-content:center;
  font-size:10.5px;font-weight:600;
  color:var(--dsw-alias-label-primary-inverted,#fff);
  background:var(--dsw-alias-button-primary-fill,#2f6bff);
}
.ea-pick-label{flex:0 0 auto;font-weight:600;white-space:nowrap}
.ea-pick-snippet{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary,#555);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ea-pick-remove{
  flex:0 0 auto;width:18px;height:18px;padding:0;border:0;border-radius:50%;
  background:transparent;color:var(--ea-text-tertiary,#666);
  font-size:13px;line-height:1;cursor:pointer;
}
.ea-pick-remove:hover{background:rgba(127,127,127,.16);color:var(--dsw-alias-label-primary,#111)}
/* 入场：从上方 4px 处落下来 + 淡入 —— 观感是「这一块从主对话被提到输入框上方」。
   退场：往上 2px 淡出，140ms（比入场快）：离开不需要被看清，但也不能凭空消失。 */
@keyframes ea-pick-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
@keyframes ea-pick-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-2px)}}
@media (prefers-reduced-motion: no-preference){
  .ea-pick-chip{animation:ea-pick-in var(--ea-pick-in-dur,180ms) var(--ea-page-ease,cubic-bezier(.2,.85,.25,1)) both}
  .ea-pick-chip[data-leaving=true]{animation:ea-pick-out var(--ea-pick-out-dur,140ms) var(--ea-page-ease-out,cubic-bezier(.4,0,.9,.5)) both}
}

/* ---------- 主对话里的「已选」标记 ----------
   只加属性、不插节点：主对话是宿主的 React 渲染结果，往里面插可交互节点会干扰它
   （§2 不打扰主 agent）。描边 + 淡色底是为了让「哪一块被选中了」在**点它的地方**
   就能看见 —— 上一版这里一个像素都不会变。 */
[data-ea-picked]{
  /* 强调色**不能**用 --dsw-alias-button-primary-fill：在真实页面里量过，
     这个令牌在主对话的作用域里解析成 rgb(223,225,230)（一种浅灰），
     画上去等于没画 —— 这正是「选中了却看不出来」的直接原因。
     浮窗里的同名令牌是另一套值（蓝），所以这里改成自带一个明确的蓝。 */
  --ea-pick-accent:#2f6bff;
  position:relative;border-radius:10px;cursor:pointer;
  background-color:rgba(47,107,255,.10);
  background-color:color-mix(in srgb, var(--ea-pick-accent) 10%, transparent);
  box-shadow:0 0 0 2px var(--ea-pick-accent);
  transition:background-color 180ms cubic-bezier(.2,.85,.25,1), box-shadow 180ms cubic-bezier(.2,.85,.25,1);
}
@media (prefers-color-scheme: dark){
  /* 深色底上 2f6bff 偏暗，提亮一档，保证描边与淡色底都还看得见 */
  [data-ea-picked]{--ea-pick-accent:#7aa2ff;background-color:rgba(122,162,255,.12)}
}
/* 编号徽标：与输入框上方标签上的编号同源（data-ea-pick-index），两处一眼对得上。 */
[data-ea-picked]::after{
  content:attr(data-ea-pick-index);
  /* 徽标贴在卡片右上角；卡片比视口还高时它会滚出去 —— 所以描边与淡色底必须
     自己就足够说明「这一块被选中了」，徽标只是补充编号。 */
  position:absolute;top:-9px;right:10px;z-index:4;
  min-width:18px;height:18px;padding:0 5px;
  display:inline-flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:600;line-height:1;
  color:var(--dsw-alias-label-primary-inverted,#fff);
  background:var(--ea-pick-accent,#2f6bff);
  border-radius:999px;
  box-shadow:0 1px 3px rgba(0,0,0,.2);
  pointer-events:none;
}
@keyframes ea-pick-badge-in{from{opacity:0;transform:scale(.72)}to{opacity:1;transform:none}}
@keyframes ea-pick-badge-out{from{opacity:1;transform:none}to{opacity:0;transform:scale(.85)}}
/* 退场：JS 先挂 leaving（保留过渡），160ms 后才摘属性 —— 直接摘属性就是「啪」一下消失。 */
[data-ea-picked=leaving]{
  background-color:transparent;
  box-shadow:0 0 0 0 transparent;
  cursor:progress;
  transition:background-color 160ms cubic-bezier(.4,0,.9,.5), box-shadow 160ms cubic-bezier(.4,0,.9,.5);
}
[data-ea-picked=leaving]::after{animation:ea-pick-badge-out 140ms ease-out both}
@media (prefers-reduced-motion: no-preference){
  [data-ea-picked]::after{animation:ea-pick-badge-in 180ms cubic-bezier(.2,.85,.25,1) both}
}
/* 选择模式：鼠标扫过哪些块可以点，得先看得出来。虚线 + 十字光标是这个动作的通用语言。 */
html[data-ea-selecting] [data-chat-node-key]:hover,
html[data-ea-selecting] [data-tool]:hover{
  outline:1px dashed var(--ea-pick-accent,#2f6bff);
  outline-offset:2px;cursor:crosshair;
}
@media (prefers-reduced-motion: reduce){
  [data-ea-picked],[data-ea-picked=leaving],.ea-pick-chip,.ea-target-bar{transition:none;animation:none}
}
/* ---------- §7/§10 模型不可用时的降级层 ---------- */
.ea-offline{margin:8px 0;padding:9px 10px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));border-radius:8px}
.ea-offline-list{margin:6px 0 0;padding-left:18px}
.ea-offline-evidence{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#111);word-break:break-word}
.ea-offline-line{margin:4px 0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-primary,#111)}
.ea-offline-note{margin:8px 0 0;font-size:11.5px;line-height:1.6;color:var(--ea-text-tertiary,#777)}
/* ---------- §6.3 依据分级徽标 ---------- */
.ea-evidence-tier{font-size:11px;line-height:1.5;padding:1px 6px;border-radius:999px;white-space:nowrap;border:1px solid transparent}
.ea-tier-observed{color:var(--dsw-alias-state-success-primary,#15803d);background:rgba(21,128,61,.1);border-color:rgba(21,128,61,.3)}
.ea-tier-reported{color:var(--ea-warn,#b45309);background:rgba(180,83,9,.1);border-color:rgba(180,83,9,.3)}
.ea-tier-unavailable,.ea-tier-unknown{color:var(--ea-text-tertiary,#666);background:rgba(127,127,127,.1);border-color:rgba(127,127,127,.3)}
.ea-evidence-tier-hint{display:block;margin-top:3px;font-size:11px;line-height:1.55;color:var(--ea-text-tertiary,#777)}

/* ---------- 使用教程页 ----------
 * 与模型选择页共用同一套"翻页"语言（data-view 一改，两页互相推拉），
 * 所以这里不重复定义时长/曲线，只用已有的 --ea-page-* 变量与 keyframes。
 *
 * 排版按「可扫读」来：一屏一节，节标题是大字，正文只用一种字号，
 * 列表不缩进太深（浮窗窄，缩进一多正文就换行成竖条）。
 * ────────────────────────────────────────────────────────────── */
.ea-tutorial-trigger{
  width:24px;height:24px;min-width:24px;padding:0;
  display:inline-flex;align-items:center;justify-content:center;
  border-radius:50%;font-weight:700;line-height:1;font-size:12.5px;
}
.ea-tutorial-panel-slot{
  position:absolute;inset:0;z-index:3;pointer-events:none;
  background:var(--ea-glass-pane,var(--dsw-alias-bg-base,#fff));
  -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
}
.ea-overlay[data-view=tutorial] .ea-tutorial-panel-slot{pointer-events:auto}
.ea-overlay[data-view=tutorial] .ea-composer{visibility:hidden}
.ea-overlay[data-view=tutorial] .ea-body{pointer-events:none}
.ea-tutorial-panel[data-closing=true]{pointer-events:none}
.ea-tutorial-panel{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;height:100%;position:relative}
@media (prefers-reduced-motion: no-preference){
  .ea-overlay[data-view=tutorial] .ea-tutorial-panel{animation:ea-page-in var(--ea-page-in-dur) var(--ea-page-ease) both}
  .ea-overlay[data-view=tutorial] .ea-body{animation:ea-chat-recede var(--ea-page-out-dur) var(--ea-page-ease-out) both}
  .ea-overlay[data-returning=true] .ea-body{animation:ea-chat-return var(--ea-page-in-dur) var(--ea-page-ease) both}
  .ea-tutorial-panel[data-closing=true]{animation:ea-page-out var(--ea-page-out-dur) var(--ea-page-ease-out) both}
  .ea-overlay[data-view=tutorial] .ea-tut-body > *{animation:ea-settle 200ms var(--ea-page-ease) 60ms both}
}
.ea-tut-bar{
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));flex:0 0 auto;
}
.ea-tut-bar-title{font-size:12.5px;font-weight:650;color:var(--dsw-alias-label-primary,#111)}
.ea-tut-body{
  flex:1 1 auto;min-height:0;overflow:auto;
  padding:14px 16px 24px;display:flex;flex-direction:column;gap:18px;
  scrollbar-width:thin;
}
.ea-tut-head{display:flex;flex-direction:column;gap:5px}
.ea-tut-title{margin:0;font-size:15px;line-height:1.4;font-weight:680;letter-spacing:.2px}
.ea-tut-lead{margin:0;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,#555)}
.ea-tut-sec{display:flex;flex-direction:column;gap:7px}
.ea-tut-h{
  margin:0;font-size:12px;font-weight:650;letter-spacing:.4px;
  color:var(--dsw-alias-label-secondary,#555);text-transform:none;
  padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.07));
}
.ea-tut-list{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:4px;font-size:12.5px;line-height:1.7}
.ea-tut-steps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:9px}
.ea-tut-step strong{font-size:12.5px;display:block;margin-bottom:2px}
.ea-tut-step p{margin:0;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,#555)}
.ea-tut-tiers{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12.5px;line-height:1.7}
.ea-tut-tiers li{display:flex;gap:7px;align-items:flex-start}
.ea-tut-tiers .ea-evidence-tier{flex:0 0 auto;margin-top:2px}
.ea-tut-note{margin:0;font-size:11.5px;line-height:1.65;color:var(--ea-text-tertiary,#777)}
.ea-tut-keys{margin:0;display:grid;grid-template-columns:auto 1fr;gap:5px 10px;font-size:12.5px;line-height:1.7}
.ea-tut-keys dt{margin:0;white-space:nowrap;font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.ea-tut-keys dd{margin:0;color:var(--dsw-alias-label-secondary,#555)}
.ea-tut-keys kbd{
  display:inline-block;padding:1px 5px;border-radius:5px;font-size:11px;line-height:1.5;
  font-family:inherit;font-weight:600;
  background:var(--ea-band-fill,rgba(127,127,127,.12));
  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14));
  box-shadow:inset 0 -1px 0 rgba(0,0,0,.08);
}
.ea-tut-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:460px){.ea-tut-two{grid-template-columns:1fr}}
.ea-tut-two strong{font-size:12.5px;display:block;margin-bottom:4px}
.ea-tut-faq{display:flex;flex-direction:column;gap:6px}
.ea-tut-q{border-radius:9px;background:var(--ea-band-fill,rgba(127,127,127,.08));padding:2px 10px}
.ea-tut-q summary{cursor:pointer;padding:6px 0;font-size:12.5px;line-height:1.6;font-weight:600;list-style:none}
.ea-tut-q summary::-webkit-details-marker{display:none}
.ea-tut-q summary::after{content:'+';float:right;color:var(--ea-text-tertiary,#777);font-weight:700}
.ea-tut-q[open] summary::after{content:'–'}
.ea-tut-a{margin:0 0 6px;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,#555)}
.ea-tut-ask{margin-bottom:8px}
.ea-tut-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:4px}
.ea-hero-tutorial{align-self:flex-start;margin-top:2px}


/* ---------- 工具过程（历史里的持久显示） ---------- */
/* 用户 2026-10-31：「工具调用要持久显示，不删去」。
   回答落地后，这一轮把落库的 tools 折叠显示在这里；默认收起，只露一行步数。 */
.ea-turn-tools{margin-top:-2px}
.ea-tool-list{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.ea-tool-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:12px;line-height:18px}
.ea-tool-row-name{color:var(--dsw-alias-label-primary,#111)}
.ea-tool-row-status{font-size:11px;color:var(--ea-text-tertiary,#888)}
.ea-tool-row[data-status=error] .ea-tool-row-status{color:var(--ea-danger,#b42318)}
.ea-tool-row .ea-tool-detail{flex-basis:100%;margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#555);white-space:pre-wrap;word-break:break-word}

/* ---------- 错误条进场 ---------- */
/* 用户 2026-10-31：「点击停止后没有丝滑的动画，是突然闪出『已按你的要求停止本次解释』」。
   原来它是"啪"地出现（零过渡），看起来像界面被打断。现在给它一条很短的淡入 + 4px 上移，
   与「刚落地的那一条」同一族曲线、更快更小：它只是提示，不该抢注意力。
   只在**文字变了**的时候挂 .ea-error-enter（见 updateOverlay）——否则每次重画都会重播一次，反而闪。 */
@keyframes ea-error-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.ea-error-enter{animation:ea-error-in 220ms cubic-bezier(.2,.85,.25,1) both}
@media (prefers-reduced-motion: reduce){.ea-error-enter{animation:none}}


/* ---------- 入口按钮（宿主会话头部右上角那个） ----------
   用户 2026-10-31：「这个图标太丑，改改，样式和动画简单精致舒适，动画顺滑优美」。

   旧版按钮里是一个**文字字符** "?"：字形、字重、基线全由宿主字体决定，30px 的方框里
   又粗又偏，和隔壁 16px 细线图标（↗ / ⋯ / ▯）根本不是一套语言。
   新版是 16×16 自绘线性图标（圆角气泡 + 两行短横线 + 左下小尾巴），三层常驻挂载
   （气泡 / 忙碌弧 / 未读点）；状态切换只改按钮上的 data-unread / data-busy，
   这里做透明度交叉淡入 —— 不换节点，就不会有"抖一下"。

   为什么 hover/press **不**用 transform: scale：
   1px 描边缩到 0.94，抗锯齿会把它摊成 1.06px 的灰边，16px 图标上就是"发脏"。
   所以这里只动 color / opacity：不重排、不重算几何，描边也不发虚。 */
/* 按钮本体也要自己画：宿主没有给 header 插槽里的 <button> 任何样式，
   之前它就是一坨**浏览器默认外观**（浅灰底 + 2px 边框）——那才是"丑"的另一半。
   这里按宿主 header 图标的语言重画：透明底、无边框、28×28、圆角 6、hover 淡底。 */
.ea-hbtn-btn{
  display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;padding:0;margin:0;
  border:0;border-radius:var(--dsw-radius-sm,6px);
  background:transparent;color:inherit;font:inherit;cursor:pointer;
  -webkit-appearance:none;appearance:none;
  transition:background-color 140ms cubic-bezier(.33,0,.2,1),color 140ms cubic-bezier(.33,0,.2,1);
}
.ea-hbtn-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.ea-hbtn-btn:active{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.22))}
.ea-hbtn-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;border-radius:var(--dsw-radius-sm,6px)}
.ea-hbtn{
  position:relative;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:16px;
  height:16px;
  line-height:0;
  color:inherit;
}
.ea-hbtn>svg{display:block;width:16px;height:16px;overflow:visible}
.ea-hbtn-glyph{transition:color 140ms cubic-bezier(.33,0,.2,1),opacity 120ms cubic-bezier(.33,0,.2,1)}
.ea-hbtn-btn:hover .ea-hbtn-glyph{color:var(--dsw-alias-label-primary,inherit)}
.ea-hbtn-btn:active .ea-hbtn-glyph{opacity:.55;transition-duration:90ms}
/* 忙碌弧：与气泡同一个墨迹框（r=6 → 12×12），切换时重心不移动。
   旋转只在忙碌时跑（不忙时它藏着，没必要让合成器一直转）。 */
.ea-hbtn-ring{position:absolute;inset:0;opacity:0;transition:opacity 160ms cubic-bezier(.33,0,.2,1)}
.ea-hbtn-ring>circle{
  transform-box:fill-box;
  transform-origin:center;
  transition:stroke-dashoffset 260ms ease-out;
}
.ea-hbtn-btn[data-busy="true"] .ea-hbtn-glyph{opacity:0}
.ea-hbtn-btn[data-busy="true"] .ea-hbtn-ring{opacity:1;transition-delay:60ms}
.ea-hbtn-btn[data-busy="true"] .ea-hbtn-ring>circle{stroke-dashoffset:0;animation:ea-hbtn-spin 900ms linear infinite}
/* 从 12 点方向起转：默认的 circle 路径从 3 点开始，直接转的话第一帧像一道"笑"，
   从 -90° 起就一眼是 loading。 */
@keyframes ea-hbtn-spin{from{transform:rotate(-90deg)}to{transform:rotate(270deg)}}
/* 未读点：绝对定位、不参与布局（否则每次未读翻转按钮内容都会重排一下）。
   位置在图标墨迹框（2–14）之外，留 0.5px 空隙，不压住气泡的圆角。 */
.ea-hbtn-dot{
  position:absolute;
  top:-3px;
  right:-3px;
  width:4.5px;
  height:4.5px;
  border-radius:999px;
  background:currentColor;
  opacity:0;
  transform:scale(.3);
  pointer-events:none;
  transition:opacity 140ms ease-out,transform 200ms cubic-bezier(.2,.9,.3,1.15);
}
.ea-hbtn-btn[data-unread="true"] .ea-hbtn-dot{opacity:1;transform:scale(1)}
@media (prefers-reduced-motion:reduce){
  /* 减少动态偏好下不做缩放/旋转，但**状态照旧可见**：未读点仍然出现，忙碌弧仍然在。 */
  .ea-hbtn-glyph,.ea-hbtn-ring,.ea-hbtn-dot{transition:none}
  .ea-hbtn-btn[data-busy="true"] .ea-hbtn-ring>circle{animation:none}
  .ea-hbtn-dot{transform:none}
}
`;

// src/client/entry.ts
var React = null;
try {
  React = require("react");
} catch {
  React = null;
}
var inject = ["slots", "workspaces"];
function apply(ctx) {
  if (typeof document === "undefined" || !React || typeof React.createElement !== "function" || typeof React.useEffect !== "function" || typeof React.useReducer !== "function" || typeof React.useRef !== "function") return;
  const run = () => {
    try {
      let selectedId;
      let lastQuestionButton = null;
      const plugin = createClientPlugin({ session: () => selectedId ? { id: selectedId } : void 0 });
      const registry = plugin.registry;
      if (!ctx.slots) return () => plugin.dispose();
      const style = document.createElement("style");
      style.dataset.dshExplainAssistant = "styles";
      style.textContent = styles_default;
      document.head.appendChild(style);
      const HeaderButton = (props) => {
        const id = typeof props?.sessionId === "string" ? props.sessionId : void 0;
        const [, bumpBadge] = React.useReducer((value) => value + 1, 0);
        React.useEffect(() => {
          if (!id) return void 0;
          return watchUnread(registry, id, () => bumpBadge());
        }, [id]);
        const [opening, setOpening] = React.useState(() => id ? isOpening(registry.get(id)) : false);
        React.useEffect(() => {
          if (!id) return void 0;
          setOpening(isOpening(registry.get(id)));
          return watchOpening(registry, id, setOpening);
        }, [id]);
        React.useEffect(() => {
          if (!id) return void 0;
          void plugin.primeUnread?.(id);
          return void 0;
        }, [id]);
        React.useEffect(() => {
          if (!id) return void 0;
          selectedId = id;
          plugin.setSession(id, props?.cwd);
          return () => {
            if (selectedId === id) {
              selectedId = void 0;
              registry.setCurrent(void 0);
            }
          };
        }, [id]);
        const state = id ? registry.get(id) : void 0;
        const unread = state?.unread === true;
        const [busy, setBusy] = React.useState(false);
        const gateRef = React.useRef(null);
        const ensureGate = () => {
          if (!gateRef.current) gateRef.current = createBusyGate({
            // 用箭头包一层：直接传 window.setTimeout 的引用，被当成对象方法调用时
            // this 会变成那个普通对象，浏览器抛 Illegal invocation（见 busy-gate.ts 的说明）。
            setTimeout: (handler, ms) => setTimeout(handler, ms),
            clearTimeout: (handle) => clearTimeout(handle)
          }, setBusy);
          return gateRef.current;
        };
        ensureGate();
        React.useEffect(() => {
          ensureGate().set(opening);
        }, [opening]);
        React.useEffect(() => () => {
          gateRef.current?.dispose();
          gateRef.current = null;
        }, []);
        const view = headerButtonState(unread, busy);
        return h("button", {
          type: "button",
          className: "ea-hbtn-btn",
          "aria-label": view.ariaLabel,
          "aria-busy": opening ? "true" : void 0,
          "data-opening": opening ? "true" : void 0,
          "data-unread": view.unread ? "true" : "false",
          "data-busy": view.busy ? "true" : "false",
          title: opening ? openingTitle() : view.title,
          onClick: () => {
            if (!id) return;
            selectedId = id;
            lastQuestionButton = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            plugin.setSession(id, props?.cwd);
            plugin.open();
          }
        }, createHeaderContent(h));
      };
      const h = React.createElement;
      const OverlayBridge = () => {
        const hostRef = React.useRef(null);
        const [, bump] = React.useReducer((value) => value + 1, 0);
        React.useEffect(() => {
          let pending;
          const unsubscribe = registry.subscribe(() => {
            if (typeof requestAnimationFrame !== "function") {
              bump();
              return;
            }
            if (pending !== void 0) return;
            pending = requestAnimationFrame(() => {
              pending = void 0;
              bump();
            });
          });
          return () => {
            unsubscribe();
            if (pending !== void 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(pending);
          };
        }, []);
        React.useEffect(() => {
          const onSelected = (event) => {
            const detail = event.detail || {};
            if (detail.sessionId !== registry.currentSessionId) return;
            registry.update(detail.sessionId, { error: void 0 });
          };
          document.addEventListener("dsh-explain-assistant:evidence-selected", onSelected);
          return () => document.removeEventListener("dsh-explain-assistant:evidence-selected", onSelected);
        }, []);
        const state = registry.current;
        const sessionId = state?.sessionId;
        const open = state?.open;
        const lastGeometryRef = React.useRef(null);
        const stateReady = state?.stateReady;
        const currentlyVisible = Boolean(hostRef.current?.firstElementChild);
        const shouldMount = sessionId ? shouldMountOverlay({ open, stateReady, currentlyVisible }) : false;
        React.useEffect(() => {
          const host = hostRef.current;
          if (!host) return void 0;
          const previousGeometry = lastGeometryRef.current;
          let controller;
          let selection;
          const current = registry.current;
          const mounting = Boolean(shouldMount && current?.open);
          if (mounting) host.replaceChildren();
          if (mounting && current?.open) {
            const element = renderOverlay(current, plugin, previousGeometry);
            host.appendChild(element);
            try {
              document.documentElement.setAttribute("data-ea-glass-open", "");
            } catch {
            }
            const boundSession = current.sessionId;
            selection = attachSelection(document, boundSession, {
              select: (item, element2, options) => {
                if (registry.currentSessionId !== boundSession) return;
                const anchor = String(item.pickId || item.id || "");
                if (anchor && element2 && typeof element2.setAttribute === "function" && element2.getAttribute("data-ea-pick") !== anchor) {
                  element2.setAttribute("data-ea-pick", anchor);
                }
                const before = registry.get(boundSession)?.evidence ?? [];
                const next = (options?.additive === true ? before : []).filter((existing) => String(existing?.pickId ?? existing?.id ?? "") !== anchor);
                next.push(item);
                registry.update(boundSession, (state2) => {
                  state2.evidence = next;
                });
                syncPickMarks(document, next);
                const detail = { sessionId: boundSession, item, additive: options?.additive === true };
                if (typeof document.dispatchEvent === "function") document.dispatchEvent(new CustomEvent("dsh-explain-assistant:evidence-selected", { detail }));
              },
              // 取消按**锚点**走，不按 id：工具卡片没有会话键，id 会退化成工具名，
              // 两张 bash 卡片就会一起消失（见 selection.ts 的 ensurePickId）。
              deselect: (pickId) => {
                if (registry.currentSessionId !== boundSession) return;
                registry.update(boundSession, (state2) => {
                  state2.evidence = state2.evidence.filter((existing) => existing.pickId !== pickId && existing.id !== pickId);
                });
              }
            });
            const onSelectMode = () => selection?.enter();
            const onSelectExit = () => selection?.exit();
            document.addEventListener("dsh-explain-assistant:select", onSelectMode);
            document.addEventListener("dsh-explain-assistant:select-exit", onSelectExit);
            controller = { dispose: (options) => {
              document.removeEventListener("dsh-explain-assistant:select", onSelectMode);
              document.removeEventListener("dsh-explain-assistant:select-exit", onSelectExit);
              selection?.dispose();
              syncPickMarks(document, []);
              element.dispatchEvent(new Event("dsh-explain-assistant:dispose"));
              if (!options?.keepElement) element.remove();
            } };
          }
          return () => {
            lastGeometryRef.current = readAppliedGeometry(host.firstElementChild);
            const closing = registry.current?.open === false;
            const element = host.firstElementChild;
            if (closing && element) {
              selection?.dispose();
              const animated = beginExit(host, element);
              const teardown = () => {
                try {
                  document.documentElement.removeAttribute("data-ea-glass-open");
                } catch {
                }
                controller?.dispose({ keepElement: true });
              };
              if (animated) setTimeout(teardown, 0);
              else {
                teardown();
                element.remove();
              }
            } else {
              try {
                document.documentElement.removeAttribute("data-ea-glass-open");
              } catch {
              }
              controller?.dispose();
              selection?.dispose();
              host.replaceChildren();
            }
          };
        }, [open, sessionId, shouldMount]);
        React.useEffect(() => {
          syncPickMarks(document, state?.open && shouldMount ? state?.evidence ?? [] : []);
        });
        React.useEffect(() => {
          const host = hostRef.current;
          const element = host?.firstElementChild;
          if (!element || !state?.open || !shouldMount) return;
          updateOverlay(element, state, plugin);
        });
        React.useEffect(() => {
          if (!state?.open) return;
          const id = state.sessionId;
          if (!id) return;
          void plugin.ensureState?.(id);
        }, [open, sessionId]);
        return h("div", { ref: hostRef, "data-shell-overlay": "dsh-explain-assistant-overlay" });
      };
      const workspaces = (() => {
        try {
          return ctx.get?.("workspaces") ?? ctx.workspaces;
        } catch {
          return void 0;
        }
      })();
      const archiveWatcher = workspaces?.list ? createArchiveWatcher({
        source: workspaces.list,
        // 只对「新进入归档集合」的会话触发（幂等）；调用宿主已有的 forget 路径。
        onArchived: (sessionId) => plugin.forget(sessionId).catch(() => void 0),
        logger: (message) => console.error("[dsh-explain-assistant]", message)
      }) : void 0;
      const removeHeader = ctx.slots.inject(
        "conversation.session.header.utilities",
        () => ctx.slots.register({ name: "conversation.session.header.utilities", id: "dsh-explain-assistant-question", label: "解释小助手", order: 100 }, HeaderButton)
      );
      const removeOverlay = ctx.slots.inject(
        "shell.overlay",
        () => ctx.slots.register({ name: "shell.overlay", id: "dsh-explain-assistant-overlay", label: "解释小助手", order: 100 }, OverlayBridge)
      );
      return () => {
        removeHeader?.();
        removeOverlay?.();
        archiveWatcher?.dispose();
        if (lastQuestionButton) lastQuestionButton.focus();
        style.remove();
        plugin.dispose();
      };
    } catch (error) {
      console.error("[dsh-explain-assistant] client init failed", error);
      return () => void 0;
    }
  };
  ctx.effect(run);
}
return module.exports;}});
