import type * as Y from "yjs";

export function hasMissingYjsAncestors(doc: Y.Doc | null | undefined): boolean;
export const MAX_CAUSAL_REPAIR_ATTEMPTS: number;
export function causalRepairDelay(attempt: number): number;
