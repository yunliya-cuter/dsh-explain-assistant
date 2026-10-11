import type { AssistantApi } from './api.js';
type ClientPluginOptions = {
    api?: AssistantApi;
    session?: {
        id: string;
        cwd?: string;
    } | (() => {
        id: string;
        cwd?: string;
    } | undefined);
    /**
     * 读取 /state 的等待上限（毫秒）。默认 15 秒。
     *
     * 做成可覆盖的**唯一**理由是可验证性：超时这条路径不压到几十毫秒就没法在单测里真触发，
     * 而「超时后必须走到明确的中文错误、不得无限期停在加载态」正是本轮的验收判据之一
     * （与宿主侧 llmTimeouts 可注入是同一个思路）。
     *
     * ⚠️ 它**只**决定「等多久算没回应」，**不**决定「到点就放行空值」：
     * 到点走的是一次**失败结局**（已就绪 + 中文错误 + 重试），不是把初始空值当真实数据渲染。
     */
    stateTimeoutMs?: number;
};
export declare function createClientPlugin(options?: ClientPluginOptions): {
    api: AssistantApi;
    registry: import("./store.js").AssistantRegistry;
    open: () => void;
    submit: (question: string) => Promise<void>;
    loadEarlier: () => Promise<void>;
    cancel: () => void;
    dispose: () => void;
    setSession: (id?: string, cwd?: string) => void;
    openHistoryDetail: (recordId: string) => Promise<void>;
    loadMoreHistoryDetail: () => Promise<void>;
    closeHistoryDetail: () => void;
    forget: (sessionId: string) => Promise<void>;
    primeUnread: (sessionId: string) => Promise<void>;
    saveGeometry: (sessionId: string, geometry: {
        x: number;
        y: number;
        width: number;
        height: number;
    }) => void;
    retryState: (sessionId?: string) => Promise<void>;
    ensureState: (sessionId?: string) => Promise<void>;
};
export {};
