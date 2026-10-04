import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

// §8 / A14：切换主对话不串记录。
// entry.ts 的 onSelect 闭包把挂监听那一刻的 sessionId 烙死；若开着选择模式立刻切会话，
// React 的 effect 清理是异步的，旧监听器晚一拍才 dispose，这期间一次点击可能把证据写进旧会话。
// entry.ts 已在落证据前加「仅当仍是当前会话」的防线。这里直接测这条防线的判定逻辑。
const store = await moduleFromSource('src/client/store.ts');

test('防线：旧会话的迟到的选中不得写入（registry 当前已切走）', () => {
  const dom = fakeDom();
  try {
    const registry = new store.AssistantRegistry();
    // 模拟：选择模式挂在 session-old 上
    const boundSession = 'session-old';
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const card = new FakeElement('div'); card.setAttribute('data-tool', 'bash'); card.textContent = 'x';
    chat.appendChild(card); dom.document.appendChild(chat);
    // registry 当前已切到 session-new（用户切了会话，但旧监听器还没 dispose）
    registry.open('session-new');
    // 复制 entry.ts 防线：仅当仍是当前会话才落证据
    const onSelect = (item) => {
      if (registry.currentSessionId !== boundSession) return;
      registry.update(boundSession, s => { s.evidence = [...s.evidence, item]; });
    };
    onSelect({ id: 'e1', sessionId: boundSession, summary: 'x', source: 'selected_frozen', capturedAt: '', evidenceState: 'observed', version: null, truncated: false, incomplete: false });
    assert.equal(registry.get('session-old').evidence.length, 0, '当前已切走，旧会话不应收到证据');
    // 对照：若仍停在旧会话，则应正常写入
    registry.setCurrent('session-old');
    onSelect({ id: 'e2', sessionId: boundSession, summary: 'y', source: 'selected_frozen', capturedAt: '', evidenceState: 'observed', version: null, truncated: false, incomplete: false });
    assert.equal(registry.get('session-old').evidence.length, 1, '仍是当前会话时应正常落证据');
  } finally { dom.restore(); }
});

test('防线：attachSelection 的 dispose 之后不再触发（异步清理兜底的第二道）', async () => {
  const dom = fakeDom();
  try {
    const selection = await moduleFromSource('src/client/selection.ts');
    const chat = new FakeElement('div'); chat.setAttribute('data-conversation-scroll', '');
    const card = new FakeElement('div'); card.setAttribute('data-tool', 'bash');
    chat.appendChild(card); dom.document.appendChild(chat);
    const picked = [];
    const ctl = selection.attachSelection(dom.document, 'session-a', i => picked.push(i));
    ctl.dispose();
    dom.document.emit('click', { target: card, button: 0, clientX: 1, clientY: 1 });
    assert.equal(picked.length, 0, 'dispose 后旧监听器必须彻底失效');
  } finally { dom.restore(); }
});
