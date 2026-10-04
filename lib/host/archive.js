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
/**
 * 判定一个会话对象的归档状态。
 *
 * 只认**显式**的归档标识，且只认下列几种明确写法；任何其他取值（包括 `false`、
 * 缺失字段、字符串 `'true'`）都不算已归档。
 * 本函数**永不抛异常**，认不出就是 `unknown`。
 */
export function classifySessionArchive(session) {
    try {
        if (!session || typeof session !== 'object' || Array.isArray(session))
            return 'unknown';
        const record = session;
        const header = record.header && typeof record.header === 'object' && !Array.isArray(record.header)
            ? record.header
            : undefined;
        // 只有「恰好是布尔 true」才算已归档；'true' 这种字符串一律不认（避免把配置串误判成归档）。
        if (record.archived === true)
            return 'archived';
        if (header?.archived === true)
            return 'archived';
        // 少数实现用状态字段表达；同样只认精确取值。
        if (record.status === 'archived' || record.state === 'archived')
            return 'archived';
        // 关键区分：字段**存在但不是明确布尔值**（例如 archived:'true'、archived:1）说明我们读不懂它的
        // 含义 —— 这种情况必须判「拿不准」而不是「活着」，因为一旦将来 DSH 改用别的编码表达归档，
        // 误判成「活着」会让本该清理的记录永远留着（漏删），误判成「已归档」则会删错（致命）。
        // 判 unknown 的效果是「保留 + 只记日志」，两边都不会出事。
        if ('archived' in record && record.archived !== false)
            return 'unknown';
        if (header && 'archived' in header && header.archived !== false)
            return 'unknown';
        // 拿到了一个会话对象，且它明确没有归档标识（或明确写着 false）→ 这个会话还活着，**绝不能删**。
        return 'alive';
    }
    catch {
        return 'unknown';
    }
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
export async function sweepArchivedSessions(deps) {
    const result = { examined: 0, removed: 0, alive: 0, unknown: 0, failed: 0 };
    const log = deps.logger;
    let ids = [];
    try {
        const listed = await deps.listSessionIds();
        ids = Array.isArray(listed) ? listed : [];
    }
    catch (error) {
        // 连自己的目录都读不出来：什么都不做，更不能猜着删。
        log?.('扫描归档记录失败，已跳过本轮：' + (error instanceof Error ? error.message : String(error)));
        return result;
    }
    for (const rawId of ids) {
        const id = typeof rawId === 'string' ? rawId.trim() : '';
        if (!id)
            continue;
        result.examined++;
        let verdict = 'unknown';
        try {
            // lookupSession 允许同步或返回 Promise；统一 await 一次。
            verdict = classifySessionArchive(await deps.lookupSession(id));
        }
        catch (error) {
            // 服务抛异常 = 拿不准 → 保留。这一条是防误删的主力。
            verdict = 'unknown';
            log?.('查询会话状态失败，已保留记录（' + id + '）：' + (error instanceof Error ? error.message : String(error)));
        }
        if (verdict !== 'archived') {
            if (verdict === 'alive')
                result.alive++;
            else
                result.unknown++;
            continue;
        }
        try {
            await deps.removeSession(id);
            result.removed++;
        }
        catch (error) {
            // remove 失败应由 store 记进重试队列；这里只计数，绝不抛出去。
            result.failed++;
            log?.('清理已归档记录失败，已进入重试队列（' + id + '）：' + (error instanceof Error ? error.message : String(error)));
        }
    }
    return result;
}
/** 周期检查的最短间隔：5 分钟（任务书要求「不要短于 5 分钟」）。 */
export const ARCHIVE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * 把扫描包成「轻量周期检查」。
 *
 * 两道闸，保证它足够轻：
 * 1. **重入闸**：上一轮还没跑完时，新的触发直接跳过（不会并发堆积）；
 * 2. **最小间隔闸**：距上次**成功开始**不足 intervalMs 时跳过，避免被反复触发。
 *
 * 两条都返回 `skipped`，调用方据此知道「这次没扫」——不静默。
 */
export function createArchiveSweeper(options) {
    const intervalMs = Math.max(ARCHIVE_SWEEP_INTERVAL_MS, options.intervalMs ?? ARCHIVE_SWEEP_INTERVAL_MS);
    const now = options.now ?? (() => Date.now());
    let running = false;
    let lastStartedAt = Number.NEGATIVE_INFINITY;
    let timer;
    let stopped = false;
    const run = async (reason) => {
        if (stopped)
            return { skipped: 'too-soon' };
        if (running)
            return { skipped: 'busy' };
        const at = now();
        if (at - lastStartedAt < intervalMs)
            return { skipped: 'too-soon' };
        running = true;
        lastStartedAt = at;
        try {
            const result = await sweepArchivedSessions(options);
            if (result.removed || result.failed) {
                options.logger?.('[dsh-explain-assistant] 归档周期检查（' + reason + '）：清理 ' + result.removed + ' 个，失败 ' + result.failed + ' 个，保留 ' + (result.alive + result.unknown) + ' 个');
            }
            return { result };
        }
        finally {
            running = false;
        }
    };
    return {
        run,
        /** 启动周期检查；unref 让定时器不阻止进程退出。 */
        start() {
            if (timer || stopped)
                return;
            timer = setInterval(() => { void run('周期'); }, intervalMs);
            if (typeof timer.unref === 'function')
                timer.unref();
        },
        stop() {
            stopped = true;
            if (timer) {
                clearInterval(timer);
                timer = undefined;
            }
        },
        get intervalMs() { return intervalMs; },
    };
}
