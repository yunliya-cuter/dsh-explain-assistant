export type Geometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GeometryChange = (geometry: Geometry) => void;
export type WindowController = { dispose(): void };

const MIN_WIDTH = 320;
const MIN_HEIGHT = 360;
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

export function attachWindowInteractions(root: HTMLElement, handle: HTMLElement, resize: HTMLElement, initial: Geometry, onChange: GeometryChange): WindowController {
  let geometry = { ...initial };
  let mode: 'drag' | 'resize' | undefined;
  let pointerId: number | undefined;
  let startX = 0;
  let startY = 0;
  let startGeometry = { ...geometry };
  let disposed = false;

  const finish = (commit: boolean): void => {
    if (!mode) return;
    const finalGeometry = { ...geometry };
    mode = undefined;
    pointerId = undefined;
    if (commit && !disposed) onChange(finalGeometry);
  };

  const begin = (kind: 'drag' | 'resize', event: PointerEvent): void => {
    if (disposed || event.button !== 0) return;
    mode = kind;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startGeometry = { ...geometry };
    try { (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId); } catch { /* no-op */ }
    event.preventDefault();
  };

  const onDragStart = (event: PointerEvent): void => {
    const target = event.target instanceof Element ? event.target : undefined;
    if (target?.closest('button, input, textarea, select, a')) return;
    begin('drag', event);
  };
  const onResizeStart = (event: PointerEvent): void => begin('resize', event);

  const onMove = (event: PointerEvent): void => {
    if (disposed || !mode || pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    geometry = mode === 'drag'
      ? clampGeometry({ ...startGeometry, x: startGeometry.x + dx, y: startGeometry.y + dy })
      : clampGeometry({ ...startGeometry, width: startGeometry.width + dx, height: startGeometry.height + dy });
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
  resize.addEventListener('pointerdown', onResizeStart);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onEnd);
  root.addEventListener('pointercancel', onCancel);
  handle.addEventListener('keydown', onKeyDown);

  applyGeometry(root, geometry);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (pointerId !== undefined) {
        try { root.releasePointerCapture?.(pointerId); } catch { /* no-op */ }
      }
      mode = undefined;
      pointerId = undefined;
      handle.removeEventListener('pointerdown', onDragStart);
      resize.removeEventListener('pointerdown', onResizeStart);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onEnd);
      root.removeEventListener('pointercancel', onCancel);
      handle.removeEventListener('keydown', onKeyDown);
    }
  };
}
