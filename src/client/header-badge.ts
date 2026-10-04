/**
 * §4/§8/§10：入口按钮（主对话右上角的「?」）的**未读徽标**。
 *
 * ── 这里修的是什么（verify-3082 在 3082 页面上实测到的真缺陷）────────────
 * 现象：宿主接口确实下发 `unread: true`（curl 实测），但按钮**始终**是 `?`，
 * 从未变成 `? ·`。三种时刻（关窗时 / 停止回答后 / 硬刷新后）测到的 `? ·` 数量恒为 0。
 *
 * 根因：`entry.ts` 的 `HeaderButton` 渲染时读 `registry.get(id).unread` 是对的，
 * **但它内部没有任何 `registry.subscribe`**。唯一的订阅在 `OverlayBridge`，而那只重渲染
 * **浮窗那棵树**；header 按钮是**另一处独立的 slot 注册**。所以
 * `registry.update(..., { unread: true })` 改了数据，却没有任何东西通知按钮重渲染
 * —— 数据在、按钮不刷新。这也解释了为什么此前 S4「刷新后徽标消失」被记为已修却没效果：
 * 修好的是「状态位恢复」，漏的是「按钮根本不重渲染」。
 *
 * ── 为什么把逻辑抽到这里 ────────────────────────────────────────────
 * 缺陷的坑正是「渲染函数看着对、但没人触发它重渲染」。若把判断写在组件内部，
 * 测试只能「手工构造 props 渲染一次」——那种写法**天然测不出这个 bug**（它绕过了订阅）。
 * 抽成纯函数 + 可注入 registry 的订阅函数后，测试可以**从真实的状态变化出发**：
 * `registry.update(id, { unread: true })` → 断言回调被触发、按钮文案变 `? ·`。
 */

/** 按钮上显示的文本。未读时多一个圆点提示（§10）。 */
export function headerButtonText(unread: unknown): string {
  return unread === true ? '? ·' : '?';
}

/** 按钮的 title（鼠标悬停提示）。未读时明确说「有新内容」。 */
export function headerButtonTitle(unread: unknown): string {
  return unread === true ? '解释小助手有新内容' : '打开解释小助手';
}

/** 只需要 subscribe / get 两个能力，便于注入真实的 AssistantRegistry 或测试替身。 */
export interface RegistryLike {
  subscribe(listener: () => void): () => void;
  get(sessionId: string): { unread?: boolean } | undefined;
}

/**
 * 订阅「**该会话自己的**」未读变化，变了才回调。
 *
 * 两个要点：
 * 1. 只在**目标会话**的 unread 真的变化时回调 —— registry 的 subscribe 是全局广播
 *    （任何会话的任何字段变化都会 emit），若不比较就会因为别的会话变动而白重渲染；
 * 2. 也因此天然满足「切换主对话后不得读到别的会话的 unread」：读的始终是传入的 sessionId。
 *
 * @returns 取消订阅函数（组件卸载时必须调用，否则泄漏）。
 */
export function watchUnread(registry: RegistryLike, sessionId: string, onChange: (unread: boolean) => void): () => void {
  if (!sessionId) return () => {};
  let last = false;
  try {
    last = registry.get(sessionId)?.unread === true;
  } catch {
    // 读初始值失败：当作「无未读」，不因此抛给组件。
    last = false;
  }
  let disposed = false;
  let unsubscribe: () => void;
  try {
    unsubscribe = registry.subscribe(() => {
      if (disposed) return;
      let next = false;
      try { next = registry.get(sessionId)?.unread === true; } catch { return; }
      if (next === last) return;   // 该会话未读没变（可能只是别的会话变了）→ 不触发
      last = next;
      onChange(next);
    });
  } catch {
    // 订阅失败不能让按钮渲染崩掉：徽标只是锦上添花，降级成「不显示徽标」。
    return () => {};
  }
  return () => {
    if (disposed) return;
    disposed = true;
    try { unsubscribe(); } catch { /* 取消订阅失败不影响卸载 */ }
  };
}
