/**
 * 「浮窗什么时候才允许出现」——打开浮窗的可测判据。
 *
 * ── 要消掉的现象（t3 在真实 3082 上实测的改前基线）────────────────────
 * 点击「?」后 **+62.7ms** 浮窗就带着初始空值画出来了（「还没有选择模型」「共 0 个可选」
 * 「还没有小助手历史」「占用未知」，几何也还是默认值 1004,264 420x620），
 * 要到 **+391.5ms**（/state 回来那一刻）才换成正确内容与正确几何。
 * 也就是说：用户先看到一个「像坏了」的半成品，再看到它整体跳一下变成对的。
 *
 * ── 本轮的解法：延后挂载 ──────────────────────────────────────────
 * 浮窗**根本不出现在页面上**，直到 /state 有结局（成功或失败）。
 * 第一次出现时就已经在最终几何上、内容也已经是真实内容 ——
 * 从「不可见」到「可见」只有一次，中间没有任何半成品形态，
 * 也就没有「先错后对」的跳变可言。
 *
 * 与上一版（先画加载页、再原地重画成内容）的区别值得写下来：
 * 那条路必须在浮窗里画一个「加载页」，而加载页本身仍是一次「先看到空的、再看到满的」。
 * 用户的原话是「模型列表是空的，没有上下文等等，过了一会才加载出正确的信息」——
 * 延后挂载直接让这段窗口不存在。
 *
 * ── 为什么把判断抽成纯函数 ────────────────────────────────────────
 * 这是「渲染函数看着对、但没人触发它重渲染」那类缺陷的高发点（见 header-badge.ts 的同类说明）。
 * 抽出来之后，判断本身可以被逐条断言，而不必先把整棵浮窗渲出来。
 */

/** 入口按钮是否处于「正在打开」的忙碌态 —— 这是浮窗之外唯一的即时反馈载体。 */
export function isOpening(state: { open?: boolean; stateReady?: boolean } | undefined): boolean {
  return state?.open === true && state?.stateReady === false;
}

/**
 * 忙碌态在按钮上长什么样。
 *
 * 用「…」而不是转圈字符：入口按钮本身很窄，追加的必须是一眼能看懂、
 * 且不会被误读成「按钮坏了」的符号。title 同步说明正在做什么。
 */
export function openingLabel(opening: boolean): string {
  return opening ? ' …' : '';
}

export function openingTitle(): string {
  return '正在打开解释小助手，正在读取当前状态…';
}

export type OverlayVisibilityInput = {
  /** 用户是否已经点开了浮窗（意图）。 */
  open?: boolean;
  /** 该会话的 /state 是否已有结局；false = 未就绪。 */
  stateReady?: boolean | undefined;
  /**
   * 浮窗**此刻**是否已经可见（由宿主 DOM 实时读出，不是推断）。
   *
   * 这条是给「浮窗已可见时切到另一个尚未就绪的会话」用的：那种情形下
   * **绝不能**把已经可见的浮窗藏起来（用户看到的是闪一下、跳一下），
   * 所以即使新会话未就绪也保持挂载（由加载页兜底）。
   */
  currentlyVisible?: boolean;
};

/**
 * 现在该不该把浮窗挂到页面上。
 *
 * 判定顺序即优先级：
 * 1. 用户没点开 → 不挂载；
 * 2. **已就绪** → 挂载（第一帧就是最终几何 + 真实内容）；
 * 3. 未就绪但浮窗**已经可见**（切会话）→ 保持挂载，不藏起来；
 * 4. 其余（首次打开且未就绪）→ **不挂载**，等 /state 的结局。
 *
 * 关于第 2 条里的 `!== false`（而不是 `=== true`）：
 * 真实 registry 里的 stateReady 恒为布尔值（store 的 initial() 给了 false，
 * 只有 /state 的两种结局会改写它），所以真实路径上行为完全等价。
 * 写成 `!== false` 是为了让**手工构造的状态对象**（既有几十条单测直接传字面量）
 * 保持原行为，不被这次改动连带影响。
 */
export function shouldMountOverlay(input: OverlayVisibilityInput): boolean {
  if (input.open !== true) return false;
  if (input.stateReady !== false) return true;
  return input.currentlyVisible === true;
}

/** 订阅「**该会话自己的**打开中状态」变化，只在真的翻转时回调（与 header-badge 的 watchUnread 同一套模式）。 */
export function watchOpening(
  registry: { subscribe(listener: () => void): () => void; get(sessionId: string): { open?: boolean; stateReady?: boolean } | undefined },
  sessionId: string,
  onChange: (opening: boolean) => void,
): () => void {
  if (!sessionId) return () => {};
  let last = false;
  try { last = isOpening(registry.get(sessionId)); } catch { last = false; }
  let disposed = false;
  let unsubscribe: () => void;
  try {
    unsubscribe = registry.subscribe(() => {
      if (disposed) return;
      let next = false;
      try { next = isOpening(registry.get(sessionId)); } catch { return; }
      if (next === last) return;   // 该会话「打开中」没变（可能只是别的会话变了）→ 不触发
      last = next;
      onChange(next);
    });
  } catch {
    // 订阅失败不能让按钮渲染崩掉：忙碌态只是反馈，降级成「不显示」。
    return () => {};
  }
  return () => {
    if (disposed) return;
    disposed = true;
    try { unsubscribe(); } catch { /* 取消订阅失败不影响卸载 */ }
  };
}
