export type Geometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GeometryChange = (geometry: Geometry) => void;
export type WindowController = {
  dispose(): void;
  /** 用户此刻是否正在拖动/缩放。后到的几何值**不得**在这一刻覆盖，否则会把用户正拖的位置拽回去。 */
  isInteracting(): boolean;
  /** 按外部（宿主）给的几何值重设。仅在 `isInteracting()` 为假时使用。 */
  applyExternal(next: Geometry): void;
};

/**
 * 窗口最小尺寸。**必须与 styles.css 里 `.dsh-explain-assistant-overlay` 的
 * `min-width` / `min-height` 完全一致** —— 这里曾经是 320×360，而 CSS 是 360×420。
 *
 * 后果（页面实测抓到）：用户拖右下角时，**前 60px 完全没反应**。
 * 因为 JS 以为窗口是 380px 高、把 style.height 改成 440px，而 CSS 的 min-height:420px
 * 一直把它顶在 420px —— 这 40px 的差就是「拖了但没动」。
 * 用户对这条的定性正是「**设计不符合操作直觉**」：手动了，窗口不动。
 *
 * 漂移由 `tests/audit-0.2.1-lead.test.mjs` 的一条闸钉住（直接读 styles.css 比对）。
 */
export const MIN_WIDTH = 360;
export const MIN_HEIGHT = 420;
const GAP = 16;

function viewportSize(width?: number, height?: number): { width: number; height: number } {
  const fallbackWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const fallbackHeight = typeof window === 'undefined' ? 768 : window.innerHeight;
  return { width: width ?? fallbackWidth, height: height ?? fallbackHeight };
}

export function clampGeometry(input: Partial<Geometry> | undefined, viewportWidth?: number, viewportHeight?: number): Geometry {
  const viewport = viewportSize(viewportWidth, viewportHeight);
  const maxWidth = Math.max(100, viewport.width - GAP * 2);
  const maxHeight = Math.max(100, viewport.height - GAP * 2);
  const minWidth = Math.min(MIN_WIDTH, maxWidth);
  const minHeight = Math.min(MIN_HEIGHT, maxHeight);
  const width = Math.min(Math.max(input?.width ?? 420, minWidth), maxWidth);
  const height = Math.min(Math.max(input?.height ?? 620, minHeight), maxHeight);
  const x = Math.min(Math.max(input?.x ?? viewport.width - width - GAP, 0), Math.max(0, viewport.width - width));
  const y = Math.min(Math.max(input?.y ?? viewport.height - height - GAP, 0), Math.max(0, viewport.height - height));
  return { x, y, width, height };
}

function applyGeometry(root: HTMLElement, geometry: Geometry): void {
  root.style.left = geometry.x + 'px';
  root.style.top = geometry.y + 'px';
  root.style.width = geometry.width + 'px';
  root.style.height = geometry.height + 'px';
}

/** 八个改大小的方向。边：n/s/e/w；角：ne/nw/se/sw。 */
export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * 按方向把「鼠标位移」翻译成新几何值。
 *
 * 拆成独立函数是因为**方向写反是最容易犯又最难靠肉眼发现的错**：
 * 拖右边时右边要跟着手走（宽度增加），拖左边时宽度增加而 **x 必须同时减小**
 * （否则整个窗口会平移而不是被拉宽）。这里逐方向写清，并由测试钉住。
 */
