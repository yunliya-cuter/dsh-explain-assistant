import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const cache = mkdtempSync(path.join(tmpdir(), 'explain-test-modules-'));
process.on('exit', () => rmSync(cache, { recursive: true, force: true }));
import vm from 'node:vm';
const root = path.resolve(import.meta.dirname, '../..');
export async function moduleFromSource(relative) {
  const built = await build({ entryPoints: [path.join(root, relative)], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  const file = path.join(cache, relative.replaceAll('/', '-') + '.mjs');
  writeFileSync(file, built.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}
/**
 * 条件等待：轮询直到 `predicate()` 为真，或超时后**抛错**（而不是默默继续）。
 *
 * 为什么要有这个：测试里大量的 `await new Promise(r => setTimeout(r, 80))` 是「赌异步链已经跑完」。
 * 一旦链路变长（例如 open() 里多了一次网络往返），固定等待就会偶发失败——
 * 表现为「跑 3 次绿、红、绿」这种不稳定。**把 sleep 数字调大只是把窗口推远，竞态还在。**
 *
 * 用法：`await waitFor(() => plugin.registry.get(id).compactState?.summary)`
 * 超时会抛出带最后观察值的错误，所以真出问题时测试仍然会红（不会变成假绿）。
 *
 * @param predicate 返回真值即视为就绪；返回的值会作为结果返回。
 * @param options.timeoutMs 超时上限（默认 2000ms）。
 * @param options.intervalMs 轮询间隔（默认 5ms）。
 * @param options.label 超时信息里的描述。
 */
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 5;
  const startedAt = Date.now();
  let last;
  for (;;) {
    try { last = await predicate(); } catch (error) { last = error; }
    if (last) return last;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('条件等待超时（' + timeoutMs + 'ms）' + (options.label ? '：' + options.label : '') +
        '；最后观察值 = ' + safeStringify(last));
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/** 轮询版的「把事件循环让出去」：等固定毫秒数仍会被用于纯调度场景，这里保留一个明确语义的辅助。 */
export const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 等「这条异步链跑完」：轮询直到该会话的 phase 不再处于 connecting / running。
 *
 * 这是把「`await sleep(150)` 赌链路跑完」换成条件等待的通用做法 —— 大多数
 * 「提交后等一会儿再断言」的测试真正想等的就是这件事（阶段离开进行中）。
 *
 * @param registry 客户端 registry（有 get(sessionId) 即可）。
 * @param sessionId 目标会话。
 * @param options.timeoutMs 超时上限（默认 2000ms）；超时会抛错，真失败仍会红。
 */
export async function waitSettled(registry, sessionId, options = {}) {
  return waitFor(() => {
    const phase = registry.get(sessionId)?.phase;
    return phase !== 'connecting' && phase !== 'running';
  }, { ...options, label: options.label ?? '会话阶段应离开进行中（connecting/running）' });
}

/**
 * 反向条件等待：在 `durationMs` 窗口内持续轮询，只要 `predicate()` 一旦为真就**立刻抛错**。
 *
 * 专用于「**不得发生**」这类断言，例如「晚到写入不得把已归档文件重建出来」。
 * 这种断言不能用 waitFor（我们等的正是「它永远不发生」），但也不能只等一次固定 sleep
 * 就下结论——那样窗口一过就漏判。这里在整个窗口内持续观察，任何时刻出现都算失败。
 */
export async function expectNever(predicate, options = {}) {
  const durationMs = options.durationMs ?? 300;
  const intervalMs = options.intervalMs ?? 5;
  const startedAt = Date.now();
  for (;;) {
    let value;
    try { value = await predicate(); } catch { value = undefined; }
    if (value) throw new Error('发生了不该发生的事' + (options.label ? '：' + options.label : ''));
    if (Date.now() - startedAt >= durationMs) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function safeStringify(value) {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

export async function clientVm() {
  const built = await build({ entryPoints: [path.join(root, 'src/client/entry.ts')], bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react','*.css'], logLevel: 'silent' });
  const dom = fakeDom();
  const exports = {}; const cleanups = []; const entries = []; const effects = [];
  const react = { createElement(type, props, ...children) { return { type, props: props || {}, children }; }, useEffect(effect) { effects.push(effect); }, useReducer() { return [0, () => {}]; }, useRef() { return {current:null}; } };
  const context = vm.createContext({ exports, module: { exports }, require(name) { if (name === 'react') return react; if (name.endsWith('.css')) return {}; throw Error('Unexpected external: ' + name); }, AbortController, console, Symbol, TextEncoder, TextDecoder, queueMicrotask, setTimeout, clearTimeout, document: dom.document, window: dom.window, Element: FakeElement, HTMLElement: FakeElement, crypto: globalThis.crypto, fetch: async () => new Response(JSON.stringify({ payload: { records: [] } })), Response });
  vm.runInContext(built.outputFiles[0].text, context, { filename: 'client-entry.bundle.cjs' });
  const ctx = { effect(effect) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup); }, slots: { inject(name, provider) { const result = provider(); if (result?.[Symbol.iterator]) [...result]; return () => {}; }, register(meta, component) { entries.push({ meta, component }); return () => {}; } } };
  context.module.exports.apply(ctx);
  return { entries, effects, context, react, cleanup() { cleanups.forEach(fn => fn()); dom.restore(); } };
}
export class FakeElement {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.listeners = new Map(); this.style = {}; this.dataset = {}; this.children = []; this.parentElement = null; this.ownText = ''; this.tabIndex = ['BUTTON','TEXTAREA','INPUT','SELECT','SUMMARY'].includes(this.tagName) ? 0 : -1;
    // 被从父节点上摘下来过几次。真实浏览器里，一次「摘下来再挂回去」就会丢掉滚动锚点，
    // 用户看到的是跳变 —— 而这个副作用在「元素对象还是同一个」时完全看不出来。
    // 所以这里把它变成一个可数的量，让「原地不动」这条断言真的有区分力。
    this.detachments = 0; }
  // 真实 DOM 的 textContent 会聚合所有子节点的文本。假 DOM 之前只返回自身文本，
  // 于是「按按钮文字找元素」的测试/调试永远找不到按钮，断言静默失败。
  get textContent() { return this.ownText + this.children.map(c => (c && c.textContent) || '').join(''); }
  set textContent(value) { this.ownText = value == null ? '' : String(value); this.children = []; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  matches(selector) { return selector.split(',').some(part => { const s = part.trim(); if (s.startsWith('.')) return (this.className || '').split(' ').includes(s.slice(1)); if (s.startsWith('[')) return this.attributes.has(s.slice(1, -1)); return s.toUpperCase() === this.tagName; }); }
  closest(selector) { for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el; return null; }
  // 真实 DOM 的 contains：自身或后代返回 true。
  // 夹具原先**没有**这个方法，于是 window.ts:200 的 handle.contains(active) 在测试里
  // 直接 TypeError —— 「焦点在浮窗子元素上时用方向键调整位置」这条路径因此
  // 从未被任何测试走到（task-37 的 F1：改坏它全量仍全绿）。
  // 补它是补一个**真实且 src 真的用到**的浏览器行为，不是为过测而编的规则。
  contains(other) {
    if (!other) return false
    for (let node = other; node; node = node.parentElement) if (node === this) return true
    return false
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { this.children.push(node); node.parentElement = this; return node; }
  addEventListener(name, fn, options) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); fn.capture = options === true || options?.capture === true; this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  // 真实事件带 stopPropagation / stopImmediatePropagation：§5.2 B3 要求选中时吞掉事件，
  // 假 DOM 缺这两个方法会让 selection.ts 在测试里直接 TypeError（真实浏览器不会）。
  // 同时记录 propagationStopped，测试才能断言「确实拦住了原卡片」。
  emit(name, values = {}) {
    const event = {
      target: this, currentTarget: this, defaultPrevented: false, propagationStopped: false, immediateStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      stopImmediatePropagation() { this.propagationStopped = true; this.immediateStopped = true; },
      ...values,
    };
    // 捕获阶段（第三个参数为 true）先于冒泡阶段执行，与浏览器一致。
    const ordered = [...(this.listeners.get(name) || [])].sort((a, b) => (b.capture ? 1 : 0) - (a.capture ? 1 : 0));
    for (const fn of ordered) { if (event.immediateStopped) break; fn(event); }
    return event;
  }
  // P3（task-37 报出的夹具自身缺陷）：原写法直接写 globalThis.document.activeElement。
  // 若在 dom.restore() 之后（典型场景：异步链跨过了 finally）被调用，
  // globalThis.document 已被删除 → TypeError: Cannot set properties of undefined。
  // 实测踩到过：同一进程先后建两个 fakeDom()、restore 第一个后，异步残留的 focus() 就崩。
  // 真实语义上「所属文档已不存在」时 focus 本就无事可做，所以这里**先判存在再写**。
  focus() { if (globalThis.document) globalThis.document.activeElement = this; }
  setPointerCapture(id) { this.pointerCapture = id; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  // 真实 DOM 的 cloneNode：深拷贝（含子节点、属性、ownText）。
  // 缓存层「交付克隆」需要它 —— 之前没有，于是那次「命中返回克隆」的尝试
  // 在假 DOM 里直接 TypeError（实测连锁红 9 条）。
  cloneNode(deep = false) {
    const copy = new FakeElement(this.tagName.toLowerCase())
    for (const [k, v] of this.attributes) copy.attributes.set(k, v)
    copy.className = this.className
    copy.ownText = this.ownText
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode ? child.cloneNode(true) : child)
    return copy
  }
  click() { return this.emit('click'); }
  get isConnected() { return true; }
  // 真 DOM 的 remove() 会把 parentElement 置空。假 DOM 早先只把自己从父节点的
  // children 里过滤掉、**不动自己的 parentElement** —— 于是「把节点摘下来再挂回去」
  // 这种在真实浏览器里会丢掉滚动锚点的操作，在测试里看不出任何差别
  // （证伪过：把「只换尾部」改成整棵 replaceChildren，测试照样全绿）。
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(e => e !== this);
    this.parentElement = null;
    this.detachments++;
  }
  // 浮窗改成「骨架建一次 + 各区块原地重画」后用到 replaceChildren / firstElementChild，
  // 假 DOM 必须提供，否则真实代码在测试里直接 TypeError。
  // 真 DOM 的 replaceChildren 会先把**所有**旧子节点摘下来（parentElement 置空），
  // 这里必须照做，否则「原地不动」这类断言在假 DOM 里永远成立、闸形同虚设。
  replaceChildren(...nodes) {
    for (const child of this.children) { child.parentElement = null; child.detachments++; }
    this.children = [];
    nodes.forEach(node => this.appendChild(node));
  }
  get firstElementChild() { return this.children.find(c => !String(c.tagName || '').startsWith('#')) ?? null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) { return this.children.flatMap(c => [ ...(c.matches?.(selector) ? [c] : []), ...(c.querySelectorAll?.(selector) || []) ]); }
}
export function fakeDom() {
  const previous = { document: globalThis.document, window: globalThis.window, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement };
  const document = new FakeElement('document'); document.activeElement = null; document.head = new FakeElement('head'); document.createElement = tag => new FakeElement(tag);
  // 真实 document 支持自定义事件（selection 模式用它做「选中一条依据」的通知）。
  // 假 DOM 缺 dispatchEvent 会让 overlay 的 enterSelectionMode 直接 TypeError。
  document.dispatchEvent = event => document.emit(event?.type || String(event), { detail: event?.detail });
  // SVG 需要 createElementNS：占用圆环用它创建 <svg>/<circle>（§9.2）。
  document.createElementNS = (_ns, tag) => new FakeElement(tag);
  document.getSelection = () => null;
  document.createTextNode = text => { const e = new FakeElement('#text'); e.textContent = text; return e; };
  const window = new FakeElement('window'); window.innerWidth = 1024; window.innerHeight = 768;
  Object.assign(globalThis, { document, window, Element: FakeElement, HTMLElement: FakeElement });
  return { document, window, restore() { for (const [k,v] of Object.entries(previous)) if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } };
}
export function sse(type, payload = {}, extra = {}) { return 'event: ' + type + '\ndata: ' + JSON.stringify({ schemaVersion: 1, sessionId: 'session-a', requestId: 'request-a', operation: 'ask', type, payload, ...extra }) + '\n\n'; }
export function streamResponse(value, chunks = [1, 3, 11, 27]) { const bytes = new TextEncoder().encode(value); return new Response(new ReadableStream({ start(c) { let from = 0; for (const size of chunks) { c.enqueue(bytes.slice(from, from + size)); from += size; } c.enqueue(bytes.slice(from)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }); }