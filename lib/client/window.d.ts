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
export declare const MIN_WIDTH = 360;
export declare const MIN_HEIGHT = 420;
export declare function clampGeometry(input: Partial<Geometry> | undefined, viewportWidth?: number, viewportHeight?: number): Geometry;
/** 八个改大小的方向。边：n/s/e/w；角：ne/nw/se/sw。 */
export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
/**
 * 按方向把「鼠标位移」翻译成新几何值。
 *
 * 拆成独立函数是因为**方向写反是最容易犯又最难靠肉眼发现的错**：
 * 拖右边时右边要跟着手走（宽度增加），拖左边时宽度增加而 **x 必须同时减小**
 * （否则整个窗口会平移而不是被拉宽）。这里逐方向写清，并由测试钉住。
 */
export declare function resizeByDirection(start: Geometry, direction: ResizeDirection, dx: number, dy: number): Geometry;
type ResizeZone = {
    element: HTMLElement;
    direction: ResizeDirection;
};
/** 当前调用顺序：`(root, handle, initial, onChange, resizeZones?)`。 */
export declare function attachWindowInteractions(root: HTMLElement, handle: HTMLElement, initial: Geometry, onChange: GeometryChange, resizeZones?: ResizeZone[]): WindowController;
/** 旧调用顺序：`(root, handle, resize, initial, onChange)`。保留以兼容既有调用方（如 tests/client.test.mjs）。 */
export declare function attachWindowInteractions(root: HTMLElement, handle: HTMLElement, resize: HTMLElement, initial: Geometry, onChange: GeometryChange): WindowController;
export {};
