import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { classifyDocumentAncestry } from "./collaboration-ancestry.js";

function decide(overrides = {}) {
  return classifyDocumentAncestry({
    hasLocalCopy: true,
    localDocumentId: null,
    incomingDocumentId: "server-generation",
    localText: "local text",
    incomingText: "server text",
    ...overrides,
  });
}

describe("Web, native Connector, and mobile Web source ancestry", () => {
  it("requires shared server identity before Yjs histories are allowed to merge", () => {
    expect(decide({ localDocumentId: "server-generation" })).toBe("shared");
    expect(decide({ localDocumentId: "previous-generation" })).toBe("replaced");
    expect(decide({ hasLocalCopy: false })).toBe("shared");
    expect(decide()).toBe("independent");
  });
  it("cannot merge independently created notes even when the text is identical", () => {
    const source = new Y.Doc();
    const server = new Y.Doc();
    source.getText("content").insert(0, "identical visible text");
    server.getText("content").insert(0, "identical visible text");
    // This represents the original mistake: equal strings have different
    // Yjs struct IDs, so applying both histories doubles the visible text.
    const invalidMerge = new Y.Doc();
    Y.applyUpdate(invalidMerge, Y.encodeStateAsUpdate(source));
    Y.applyUpdate(invalidMerge, Y.encodeStateAsUpdate(server));
    expect(invalidMerge.getText("content").toString()).toBe(
      "identical visible text".repeat(2)
    );
    expect(decide({ localText: "identical visible text",
      incomingText: "identical visible text" })).toBe("adopt-identical");
    source.destroy(); server.destroy(); invalidMerge.destroy();
  });
  it("protects differing offline originals, including an empty server file", () => {
    expect(decide({ incomingText: "" })).toBe("independent");
    expect(decide({ localText: "", incomingText: "server note" })).toBe("independent");
    expect(decide({ localText: "", incomingText: "" })).toBe("adopt-identical");
  });
  it("adopts an unedited empty offline note without inventing a conflict", () => {
    expect(decide({localText:"",incomingText:"filled server",
      localHasOperations:false})).toBe("shared");
    // An actual delete-to-empty Yjs lineage is not the same as never edited.
    expect(decide({localText:"",incomingText:"filled server",
      localHasOperations:true})).toBe("independent");
  });
});
