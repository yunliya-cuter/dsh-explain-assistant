import type { AssistantClientState } from './store.js';
import type { createClientPlugin } from './index.js';
export type OverlayProps = {
    state: AssistantClientState;
    plugin: ReturnType<typeof createClientPlugin>;
    onClose?: () => void;
};
export declare function renderOverlay(state: AssistantClientState, plugin: OverlayProps['plugin']): HTMLElement;
/** 状态变化时原地重画各区块。骨架、输入框、滚动位置都不动。 */
export declare function updateOverlay(root: HTMLElement, state: AssistantClientState, plugin: OverlayProps['plugin']): void;
