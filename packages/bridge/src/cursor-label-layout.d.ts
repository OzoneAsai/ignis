export type LabelRect = { left: number; top: number; right: number; bottom: number };
export type LabelAnchor = { left: number; top: number; bottom: number };
export type LabelItem = {
  key: string;
  caret: LabelAnchor;
  width: number;
  height: number;
};
export type LabelPlacement = {
  left: number;
  top: number;
  dx: number;
  dy: number;
};
export interface OverlaySpace {
  bounds: LabelRect;
  scaleX: number;
  scaleY: number;
  toLocal(rect: LabelRect): LabelRect;
}
export function createOverlaySpace(host: HTMLElement | null | undefined): OverlaySpace | null;
export function cursorLabelTextColor(background: string): "#000000" | "#ffffff";
export function cursorHighlightTint(color: string): string;
export function layoutCursorLabels(
  items: LabelItem[],
  obstacles: LabelRect[],
  bounds: LabelRect,
  previous?: ReadonlyMap<string, LabelPlacement>
): Map<string, LabelPlacement>;
export function visibleContentObstacles(
  contentDOM: Element | null | undefined,
  space: OverlaySpace | null,
  viewport: LabelRect,
  limit?: number
): LabelRect[] | null;
