/** Shared wire and durable contracts for dsh-explain-assistant. */

export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export type Operation = 'state' | 'history' | 'history-result' | 'models' | 'select-model' | 'ask' | 'compact' | 'cancel' | 'forget' | 'mark-read' | 'geometry';
export type SseEventType = 'start' | 'progress' | 'reasoning' | 'text' | 'tool_start' | 'tool_result' | 'usage' | 'complete' | 'error' | 'aborted';

export interface Envelope<T> {
  schemaVersion: number;
  sessionId: string;
  requestId?: string;
  operation: Operation;
  historyRevision?: number;
  payload: T;
}

export interface ErrorBody {
  code: ErrorCode | string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  schemaVersion: number;
  ok: false;
  sessionId?: string;
  requestId?: string;
  operation?: Operation;
  error: ErrorBody;
}

export type ErrorCode =
  | 'INVALID_REQUEST' | 'UNSUPPORTED_SCHEMA' | 'SESSION_NOT_FOUND' | 'SESSION_ARCHIVED'
  | 'SESSION_FORBIDDEN' | 'WORKSPACE_UNAVAILABLE' | 'PATH_INVALID' | 'PATH_OUTSIDE_WORKSPACE'
  | 'MODEL_UNAVAILABLE' | 'MODEL_NOT_FOUND' | 'IMAGE_UNSUPPORTED' | 'REQUEST_IN_FLIGHT'
  | 'HISTORY_CONFLICT' | 'RECORD_NOT_FOUND' | 'TOOL_NOT_ALLOWED' | 'TOOL_INVALID_ARGUMENTS'
  | 'TOOL_FAILED' | 'TOOL_TIMEOUT' | 'LIMIT_EXCEEDED' | 'PERSISTENCE_FAILED'
  | 'PERSISTENCE_CORRUPT' | 'DEPENDENCY_UNAVAILABLE' | 'ABORTED' | 'INTERNAL_ERROR';

