import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
const require = createRequire(import.meta.url);
const { VaultSyncStore } = require("./store");
const { createSyncRouter } = require("./http");

const TOKEN = "media-bypass-owner-123456789012345678901234";
const opened = [];
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-bypass-http-"));
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  const options = {
    dataRoot: root, contentScope: "markdown-only",
    getVaultPath: (id) => id === "DocVault" ? vault : null,
    collaboration: { getActive: () => null, peekDocumentId: () => null },
    writeCoalescer: { flushPending: async () => {} },
  };
  const store = new VaultSyncStore(options);
  const app = express();
  app.use(express.json());
  app.use("/api/sync/v1", createSyncRouter({ store, token: TOKEN }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port + "/api/sync/v1";
  const admin = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };
  opened.push({ root, server, store });
  return { root, vault, store, options, base, admin };
}
afterEach(async () => {
  for (const { root, server, store } of opened.splice(0)) {
    await new Promise((done) => server.close(done));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const save = (base, headers, extensions, expectedExtensions) => fetch(
  base + "/admin/vaults/DocVault/media-bypass", {
    method: "PUT", headers,
    body: JSON.stringify({ extensions, expectedExtensions }),
  }
);
describe("selective media bypass with Syncthing absent", () => {
  it("does not hash or publish oversized bypass files, and never tombstones a tracked one", async () => {
    const { base, admin, store, vault } = await fixture();
    expect((await save(base, admin, ["pdf"], [])).status).toBe(200);
    const pdfPath = path.join(vault, "presentation.pdf");
    fs.writeFileSync(pdfPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x41));
    const url = base + "/vaults/DocVault/manifest";
    const token = store.enrollDevice("DocVault", "SLS").token;
    const headers = { Authorization: "Bearer " + token };
    const first = await fetch(url, { headers });
    expect(first.status).toBe(200);
    expect((await first.json()).files).toEqual([]);
    expect(store.head("DocVault")).toBe(0);
    fs.writeFileSync(pdfPath, "%PDF-1.4 small PDF");
    const published = await fetch(url, { headers });
    expect(published.status).toBe(200);
    expect((await published.json()).files.map((file) => file.path))
      .toEqual(["presentation.pdf"]);
    expect(store.head("DocVault")).toBe(1);

    // A newly oversized version is not a remote delete. The journal should
    // remain unchanged until the local file fits the protocol again.
    fs.writeFileSync(pdfPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x42));
    const paused = await fetch(url, { headers });
    expect(paused.status).toBe(409);
    expect((await paused.json()).code).toBe("OVERSIZE_MEDIA_BYPASS");
    expect(store.head("DocVault")).toBe(1);
    fs.writeFileSync(pdfPath, "%PDF-1.4 small PDF restored");
    const recovered = await fetch(url, { headers });
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).files.map((file) => file.path))
      .toEqual(["presentation.pdf"]);
    expect(store.head("DocVault")).toBe(2);
  });

  it("requires admin approval, persists selected types, verifies bytes and hard size cap", async () => {
    const { base, admin, store, vault, options } = await fixture();
    const url = base + "/admin/vaults/DocVault/media-bypass";
    expect((await fetch(url)).status).toBe(401);
    const bad = await save(base, admin, ["exe"], []);
    expect(bad.status).toBe(400);
    const applied = await save(base, admin, ["PDF", "docx", "xlsx", "pptx"], []);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      applied: true, extensions: ["docx", "pdf", "pptx", "xlsx"],
    });
    expect((await save(base, admin, ["pdf"], [])).status).toBe(409);
    fs.writeFileSync(path.join(vault, "report.pdf"),
      Buffer.from("%PDF-1.4\nfixture pdf bytes"));
    fs.writeFileSync(path.join(vault, "private.png"), Buffer.from("not shared"));
    const token = store.enrollDevice("DocVault", "iPhone").token;
    const headers = { Authorization: "Bearer " + token };
    const session = await (await fetch(
      base + "/vaults/DocVault/session", { headers }
    )).json();
    expect(session).toMatchObject({
      contentScope: "markdown-only",
      mediaBypassExtensions: ["docx", "pdf", "pptx", "xlsx"],
    });
    const manifest = await (await fetch(
      base + "/vaults/DocVault/manifest", { headers }
    )).json();
    expect(manifest.files.map((file) => file.path)).toEqual(["report.pdf"]);
    const pdf = await fetch(
      base + "/vaults/DocVault/files/" + manifest.files[0].fileId, { headers }
    );
    expect(pdf.status).toBe(200);
    expect(await pdf.text()).toBe("%PDF-1.4\nfixture pdf bytes");
    const blocked = await fetch(base + "/vaults/DocVault/operations", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "create", opId: "excluded-image-0001", path: "private.png",
        contentBase64: Buffer.from("unsent").toString("base64"),
      }),
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).code).toBe("OUT_OF_SCOPE");
    const tooLarge = await fetch(base + "/vaults/DocVault/operations", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "create", opId: "oversized-pdf-0001", path: "large.pdf",
        contentBase64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
      }),
    });
    expect(tooLarge.status).not.toBe(200);
    expect(fs.existsSync(path.join(vault, "large.pdf"))).toBe(false);
    expect(store.mediaBypassFor("DocVault")).toEqual(["docx", "pdf", "pptx", "xlsx"]);
    const after = new VaultSyncStore(options);
    try {
      expect(after.mediaBypassFor("DocVault")).toEqual(["docx", "pdf", "pptx", "xlsx"]);
      expect((await after.scan("DocVault")).files.map((item) => item.path))
        .toEqual(["report.pdf"]);
    } finally { after.close(); }
  });
  it("permits expanding a journaled Vault but rejects removal without migration", async () => {
    const { base, admin, store } = await fixture();
    store.enrollDevice("DocVault", "Android");
    const first = await save(base, admin, ["pdf"], []);
    expect(first.status).toBe(200);
    const expanded = await save(base, admin, ["pdf", "pptx"], ["pdf"]);
    expect(expanded.status).toBe(200);
    const removed = await save(base, admin, ["pdf"], ["pdf", "pptx"]);
    expect(removed.status).toBe(409);
    expect((await removed.json()).code).toBe("BYPASS_MIGRATION_REQUIRED");
    expect(store.mediaBypassFor("DocVault")).toEqual(["pdf", "pptx"]);
  });
});
