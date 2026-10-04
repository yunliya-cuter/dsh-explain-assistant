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
  return { sessionId, cwd, open: false, unread: false, draft: "", phase: "idle", reasoning: "", text: "", tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [], occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: false, compactState: { status: "idle" } };
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
    throw new AssistantApiError("Invalid JSON response from " + url + ": " + text.slice(0, 512), { code: "JSON_PARSE_FAILED", status: response.status, url, raw: text.slice(0, 4096) });
  }
}
async function json(url, init) {
  let response;
  try {
    response = await fetch(url, { credentials: "same-origin", ...init });
  } catch (error) {
    if (error instanceof AssistantApiError) throw error;
    throw new AssistantApiError("Network request failed for " + url + ": " + (error instanceof Error ? error.message : String(error)), { code: "NETWORK_ERROR", url, raw: error });
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
  if (!response.body) throw new AssistantApiError("SSE response body unavailable at " + url, { code: "SSE_BODY_UNAVAILABLE", status: response.status, url });
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
    if (signal?.aborted) throw new AssistantApiError("SSE request aborted at " + url, { code: "ABORTED", url, raw: error });
    throw new AssistantApiError("SSE stream failed at " + url + ": " + (error instanceof Error ? error.message : String(error)), { code: "SSE_STREAM_FAILED", url, raw: error });
  } finally {
    reader.releaseLock();
  }
  if (!terminal) throw new AssistantApiError("SSE stream ended without a terminal event at " + url, { code: "SSE_TERMINAL_MISSING", url, raw: buffer.slice(0, 4096) });
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
  const appendRecord = (request, status, state, answer) => {
    if (request.recorded || request.kind !== "ask") return;
    request.recorded = true;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    assistantRegistry.update(request.sessionId, (current) => {
      const recordId = newRecordId(request.requestId);
      if (current.records.some((record) => record.id === recordId)) return;
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
        current.unread = true;
      });
      appendRecord(request, "complete", assistantRegistry.get(request.sessionId), answer);
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
        current.unread = true;
        if (request.kind === "compact") current.compactState = { ...current.compactState, status: "interrupted", error: message };
      });
      appendRecord(request, "interrupted", assistantRegistry.get(request.sessionId));
      return;
    }
    if (event.type === "error") {
      terminalEvent.set(request.sessionId, "error");
      const message = typeof data.message === "string" ? data.message : "请求失败";
      assistantRegistry.update(request.sessionId, (current) => {
        current.phase = "error";
        current.requestId = void 0;
        current.error = message;
        current.unread = true;
        if (request.kind === "compact") current.compactState = { ...current.compactState, status: "error", error: message };
      });
      appendRecord(request, "interrupted", assistantRegistry.get(request.sessionId));
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
  const refreshState = (sessionId, options2) => {
    return callApi(() => api.state(sessionId)).then((result) => {
      if (disposed) return;
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
      assistantRegistry.update(sessionId, {
        records: mergedRecords,
        hasEarlier: stillHasEarlier,
        historyCursor: nextCursor,
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
          occupancyEstimated: payload.occupancyEstimated === true
        },
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
          compactState: current.compactState && (current.compactState.status === "running" || current.compactState.status === "error" || current.compactState.status === "interrupted") ? current.compactState : { ...compactState, status: typeof compactState.summary === "string" && compactState.summary ? "complete" : "error" }
        } : {},
        // §10/S4：未读是宿主侧的真相（markUnread 落库），刷新后必须恢复，否则徽标消失。
        //
        // 但 §10「打开浮窗后清除」优先：紧随「打开」的那一次刷新**不得**把宿主仍是 true 的值写回来
        // （宿主标记已读可能失败，那时本地清除仍应生效，否则徽标清除后立刻又亮 = 闪烁）。
        // 用**单次标志**而不是持久集合：抑制只针对这次打开引发的刷新，
        // 之后的刷新（例如回答完成后）恢复「宿主为准」，不会把未读永久压住。
        ...typeof payload.unread === "boolean" && !(options2?.keepCleared === true && payload.unread === true) ? { unread: payload.unread } : {}
      });
    }).catch((error) => {
      if (!disposed) assistantRegistry.update(sessionId, { error: errorMessage(error), phase: "error" });
    });
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
    assistantRegistry.open(sessionId, current.cwd);
    void clearUnreadOnHost(sessionId);
  };
  const run = (question, kind) => {
    if (disposed) return Promise.reject(new Error("解释小助手已关闭"));
    const current = session();
    if (!current) return Promise.reject(new Error("当前没有主对话"));
    const sessionId = current.id;
    if (active.has(sessionId) || phaseBusy(assistantRegistry.get(sessionId))) return Promise.reject(new Error("已有解释请求正在处理中"));
    const request = { token: /* @__PURE__ */ Symbol("explain-request"), controller: new AbortController(), sessionId, question, kind, startedAt: (/* @__PURE__ */ new Date()).toISOString(), recorded: false };
    active.set(sessionId, request);
    const state = assistantRegistry.get(sessionId, current.cwd);
    const evidence = state.evidence.slice();
    assistantRegistry.update(sessionId, { draft: "", phase: "connecting", reasoning: "", text: "", tools: [], error: void 0, unread: false, ...kind === "compact" ? { compactState: { status: "running" } } : {} });
    const onEvent = (event) => applyEvent(request, event);
    const task = callApi(() => kind === "compact" ? api.compact(sessionId, request.controller.signal, onEvent) : api.ask(sessionId, question, request.controller.signal, evidence, onEvent));
    return task.catch((error) => {
      if (isCurrent(request)) {
        const lastTerminal = terminalEvent.get(sessionId);
        terminalEvent.delete(sessionId);
        const aborted = isAbortLike(error, request.controller.signal, lastTerminal);
        const message = aborted && !request.controller.signal.aborted ? errorMessage(error) : aborted ? "请求已中断" : errorMessage(error);
        assistantRegistry.update(sessionId, (current2) => {
          current2.phase = aborted ? "interrupted" : "error";
          current2.requestId = void 0;
          current2.error = message;
          current2.unread = true;
          if (request.kind === "compact") current2.compactState = { ...current2.compactState, status: aborted ? "interrupted" : "error", error: message };
        });
        if (aborted) appendRecord(request, "interrupted", assistantRegistry.get(sessionId));
      }
    }).finally(() => {
      if (active.get(sessionId)?.token === request.token) active.delete(sessionId);
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
      const result = await api.history(current.id, cursor);
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
        loadingEarlier: false
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
      const result = await api.historyResult(id, recordId);
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
      const result = await api.historyResult(id, detail.recordId, cursor ?? void 0);
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
    try {
      await api.forget(sessionId);
      assistantRegistry.update(sessionId, { records: [], compactState: void 0, unread: false, archived: true });
    } catch (error) {
      console.error("[dsh-explain-assistant] 归档清理请求失败（" + sessionId + "）：", errorMessage(error));
    }
  };
  const cancel = () => {
    const current = session();
    if (!current) return;
    const request = active.get(current.id);
    if (!request) return;
    request.controller.abort();
    const cancelId = request.requestId;
    if (cancelId) void callApi(() => api.cancel(request.sessionId, cancelId)).catch(() => void 0);
    assistantRegistry.update(request.sessionId, { phase: "interrupted", requestId: void 0, error: "已按你的要求停止本次解释" });
    appendRecord(request, "interrupted", assistantRegistry.get(request.sessionId));
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
    assistantRegistry.sessions().forEach((state) => {
      if (state.open) assistantRegistry.close(state.sessionId);
    });
    assistantRegistry.setCurrent(void 0);
  };
  const setSession = (id, cwd) => {
    selectedSession = id ? { id, cwd } : void 0;
    assistantRegistry.setCurrent(id);
  };
  return { api, registry: assistantRegistry, open, submit, loadEarlier, cancel, dispose, setSession, openHistoryDetail, loadMoreHistoryDetail, closeHistoryDetail, forget, primeUnread };
}

// src/client/window.ts
var MIN_WIDTH = 320;
var MIN_HEIGHT = 360;
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
function applyGeometry(root, geometry) {
  root.style.left = geometry.x + "px";
  root.style.top = geometry.y + "px";
  root.style.width = geometry.width + "px";
  root.style.height = geometry.height + "px";
}
function attachWindowInteractions(root, handle, resize, initial2, onChange) {
  let geometry = { ...initial2 };
  let mode;
  let pointerId;
  let startX = 0;
  let startY = 0;
  let startGeometry = { ...geometry };
  let disposed = false;
  const finish = (commit) => {
    if (!mode) return;
    const finalGeometry = { ...geometry };
    mode = void 0;
    pointerId = void 0;
    if (commit && !disposed) onChange(finalGeometry);
  };
  const begin = (kind, event) => {
    if (disposed || event.button !== 0) return;
    mode = kind;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startGeometry = { ...geometry };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
    }
    event.preventDefault();
  };
  const onDragStart = (event) => {
    const target = event.target instanceof Element ? event.target : void 0;
    if (target?.closest("button, input, textarea, select, a")) return;
    begin("drag", event);
  };
  const onResizeStart = (event) => begin("resize", event);
  const onMove = (event) => {
    if (disposed || !mode || pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    geometry = mode === "drag" ? clampGeometry({ ...startGeometry, x: startGeometry.x + dx, y: startGeometry.y + dy }) : clampGeometry({ ...startGeometry, width: startGeometry.width + dx, height: startGeometry.height + dy });
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
  handle.addEventListener("pointerdown", onDragStart);
  resize.addEventListener("pointerdown", onResizeStart);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", onEnd);
  root.addEventListener("pointercancel", onCancel);
  handle.addEventListener("keydown", onKeyDown);
  applyGeometry(root, geometry);
  return {
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
      resize.removeEventListener("pointerdown", onResizeStart);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onEnd);
      root.removeEventListener("pointercancel", onCancel);
      handle.removeEventListener("keydown", onKeyDown);
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

// src/client/overlay.tsx
var previouslyFocused = null;
function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === void 0 || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}
function fill(node, children) {
  node.replaceChildren(...children.filter((child) => child !== null && child !== void 0 && child !== false));
}
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === void 0 || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "style") Object.assign(node.style, value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  appendChildren(node, children);
  return node;
}
function button(label, aria, handler, options = {}) {
  return el("button", {
    type: "button",
    class: options.class || "ea-btn",
    "aria-label": aria,
    title: options.title,
    disabled: options.disabled,
    "aria-pressed": options.pressed === void 0 ? void 0 : String(options.pressed),
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
function currentAnswerNodes(state, plugin) {
  const nodes = [];
  if (isBusy(state) && !state.text) {
    nodes.push(el(
      "div",
      { class: "ea-running", role: "status" },
      el("span", { class: "ea-spinner", "aria-hidden": "true" }),
      el("span", { text: state.phase === "connecting" ? "正在连接模型…" : "正在解释…" }),
      button("停止", "停止本次解释", () => plugin.cancel?.(), { class: "ea-btn ea-btn-quiet" })
    ));
  }
  if (state.text) {
    nodes.push(el("article", { class: "dsh-explain-assistant-answer ea-answer", "aria-label": "小助手回答", text: state.text }));
  }
  if (state.reasoning) {
    nodes.push(el(
      "details",
      { class: "dsh-explain-assistant-reasoning ea-disclosure" },
      el("summary", {}, "推理过程（原始内容，默认折叠）"),
      el("div", { class: "ea-disclosure-body", text: state.reasoning })
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
function heroNodes(state) {
  if (state.text || state.records.length || state.error || isBusy(state)) return [];
  return [el(
    "section",
    { class: "ea-hero", "aria-label": "使用说明" },
    el("p", { class: "ea-hero-title", text: "小助手在旁边看着主 agent，随时把「它正在干什么」讲成白话。" }),
    el(
      "ul",
      { class: "ea-hero-list" },
      el("li", { text: "点右上角「选择主对话内容」，再点主对话里的一条步骤卡片，就能针对那一步提问。" }),
      el("li", { text: "也可以直接在下面输入问题，或者点上面的快捷问题。" }),
      el("li", { text: "小助手只读：不改主 agent、不执行命令、不碰主对话的输入框。" })
    )
  )];
}
function modelNodes(state, plugin, open, onToggle) {
  const groups = state.catalog?.groups || [];
  const failures = state.catalog?.failures || [];
  let total = 0;
  groups.forEach((group) => {
    total += (group.models || []).length;
  });
  const current = el("span", { class: "dsh-explain-assistant-model-current ea-model-current" });
  current.textContent = state.model ? "本对话已选 · " + state.model.provider + " / " + state.model.model : "还没有选择模型：请先选一个，小助手不会自动替你挑";
  const list = el("div", { class: "dsh-explain-assistant-model-list ea-model-list", role: "group", "aria-label": "可选模型列表" });
  let rendered = 0;
  groups.forEach((group) => {
    const options = [];
    (group.models || []).forEach((entry) => {
      const provider = String(entry.provider || group.provider || "");
      const model = String(entry.id || "");
      if (!provider || !model) return;
      rendered++;
      const selected = Boolean(state.model && state.model.provider === provider && state.model.model === model);
      options.push(button((selected ? "✓ " : "") + (entry.name || model), "选择模型 " + provider + "/" + model, () => {
        if (!plugin.api?.selectModel) return;
        const previous = plugin.registry.get(state.sessionId)?.model;
        plugin.registry.update(state.sessionId, { model: { provider, model, source: "explicit" }, error: void 0 });
        void plugin.api.selectModel(state.sessionId, { provider, model }).catch((error) => plugin.registry.update(state.sessionId, {
          model: previous,
          error: "选择模型失败：" + (error instanceof Error ? error.message : String(error))
        }));
      }, { class: "dsh-explain-assistant-model-option ea-btn ea-model-option", pressed: selected }));
    });
    if (!options.length) return;
    list.appendChild(el(
      "div",
      { class: "ea-model-group" },
      el(
        "div",
        { class: "ea-model-group-name" },
        el("span", { text: String(group.displayName || group.provider || "未命名提供方") }),
        el("span", { class: "ea-count", text: String(options.length) })
      ),
      el("div", { class: "ea-model-options" }, ...options)
    ));
  });
  if (!rendered) list.appendChild(el("p", { class: "dsh-explain-assistant-empty ea-empty", text: "暂时没有可用的模型，请先检查模型配置" }));
  const refresh = button("刷新模型", "刷新可用模型", (event) => {
    if (!plugin.api?.models) return;
    const target = event.currentTarget;
    target.disabled = true;
    void plugin.api.models().then((result) => {
      const payload = result.payload || {};
      plugin.registry.update(state.sessionId, { catalog: payload });
    }).catch((error) => plugin.registry.update(state.sessionId, { error: error instanceof Error ? error.message : String(error) })).finally(() => {
      target.disabled = false;
    });
  }, { class: "ea-btn ea-btn-quiet" });
  const toggle = button(
    open ? "收起模型列表" : state.model ? "换一个模型（共 " + total + " 个）" : "点这里选择模型（共 " + total + " 个可选）",
    open ? "收起模型列表" : "展开可选模型列表",
    () => onToggle?.(!open),
    { class: "ea-model-summary", pressed: open }
  );
  const details = el(
    "div",
    { class: "ea-model-details", "data-unselected": state.model ? void 0 : "true", "data-open": open ? "true" : void 0 },
    toggle,
    open ? list : null
  );
  const failureNodes = failures.filter((failure) => failure?.message).map((failure) => el("small", { class: "dsh-explain-assistant-model-failure ea-model-failure", text: failure.message }));
  return [el(
    "section",
    { class: "dsh-explain-assistant-model ea-card", "aria-labelledby": "dsh-explain-assistant-model-title" },
    el(
      "div",
      { class: "ea-card-head" },
      el("h3", { class: "ea-card-title", id: "dsh-explain-assistant-model-title", text: "模型" }),
      refresh
    ),
    current,
    details,
    ...failureNodes
  )];
}
function compactNodes(state) {
  const compact = state.compactState;
  if (!compact || compact.status === "idle") return [];
  const status = compact.status ?? (compact.summary ? "complete" : "error");
  const rows = [];
  if (status === "running") {
    rows.push(el("p", { class: "ea-compact-status", role: "status", text: "正在整理小助手自己的上下文…" }));
  } else if (status === "complete") {
    rows.push(el("p", { class: "ea-compact-status", role: "status", text: "已压缩：后续回答参考下面这份摘要。完整问答记录仍然保留在历史里，没有被删除。" }));
    if (compact.summary) rows.push(el("p", { class: "dsh-explain-assistant-compact-summary ea-compact-summary", text: compact.summary }));
    if (compact.updatedAt) rows.push(el("small", { class: "ea-meta", text: "压缩时间 " + timeText(compact.updatedAt) }));
  } else {
    const failed = status === "error";
    rows.push(el("p", { class: failed ? "ea-compact-status ea-compact-error" : "ea-compact-status", role: "alert", text: (failed ? "压缩失败：" : "压缩已中断：") + (compact.error || "没有拿到可用的摘要") }));
    if (compact.summary) {
      rows.push(el("p", { class: "dsh-explain-assistant-compact-summary ea-compact-summary", text: compact.summary }));
      rows.push(el("small", { class: "ea-meta", text: "上面这份是上一次成功压缩的摘要，仍然可用。" }));
    }
  }
  return [el(
    "section",
    { class: "dsh-explain-assistant-compact ea-card", "aria-label": "小助手上下文压缩" },
    el(
      "div",
      { class: "ea-card-head" },
      el("h3", { class: "ea-card-title", text: "小助手上下文" })
    ),
    ...rows
  )];
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
        el("strong", { class: "ea-evidence-title", text: item.title || item.id }),
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
    "section",
    { class: "dsh-explain-assistant-evidence ea-card", "aria-labelledby": "dsh-explain-assistant-evidence-title" },
    el(
      "div",
      { class: "ea-card-head" },
      el("h3", { class: "ea-card-title", id: "dsh-explain-assistant-evidence-title", text: "已选择依据" }),
      el("span", { class: "ea-count ea-count-inline", text: String(state.evidence.length) })
    ),
    ...rows
  )];
}
function historyNodes(state, plugin) {
  const children = [el(
    "div",
    { class: "ea-card-head" },
    el("h3", { class: "ea-card-title", text: "历史" }),
    state.records.length ? el("span", { class: "ea-count ea-count-inline", text: String(state.records.length) }) : null,
    state.hasEarlier ? button(state.loadingEarlier ? "正在加载…" : "查看更早历史", "加载更早历史", () => {
      if (!state.loadingEarlier) void plugin.loadEarlier();
    }, { class: "ea-btn ea-btn-quiet", disabled: state.loadingEarlier }) : null
  )];
  if (!state.records.length) {
    children.push(el("p", { class: "dsh-explain-assistant-empty ea-empty", text: "还没有小助手历史" }));
  } else {
    state.records.forEach((record) => {
      const recordId = typeof record.id === "string" && record.id ? record.id : "";
      const answer = typeof record.answerText === "string" && record.answerText ? record.answerText : record.answer;
      const at = record.startedAt ?? record.createdAt;
      const reasoning = typeof record.reasoningText === "string" && record.reasoningText ? record.reasoningText : record.reasoning;
      children.push(el(
        "article",
        { class: "dsh-explain-assistant-record ea-record" },
        el(
          "div",
          { class: "ea-row-head" },
          el("strong", { class: "ea-record-question", text: record.question }),
          el("small", { class: "ea-meta", text: timeText(at) })
        ),
        answer ? el("p", { class: "ea-record-answer", text: answer }) : null,
        reasoning ? el(
          "details",
          { class: "ea-disclosure" },
          el("summary", {}, "这次回答的推理过程"),
          el("div", { class: "ea-disclosure-body", text: reasoning })
        ) : null,
        // 同样两套字段名：客户端本地写 incomplete，宿主写 status/complete。
        // 只看 incomplete 的话，来自宿主的未完成记录永远不会显示警告（§6.3「不得把没验证的说成已验证」）。
        //
        // §10/D1：记录会**留在磁盘上** —— 整页重载后只有「未完成」不足以让用户明白为什么停的。
        // 若记录带了原因（routes.ts 落库时写入），就把对应的中文提示一并显示。
        // 文案从 src/shared 取，与宿主 SSE 事件用的是**同一份常量**（本项目吃过两处不一致的亏）。
        // 老记录没有 reason 字段 → recordReasonText 返回 undefined → 退回原来的「此记录未完成或未验证」，行为不变。
        record.incomplete === true || record.status === "interrupted" || record.status === "error" || record.complete === false ? el("small", { class: "ea-warn", text: (() => {
          const reasonText = recordReasonText(record.reason);
          return reasonText ? RECORD_REASON_PREFIX + reasonText : RECORD_INCOMPLETE_TEXT;
        })() }) : null,
        // §5.1/§11.6：历史里只显示摘要，用户要能点开某一条看它的**完整依据**。
        // 此前没有任何入口，api.historyResult 是死代码，被截断的工具结果与依据在界面上永远看不到。
        recordId ? button(state.historyDetail?.recordId === recordId ? "正在查看完整内容" : "查看完整内容", "查看这条记录的完整内容", () => {
          void plugin.openHistoryDetail?.(recordId);
        }, { class: "ea-btn ea-btn-quiet ea-record-detail", pressed: state.historyDetail?.recordId === recordId }) : null
      ));
    });
  }
  return [el("section", { class: "dsh-explain-assistant-history ea-card" }, ...children)];
}
function historyDetailNodes(state, plugin) {
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
  if (detail.status === "loading" && !evidence.length && !tools.length && !images.length) {
    rows.push(el("p", { class: "ea-detail-status", role: "status", text: "正在读取这条记录的完整内容…" }));
    return [el("section", { class: "dsh-explain-assistant-detail ea-card ea-detail" }, ...rows)];
  }
  if (detail.status === "error") {
    rows.push(el("p", { class: "ea-detail-error ea-error", role: "alert", text: detail.error || "这条记录的完整内容没有取到。" }));
    return [el("section", { class: "dsh-explain-assistant-detail ea-card ea-detail" }, ...rows)];
  }
  if (record.question) rows.push(el("p", { class: "ea-detail-question", text: "问题：" + String(record.question) }));
  const answer = typeof record.answerText === "string" && record.answerText ? record.answerText : record.answer;
  if (answer) rows.push(el("article", { class: "ea-detail-answer", text: String(answer) }));
  const reasoning = typeof record.reasoningText === "string" && record.reasoningText ? record.reasoningText : record.reasoning;
  if (reasoning) rows.push(el(
    "details",
    { class: "ea-disclosure" },
    el("summary", {}, "完整推理过程"),
    el("div", { class: "ea-disclosure-body", text: String(reasoning) })
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
  if (!evidence.length && !tools.length && !images.length && !answer) {
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
  return [el("section", { class: "dsh-explain-assistant-detail ea-card ea-detail" }, ...rows)];
}
function ringNode(state) {
  const box = el("div", { class: "dsh-explain-assistant-ring ea-ring" });
  const known = Boolean(state.occupancyKnown) && typeof state.occupancy === "number";
  const percent = known ? Math.min(100, Math.max(0, Math.round(state.occupancy))) : 0;
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", known ? "上下文占用约 " + percent + "%" + (state.occupancyEstimated ? "（估算值）" : "") : "上下文占用未知");
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
function renderOverlay(state, plugin) {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : previouslyFocused;
  const like = plugin;
  const root = el("section", {
    class: "dsh-explain-assistant-overlay ea-overlay",
    role: "dialog",
    "aria-modal": "false",
    "aria-labelledby": "dsh-explain-assistant-title"
  });
  root.tabIndex = -1;
  const titlebar = el("header", { class: "dsh-explain-assistant-titlebar ea-header", "data-drag-handle": "true", tabindex: "0", "aria-label": "拖动解释小助手窗口；使用方向键移动" });
  const phase = el("span", { class: "dsh-explain-assistant-status ea-phase", "aria-live": "polite" });
  const close = button("×", "关闭解释小助手", () => {
    contexts.get(root)?.plugin.registry.close(state.sessionId);
    previouslyFocused?.focus();
    previouslyFocused = null;
  }, { class: "dsh-explain-assistant-close ea-close", title: "关闭（Esc）" });
  const leaveSelectionMode = () => {
    root.removeAttribute("data-selection-mode");
    select.setAttribute("aria-pressed", "false");
    select.textContent = "选择主对话内容";
    selectionStatus.textContent = "";
  };
  const enterSelectionMode = () => {
    root.setAttribute("data-selection-mode", "true");
    select.setAttribute("aria-pressed", "true");
    select.textContent = "退出选择模式";
    selectionStatus.textContent = "请点击主对话中的步骤卡片或助手汇报（也可以右键，或聚焦后按 Shift+Enter）。再次点本按钮可退出。";
    document.dispatchEvent(new CustomEvent("dsh-explain-assistant:select", { detail: { sessionId: state.sessionId } }));
  };
  const select = button("选择主对话内容", "选择主对话中的步骤或工具卡片", () => {
    if (root.hasAttribute("data-selection-mode")) leaveSelectionMode();
    else enterSelectionMode();
  }, { class: "ea-btn ea-btn-soft", pressed: false });
  const onEvidenceSelected = (event) => {
    const detail = event.detail || {};
    if (detail.sessionId !== state.sessionId) return;
    leaveSelectionMode();
  };
  document.addEventListener("dsh-explain-assistant:evidence-selected", onEvidenceSelected);
  root.addEventListener("dsh-explain-assistant:dispose", () => document.removeEventListener("dsh-explain-assistant:evidence-selected", onEvidenceSelected), { once: true });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.hasAttribute("data-selection-mode")) leaveSelectionMode();
  }, true);
  const compact = button("/compact", "压缩小助手上下文", () => {
    const current = contexts.get(root);
    if (current && !isBusy(current.state)) void current.plugin.submit("/compact");
  }, { class: "ea-btn ea-btn-soft", title: "整理小助手自己的上下文；不影响主对话" });
  titlebar.append(
    el("strong", { id: "dsh-explain-assistant-title", class: "ea-title", text: "解释小助手" }),
    phase,
    el("div", { class: "ea-header-actions" }, select, compact, close)
  );
  const selectionStatus = el("span", { class: "dsh-explain-assistant-selection-status ea-selection-status", role: "status" });
  const body = el("div", { class: "dsh-explain-assistant-content ea-body" });
  const errorSlot = el("div", { class: "ea-slot" });
  const currentSlot = el("div", { class: "ea-slot" });
  const heroSlot = el("div", { class: "ea-slot" });
  const quickSlot = el("div", { class: "ea-slot" });
  const modelSlot = el("div", { class: "ea-slot" });
  const evidenceSlot = el("div", { class: "ea-slot" });
  const compactSlot = el("div", { class: "ea-slot" });
  const historySlot = el("div", { class: "ea-slot" });
  const detailSlot = el("div", { class: "ea-slot" });
  body.append(detailSlot, errorSlot, currentSlot, heroSlot, quickSlot, modelSlot, evidenceSlot, compactSlot, historySlot, selectionStatus);
  const input = el("textarea", { class: "ea-input", placeholder: "问小助手主 agent 正在做什么…", "aria-label": "向解释小助手提问", rows: "2" });
  const send = button(isBusy(state) ? "处理中" : "发送", "发送问题", () => {
    form.requestSubmit();
  }, { class: "ea-btn ea-btn-primary ea-send" });
  const ringSlot = el("div", { class: "ea-ring-slot" });
  const targetBar = el("div", { class: "ea-target-bar", role: "status", "aria-live": "polite" });
  const form = el("form", { class: "dsh-explain-assistant-form ea-composer" });
  form.append(targetBar, input, el("div", { class: "ea-composer-actions" }, ringSlot, send));
  const resize = button("◢", "调整窗口大小；使用方向键调整", void 0, { class: "dsh-explain-assistant-resize ea-resize" });
  const geometry = clampGeometry(state.geometry, window.innerWidth, window.innerHeight);
  root.style.left = geometry.x + "px";
  root.style.top = geometry.y + "px";
  root.style.width = geometry.width + "px";
  root.style.height = geometry.height + "px";
  root.append(titlebar, body, form, resize);
  const ctx = {
    state,
    plugin: like,
    body,
    phase,
    selectionStatus,
    errorSlot,
    currentSlot,
    heroSlot,
    quickSlot,
    modelSlot,
    evidenceSlot,
    compactSlot,
    historySlot,
    detailSlot,
    ringSlot,
    targetBar,
    // 默认折叠模型列表：一开就摊开 33 个模型会把「使用说明 + 快捷问题」顶出可视区。
    // 未选模型时由摘要行 + 醒目的提示承担「先选一个」的引导（§7/§11.8）。
    form,
    input,
    send,
    modelOpen: false,
    rerender: () => updateOverlay(root, ctx.state, ctx.plugin)
  };
  contexts.set(root, ctx);
  input.value = state.draft;
  input.addEventListener("input", () => {
    const current = contexts.get(root);
    if (current) current.plugin.registry.update(current.state.sessionId, { draft: input.value });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const current = contexts.get(root);
    if (!current) return;
    const question = input.value.trim();
    if (question && !isBusy(current.state)) void current.plugin.submit(question);
  });
  updateOverlay(root, state, like);
  const focusable = () => Array.from(root.querySelectorAll('button, textarea, input, select, summary, [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
  const keydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
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
  const controller = attachWindowInteractions(root, titlebar, resize, geometry, (next) => {
    const current = contexts.get(root);
    if (current) current.plugin.registry.update(current.state.sessionId, { geometry: next });
  });
  root.addEventListener("dsh-explain-assistant:dispose", () => controller.dispose(), { once: true });
  queueMicrotask(() => {
    (input || root).focus({ preventScroll: true });
    body.scrollTop = 0;
  });
  return root;
}
function updateOverlay(root, state, plugin) {
  const ctx = contexts.get(root);
  if (!ctx) return;
  ctx.state = state;
  ctx.plugin = plugin;
  ctx.phase.textContent = phaseLabel(state);
  ctx.errorSlot.replaceChildren();
  if (state.error) ctx.errorSlot.appendChild(el("div", { class: "dsh-explain-assistant-error ea-error", role: "alert", text: state.error }));
  fill(ctx.currentSlot, [...currentAnswerNodes(state, ctx.plugin), ...offlineFallbackNodes(state)]);
  fill(ctx.heroSlot, heroNodes(state));
  fill(ctx.quickSlot, quickNodes(state, ctx.plugin));
  fill(ctx.modelSlot, modelNodes(state, ctx.plugin, ctx.modelOpen, (next) => {
    ctx.modelOpen = next;
    ctx.rerender();
  }));
  fill(ctx.evidenceSlot, evidenceNodes(state, ctx.plugin));
  fill(ctx.compactSlot, compactNodes(state));
  fill(ctx.historySlot, historyNodes(state, ctx.plugin));
  fill(ctx.detailSlot, historyDetailNodes(state, ctx.plugin));
  const detailId = state.historyDetail?.recordId;
  if (detailId && detailId !== ctx.detailRecordId) {
    ctx.detailRecordId = detailId;
    ctx.body.scrollTop = 0;
  } else if (!detailId) ctx.detailRecordId = void 0;
  ctx.ringSlot.replaceChildren(ringNode(state));
  const targets = state.evidence.filter((item) => item?.title || item?.summary);
  const currentId = state.evidence.length ? state.evidence[state.evidence.length - 1] : void 0;
  if (targets.length && currentId) {
    const label = currentId.title || (currentId.summary || "").slice(0, 40) || "未命名步骤";
    fill(ctx.targetBar, [
      el("span", { class: "ea-target-label", text: "正在围绕这条内容提问：" }),
      el("strong", { class: "ea-target-title", text: label }),
      targets.length > 1 ? el("small", { class: "ea-target-more", text: "（另有 " + (targets.length - 1) + " 条依据）" }) : null,
      button("取消", "不再围绕这条内容提问", () => {
        plugin.registry.update(state.sessionId, (current) => {
          current.evidence = [];
        });
      }, { class: "ea-btn ea-btn-quiet ea-target-clear" })
    ]);
    ctx.targetBar.setAttribute("data-has-target", "true");
  } else {
    ctx.targetBar.replaceChildren();
    ctx.targetBar.removeAttribute("data-has-target");
  }
  if (ctx.input.value !== state.draft) ctx.input.value = state.draft;
  const busy = isBusy(state);
  ctx.send.textContent = busy ? "处理中" : "发送";
  ctx.send.disabled = busy;
}

// src/client/selection.ts
var TARGETS = "[data-tool], [data-chat-node-key]";
function insideChat(node) {
  const chat = node.closest("[data-conversation-scroll], [data-chat-root], [data-chat-flow-kind]");
  return Boolean(chat && !node.closest(".dsh-explain-assistant-overlay, [data-shell-overlay]"));
}
function nearest(target) {
  if (!(target instanceof Element)) return void 0;
  const node = target.closest(TARGETS);
  return node && insideChat(node) ? node : void 0;
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
function evidenceFromElement(element, sessionId) {
  const tool = element.closest("[data-tool]");
  const source = "selected_frozen";
  const state = (element.getAttribute("data-state") || "").toLowerCase();
  return { id: element.getAttribute("data-chat-node-key") || element.getAttribute("data-tool") || crypto.randomUUID(), title: tool?.getAttribute("data-tool") || element.getAttribute("data-chat-flow-kind") || void 0, summary: (element.textContent || "").trim().slice(0, 4e3), source, capturedAt: (/* @__PURE__ */ new Date()).toISOString(), evidenceState: classifyEvidence(element), sessionId, version: element.getAttribute("data-version") || null, truncated: false, incomplete: state === "running" || state === "ongoing" || state === "preparing" };
}
var CLICK_SLOP_PX = 5;
function attachSelection(root, sessionId, onSelect) {
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      ;
      event.stopImmediatePropagation();
    }
  };
  const context = (event) => {
    const node = nearest(event.target);
    if (!node) return;
    swallow(event);
    onSelect(evidenceFromElement(node, sessionId));
  };
  let pressed;
  const click = (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const node = nearest(event.target);
    if (!node) return;
    if (pressed && pressed.node === node) {
      const moved = Math.abs(event.clientX - pressed.x) + Math.abs(event.clientY - pressed.y);
      if (moved > CLICK_SLOP_PX) return;
      const selection = typeof root.getSelection === "function" ? root.getSelection() : null;
      if (selection && String(selection).trim().length > 0) return;
    }
    swallow(event);
    onSelect(evidenceFromElement(node, sessionId));
  };
  const pointerdown = (event) => {
    if (event.button !== 0) return;
    const node = nearest(event.target);
    pressed = node ? { x: event.clientX, y: event.clientY, node } : void 0;
  };
  const keydown = (event) => {
    if (!(event.shiftKey && event.key === "Enter")) return;
    const node = nearest(document.activeElement);
    if (!node) return;
    swallow(event);
    onSelect(evidenceFromElement(node, sessionId));
  };
  root.addEventListener("contextmenu", context, true);
  root.addEventListener("click", click, true);
  root.addEventListener("mousedown", pointerdown, true);
  root.addEventListener("keydown", keydown, true);
  return {
    dispose() {
      root.removeEventListener("contextmenu", context, true);
      root.removeEventListener("click", click, true);
      root.removeEventListener("mousedown", pointerdown, true);
      root.removeEventListener("keydown", keydown, true);
    }
  };
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

// src/client/header-badge.ts
function headerButtonText(unread) {
  return unread === true ? "? ·" : "?";
}
function headerButtonTitle(unread) {
  return unread === true ? "解释小助手有新内容" : "打开解释小助手";
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

// src/client/styles.css
var styles_default = '/* ==================================================================\n * 解释小助手 · 界面样式\n *\n * 设计取向：贴着 DSH 宿主既有的观感走（同一套 --dsw-alias-* 变量），\n * 不另立一套配色，免得和页面其它部分打架。\n *\n * 上一版为什么"不可用"，这几条是直接原因，改动都针对它们：\n *   1. 标题栏把「选择内容」「/compact」「×」和标题挤在一行，文字被压、按钮贴边；\n *   2. 33 个模型平铺成一个换行流，把浮窗整个吃掉，用户要滚很久才看得到输入框；\n *   3. 占用圆环绝对定位在右下角，和「发送」按钮重叠；\n *   4. 没有正文滚动区和固定输入区的分层，滚动时按钮跟着跑；\n *   5. 行高、间距、字号没有层级，一段回答和一堆按钮长得一样重。\n * ================================================================== */\n\n/* ---------- 外壳 ---------- */\n.dsh-explain-assistant-overlay{\n  position:fixed;z-index:30;\n  display:flex;flex-direction:column;box-sizing:border-box;\n  min-width:360px;min-height:420px;\n  background:var(--dsw-alias-bg-base,#fff);\n  color:var(--dsw-alias-label-primary,#111);\n  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14));\n  border-radius:14px;\n  box-shadow:0 18px 48px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.16);\n  overflow:hidden;pointer-events:auto;\n  font-size:13px;line-height:1.6;\n  -webkit-font-smoothing:antialiased;\n}\n.dsh-explain-assistant-overlay *,.dsh-explain-assistant-overlay *::before,.dsh-explain-assistant-overlay *::after{box-sizing:border-box}\n\n/* ---------- 标题栏 ---------- */\n.dsh-explain-assistant-titlebar{\n  display:flex;align-items:center;gap:10px;flex:0 0 auto;\n  min-height:46px;padding:0 10px 0 14px;\n  cursor:move;user-select:none;\n  border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));\n  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));\n}\n.dsh-explain-assistant-titlebar .ea-title{flex:0 0 auto;font-size:14px;font-weight:600;letter-spacing:.02em}\n.dsh-explain-assistant-status{flex:1 1 auto;min-width:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#777);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.ea-header-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}\n.dsh-explain-assistant-close{\n  font-size:20px;line-height:1;background:none;border:0;padding:4px 8px;cursor:pointer;\n  border-radius:8px;color:var(--dsw-alias-label-secondary,#444);\n}\n.dsh-explain-assistant-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}\n\n/* ---------- 通用按钮 ---------- */\n.ea-btn{\n  font:inherit;line-height:1.2;\n  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));\n  border-radius:8px;\n  background:var(--dsw-alias-bg-base,#fff);\n  color:var(--dsw-alias-label-primary,#111);\n  padding:6px 11px;cursor:pointer;\n  white-space:nowrap;\n  transition:background .12s ease,border-color .12s ease;\n}\n.ea-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}\n.ea-btn:disabled{opacity:.5;cursor:not-allowed}\n.ea-btn-soft{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));border-color:transparent;padding:5px 10px;font-size:12px}\n.ea-btn-quiet{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary,#555);padding:4px 8px;font-size:12px}\n.ea-btn-quiet:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}\n.ea-btn-primary{\n  background:var(--dsw-alias-button-primary-fill,#2f6bff);\n  border-color:var(--dsw-alias-button-primary-fill,#2f6bff);\n  color:var(--dsw-alias-label-primary-inverted,#fff);\n  font-weight:600;padding:9px 18px;\n}\n.ea-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#245bdd);border-color:var(--dsw-alias-button-primary-hover,#245bdd)}\n\n/* ---------- 正文滚动区 ---------- */\n.dsh-explain-assistant-content{\n  display:flex;flex:1 1 auto;flex-direction:column;gap:12px;\n  min-height:0;overflow-y:auto;overflow-x:hidden;\n  padding:14px;\n  scrollbar-width:thin;\n}\n.ea-slot{display:flex;flex-direction:column;gap:12px}\n.ea-slot:empty{display:none}\n\n/* ---------- 首次打开的引导 ---------- */\n.ea-hero{\n  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));\n  border-radius:10px;padding:12px 14px;\n  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));\n}\n.ea-hero-title{margin:0 0 8px;font-size:13px;color:var(--dsw-alias-label-secondary,#444)}\n.ea-hero-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#555)}\n.ea-hero-list li{line-height:1.65}\n\n/* ---------- 卡片 ---------- */\n.ea-card{\n  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));\n  border-radius:10px;padding:11px 12px;\n  display:flex;flex-direction:column;gap:8px;\n}\n.ea-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n.ea-card-title{margin:0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#3a3a3a);flex:0 0 auto}\n.ea-count{\n  display:inline-block;min-width:18px;text-align:center;\n  font-size:11px;line-height:16px;padding:0 5px;border-radius:9px;\n  background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16));\n  color:var(--dsw-alias-label-tertiary,#666);\n}\n.ea-count-inline{margin-left:auto}\n\n/* ---------- 回答 / 运行中 ---------- */\n.ea-answer{\n  white-space:pre-wrap;word-break:break-word;\n  font-size:13.5px;line-height:1.75;\n  padding:12px 14px;border-radius:10px;\n  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));\n  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));\n}\n.ea-running{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#555)}\n.ea-spinner{\n  width:14px;height:14px;flex:0 0 auto;border-radius:50%;\n  border:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.2));\n  border-top-color:var(--dsw-alias-button-primary-fill,#2f6bff);\n  animation:ea-spin .8s linear infinite;\n}\n@keyframes ea-spin{to{transform:rotate(360deg)}}\n@media (prefers-reduced-motion:reduce){.ea-spinner{animation:none}}\n\n/* ---------- 错误 ---------- */\n.dsh-explain-assistant-error,.ea-error{\n  color:var(--dsw-alias-state-error-primary,#b42318);\n  background:var(--dsw-alias-bg-layer-1,rgba(180,35,24,.08));\n  border:1px solid var(--dsw-alias-state-error-primary,rgba(180,35,24,.3));\n  padding:9px 11px;border-radius:9px;font-size:12.5px;\n  white-space:pre-wrap;word-break:break-word;\n}\n\n/* ---------- 快捷问题 ---------- */\n.ea-quick{\n  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));\n  border-radius:10px;padding:11px 12px;\n  display:flex;flex-direction:column;gap:9px;\n}\n.ea-quick-row{display:flex;flex-wrap:wrap;gap:7px}\n.ea-chip{\n  border-radius:999px;padding:6px 13px;font-size:12.5px;\n  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));\n  border-color:transparent;\n}\n.ea-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}\n\n/* ---------- 模型选择 ---------- */\n.ea-model-current{font-size:12px;color:var(--dsw-alias-label-secondary,#555);word-break:break-all;line-height:1.5}\n.ea-model-summary{\n  cursor:pointer;font-size:12px;padding:5px 0;text-align:left;\n  color:var(--dsw-alias-label-tertiary,#666);\n  background:transparent;border-color:transparent;\n}\n.ea-model-details[data-open=true] .ea-model-summary{margin-bottom:6px}\n/* 未选模型时把摘要行做成醒目的行动点：用户必须能一眼看到「这里要先点一下」。 */\n.ea-model-details[data-unselected=true] .ea-model-summary{\n  display:inline-block;padding:7px 14px;border-radius:8px;\n  font-weight:600;font-size:12.5px;\n  color:var(--dsw-alias-label-primary-inverted,#fff);\n  background:var(--dsw-alias-button-primary-fill,#2f6bff);\n  border-color:transparent;\n}\n.ea-model-details[data-unselected=true] .ea-model-summary:hover{background:var(--dsw-alias-button-primary-hover,#245bdd)}\n.ea-model-list{\n  display:flex;flex-direction:column;gap:10px;\n  max-height:280px;overflow-y:auto;\n  padding:8px;border-radius:9px;\n  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));\n  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));\n}\n.ea-model-group{display:flex;flex-direction:column;gap:6px}\n.ea-model-group-name{\n  display:flex;align-items:center;gap:7px;\n  font-size:11.5px;font-weight:600;letter-spacing:.02em;\n  color:var(--dsw-alias-label-tertiary,#666);\n  position:sticky;top:-8px;padding:4px 0;\n  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));\n}\n.ea-model-options{display:flex;flex-wrap:wrap;gap:6px}\n.ea-model-option{border-radius:7px;padding:5px 10px;font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis}\n.ea-model-option[aria-pressed=true]{\n  border-color:var(--dsw-alias-button-primary-fill,#2f6bff);\n  color:var(--dsw-alias-button-primary-fill,#2f6bff);\n  background:var(--dsw-alias-bg-layer-2,rgba(47,107,255,.1));\n  font-weight:600;\n}\n.ea-model-failure{display:block;font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#a15c00);line-height:1.5}\n\n/* ---------- 依据 ---------- */\n.ea-evidence-row{display:flex;flex-direction:column;gap:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1))}\n.ea-evidence-row:first-of-type{border-top:0;padding-top:0}\n.ea-row-head{display:flex;align-items:baseline;gap:8px;justify-content:space-between}\n.ea-evidence-title{font-size:12.5px;word-break:break-all}\n.ea-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#777);white-space:nowrap;flex:0 0 auto}\n.ea-evidence-summary{margin:2px 0 0;font-size:12.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#444)}\n\n/* ---------- 历史 ---------- */\n.ea-record{display:flex;flex-direction:column;gap:5px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1))}\n.ea-record:first-of-type{border-top:0;padding-top:0}\n.ea-record-question{font-size:12.5px;word-break:break-word}\n.ea-record-answer{margin:0;font-size:12.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#444)}\n.ea-warn{font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#a15c00)}\n.ea-empty{color:var(--dsw-alias-label-tertiary,#777);font-size:12.5px;margin:0}\n\n/* ---------- 折叠块 ---------- */\n.ea-disclosure>summary,.ea-tool>summary{\n  cursor:pointer;font-size:12.5px;\n  color:var(--dsw-alias-label-secondary,#444);\n  padding:4px 0;\n}\n.ea-disclosure-body{\n  max-height:260px;overflow:auto;\n  white-space:pre-wrap;word-break:break-word;\n  font-size:12px;line-height:1.65;\n  padding:8px 10px;border-radius:8px;\n  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));\n  color:var(--dsw-alias-label-secondary,#555);\n}\n.ea-tool{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));padding-top:4px}\n.ea-tool:first-of-type{border-top:0}\n.ea-tool-body{display:flex;flex-direction:column;gap:6px;padding:4px 0 6px}\n.ea-tool-detail{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#555)}\n.ea-pre{\n  margin:0;max-height:200px;overflow:auto;\n  white-space:pre-wrap;word-break:break-word;\n  font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;\n  padding:8px 10px;border-radius:8px;\n  background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.1));\n  color:var(--dsw-alias-label-secondary,#444);\n}\n.ea-tools{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));padding-top:10px}\n\n/* ---------- 底部输入区（固定，不随正文滚动） ---------- */\n.dsh-explain-assistant-form{\n  display:flex;flex-direction:column;gap:9px;flex:0 0 auto;\n  padding:11px 13px 12px;\n  border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));\n  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));\n}\n.ea-input{\n  width:100%;min-height:52px;max-height:150px;\n  resize:vertical;\n  padding:9px 11px;\n  font:inherit;line-height:1.55;\n  color:var(--dsw-alias-label-primary,#111);\n  background:var(--dsw-alias-bg-base,#fff);\n  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));\n  border-radius:9px;\n}\n.ea-input::placeholder{color:var(--dsw-alias-label-tertiary,#888)}\n.ea-composer-actions{display:flex;align-items:center;justify-content:space-between;gap:10px}\n.ea-ring-slot{display:flex;align-items:center;min-width:0}\n\n/* ---------- 选中模式提示 ---------- */\n.ea-selection-status{font-size:12px;color:var(--dsw-alias-label-tertiary,#666);line-height:1.5;min-height:0}\n.ea-selection-status:empty{display:none}\n.dsh-explain-assistant-overlay[data-selection-mode=true]{outline:2px solid var(--dsw-alias-button-primary-fill,#2f6bff);outline-offset:-2px}\n\n/* ---------- 占用圆环（§9.2） ---------- */\n.dsh-explain-assistant-ring{\n  display:flex;align-items:center;gap:7px;\n  font-size:11px;color:var(--dsw-alias-label-tertiary,#666);\n}\n.dsh-explain-assistant-ring svg{display:block;flex:0 0 auto}\n.dsh-explain-assistant-ring-track{stroke:var(--dsw-alias-border-l3,rgba(0,0,0,.18))}\n.dsh-explain-assistant-ring-arc{stroke:var(--dsw-alias-button-primary-fill,#2f6bff)}\n.dsh-explain-assistant-ring[data-estimated=true] .dsh-explain-assistant-ring-arc{stroke:var(--dsw-alias-state-warn-primary,#f59e0b)}\n.dsh-explain-assistant-ring[data-unknown=true] .dsh-explain-assistant-ring-track{stroke-dasharray:2 3}\n.dsh-explain-assistant-ring-label{white-space:nowrap}\n.dsh-explain-assistant-ring-estimated{color:var(--dsw-alias-state-warn-primary,#f59e0b);font-size:10px}\n\n/* ---------- /compact 结果（§9.1） ---------- */\n.ea-compact-status{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#444)}\n.ea-compact-error{color:var(--dsw-alias-state-error-primary,#dc2626)}\n.dsh-explain-assistant-compact-summary{\n  margin:6px 0 0;padding:8px 10px;\n  font-size:12.5px;line-height:1.6;white-space:pre-wrap;\n  color:var(--dsw-alias-label-primary,#111);\n  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));\n  border-left:3px solid var(--dsw-alias-button-primary-fill,#2f6bff);\n  border-radius:0 7px 7px 0;\n}\n\n/* ---------- 缩放手柄 ---------- */\n.dsh-explain-assistant-resize{\n  position:absolute;right:0;bottom:0;width:18px;height:18px;\n  cursor:nwse-resize;border:0;background:transparent;\n  color:var(--dsw-alias-label-tertiary,#888);font-size:11px;line-height:1;\n  display:flex;align-items:flex-end;justify-content:flex-end;\n  padding:0 2px 2px 0;\n}\n\n/* ---------- 焦点可见 ---------- */\n.dsh-explain-assistant-overlay button:focus-visible,\n.dsh-explain-assistant-overlay textarea:focus-visible,\n.dsh-explain-assistant-overlay summary:focus-visible,\n.dsh-explain-assistant-overlay [tabindex]:focus-visible{\n  outline:2px solid var(--dsw-alias-button-primary-fill,#2f6bff);\n  outline-offset:1px;\n}\n/* ---------- §5.2 正在围绕哪条内容提问（输入框上方常驻） ---------- */\n.ea-target-bar{\n  display:flex;align-items:center;gap:6px;flex-wrap:wrap;\n  margin:0 0 6px;padding:6px 9px;\n  font-size:12px;line-height:1.5;\n  color:var(--dsw-alias-label-primary,#111);\n  background:var(--dsw-alias-bg-layer-1,rgba(47,107,255,.08));\n  border-left:3px solid var(--dsw-alias-button-primary-fill,#2f6bff);\n  border-radius:0 7px 7px 0;\n}\n.ea-target-bar:empty,.ea-target-bar:not([data-has-target]){display:none}\n.ea-target-label{color:var(--dsw-alias-label-secondary,#555)}\n.ea-target-title{font-weight:600;word-break:break-word}\n.ea-target-more{color:var(--dsw-alias-label-tertiary,#777)}\n.ea-target-clear{margin-left:auto}\n/* ---------- §7/§10 模型不可用时的降级层 ---------- */\n.ea-offline{margin:8px 0;padding:9px 10px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));border-radius:8px}\n.ea-offline-list{margin:6px 0 0;padding-left:18px}\n.ea-offline-evidence{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#111);word-break:break-word}\n.ea-offline-line{margin:4px 0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-primary,#111)}\n.ea-offline-note{margin:8px 0 0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#777)}\n/* ---------- §6.3 依据分级徽标 ---------- */\n.ea-evidence-tier{font-size:11px;line-height:1.5;padding:1px 6px;border-radius:999px;white-space:nowrap;border:1px solid transparent}\n.ea-tier-observed{color:var(--dsw-alias-state-success-primary,#15803d);background:rgba(21,128,61,.1);border-color:rgba(21,128,61,.3)}\n.ea-tier-reported{color:var(--dsw-alias-state-warning-primary,#b45309);background:rgba(180,83,9,.1);border-color:rgba(180,83,9,.3)}\n.ea-tier-unavailable,.ea-tier-unknown{color:var(--dsw-alias-label-tertiary,#666);background:rgba(127,127,127,.1);border-color:rgba(127,127,127,.3)}\n.ea-evidence-tier-hint{display:block;margin-top:3px;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary,#777)}\n';

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
        return h("button", {
          type: "button",
          "aria-label": "打开解释小助手",
          title: headerButtonTitle(unread),
          onClick: () => {
            if (!id) return;
            selectedId = id;
            lastQuestionButton = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            plugin.setSession(id, props?.cwd);
            plugin.open();
          }
        }, headerButtonText(unread));
      };
      const h = React.createElement;
      const OverlayBridge = () => {
        const hostRef = React.useRef(null);
        const [, bump] = React.useReducer((value) => value + 1, 0);
        React.useEffect(() => registry.subscribe(() => bump()), []);
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
        React.useEffect(() => {
          const host = hostRef.current;
          if (!host) return void 0;
          host.replaceChildren();
          let controller;
          let selection;
          const current = registry.current;
          if (current?.open) {
            const element = renderOverlay(current, plugin);
            host.appendChild(element);
            const onSelectMode = () => {
              selection?.dispose();
              const boundSession = current.sessionId;
              selection = attachSelection(document, boundSession, (item) => {
                if (registry.currentSessionId !== boundSession) return;
                registry.update(boundSession, (state2) => {
                  state2.evidence = [...state2.evidence.filter((existing) => existing.id !== item.id), item];
                });
                const detail = { sessionId: boundSession, item };
                if (typeof document.dispatchEvent === "function") document.dispatchEvent(new CustomEvent("dsh-explain-assistant:evidence-selected", { detail }));
              });
            };
            document.addEventListener("dsh-explain-assistant:select", onSelectMode);
            controller = { dispose: () => {
              document.removeEventListener("dsh-explain-assistant:select", onSelectMode);
              selection?.dispose();
              element.dispatchEvent(new Event("dsh-explain-assistant:dispose"));
              element.remove();
            } };
          }
          return () => {
            controller?.dispose();
            selection?.dispose();
            host.replaceChildren();
          };
        }, [open, sessionId]);
        React.useEffect(() => {
          const host = hostRef.current;
          const element = host?.firstElementChild;
          if (!element || !state?.open) return;
          updateOverlay(element, state, plugin);
        });
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