export class ExplainAssistantError extends Error {
  readonly code: ErrorCode | string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode | string, message: string, options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ExplainAssistantError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export type EvidenceSource = 'session_snapshot' | 'selected_frozen' | 'workspace_latest' | 'assistant_history';
export type EvidenceState = 'observed' | 'reported_only' | 'unavailable';
export type EvidenceKind = 'session' | 'node' | 'tool' | 'file' | 'image' | 'history' | 'model';

export interface EvidenceEnvelope {
  schemaVersion: SchemaVersion;
  sessionId: string;
  nodeId?: string;
  seq?: number;
  kind: EvidenceKind;
  status?: string;
  title?: string;
  summary?: string;
  command?: string;
  arguments?: unknown;
  output?: unknown;
  text?: string;
  timestamp?: string;
  source: EvidenceSource;
  evidenceState: EvidenceState;
  capturedAt: string;
  version?: string;
  truncated: boolean;
  incomplete: boolean;
  metadata?: Record<string, unknown>;
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ModelCapability {
  inputModalities?: readonly ('text' | 'image')[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cost?: number;
}

export interface ToolTrace {
  tool: string;
  callId?: string;
  arguments?: unknown;
  status: 'preparing' | 'running' | 'ok' | 'error' | 'stopped';
  result?: unknown;
  error?: ErrorBody;
  startedAt: string;
  finishedAt?: string;
  truncated?: boolean;
  sentBytes?: number;
  availableBytes?: number;
}

export interface ImageSnapshotRef {
  id: string;
  relativePath: string;
  mediaType: string;
  bytes: number;
  width?: number;
  height?: number;
  sha256: string;
  capturedAt: string;
}

export interface AssistantRecord {
  id: string;
  kind: 'ask' | 'compact';
  status: 'running' | 'complete' | 'error' | 'interrupted';
  complete: boolean;
  question?: string;
  answerText: string;
  reasoningText: string;
  evidence: EvidenceEnvelope[];
  tools: ToolTrace[];
  images: ImageSnapshotRef[];
  model?: ModelSelection;
  modelCapability?: ModelCapability;
  usage?: Usage;
  error?: ErrorBody;
  persistenceError?: boolean;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface CompactState {
  version: number;
  summary: string;
  sourceRecordIds: string[];
  createdAt: string;
  model?: ModelSelection;
}

export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AssistantState {
  schemaVersion: number;
  sessionId: string;
  historyRevision: number;
  explicitModel?: ModelSelection;
  records: AssistantRecord[];
  compactState?: CompactState;
  unread: boolean;
  geometry?: Geometry;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedState extends AssistantState {
  schemaVersion: number;
}

/**
 * §5.1 / §8：单条历史记录的展开读取结果（GET /history-result）。
 *
 * 字段只有三个：record 的字段沿用 AssistantRecord/**EvidenceEnvelope/ToolTrace/ImageSnapshotRef** 的既有形状，
 * 不另造第二套协议；另外两个是分页器自己的状态。
 */
export interface HistoryResultPayload {
  /** 这条记录属于哪个会话。客户端拿它对账，跨会话请求在这里就能被发现（§8「不混入其他主对话」）。 */
  sessionId: string;
  /** 这条记录的 id，必须与请求里的 recordId 一致。 */
  recordId: string;
  /** 该记录的完整内容。数组字段按页展开，未取到的部分仍在 counts 里如实计数。 */
  record: AssistantRecord;
  /** 该记录各项内容的**完整总条数**（不随分页变化），界面据此显示「已显示 x / 共 n」。 */
  counts: {
    evidence: number;
    tools: number;
    images: number;
  };
  /** 游标与 hasEarlier 沿用 /history 那条分页接口的既有命名，不另造第二套。 */
  cursor: string | null;
  /** 还有更早内容没取：为 true 时界面才显示「继续加载」。 */
  hasEarlier: boolean;
}

export interface StateLoadResult {
  state: AssistantState;
  created: boolean;
  recoveredCorrupt?: string;
  readOnlyFutureVersion?: number;
}

export interface SseEvent<T = unknown> {
  schemaVersion: SchemaVersion;
  sessionId: string;
  requestId: string;
  operation: 'ask' | 'compact';
  type: SseEventType;
  payload?: T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isModelSelection(value: unknown): value is ModelSelection {
  return isRecord(value) && typeof value.provider === 'string' && value.provider.length > 0 && typeof value.model === 'string' && value.model.length > 0 && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string');
}

export function validateSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw new ExplainAssistantError('INVALID_REQUEST', '会话标识无效。');
}

export function safeSessionId(sessionId: string): string {
  validateSessionId(sessionId);
  return sessionId;
}

export function createEmptyState(sessionId: string, now = new Date().toISOString()): AssistantState {
  validateSessionId(sessionId);
  return { schemaVersion: SCHEMA_VERSION, sessionId, historyRevision: 0, records: [], unread: false, archived: false, createdAt: now, updatedAt: now };
}

export function assertState(value: unknown, expectedSessionId?: string): asserts value is PersistedState {
  if (!isRecord(value) || typeof value.schemaVersion !== 'number' || typeof value.sessionId !== 'string' || !Array.isArray(value.records) || typeof value.historyRevision !== 'number' || typeof value.unread !== 'boolean' || typeof value.archived !== 'boolean') throw new ExplainAssistantError('PERSISTENCE_CORRUPT', '本地保存的小助手记录格式不正确。');
  validateSessionId(value.sessionId);
  if (expectedSessionId !== undefined && value.sessionId !== expectedSessionId) throw new ExplainAssistantError('PERSISTENCE_CORRUPT', '本地保存的记录属于另一个会话，已拒绝读取。');
}

export function validateEnvelope(value: unknown, expectedOperation?: Operation): asserts value is Envelope<unknown> {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || typeof value.sessionId !== 'string' || typeof value.operation !== 'string' || !('payload' in value)) throw new ExplainAssistantError(value && isRecord(value) && value.schemaVersion !== SCHEMA_VERSION ? 'UNSUPPORTED_SCHEMA' : 'INVALID_REQUEST', '请求格式无效或版本不受支持。');
  validateSessionId(value.sessionId);
  if (!(['state','history','history-result','models','select-model','ask','compact','cancel','forget','mark-read','geometry'] as string[]).includes(value.operation)) throw new ExplainAssistantError('INVALID_REQUEST', '未知的操作。');
  if (expectedOperation !== undefined && value.operation !== expectedOperation) throw new ExplainAssistantError('INVALID_REQUEST', '操作与请求不匹配。');
  if (value.requestId !== undefined && (typeof value.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.requestId))) throw new ExplainAssistantError('INVALID_REQUEST', '请求标识无效。');
}

export function toErrorBody(error: unknown, fallbackCode: ErrorCode = 'INTERNAL_ERROR'): ErrorBody {
  if (error instanceof ExplainAssistantError) return { code: error.code, message: error.message, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) };
  return { code: fallbackCode, message: '解释小助手没能完成这次操作，请稍后重试。', retryable: false };
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
