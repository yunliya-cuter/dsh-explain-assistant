import { createClientPlugin } from './index.js';
import { renderOverlay, updateOverlay } from './overlay.js';
import { attachSelection } from './selection.js';
import { createArchiveWatcher } from './archive-watch.js';
import { headerButtonText, headerButtonTitle, watchUnread } from './header-badge.js';
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
        title: headerButtonTitle(unread),
        onClick: () => {
          if (!id) return;
          selectedId = id;
          lastQuestionButton = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          plugin.setSession(id, props?.cwd);
          plugin.open();
        },
      }, headerButtonText(unread));
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
      React.useEffect(() => {
        const host = hostRef.current as HTMLElement | null;
        if (!host) return undefined;
        host.replaceChildren();
        let controller: { dispose(): void } | undefined;
        let selection: { dispose(): void } | undefined;
        const current = registry.current;
        if (current?.open) {
          const element = renderOverlay(current, plugin);
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
        return () => { controller?.dispose(); selection?.dispose(); host.replaceChildren(); };
      }, [open, sessionId]);

      // 其余状态变化：原地重画。这里不再重建 DOM，所以草稿、光标、滚动位置都保得住。
      React.useEffect(() => {
        const host = hostRef.current as HTMLElement | null;
        const element = host?.firstElementChild as HTMLElement | null;
        if (!element || !state?.open) return;
        updateOverlay(element, state, plugin);
      });

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
