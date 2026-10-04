import { AssistantState, PersistedState, StateLoadResult } from './contracts.js';
export interface PersistenceOptions {
    rootDir: string;
    /** Optional clock to make migration and cleanup tests deterministic. */
    now?: () => Date;
    /** Do not mutate the source file when a future schema is encountered. */
    readOnlyFutureVersions?: boolean;
}
export interface StateStore {
    load(sessionId: string): Promise<StateLoadResult>;
    save(state: AssistantState): Promise<void>;
    update(sessionId: string, mutator: (state: AssistantState) => AssistantState | void): Promise<AssistantState>;
    remove(sessionId: string): Promise<void>;
    /** 枚举本插件存储目录里的会话标识（F6 归档周期检查用）。 */
    listSessionIds(): Promise<string[]>;
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
export declare function createPersistenceStore(rootDir: string): JsonSessionStore;
export {};
