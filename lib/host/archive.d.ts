/**
 * §4/§8 F6：归档处理的**轻量周期检查**。
 *
 * 实施文档 `docs/implementation-plan.md` §8 要求归档处理有三条腿：
 * 「启动清理、轻量周期检查、可用归档事件即时处理」。目前：
 * - 启动清理：已在 `src/index.ts` 的 `cleanupArchived`（只重试**失败的删除**）；
 * - **轻量周期检查：本文件**；
 * - 归档事件即时处理：**不可实现**。已核实整个 DSH 安装里没有 archive 事件、
 *   也没有 archived 标识（`grep -rn 'archived' dsh/lib` 为空）。不为凑齐三条腿去硬造假监听。
 *
 * ─────────────────────────────────────────────────────────────
 * 这是**删用户数据**的功能，所以本文件的设计原则是：**宁可漏删，绝不误删**。
 * ─────────────────────────────────────────────────────────────
 *
 * 最容易犯的致命错误：把「查不到这个会话」当成「这个会话已归档」。
 * `sessions.get(id)` 返回 undefined 的原因至少有三种，**它们无法区分**：
 *   1. 会话真的被删了；
 *   2. sessions 服务此刻不可用 / 还没加载好；
 *   3. 插件跑在会话还没注册进来的时机上。
 * 只有第 1 种才够格删。把 undefined 当已归档，等于在服务抖一下的时候批量清空用户记录。
 * 所以本文件的判据是：**只有拿到一个「明确自报已归档」的会话对象才允许删**；
 * 其余一切情况（undefined、非对象、抛异常、服务不可用、字段缺失）一律判 `unknown` → **保留**。
 *
 * 副作用（如实说明）：当前 DSH 版本没有任何归档标识，所以这个周期检查在实际运行中
 * **几乎不会删掉任何东西** —— 这是正确的安全行为，不是缺陷。等 DSH 将来提供归档信号，
 * 本文件无需改动即可生效。
 */
export type ArchiveVerdict = 'archived' | 'alive' | 'unknown';
/**
 * 判定一个会话对象的归档状态。
 *
 * 只认**显式**的归档标识，且只认下列几种明确写法；任何其他取值（包括 `false`、
 * 缺失字段、字符串 `'true'`）都不算已归档。
 * 本函数**永不抛异常**，认不出就是 `unknown`。
 */
export declare function classifySessionArchive(session: unknown): ArchiveVerdict;
export interface ArchiveSweepDeps {
    /** 枚举**我们自己**存储目录里的会话标识（不去列 DSH 的全局会话列表——没有可靠接口）。 */
    listSessionIds: () => readonly string[] | Promise<readonly string[]>;
    /** 向 sessions 服务询问这个会话当前是什么状态。返回值原样交给 classifySessionArchive。 */
    lookupSession: (id: string) => unknown;
    /** 真正执行删除；失败应由实现方放进重试队列（见 JsonSessionStore.remove）。 */
    removeSession: (id: string) => Promise<void>;
    logger?: (message: string) => void;
}
export interface ArchiveSweepResult {
    /** 本次看了几个会话。 */
    examined: number;
    /** 其中判定「确定已归档」并执行删除的个数。 */
    removed: number;
    /** 判定「会话还活着」而**主动保留**的个数（防误删的关键计数）。 */
    alive: number;
    /** 判定「拿不准」而**主动保留**的个数（服务不可用、查不到、抛异常都算这里）。 */
    unknown: number;
    /** 删除失败的个数（已进入重试队列）。 */
    failed: number;
}
/**
 * 扫一遍我们自己的记录，只清理「确定已归档」的会话。
 *
 * 安全约定（逐条对应任务书）：
 * - 拿不准就**保留**：unknown 只是计数 + 日志，绝不触发删除；
 * - 会话**还活着**：保留（即使我们本地曾把它标成归档，也以「会话服务说它活着」为准）；
 * - 单个会话出任何错都不能让整轮扫描崩掉，更不能向上抛；
 * - 只删本插件自己的 JSON 与图片快照（删除动作由 removeSession 决定，见 store.remove）。
 */
export declare function sweepArchivedSessions(deps: ArchiveSweepDeps): Promise<ArchiveSweepResult>;
/** 周期检查的最短间隔：5 分钟（任务书要求「不要短于 5 分钟」）。 */
export declare const ARCHIVE_SWEEP_INTERVAL_MS: number;
export interface ArchiveSweeperOptions extends ArchiveSweepDeps {
    intervalMs?: number;
    /** 可注入的时钟，便于测试「短时间内不会被反复触发」。 */
    now?: () => number;
}
/**
 * 把扫描包成「轻量周期检查」。
 *
 * 两道闸，保证它足够轻：
 * 1. **重入闸**：上一轮还没跑完时，新的触发直接跳过（不会并发堆积）；
 * 2. **最小间隔闸**：距上次**成功开始**不足 intervalMs 时跳过，避免被反复触发。
 *
 * 两条都返回 `skipped`，调用方据此知道「这次没扫」——不静默。
 */
export declare function createArchiveSweeper(options: ArchiveSweeperOptions): {
    run: (reason: string) => Promise<{
        skipped?: 'busy' | 'too-soon';
        result?: ArchiveSweepResult;
    }>;
    /** 启动周期检查；unref 让定时器不阻止进程退出。 */
    start(): void;
    stop(): void;
    readonly intervalMs: number;
};
