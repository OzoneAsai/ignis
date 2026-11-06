import type * as Y from "yjs";

export type CursorSelection = { anchor: string; head: string };
export type CursorCoordinates = { anchor: number; head: number };
export type CursorPacket = {
  selections: CursorSelection[];
  mainIndex: number;
  anchor: string;
  head: string;
};
export const MAX_SHARED_SELECTIONS: number;
export const MAX_CURSOR_ENCODED_CHARS: number;
export function decodeCursorPosition(value: unknown): Uint8Array | null;
export function encodeCursorSelection(
  text: Y.Text, anchor: number, head: number
): CursorSelection | null;
export function encodeCursorSelections(
  text: Y.Text, ranges: ReadonlyArray<CursorCoordinates>, mainIndex?: number
): CursorPacket | null;
export function selectionEntries(peer: {
  anchor?: string | null;
  head?: string | null;
  selections?: CursorSelection[];
}): Array<CursorSelection | null>;
export function resolveCursorSelection(
  text: Y.Text, entry: { anchor?: string | null; head?: string | null } | null
): CursorCoordinates | null;
export function resolveCursorSelections(
  text: Y.Text, peer: { anchor?: string | null; head?: string | null;
    selections?: CursorSelection[] }
): Array<CursorCoordinates | null>;
