/**
 * §4/§8 F6：接住 DSH 真实的**归档信号**，在「归档那一刻」清理本插件为那个会话保存的记录。
 *
 * ── 为什么这里能成立（此前记为「做不到」是错的）────────────────────────
 * 之前搜「archived」只搜了 dsh 主包，漏了它自己的依赖树。真实信号链（已核到文件与行）：
 * - 服务：`@deepseek-ai/dsh-api-workspace-controller`，client 侧 `lib/client.js:389`
 *   构造时 `super(ctx, "workspaces")` → 服务名 **workspaces**；
 * - 接口：`lib/types/client/service.d.ts` 的 `IWorkspaces.list: WorkspaceSource`，
 *   `WorkspaceSource { getSnapshot(); subscribe(listener): () => void }`；
 * - 数据：`lib/types/client/model.d.ts` 的 `WorkspaceSnapshot.archivedSessionIds`
 *   —— **完整归档集合**，注释明写 "Complete registry-global archive set in Host order"；
 * - 推送：`WorkspaceFollowSink.replaceArchived()` 由 follow 增量调用
 *   （`client.js:138/152/188`），所以归档变化会真的推下来。
 * 包实际位置：`<dsh>/node_modules/@deepseek-ai/dsh-api-workspace-controller`
 * （dsh-web-app 的依赖，随 dsh web 一起提供）。
 *
 * ── 安全底线（这是删数据）───────────────────────────────────────────
 * 1. **首次快照只建基线，不触发任何清理**。归档集合是全量的，里面可能躺着很久以前
 *    归档的会话；若把「第一次看到的集合」当成「刚刚新归档的」，插件一加载就会把一批
 *    老记录删掉。所以 `previous === undefined` 时一律回空数组。
 * 2. **只对「新进入」集合的 id 触发**：已在上一份集合里的 id 不再触发（幂等，
 *    重复推送同一集合不会重复清理）。
 * 3. **unarchive 不触发任何动作**：从集合移除只是更新基线，不删、不恢复。
 * 4. **拿不到集合 / 服务抛异常 → 保留不删**，只记日志，且**不更新基线**
 *    （避免把「读失败」误当成「集合变空了」，那会让下次成功时的一批老 id 被当成新归档）。
 */
/** 只依赖我们真正用到的那一小块形状，便于测试注入假服务；不引入对 DSH 包的静态依赖。 */
export interface WorkspaceSnapshotLike {
    archivedSessionIds?: readonly unknown[];
    /** follow 生命周期。模型初始为 'pending'，baseline 到达后转 'ready'。 */
    phase?: unknown;
}
export interface WorkspaceSourceLike {
    getSnapshot(): WorkspaceSnapshotLike | undefined;
    subscribe(listener: () => void): () => void;
}
/**
 * 算出「这一份集合里，哪些是相对上一份**新进入**的」。
 *
 * `previous === undefined` 表示这是第一份快照：只建基线，返回空数组（见文件头第 1 条）。
 * 本函数永不抛异常，认不出的值直接忽略。
 */
export declare function diffNewlyArchived(previous: ReadonlySet<string> | undefined, next: unknown): string[];
export interface ArchiveWatcherOptions {
    source: WorkspaceSourceLike;
    /** 收到「某个会话刚刚被归档」时调用。抛出的异常必须被吞掉，不能影响后续。 */
    onArchived: (sessionId: string) => void | Promise<void>;
    logger?: (message: string) => void;
}
export interface ArchiveWatcher {
    /** 手动同步一次（测试与兜底都用它）。返回本次新进入的 id 列表。 */
    sync(): string[];
    dispose(): void;
    readonly disposed: boolean;
}
/**
 * 订阅归档集合，只在「新进入」时回调。
 *
 * 降级：`source` 拿不到、`subscribe` 抛异常、`getSnapshot` 抛异常 —— 一律只记日志，
 * 不抛给调用方、不触发任何清理。返回的对象始终可用（`sync` 变 no-op）。
 */
export declare function createArchiveWatcher(options: ArchiveWatcherOptions): ArchiveWatcher;
