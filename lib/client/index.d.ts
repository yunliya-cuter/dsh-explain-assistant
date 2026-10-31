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
    /**
     * 「占用待补」时自动重取 /state 的延迟（毫秒）。默认 3 秒。
     *
     * 宿主那边主 agent 上下文的读取有 500ms 截止时间：超时那次不带占用（occupancyPending=true），
     * 后台继续读。等它读完，客户端在这里自动补一次 —— 用户不需要再点一次。
     * 做成可覆盖的唯一理由是可验证性：单测里压到 0 才能真触发。
     */
    occupancyRetryDelayMs?: number;
    /**
     * 「占用待补」最多自动补几次（默认 2 = 首补 + 一次重试）。
     *
     * 审计 2026-10-31：这里一直写着「只补一次」，实现却是每 3 秒无限轮询 ——
     * 而宿主对**空会话**（还没有主 agent 消息）同样返回 occupancyPending=true，
     * 于是新建一个空对话、打开浮窗，/state 会被无限每 3 秒打一次。加硬上限。
     */
    occupancyRetryMax?: number;
    /**
     * 「更早的历史 / 展开单条记录」这两条读路径的等待上限（毫秒）。默认 10 秒。
     *
     * 与 stateTimeoutMs 同一个理由：把"永远转圈"这条路径压到几十毫秒，才能在单测里真触发。
     * 它**只**决定「等多久算没回应」，到点走一次失败结局（中文原因 + 用户可以再点一次），
     * 不会把空结果当成真实数据放行。
     */
    readTimeoutMs?: number;
};
export declare function createClientPlugin(options?: ClientPluginOptions): {
    api: AssistantApi;
    registry: import("./store.js").AssistantRegistry;
    open: () => void;
    close: () => void;
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
