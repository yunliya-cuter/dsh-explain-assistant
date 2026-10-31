/**
 * 「最多等这么久」——把一条**可以慢但不必等**的支路从关键路径上摘下来。
 *
 * 背景（2026-10-31，3081 实测）：打开浮窗要等 /state，而 /state 里最贵的一项是把主 agent
 * 的上下文读一遍（readSurface）。用户的会话已经到 44 MB，这一项**实测 5.8–17 秒**，
 * 于是点完入口按钮要等近十秒才有反应，超过客户端 15 秒上限时更是直接变成"点了没反应"。
 *
 * 但占用（那个圆环）只是锦上添花：拿不到就该显示「占用未知」，不能让它把整个浮窗拖住。
 *
 * 行为：
 * · 任务在 ms 内完成 → 返回它的结果；
 * · 超时 → 返回 undefined（**不取消**原任务：让它继续跑完，把缓存焐热，下一次就是快的）；
 * · 注意：超时之后原任务若 reject，必须有调用方接住（见 index.ts 里的 .catch）。
 */
/**
 * 与 withDeadline 相同，但超时返回调用方给的**哨兵值**。
 *
 * 为什么需要：withDeadline 超时返回 undefined，而任务**自己**也可能正常返回 undefined
 * （例如"这个会话还没有主 agent 内容"）。两者混在一起，上层就把"空会话"当成"这次没赶上截止时间"，
 * 于是永久回 occupancyPending=true —— 客户端照着注释"只补一次"，实际每 3 秒打一次 /state。
 */
export declare function withDeadlineSentinel<T, S>(task: Promise<T>, ms: number, timeout: S): Promise<T | S>;
/**
 * 与 signal 赛跑：一旦 abort 立刻 reject，**不等底层 Promise 自己结束**。
 *
 * 为什么需要：模型调用前的几步（读主 agent 表面、读模型目录、准备工具上下文）都不接受 signal，
 * 用户点「停止」只能 abort controller，active 仍被占着 —— 再发一条就是 409「已经有一个解释请求在处理中」。
 * 实测：大会话里点停止后要等十几秒才能再发。
 */
export declare function withAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T>;
export declare function withDeadline<T>(task: Promise<T>, ms: number): Promise<T | undefined>;
