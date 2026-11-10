export const MEDIA_BYPASS_TYPES: readonly string[];
export function normalizeMediaBypassExtensions(value?: readonly string[]): readonly string[];
export function bypassesPath(relative: string, extensions: readonly string[]): boolean;
