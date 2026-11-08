export type SyncContentScope = "all" | "markdown-only";
export const CONTENT_SCOPES: readonly SyncContentScope[];
export function createContentScope(
  mode?: SyncContentScope, bypassExtensions?: readonly string[]
): {
  readonly mode: SyncContentScope;
  readonly bypassExtensions: readonly string[];
  readonly allowsPath: (path: string) => boolean;
};
