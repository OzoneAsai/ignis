export type StorageCapacity = {
  availableBytes: number;
  reserveBytes: number;
  constrained: boolean;
};
export const MINIMUM_RESERVE_BYTES: number;
export function storageCapacityFromStatfs(
  stats: { bavail: number | bigint; bsize: number | bigint },
  reserveBytes?: number,
): StorageCapacity;
export function inspectStorageCapacity(directory: string): Promise<StorageCapacity>;
