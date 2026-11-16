import { describe, expect, it } from "vitest";
import { SyncHttpError, isReviewableConflict, pendingDependent } from "./operation-replay.ts";

const rename = (fileId, path, toPath) => ({
  opId: fileId + "-operation", type: "rename", fileId,
  generationId: fileId + "-generation", baseHash: "abc", path, toPath
});

describe("two-connector replay dependency and refusal semantics", () => {
  it("separates file conflicts from authentication, schema and transport failures", () => {
    expect(isReviewableConflict(new SyncHttpError(409, "BASE_MISMATCH"))).toBe(true);
    expect(isReviewableConflict(new SyncHttpError(409, "CREATE_CONFLICT"))).toBe(true);
    expect(isReviewableConflict(new SyncHttpError(409, "OP_ID_REUSED"))).toBe(false);
    expect(isReviewableConflict(new SyncHttpError(409, "SCOPE_CHANGED"))).toBe(false);
    expect(isReviewableConflict(new SyncHttpError(503, "BASE_MISMATCH"))).toBe(false);
    expect(isReviewableConflict(new Error("Ignis Sync HTTP 409"))).toBe(false);
  });
  it("preserves transitive same-identity and path dependencies", () => {
    const first = rename("id-a", "A.md", "B.md");
    const second = rename("id-a", "B.md", "C.md");
    const occupant = rename("id-b", "Else.md", "B.md");
    const independent = rename("id-c", "Free.md", "AlsoFree.md");
    expect(pendingDependent(first, second)).toBe(true);
    expect(pendingDependent(first, occupant)).toBe(true);
    expect(pendingDependent(first, independent)).toBe(false);
  });
});
