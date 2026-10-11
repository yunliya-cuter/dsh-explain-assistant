import { createClientPlugin } from './index.js';
import { renderOverlay, updateOverlay } from './overlay.js';
import { readAppliedGeometry } from './window.js';
import { attachSelection } from './selection.js';
import { createArchiveWatcher } from './archive-watch.js';
import { headerButtonText, headerButtonTitle, watchUnread } from './header-badge.js';
import { shouldMountOverlay, isOpening, watchOpening, openingLabel, openingTitle } from './open-gate.js';
import css from './styles.css';

let React: any = null;
try {
  React = require('react');
} catch {
  React = null;
}
/**
 * §4/§8 F6：额外注入 `workspaces`（@deepseek-ai/dsh-api-workspace-controller 的 client 服务）。
 *
 * 为什么需要它：归档集合 `WorkspaceSnapshot.archivedSessionIds` 是这个服务下发的，
 * 拿到它才能在「归档那一刻」清理记录。
 * 服务**可选**：拿不到时必须静默降级（周期检查仍是兜底），不能让插件加载失败。
 */
export const inject = ['slots', 'workspaces'];

export function apply(ctx: any): void {
  if (typeof document === 'undefined' || !React ||
      typeof React.createElement !== 'function' ||
      typeof React.useEffect !== 'function' ||
      typeof React.useReducer !== 'function' ||
      typeof React.useRef !== 'function') return;
  const run = () => {
    try {
    let selectedId: string | undefined;
    let lastQuestionButton: HTMLElement | null = null;
    const plugin = createClientPlugin({ session: () => selectedId ? { id: selectedId } : undefined });
    const registry = plugin.registry;
    if (!ctx.slots) return () => plugin.dispose();
    const style = document.createElement('style');
    style.dataset.dshExplainAssistant = 'styles';
    style.textContent = css;
    document.head.appendChild(style);

    const HeaderButton = (props: any) => {
      const id = typeof props?.sessionId === 'string' ? props.sessionId : undefined;
      /**
       * §4/§8/§10：未读徽标必须**随状态变化重渲染**。
       *
       * 缺陷（verify-3082 在 3082 页面上实测）：宿主明明下发 unread:true，按钮却始终是「?」。
       * 根因是这里**只读 registry 却不订阅**——唯一的订阅在 OverlayBridge，而那只重渲染
       * 浮窗那棵树；header 按钮是另一处独立的 slot 注册，所以 registry.update 改了数据
       * 也没有东西通知它重画。数据在、按钮不刷新。
       *
       * 修法：与 OverlayBridge 同样的订阅模式，只订阅**本会话自己的** unread 变化，
       * 卸载时取消订阅（避免泄漏）。
       */
      const [, bumpBadge] = React.useReducer((value: number) => value + 1, 0);
      React.useEffect(() => {
        if (!id) return undefined;
        return watchUnread(registry, id, () => bumpBadge());
      }, [id]);
      /**
       * 「正在打开」的忙碌态 —— 本轮引入的唯一即时反馈载体。
       *
       * 为什么需要它：浮窗现在要等 /state 有结局才出现。正常宿主下这是几十毫秒（察觉不到），
       * 但慢宿主（t4 用 --slow-state 把 /state 拖到 5 秒）下，用户点完「?」会**什么都没有发生**——
       * 浮窗不出现、按钮也不变。那不是「没有半成品」，那是让人以为点击没生效。
       *
       * 契约把这条路堵死了：反馈载体**只能是浮窗之外**的元素，不得靠弹浮窗来实现反馈。
       * 所以忙碌态就落在入口按钮自己身上（文案 + title + aria-busy）。
       * 订阅方式与 watchUnread 一致：只订阅**本会话自己**的「打开中」翻转，卸载时取消。
       */
      const [opening, setOpening] = React.useState(() => (id ? isOpening(registry.get(id)) : false));
      React.useEffect(() => {
        if (!id) return undefined;
        setOpening(isOpening(registry.get(id)));
        return watchOpening(registry, id, setOpening);
      }, [id]);
      /**
       * §4/§10 冷启动预取未读。
       *
       * 缺陷（verify-3082 在 3082 上实测）：**硬刷新后**按钮一直是「?」，即使宿主 unread=true；
       * 必须先点开一次浮窗（那会触发 /state）才变成「? ·」。用户刷新后看不到「有新内容」。
       *
       * 修法：按钮挂载时找 plugin 预取一次该会话的 unread。预取**按会话去重**
       * （plugin 内部复用同一个 in-flight Promise），所以同一会话挂多个订阅者也只打一次接口。
       * 拿不到就降级成「?」——预取失败不影响渲染。
       */
      React.useEffect(() => {
        if (!id) return undefined;
        void plugin.primeUnread?.(id);
        return undefined;
      }, [id]);
      React.useEffect(() => {
        if (!id) return undefined;
        selectedId = id;
        plugin.setSession(id, props?.cwd);
        return () => {
          if (selectedId === id) {
            selectedId = undefined;
            registry.setCurrent(undefined);
          }
        };
      }, [id]);
      const state = id ? registry.get(id) : undefined;
      const unread = state?.unread === true;
      return h('button', {
        type: 'button',
        'aria-label': '打开解释小助手',
        'aria-busy': opening ? 'true' : undefined,
        'data-opening': opening ? 'true' : undefined,
        title: opening ? openingTitle() : headerButtonTitle(unread),
        onClick: () => {
          if (!id) return;
          selectedId = id;
          lastQuestionButton = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          plugin.setSession(id, props?.cwd);
          plugin.open();
        },
      }, headerButtonText(unread) + openingLabel(opening));
    };

    const h = React.createElement;
    const OverlayBridge = () => {
      const hostRef = React.useRef(null);
      const [, bump] = React.useReducer((value: number) => value + 1, 0);
      React.useEffect(() => registry.subscribe(() => bump()), []);
      React.useEffect(() => {
        const onSelected = (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          if (detail.sessionId !== registry.currentSessionId) return;
          registry.update(detail.sessionId, { error: undefined });
        };
        document.addEventListener('dsh-explain-assistant:evidence-selected', onSelected);
        return () => document.removeEventListener('dsh-explain-assistant:evidence-selected', onSelected);
      }, []);
      const state = registry.current;

      // 骨架只建一次：状态变化走 updateOverlay 原地重画各区块。
      // 上一版每次状态变化都 host.replaceChildren() 重建整棵 DOM，后果是
      // 打字时输入框被换成新节点、光标被顶到末尾，滚动位置也被重置——
      // 这正是「几乎不可用」的一部分。现在只有 open / session 变化才重建骨架。
      const sessionId = state?.sessionId;
      const open = state?.open;
      /**
       * ── 延后挂载（t4 的核心）──────────────────────────────────────────
       *
       * 浮窗**不**在「用户点开」那一刻就挂出来，而是等 /state 有结局（成功或失败）。
       * 于是它第一次出现在页面上时就已经是最终形态：最终几何 + 真实内容。
       * 从不可见到可见只有一次，中间没有「空列表 → 正确内容」的半成品形态，
       * 也就没有那 62.7ms→391.5ms 的错值窗口。
       *
       * 三个必须守住的边界（都在 shouldMountOverlay 里，并有单测）：
       * 1. **必须等出结局**：/state 失败或超时也算结局 —— 那时浮窗要出现并显示
       *    明确的中文错误 + 重试入口。否则用户点完什么都没发生（= 卡死），
       *    比错值更糟。失败结局由 applyStateFailure 置 stateReady 保证。
       * 2. **不空白**：等待期间入口按钮自己进入忙碌态（见 HeaderButton），
       *    这是契约指定的反馈载体（反馈不得靠弹浮窗实现）。
       * 3. **切会话不藏窗**：浮窗已经可见时切到另一个尚未就绪的会话，
       *    不得把它藏起来再弹出来（那是闪跳）。此时保持挂载，由加载页兜底。
       */
      /**
       * 浮窗「上一次出现在屏幕上时」的实际几何。
       *
       * 存在的理由见下面 effect 里的长注释：切会话时 effect 会重新执行，
       * 而 React 先跑清理函数（那句 replaceChildren 已经把旧浮窗摘掉了），
       * 所以新的函数体里**读不到**旧几何，只能靠清理那一刻存下来的值。
       */
      const lastGeometryRef = React.useRef(null);
      const stateReady = state?.stateReady;
      // 「浮窗此刻是否已经在页面上」**实时读 DOM**（不是推断、不是记一个 ref）：
      // 这正是「切会话不得把已可见的浮窗藏起来」那条判据需要的事实依据。
      // 首帧 hostRef 还没挂上 → 读出 false，正确。
      const currentlyVisible = Boolean((hostRef.current as HTMLElement | null)?.firstElementChild);
      const shouldMount = sessionId
        ? shouldMountOverlay({ open, stateReady, currentlyVisible })
        : false;
      React.useEffect(() => {
        const host = hostRef.current as HTMLElement | null;
        if (!host) return undefined;
        /*
         * 上一帧浮窗的实际几何，供本帧重建时沿用。
         *
         * ⚠️ 这里**不能**读 host.firstElementChild —— 实测过，读到的是 null。
         * React 的执行顺序是：先跑**上一个 effect 的清理函数**，再跑新的 effect 函数体；
         * 而清理函数里就有一句 host.replaceChildren()（把旧浮窗摘掉）。
         * 于是等这个函数体执行时，host 已经是空的，读出来永远是 undefined →
         * 加载页照样退回默认几何（t8 的 F-A 原样复现，实测 distinctRects 仍是 1004,264,420x620）。
         *
         * 正确的位置是**清理函数里、摘除之前**：那一刻旧浮窗还在 DOM 上，
         * 读到的就是用户此刻真正看到的几何。读完暂存在 ref 里给下一次重建用。
         * 首次挂载时清理函数从未跑过 → ref 为 undefined → 仍落默认值（A2 要的那一种）。
         */
        const previousGeometry = lastGeometryRef.current;
        host.replaceChildren();
        let controller: { dispose(): void } | undefined;
        let selection: { dispose(): void } | undefined;
        const current = registry.current;
        if (shouldMount && current?.open) {
          const element = renderOverlay(current, plugin, previousGeometry);
          host.appendChild(element);
          const onSelectMode = () => {
            selection?.dispose();
            const boundSession = current.sessionId;
            selection = attachSelection(document, boundSession, (item) => {
              // §8 切换主对话不串记录：onSelect 闭包烙的是挂监听那一刻的会话。
              // 若用户开着选择模式立刻切会话，React 的 effect 清理是异步的，旧监听器
              // 可能晚一拍才 dispose；这期间一次点击会把证据写进旧会话。落证据前再确认
              // 它仍是当前会话，否则丢弃。
              if (registry.currentSessionId !== boundSession) return;
              registry.update(boundSession, state => { state.evidence = [...state.evidence.filter(existing => existing.id !== item.id), item]; });
              const detail = { sessionId: boundSession, item };
              if (typeof document.dispatchEvent === 'function') document.dispatchEvent(new CustomEvent('dsh-explain-assistant:evidence-selected', { detail }));
            });
          };
          document.addEventListener('dsh-explain-assistant:select', onSelectMode);
          controller = { dispose: () => { document.removeEventListener('dsh-explain-assistant:select', onSelectMode); selection?.dispose(); element.dispatchEvent(new Event('dsh-explain-assistant:dispose')); element.remove(); } };
        }
        return () => {
          // 摘除**之前**把这一刻的实际几何记下来 —— 这是下一次重建能「原地不动」的唯一依据。
          lastGeometryRef.current = readAppliedGeometry(host.firstElementChild as HTMLElement | null);
          controller?.dispose(); selection?.dispose(); host.replaceChildren();
        };
      }, [open, sessionId, shouldMount]);

      // 其余状态变化：原地重画。这里不再重建 DOM，所以草稿、光标、滚动位置都保得住。
      React.useEffect(() => {
        const host = hostRef.current as HTMLElement | null;
        const element = host?.firstElementChild as HTMLElement | null;
        if (!element || !state?.open || !shouldMount) return;
        updateOverlay(element, state, plugin);
      });

      /**
       * 「打开浮窗」必须触发一次 /state 读取，否则就绪标记永远不会被置位。
       *
       * 为什么需要这条：本轮的加载页**只**由 registry 的 stateReady 决定（未就绪 → 加载页），
       * 而 stateReady 只在 refreshState 的两个结局里被改写。refreshState 目前由
       * open()（点「?」按钮）与回答完成触发；若浮窗是**别的原因**打开的
       * （例如状态由外部直接置 open，或某条路径调了 registry.open 而没经过 plugin.open），
       * 界面就会一直停在加载页上 —— 那就是「无限期停在加载态」，是契约明令禁止的。
       *
       * 所以这里补一条兜底读取（ensureState），它的性质：
       * - **只在尚未就绪时发**（stateReady 为真就什么都不做，不影响既有链路的时机与顺序）；
       * - **in-flight 去重**：open() 已经为同一会话发过的那一次请求会被直接复用，
       *   所以正常路径上**不会**多打一次 /state（去重逻辑在 index.ts 的 ensureState）；
       * - **失败也有出路**：内部把失败落成「已就绪 + 中文错误 + 重试」，不抛、不静默。
       */
      React.useEffect(() => {
        if (!state?.open) return;
        const id = state.sessionId;
        if (!id) return;
        void plugin.ensureState?.(id);
      }, [open, sessionId]);

      return h('div', { ref: hostRef, 'data-shell-overlay': 'dsh-explain-assistant-overlay' });
    };

    /**
     * §4/§8 F6：订阅 DSH 的归档信号，归档那一刻清掉本插件为该会话保存的记录。
     *
     * 拿不到 workspaces 服务时**静默降级**（不抛、不影响其它功能）；周期检查仍是兜底。
     * `dispose` 时必须取消订阅，否则会泄漏。
     */
    const workspaces = (() => { try { return ctx.get?.('workspaces') ?? ctx.workspaces; } catch { return undefined; } })();
    const archiveWatcher = workspaces?.list
      ? createArchiveWatcher({
        source: workspaces.list,
        // 只对「新进入归档集合」的会话触发（幂等）；调用宿主已有的 forget 路径。
        onArchived: (sessionId) => plugin.forget(sessionId).catch(() => undefined),
        logger: (message) => console.error('[dsh-explain-assistant]', message),
      })
      : undefined;

    const removeHeader = ctx.slots.inject('conversation.session.header.utilities', () =>
      ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-explain-assistant-question', label: '解释小助手', order: 100 }, HeaderButton)
    );
    const removeOverlay = ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'dsh-explain-assistant-overlay', label: '解释小助手', order: 100 }, OverlayBridge)
    );
    return () => {
      removeHeader?.(); removeOverlay?.();
      archiveWatcher?.dispose();          // 取消归档订阅，避免泄漏
      if (lastQuestionButton) lastQuestionButton.focus();
      style.remove();
      plugin.dispose();
    };
    } catch (error) {
      console.error('[dsh-explain-assistant] client init failed', error);
      return () => undefined;
    }
  };
  ctx.effect(run);
}
