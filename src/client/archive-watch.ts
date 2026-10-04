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
export function diffNewlyArchived(previous: ReadonlySet<string> | undefined, next: unknown): string[] {
  if (previous === undefined) return [];
  if (!Array.isArray(next)) return [];
  const seen = new Set<string>();
  const fresh: string[] = [];
  for (const raw of next) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (previous.has(id)) continue;   // 上一份里就有 → 不是「新进入」
    fresh.push(id);
  }
  return fresh;
}

/**
 * 从快照里取出一份干净的归档 id 集合；**拿不到「权威数据」时返回 undefined**（调用方据此保留不删）。
 *
 * ── 事故：0.1.38 一次性误删 30 条记录（务必读这段再改本函数）──────────────
 * 这里原本只判断 `Array.isArray(archivedSessionIds)`。而 DSH 的 client model
 * **在 follow baseline 到达之前，`archivedSessionIds` 就是一个合法的空数组**
 * （构造函数里 `archivedSessionIds = []`，`phase = 'pending'`）。于是真实时序变成：
 *   ① 插件加载 → sync() 立刻跑 → 读到**未就绪的空数组** → known = 空集（**假基线**）；
 *   ② Host baseline 到达（真实 30 条）→ 相对空集**全部**被判为「新进入」→ 30 条一次性被删。
 * 实测复现：①创建后删 [] → ②baseline 到达后删 ["A","B","C"]。
 *
 * **教训**：把「未初始化的占位值」当成权威数据，会引发任意规模的批量动作
 * （这次 30 条，换成 300 条也一样）。判定就绪必须用**显式的生命周期字段**，
 * 不能用「数组是否为空」这种间接信号。
 *
 * 因此：**只有 phase === 'ready' 才算权威集合**；
 * - phase 是 'pending'（未就绪）→ undefined，保留不删；
 * - **快照没有 phase 字段**（例如更早/未知版本）→ 也返回 undefined，按「不可用」处理
 *   （fail-safe：宁可漏删，绝不误删）。
 */
function readArchivedIds(snapshot: WorkspaceSnapshotLike | undefined): Set<string> | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  // 就绪闸：没有 phase 或 phase !== 'ready' 一律视为「集合不可用」。
  if (snapshot.phase !== 'ready') return undefined;
  const raw = snapshot.archivedSessionIds;
  if (!Array.isArray(raw)) return undefined;
  const set = new Set<string>();
  for (const item of raw) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (id) set.add(id);
  }
  return set;
}

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
export function createArchiveWatcher(options: ArchiveWatcherOptions): ArchiveWatcher {
  let known: Set<string> | undefined;
  let disposed = false;
  const log = options.logger;

  const sync = (): string[] => {
    if (disposed) return [];
    let snapshot: WorkspaceSnapshotLike | undefined;
    try {
      snapshot = options.source?.getSnapshot?.();
    } catch (error) {
      // 读失败 → 保留不删，**且不更新基线**（见文件头第 4 条）。
      log?.('读取归档集合失败，已保留全部记录：' + (error instanceof Error ? error.message : String(error)));
      return [];
    }
    const next = readArchivedIds(snapshot);
    if (!next) {
      // 未就绪（phase !== 'ready'）或形状不对 → 一律保留不删，**且不更新基线**。
      // 不更新基线是关键：否则会把「读不到」误当成「集合变空了」，
      // 等下一次真正就绪时，一批历史归档的 id 会被当成「新进入」→ 批量误删。
      log?.('归档集合尚未就绪或不可用（phase 非 ready / 缺少字段），已保留全部记录。');
      return [];
    }
    const fresh = diffNewlyArchived(known, [...next]);
    known = next;   // 先更新基线，再回调：即使回调抛错也不会让它下次重复触发
    for (const id of fresh) {
      try {
        const result = options.onArchived(id);
        // 异步回调的拒绝也要吞掉：不能让一个会话的清理失败影响其它会话或订阅者。
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<unknown>).catch((error: unknown) => {
            log?.('归档清理失败（' + id + '）：' + (error instanceof Error ? error.message : String(error)));
          });
        }
      } catch (error) {
        log?.('归档清理失败（' + id + '）：' + (error instanceof Error ? error.message : String(error)));
      }
    }
    return fresh;
  };

  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = options.source?.subscribe?.(() => { sync(); }) ?? undefined;
  } catch (error) {
    // 订阅失败不影响插件其余功能（静默降级），周期检查仍是兜底。
    log?.('订阅归档信号失败，已跳过（周期检查仍会兜底）：' + (error instanceof Error ? error.message : String(error)));
  }
  // 建立基线。注意：这一步**不会**触发清理（known 仍是 undefined）。
  sync();

  return {
    sync,
    get disposed() { return disposed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { unsubscribe?.(); } catch { /* 取消订阅失败不影响卸载 */ }
      unsubscribe = undefined;
    },
  };
}
