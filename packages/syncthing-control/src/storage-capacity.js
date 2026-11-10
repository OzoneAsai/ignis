const fs = require("node:fs/promises");

// A minimum reserve is not a promise that a large transfer will fit. It is
// the threshold below which a *new* full-replication pilot is not offered
// without an extra operator decision.
const MINIMUM_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;

function storageCapacityFromStatfs(stats, reserveBytes = MINIMUM_RESERVE_BYTES) {
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new Error("Invalid disk reserve");
  }
  for (const value of [stats?.bavail, stats?.bsize]) {
    if (!(typeof value === "bigint" ||
          (typeof value === "number" && Number.isSafeInteger(value)))) {
      throw new Error("Disk capacity could not be measured");
    }
  }
  let bytes;
  try {
    bytes = BigInt(stats.bavail) * BigInt(stats.bsize);
  } catch {
    throw new Error("Disk capacity could not be measured");
  }
  if (bytes < 0n) throw new Error("Disk capacity is negative");
  const availableBytes = Number(bytes > BigInt(Number.MAX_SAFE_INTEGER)
    ? BigInt(Number.MAX_SAFE_INTEGER) : bytes);
  return {
    availableBytes,
    reserveBytes,
    constrained: availableBytes < reserveBytes,
  };
}

async function inspectStorageCapacity(directory) {
  return storageCapacityFromStatfs(await fs.statfs(directory));
}

module.exports = {
  MINIMUM_RESERVE_BYTES, storageCapacityFromStatfs, inspectStorageCapacity,
};
