import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  MINIMUM_RESERVE_BYTES, storageCapacityFromStatfs,
} = require("./storage-capacity");

describe("shared low-storage preflight", () => {
  it("marks near-full Mac storage as constrained", () => {
    expect(storageCapacityFromStatfs({ bavail: 100000, bsize: 4096 }))
      .toMatchObject({ availableBytes: 409600000, constrained: true });
    expect(storageCapacityFromStatfs({
      bavail: BigInt(MINIMUM_RESERVE_BYTES / 4096), bsize: 4096n,
    })).toMatchObject({ availableBytes: MINIMUM_RESERVE_BYTES,
      constrained: false });
  });
  it("rejects invalid numbers and keeps extreme values within safe integers", () => {
    expect(() => storageCapacityFromStatfs({ bavail: null, bsize: null }))
      .toThrow("could not be measured");
    expect(() => storageCapacityFromStatfs({ bavail: -1, bsize: 4096 }))
      .toThrow("negative");
    expect(storageCapacityFromStatfs({ bavail: 10n ** 19n, bsize: 4096n })
      .availableBytes).toBe(Number.MAX_SAFE_INTEGER);
  });
});
