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
export type ToolProgress = {
    id: string;
    name: string;
    label?: string;
    status: 'running' | 'ok' | 'error';
    detail?: string;
    result?: unknown;
    callId?: string;
    startedAt?: string;
    completedAt?: string;
    truncated?: boolean;
    availableBytes?: number;
    sentBytes?: number;
};
export type AssistantRecord = {
    id: string;
    question: string;
    answer?: string;
    reasoning?: string;
    status: AssistantPhase;
    createdAt: string;
    completedAt?: string;
    tools?: ToolProgress[];
    usage?: Record<string, unknown>;
    incomplete?: boolean;
    [key: string]: unknown;
};
export type Geometry = {
    x: number;
    y: number;
    width: number;
    height: number;
};
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
    counts?: {
        evidence?: number;
        tools?: number;
        images?: number;
    };
    /** 下一页游标；null 表示已经取完。 */
    cursor?: string | null;
    hasEarlier: boolean;
    loadingMore: boolean;
    error?: string;
};
export type CompactState = {
    summary?: string;
    reasoning?: string;
    updatedAt?: string;
    historyRevision?: number;
    status?: 'idle' | 'running' | 'complete' | 'error' | 'interrupted';
    error?: string;
};
export type ModelOption = {
    provider: string;
    model: string;
    source: 'explicit' | 'default';
    contextWindow?: number;
    inputModalities?: readonly string[];
};
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
    /** 首次打开时的快捷问题是否已被用户点过（点过就不再自动展示，§4）。 */
    quickQuestionsDismissed?: boolean;
    /** 模型目录（§7/§11.8），由宿主 /models 返回。 */
    catalog?: {
        groups?: Array<{
            provider?: string;
            displayName?: string;
            models?: Array<{
                provider?: string;
                id?: string;
                name?: string;
                contextWindow?: number;
            }>;
        }>;
        failures?: Array<{
            code?: string;
            message?: string;
        }>;
    };
    compactState?: CompactState;
    /** §5.1：当前展开的那条记录的完整内容（含分页游标）。 */
    historyDetail?: HistoryDetailState;
    error?: string;
    dependencyWarnings?: string[];
    archived?: boolean;
};
type Listener = () => void;
export declare class AssistantRegistry {
    private states;
    private listeners;
    private activeSessionId?;
    get(sessionId: SessionId, cwd?: string): AssistantClientState;
    get current(): AssistantClientState | undefined;
    get currentSessionId(): SessionId | undefined;
    setCurrent(sessionId?: SessionId): void;
    update(sessionId: SessionId, patch: Partial<AssistantClientState> | ((state: AssistantClientState) => void)): void;
    open(sessionId: SessionId, cwd?: string): void;
    close(sessionId: SessionId): void;
    remove(sessionId: SessionId): void;
    markUnread(sessionId: SessionId): void;
    sessions(): AssistantClientState[];
    subscribe(listener: Listener): () => void;
    snapshot(): {
        activeSessionId?: SessionId;
        states: AssistantClientState[];
    };
    private emit;
}
export declare const assistantRegistry: AssistantRegistry;
export declare function useAssistantRegistry<T>(selector: (state: AssistantClientState | undefined) => T, sessionId?: SessionId): T;
export type RegistryDispatch = (value: AssistantClientState | ((state: AssistantClientState) => AssistantClientState)) => void;
export {};
