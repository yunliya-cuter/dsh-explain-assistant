export type SessionId = string;
export type AssistantPhase = 'idle' | 'connecting' | 'running' | 'complete' | 'error' | 'interrupted';
export type EvidenceSource = 'session_snapshot' | 'selected_frozen' | 'workspace_latest' | 'assistant_history';
export type EvidenceState = 'observed' | 'reported_only' | 'unavailable';
export type EvidenceItem = {
  id: string;
  title?: string;
  summary?: string;
  source?: EvidenceSource | string;
  evidenceState?: EvidenceState;
  capturedAt?: string;
  version?: string | null;
  hash?: string | null;
  truncated?: boolean;
  incomplete?: boolean;
  sessionId?: string;
  [key: string]: unknown;
};
export type ToolProgress = { id: string; name: string; label?: string; status: 'running' | 'ok' | 'error'; detail?: string; result?: unknown; callId?: string; startedAt?: string; completedAt?: string; truncated?: boolean; availableBytes?: number; sentBytes?: number };
export type AssistantRecord = { id: string; question: string; answer?: string; reasoning?: string; status: AssistantPhase; createdAt: string; completedAt?: string; tools?: ToolProgress[]; usage?: Record<string, unknown>; incomplete?: boolean; [key: string]: unknown };
export type Geometry = { x: number; y: number; width: number; height: number };
/**
 * §5.1/§8/§11.6 某条历史记录的「完整内容」展开态。
 *
 * before：宿主 /history-result 没有任何实现，api.historyResult 是死代码，
 * 界面上也没有任何入口 —— 用户只看得到最近一条记录的摘要，想看某一条当时到底读到什么、
 * 跑过哪些工具，没有任何办法。这里保存展开后的记录与分页游标，界面据此渲染与续读。
 */
export type HistoryDetailState = {
  recordId: string;
  status: 'loading' | 'ready' | 'error';
  record?: Record<string, unknown>;
  counts?: { evidence?: number; tools?: number; images?: number };
  /** 下一页游标；null 表示已经取完。 */
  cursor?: string | null;
  hasEarlier: boolean;
  loadingMore: boolean;
  error?: string;
};
export type CompactState = { summary?: string; reasoning?: string; updatedAt?: string; historyRevision?: number; status?: 'idle' | 'running' | 'complete' | 'error' | 'interrupted'; error?: string };
export type ModelOption = { provider: string; model: string; source: 'explicit' | 'default'; contextWindow?: number; inputModalities?: readonly string[] };

export type AssistantClientState = {
  sessionId: SessionId;
  cwd?: string;
  open: boolean;
  unread: boolean;
  draft: string;
  model?: ModelOption;
  phase: AssistantPhase;
  requestId?: string;
  reasoning: string;
  text: string;
  tools: ToolProgress[];
  records: AssistantRecord[];
  hasEarlier: boolean;
  historyCursor?: string;
  loadingEarlier: boolean;
  evidence: EvidenceItem[];
  geometry?: Geometry;
  occupancy?: number;
  occupancyKnown: boolean;
  /** 占用值若是推算而非直接测量，界面要标「估算」（§9.2）。 */
  occupancyEstimated?: boolean;
  /**
   * 0.2：这份上下文由哪两块构成。
   *
   * 用户要求：「鼠标放上去应能显示出多少部分是主 agent 转移至小助手的上下文，
   * 哪部分是小助手与用户对话产生的上下文」。
   *
   * 两块之和 === 本次实际注入的量（宿主按**截断之后**的实际值记账）。
   * 拿不到时**不显示悬停提示**——宁可不显示，也不编造一个数字。
   */
  occupancyParts?: {
    mainAgentTokens: number;
    mainAgentChars: number;
    ownTokens: number;
    ownChars: number;
    /** 主 agent 段用了几条表面事件（可核查）。 */
    mainAgentEvents?: number;
    /** 主 agent 段是否因为总量上限被截断过。 */
    mainlineTruncated?: boolean;
  };
  /** 首次打开时的快捷问题是否已被用户点过（点过就不再自动展示，§4）。 */
  quickQuestionsDismissed?: boolean;
  /** 模型目录（§7/§11.8），由宿主 /models 返回。 */
  catalog?: {
    groups?: Array<{ provider?: string; displayName?: string; models?: Array<{ provider?: string; id?: string; name?: string; contextWindow?: number }> }>;
    failures?: Array<{ code?: string; message?: string }>;
  };
  compactState?: CompactState;
  /** §5.1：当前展开的那条记录的完整内容（含分页游标）。 */
  historyDetail?: HistoryDetailState;
  error?: string;
  dependencyWarnings?: string[];
  archived?: boolean;
};

type Listener = () => void;

function initial(sessionId: SessionId, cwd?: string): AssistantClientState {
  return { sessionId, cwd, open: false, unread: false, draft: '', phase: 'idle', reasoning: '', text: '', tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [], occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: false, compactState: { status: 'idle' } };
}

export class AssistantRegistry {
  private states = new Map<SessionId, AssistantClientState>();
  private listeners = new Set<Listener>();
  private activeSessionId?: SessionId;
  get(sessionId: SessionId, cwd?: string): AssistantClientState { if (!this.states.has(sessionId)) this.states.set(sessionId, initial(sessionId, cwd)); const state = this.states.get(sessionId)!; if (cwd && !state.cwd) state.cwd = cwd; return state; }
  get current(): AssistantClientState | undefined { return this.activeSessionId ? this.states.get(this.activeSessionId) : undefined; }
  get currentSessionId(): SessionId | undefined { return this.activeSessionId; }
  setCurrent(sessionId?: SessionId): void { if (this.activeSessionId === sessionId) { this.emit(); return; } this.activeSessionId = sessionId; this.emit(); }
  update(sessionId: SessionId, patch: Partial<AssistantClientState> | ((state: AssistantClientState) => void)): void { const state = this.get(sessionId); if (typeof patch === 'function') patch(state); else Object.assign(state, patch); this.emit(); }
  open(sessionId: SessionId, cwd?: string): void { this.get(sessionId, cwd); this.activeSessionId = sessionId; this.update(sessionId, { open: true, unread: false }); }
  close(sessionId: SessionId): void { this.update(sessionId, { open: false }); }
  remove(sessionId: SessionId): void { this.states.delete(sessionId); if (this.activeSessionId === sessionId) this.activeSessionId = undefined; this.emit(); }
  markUnread(sessionId: SessionId): void { this.update(sessionId, { unread: true }); }
  sessions(): AssistantClientState[] { return [...this.states.values()]; }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  snapshot(): { activeSessionId?: SessionId; states: AssistantClientState[] } { return { activeSessionId: this.activeSessionId, states: this.sessions() }; }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

export const assistantRegistry = new AssistantRegistry();
export function useAssistantRegistry<T>(selector: (state: AssistantClientState | undefined) => T, sessionId?: SessionId): T { return selector(sessionId ? assistantRegistry.get(sessionId) : assistantRegistry.current); }
export type RegistryDispatch = (value: AssistantClientState | ((state: AssistantClientState) => AssistantClientState)) => void;
