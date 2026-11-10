import type * as Y from "yjs";

export type CompositionGuard = { from: number; to: number };
export type ImeSnapshot = { doc: Y.Doc; text: Y.Text };
export function beginComposition(doc: Y.Doc): ImeSnapshot;
export function publishComposition(
  live: Y.Doc, snapshot: ImeSnapshot, edited: string, origin: unknown
): boolean;
export function commitComposition(
  live: Y.Doc, snapshot: ImeSnapshot, edited: string, origin: unknown
): void;
export function independentCompositionDelta(
  delta: Array<{retain?:number;delete?:number;insert?:string}>,
  guard: CompositionGuard
): boolean;
export function projectIndependentCompositionUpdate(
  snapshot: ImeSnapshot,
  update: Uint8Array,
  guard: CompositionGuard,
  onIndependent: (
    targetText: Y.Text,
    delta: Array<{retain?:number;delete?:number;insert?:string}>
  ) => boolean
): {projected:boolean;guard:CompositionGuard;reason?:string};
export function shiftCompositionGuard(
  guard: CompositionGuard,
  delta: Array<{retain?:number;delete?:number;insert?:string}>
): CompositionGuard;
export function widenCompositionGuard(
  guard: CompositionGuard, before: string, after: string
): CompositionGuard;