export function resizeByDirection(start: Geometry, direction: ResizeDirection, dx: number, dy: number): Geometry {
  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 768 : window.innerHeight;
  // 四条边各自独立，先全部算出来，再只夹「被拖的那条边」。
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (direction.includes('e')) right = start.x + start.width + dx;
  if (direction.includes('w')) left = start.x + dx;
  if (direction.includes('s')) bottom = start.y + start.height + dy;
  if (direction.includes('n')) top = start.y + dy;
  // ── 关键：夹的是**尺寸**，不是位置 ──────────────────────────────────
  //
  // 早先这里是先 `clampGeometry({x: start.x, ...})` 再反推 —— 那样在窗口快要超出视口时，
  // clamp 会去改 **x**，于是「拖右边」把整个窗口一起往左拽。
  // 页面实测抓到：拖右边 +80px，宽度确实 420→500，但 x 也从 847 变成 783（左移 64px）——
  // 用户看到的是「窗口一边变宽一边乱跑」，完全不符合拖边的手感。
  //
  // 正确做法：**没被拖的那条边绝对不动**，只把被拖的边夹在合法范围内。
  // 这样拖右边只会改宽度，拖左边只会改左边（右边钉住），四个角同理。
  if (direction.includes('e')) right = Math.min(Math.max(right, left + MIN_WIDTH), Math.max(left + MIN_WIDTH, vw - GAP));
  if (direction.includes('w')) left = Math.max(Math.min(left, right - MIN_WIDTH), 0);
  if (direction.includes('s')) bottom = Math.min(Math.max(bottom, top + MIN_HEIGHT), Math.max(top + MIN_HEIGHT, vh - GAP));
  if (direction.includes('n')) top = Math.max(Math.min(top, bottom - MIN_HEIGHT), 0);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

type ResizeZone = { element: HTMLElement; direction: ResizeDirection };

/** 当前调用顺序：`(root, handle, initial, onChange, resizeZones?)`。 */
export function attachWindowInteractions(root: HTMLElement, handle: HTMLElement, initial: Geometry, onChange: GeometryChange, resizeZones?: ResizeZone[]): WindowController;
/** 旧调用顺序：`(root, handle, resize, initial, onChange)`。保留以兼容既有调用方（如 tests/client.test.mjs）。 */
export function attachWindowInteractions(root: HTMLElement, handle: HTMLElement, resize: HTMLElement, initial: Geometry, onChange: GeometryChange): WindowController;
export function attachWindowInteractions(
  root: HTMLElement,
  handle: HTMLElement,
  third: Geometry | HTMLElement,
  fourth: GeometryChange | Geometry,
  fifth?: ResizeZone[] | GeometryChange,
): WindowController {
  // 两种顺序都认：第三个参数是**元素**（有 addEventListener）就是旧顺序，否则是新顺序。
  // 为什么要兼容而不是去改那个测试：签名是**我**改的，打破既有调用方是我的责任；
  // 改别人的测试会让「测试为什么变」这件事失去独立见证。
  const isElement = (value: unknown): value is HTMLElement =>
    Boolean(value) && typeof value === 'object' && typeof (value as { addEventListener?: unknown }).addEventListener === 'function';
  const initial = (isElement(third) ? fourth : third) as Geometry;
  const onChange = (isElement(third) ? fifth : fourth) as GeometryChange;
  const resizeZones: ResizeZone[] = (isElement(third) ? [] : (fifth as ResizeZone[] | undefined)) ?? [];
  let geometry = { ...initial };
  let mode: 'drag' | 'resize' | undefined;
  let direction: ResizeDirection | undefined;
  let pointerId: number | undefined;
  let startX = 0;
  let startY = 0;
  let startGeometry = { ...geometry };
  let disposed = false;

  /**
   * 外部（宿主读回来的）几何值：同步内部状态并落到 DOM。
   *
   * 为什么必须有这个入口：浮窗**创建那一刻** `state.geometry` 往往还没到
   * （首次打开时 `/state` 是异步的），于是先按默认值渲染；等几何值回来了，
   * `updateOverlay` 只重画内容、**不重设位置** —— 于是「整页重载后首次打开」
   * 永远停在默认位置，必须关闭重开（重新走一遍创建）才生效。
   * 实测（verify-3082）：硬重载后首次打开 `(600,16) 420x526`，关闭重开才 `(220,32) 620x526`。
   */
  const applyExternalGeometry = (next: Geometry): void => {
    geometry = { ...next };
    startGeometry = { ...next };
    applyGeometry(root, geometry);
  };

  const finish = (commit: boolean): void => {
    if (!mode) return;
    const finalGeometry = { ...geometry };
    mode = undefined;
    direction = undefined;
    pointerId = undefined;
    root.removeAttribute('data-resizing');
    if (commit && !disposed) onChange(finalGeometry);
  };

  const begin = (kind: 'drag' | 'resize', event: PointerEvent, dir?: ResizeDirection): void => {
    if (disposed || event.button !== 0) return;
    mode = kind;
    direction = dir;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startGeometry = { ...geometry };
    try { (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId); } catch { /* no-op */ }
    // 改大小期间给整个浮窗加标记：CSS 据此画出边框反馈（拖动时看得见「正在改」）。
    if (kind === 'resize') root.setAttribute('data-resizing', 'true');
    event.preventDefault();
  };

  const onDragStart = (event: PointerEvent): void => {
    const target = event.target instanceof Element ? event.target : undefined;
    if (target?.closest('button, input, textarea, select, a')) return;
    begin('drag', event);
  };

  const onMove = (event: PointerEvent): void => {
    if (disposed || !mode || pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    geometry = mode === 'drag'
      ? clampGeometry({ ...startGeometry, x: startGeometry.x + dx, y: startGeometry.y + dy })
      : resizeByDirection(startGeometry, direction ?? 'se', dx, dy);
    applyGeometry(root, geometry);
  };

  const releaseCapture = (event: PointerEvent): void => {
    try { (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId); } catch { /* no-op */ }
  };
  const onEnd = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    releaseCapture(event);
    finish(true);
  };
  const onCancel = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    releaseCapture(event);
    geometry = { ...startGeometry };
    applyGeometry(root, geometry);
    finish(false);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (disposed) return;
    const active = document.activeElement;
    if (active !== handle && !handle.contains(active)) return;
    const step = event.shiftKey ? 10 : 1;
    let next: Geometry | undefined;
    if (event.key === 'ArrowLeft') next = { ...geometry, x: geometry.x - step };
    else if (event.key === 'ArrowRight') next = { ...geometry, x: geometry.x + step };
    else if (event.key === 'ArrowUp') next = { ...geometry, y: geometry.y - step };
    else if (event.key === 'ArrowDown') next = { ...geometry, y: geometry.y + step };
    else if (event.key === 'Escape' && mode) { geometry = { ...startGeometry }; applyGeometry(root, geometry); finish(false); return; }
    if (!next) return;
    event.preventDefault();
    geometry = clampGeometry(next);
    applyGeometry(root, geometry);
    onChange({ ...geometry });
  };

  handle.addEventListener('pointerdown', onDragStart);
  // 每条边/每个角各自一个监听，方向在闭包里固定 —— 这样「拖哪条边就改哪条边」。
  const zoneHandlers: Array<{ element: HTMLElement; handler: (event: PointerEvent) => void }> = [];
  for (const zone of resizeZones) {
    const handler = (event: PointerEvent): void => begin('resize', event, zone.direction);
    zoneHandlers.push({ element: zone.element, handler });
    zone.element.addEventListener('pointerdown', handler);
  }
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onEnd);
  root.addEventListener('pointercancel', onCancel);
  handle.addEventListener('keydown', onKeyDown);

  applyGeometry(root, geometry);

  return {
    isInteracting(): boolean { return mode !== undefined; },
    applyExternal(next: Geometry): void { if (!disposed) applyExternalGeometry(next); },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (pointerId !== undefined) {
        try { root.releasePointerCapture?.(pointerId); } catch { /* no-op */ }
      }
      mode = undefined;
      pointerId = undefined;
      handle.removeEventListener('pointerdown', onDragStart);
      for (const zone of zoneHandlers) zone.element.removeEventListener('pointerdown', zone.handler);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onEnd);
      root.removeEventListener('pointercancel', onCancel);
      handle.removeEventListener('keydown', onKeyDown);
    }
  };
}
