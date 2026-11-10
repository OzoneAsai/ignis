import { describe, expect, it } from "vitest";
import { effectiveContentScope, sharingSummary, formatLocalBytes } from "./sharing-settings.ts";

describe("local-only media preference", () => {
  it("applies the server-and-device intersection to allowed PDF/Office bypasses", () => {
    const docs = [{ path: "Docs/readme.md", stat: { size: 13 } },
      { path: "Docs/report.pdf", stat: { size: 1024 } },
      { path: "Docs/deck.pptx", stat: { size: 25000 } },
      { path: "Docs/cover.png", stat: { size: 800 } }];
    expect(sharingSummary(docs, "markdown-only", "markdown-only",
      [], [], ["pdf", "pptx"], ["pdf"])).toMatchObject({
        sharedFiles: 2, localOnlyFiles: 2, effectiveBypass: ["pdf"],
      });
    expect(sharingSummary(docs, "markdown-only", "follow-server",
      [], [], ["pdf", "pptx"], [])).toMatchObject({
        sharedFiles: 3, localOnlyFiles: 1,
        effectiveBypass: ["pdf", "pptx"],
      });
  });
  it("cannot widen a server Markdown-only policy", () => {
    expect(effectiveContentScope("markdown-only", "follow-server")).toBe("markdown-only");
    expect(effectiveContentScope("markdown-only", "markdown-only")).toBe("markdown-only");
    expect(effectiveContentScope("all", "markdown-only")).toBe("markdown-only");
    expect(effectiveContentScope("all", "follow-server")).toBe("all");
  });
  it("counts eligible notes, kept-local media and pending writes without reading bytes", () => {
    const files = [
      { path: "Notes/hello.md", stat: { size: 35 } },
      { path: "Media/image.png", stat: { size: 700 } },
      { path: "Media/movie.mp4", stat: { size: 6 * 1024 * 1024 } },
      { path: ".obsidian/workspace.json", stat: { size: 80 } },
    ];
    expect(sharingSummary(files, "all", "markdown-only",
      [], [{ path: "Media/image.png" }])).toMatchObject({
      sharedFiles: 1,
      localOnlyFiles: 2,
      localOnlyBytes: 700 + 6 * 1024 * 1024,
      oversizedFiles: 1,
      pendingOperations: 1,
      blockedQueued: 1,
    });
    expect(sharingSummary(files, "all", "follow-server")).toMatchObject({
      sharedFiles: 2, localOnlyFiles: 1, blockedQueued: 0,
    });
  });
  it("formats local-only storage estimates without rounding small files to zero", () => {
    expect(formatLocalBytes(0)).toBe("0 B");
    expect(formatLocalBytes(71)).toBe("71 B");
    expect(formatLocalBytes(5120)).toBe("5.0 KiB");
    expect(formatLocalBytes(2 * 1024 ** 3)).toBe("2.0 GiB");
  });
});
