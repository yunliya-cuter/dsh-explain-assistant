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
export async function withDeadline(task, ms) {
    if (!Number.isFinite(ms) || ms <= 0)
        return task;
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(undefined), ms);
    });
    try {
        return await Promise.race([task, timeout]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
