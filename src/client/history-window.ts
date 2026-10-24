/**
 * 历史区的「窗口」：一次只在页面上挂一小段，往上翻阅时再补。
 *
 * ── 为什么必须窗口化（实测数字）──────────────────────────────────
 * 一条历史回答实测平均 650px 高（有的 2000 多字）。20 条一起挂上去，历史区高
 * **12,917px**、可见区只有 357px —— 用户要滚 36 屏才到底，而且每次状态变化
 * （流式回答期间每个分片都算一次）都要把这些节点重新挂一遍。
 *
 * ── 为什么照 dsh 的做法 ──────────────────────────────────────────
 * dsh 的轨迹视图是「尾部 50 个节点 + 顶部一颗『加载更早的历史』药丸」，
 * 主对话那边是按页向宿主要（一页至少 50 条消息 / 2 轮、最多 500 条）。
 * 这里同一套思路，只是把「条」换成我们的「轮」：
 *   · 默认只挂最近 HISTORY_WINDOW 条；
 *   · 顶部药丸一次往上补 HISTORY_BATCH 条；
 *   · 同时最多挂 HISTORY_WINDOW_MAX 条 —— 超过就把最下面那批从 DOM 摘掉，
 *     数据仍在内存里，点「回到最近」就回来。
 *
 * ── 为什么用 id 而不是下标记住窗口 ──────────────────────────────
 * 往上翻页时宿主会**在前面**插入更早的记录（20 条一页），下标全部后移。
 * 用下标记住窗口，补一页之后用户看到的内容就会整体错位；
 * 记住「最上面那一条的 id」，插入多少条都不影响正在看的那一段。
 */

/** 默认一次挂多少条历史。 */
export const HISTORY_WINDOW = 6;
/** 点一次「更早的 N 条」补多少条。 */
export const HISTORY_BATCH = 6;
/** 同时最多挂多少条。超过就从最下面摘掉（数据还在）。 */
export const HISTORY_WINDOW_MAX = 12;

export type HistoryWindowState = {
  /** 当前窗口里**最上面**那条记录的 id。 */
  firstId?: string;
  /** 窗口里挂了多少条。 */
  count: number;
  /** 这次渲染时窗口是否贴着最新一条。贴着就要跟着新记录走。 */
  atTail: boolean;
};

export type HistoryWindow = {
  start: number;
  end: number;
  total: number;
  items: readonly unknown[];
  atTail: boolean;
};

const idOf = (record: unknown): string => {
  const value = (record as { id?: unknown } | null | undefined)?.id;
  return typeof value === 'string' ? value : '';
};

/**
 * 算出这一次要挂哪一段。
 *
 * @param records 全部已载入的记录（旧 → 新）。
 * @param previous 上一次的窗口；第一次渲染传 undefined。
 * @param expand 这一次要额外往上补几条（点「更早的 N 条」时传 HISTORY_BATCH）。
 */
export function resolveHistoryWindow(
  records: readonly unknown[],
  previous?: HistoryWindowState,
  expand = 0,
): HistoryWindow {
  const total = records.length;
  if (!total) return { start: 0, end: 0, total: 0, items: [], atTail: true };

  let count = Math.min(HISTORY_WINDOW_MAX, Math.max(1, Math.round(previous?.count ?? HISTORY_WINDOW)));
  let start = -1;
  if (previous?.firstId) start = records.findIndex(record => idOf(record) === previous.firstId);
  // 贴着最新一条时，窗口跟着尾巴走（新回答落地后要能看见它）。
  if (previous?.atTail && start >= 0) start = Math.max(0, total - count);
  if (start < 0) start = Math.max(0, total - count);

  if (expand > 0 && start > 0) {
    const add = Math.min(expand, start);
    start -= add;
    count = Math.min(HISTORY_WINDOW_MAX, count + add);
  }

  if (start > total - 1) start = Math.max(0, total - 1);
  const end = Math.min(total, start + count);
  return { start, end, total, items: records.slice(start, end), atTail: end >= total };
}

/** 窗口落在最新一段时的状态（「回到最近」用它）。 */
export function tailWindowState(records: readonly unknown[]): HistoryWindowState | undefined {
  if (!records.length) return undefined;
  const start = Math.max(0, records.length - HISTORY_WINDOW);
  return { firstId: idOf(records[start]), count: Math.min(HISTORY_WINDOW, records.length), atTail: true };
}
