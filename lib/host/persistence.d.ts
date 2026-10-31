import { AssistantState, PersistedState, StateLoadResult } from './contracts.js';
interface PersistenceOptions {
    rootDir: string;
    /** Optional clock to make migration and cleanup tests deterministic. */
    now?: () => Date;
    /** Do not mutate the source file when a future schema is encountered. */
    readOnlyFutureVersions?: boolean;
}
interface StateStore {
    load(sessionId: string): Promise<StateLoadResult>;
    save(state: AssistantState): Promise<void>;
    update(sessionId: string, mutator: (state: AssistantState) => AssistantState | void): Promise<AssistantState>;
    remove(sessionId: string): Promise<void>;
    /** 枚举本插件存储目录里的会话标识（F6 归档周期检查用）。 */
    listSessionIds(): Promise<string[]>;
    /**
     * 标记已读：**一次**串行的读改写，且只在真的需要时写盘。
     *
     * 为什么单独开一个方法、而不是让调用方自己 update(mutator)：
     * update 对**不存在的文件**会 load→save 新建一份，于是"只是点开看一眼"的会话
     * 也会在磁盘上留下一个空文件（实测已有 session-ba15016d… 这种 0 条记录的文件）。
     * 而"先 load 判断再 update"会在队列里插进两次读，中间给并发的 GET 留出窗口 ——
     * 实测让「打开浮窗 → 宿主已读」这条链在测试里输给了紧随其后的刷新。
     * 放在同一个队列里做，既不多建文件，也不多一次往返。
     */
    markRead(sessionId: string): Promise<void>;
    pathFor(sessionId: string): string;
    imageDirFor(sessionId: string): string;
    close(): Promise<void>;
}
type Migration = (state: PersistedState) => PersistedState;
/**
 * Durable per-session state with serialized updates and replace-style writes.
 * The directory is plugin-owned; callers must never pass a workspace path here.
 */
export declare class JsonSessionStore implements StateStore {
    private readonly rootDir;
    private readonly now;
    private readonly readOnlyFutureVersions;
    private readonly queues;
    private readonly migrations;
    private readonly pendingDeletes;
    private closed;
    constructor(options: PersistenceOptions);
    pathFor(sessionId: string): string;
    imageDirFor(sessionId: string): string;
    registerMigration(fromVersion: number, migration: Migration): void;
    load(sessionId: string): Promise<StateLoadResult>;
    save(state: AssistantState): Promise<void>;
    update(sessionId: string, mutator: (state: AssistantState) => AssistantState | void): Promise<AssistantState>;
    /**
     * §4/§8 F6：枚举**本插件自己**存储目录里的会话标识，供归档周期检查使用。
     *
     * 刻意不去列 DSH 的全局会话列表（没有可靠的全局接口）：只读我们自己的
     * `<rootDir>/sessions/*.json`，文件名就是会话标识（见 pathFor）。
     * 读目录失败时回空数组——清理是尽力而为，不能因为列不出来就报错或乱猜。
     */
    listSessionIds(): Promise<string[]>;
    markRead(sessionId: string): Promise<void>;
    remove(sessionId: string): Promise<void>;
    close(): Promise<void>;
    /** Retry archive cleanup; failed deletes remain queued and never touch workspace files. */
    retryPendingDeletes(): Promise<{
        attempted: number;
        failed: number;
    }>;
    pendingDeleteIds(): readonly string[];
    private loadUnlocked;
    private migrate;
    private writeAtomic;
    private quarantine;
    private readExistingSchema;
    private enqueue;
    private ensureOpen;
}
export {};
