export type Geometry = {
    x: number;
    y: number;
    width: number;
    height: number;
};
export type GeometryChange = (geometry: Geometry) => void;
export type WindowController = {
    dispose(): void;
};
export declare function clampGeometry(input: Partial<Geometry> | undefined, viewportWidth?: number, viewportHeight?: number): Geometry;
export declare function attachWindowInteractions(root: HTMLElement, handle: HTMLElement, resize: HTMLElement, initial: Geometry, onChange: GeometryChange): WindowController;
