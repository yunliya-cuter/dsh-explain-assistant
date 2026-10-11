function initial(sessionId, cwd) {
    // stateReady 的初值**必须**是 false：这是「界面在看到真实数据之前只能显示加载页」的唯一依据。
    // 注意它是**每个会话各一份**（initial 由 AssistantRegistry.get(sessionId) 按会话构造），
    // 所以切换会话不会串用另一个会话的就绪值。
    return { sessionId, cwd, open: false, unread: false, draft: '', phase: 'idle', reasoning: '', text: '', tools: [], records: [], hasEarlier: false, loadingEarlier: false, evidence: [], occupancyKnown: false, occupancyEstimated: false, quickQuestionsDismissed: false, compactState: { status: 'idle' }, stateReady: false };
}
export class AssistantRegistry {
    states = new Map();
    listeners = new Set();
    activeSessionId;
    get(sessionId, cwd) { if (!this.states.has(sessionId))
        this.states.set(sessionId, initial(sessionId, cwd)); const state = this.states.get(sessionId); if (cwd && !state.cwd)
        state.cwd = cwd; return state; }
    get current() { return this.activeSessionId ? this.states.get(this.activeSessionId) : undefined; }
    get currentSessionId() { return this.activeSessionId; }
    setCurrent(sessionId) { if (this.activeSessionId === sessionId) {
        this.emit();
        return;
    } this.activeSessionId = sessionId; this.emit(); }
    update(sessionId, patch) { const state = this.get(sessionId); if (typeof patch === 'function')
        patch(state);
    else
        Object.assign(state, patch); this.emit(); }
    open(sessionId, cwd) { this.get(sessionId, cwd); this.activeSessionId = sessionId; this.update(sessionId, { open: true, unread: false }); }
    close(sessionId) { this.update(sessionId, { open: false }); }
    remove(sessionId) { this.states.delete(sessionId); if (this.activeSessionId === sessionId)
        this.activeSessionId = undefined; this.emit(); }
    markUnread(sessionId) { this.update(sessionId, { unread: true }); }
    sessions() { return [...this.states.values()]; }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    snapshot() { return { activeSessionId: this.activeSessionId, states: this.sessions() }; }
    emit() { for (const listener of this.listeners)
        listener(); }
}
export const assistantRegistry = new AssistantRegistry();
export function useAssistantRegistry(selector, sessionId) { return selector(sessionId ? assistantRegistry.get(sessionId) : assistantRegistry.current); }
