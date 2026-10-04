import type { AssistantApi } from './api.js';
export type ClientPluginOptions = {
    api?: AssistantApi;
    session?: {
        id: string;
        cwd?: string;
    } | (() => {
        id: string;
        cwd?: string;
    } | undefined);
};
export declare function createClientPlugin(options?: ClientPluginOptions): {
    api: AssistantApi;
    registry: import("./store.js").AssistantRegistry;
    open: () => void;
    submit: (question: string) => Promise<void>;
    loadEarlier: () => Promise<void>;
    cancel: () => void;
    dispose: () => void;
    setSession: (id?: string, cwd?: string) => void;
    openHistoryDetail: (recordId: string) => Promise<void>;
    loadMoreHistoryDetail: () => Promise<void>;
    closeHistoryDetail: () => void;
    forget: (sessionId: string) => Promise<void>;
    primeUnread: (sessionId: string) => Promise<void>;
};
