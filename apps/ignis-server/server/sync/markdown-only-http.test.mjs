import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const require = createRequire(import.meta.url);
const { VaultSyncStore } = require("./store");
const { createSyncRouter } = require("./http");
const OWNER_TOKEN = "markdown-only-isolated-admin-credential-12345";
const opened = [];

async function createIsolatedSync() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-only-md-http-"));
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  const collaboration = {
    getActive: () => null,
    peekDocumentId: () => null,
    isCollaborative: () => false,
    renameNote: async (_vault, _a, _b, action) => action(),
    deleteNote: async (_vault, _path, action) => action(),
  };
  const store = new VaultSyncStore({
    dataRoot: root,
    contentScope: "markdown-only",
    getVaultPath: (id) => id === "MarkdownTest" ? vault : null,
    collaboration,
    writeCoalescer: { flushPending: async () => {} },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/sync/v1", createSyncRouter({ store, token: OWNER_TOKEN }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  opened.push({ root, store, server });
  const base = "http://127.0.0.1:" + server.address().port + "/api/sync/v1";
  const enrolled = await fetch(base + "/admin/vaults/MarkdownTest/devices", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + OWNER_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ label: "SLS isolated Markdown client" }),
  });
  expect(enrolled.status).toBe(201);
  const { token } = await enrolled.json();
  const headers = { Authorization: "Bearer " + token };
  return { base, vault, store, headers };
}

afterEach(async () => {
  for (const item of opened.splice(0)) {
    await new Promise((resolve) => item.server.close(resolve));
    item.store.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

describe("authenticated Markdown-only Vault Sync, Syncthing disabled", () => {
  it("allows notes in both directions but refuses binary uploads", async () => {
    const { base, vault, headers, store } = await createIsolatedSync();
    fs.mkdirSync(path.join(vault, "Media"));
    fs.writeFileSync(path.join(vault, "Mac.md"), "# From Mac");
    fs.writeFileSync(path.join(vault, "Media", "secret-video.mp4"),
      Buffer.from("never-transferred-video"));
    fs.writeFileSync(path.join(vault, "Media", "photo.jpg"),
      Buffer.from("never-transferred-image"));

    const capabilities = await (await fetch(base + "/capabilities")).json();
    expect(capabilities.contentScope).toBe("markdown-only");
    expect(capabilities.supported).not.toContain("conditional-binary-4MiB");
    const session = await (await fetch(base + "/vaults/MarkdownTest/session",
      { headers })).json();
    expect(session.contentScope).toBe("markdown-only");
    const manifest = await (await fetch(base + "/vaults/MarkdownTest/manifest",
      { headers })).json();
    expect(manifest.files.map((item) => item.path)).toEqual(["Mac.md"]);
    const downloaded = await fetch(
      base + "/vaults/MarkdownTest/files/" + manifest.files[0].fileId,
      { headers },
    );
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("# From Mac");

    const content = { type: "create", path: "Media/sidecar.jpg",
      contentBase64: Buffer.from("not-shared").toString("base64"),
      opId: "excluded-binary-001" };
    const denied = await fetch(base + "/vaults/MarkdownTest/operations", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(content),
    });
    expect(denied.status).toBe(409);
    expect((await denied.json()).code).toBe("OUT_OF_SCOPE");

    const created = await fetch(base + "/vaults/MarkdownTest/operations", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "create", path: "SLS-response.md",
        content: "# From SLS", opId: "markdown-create-001" }),
    });
    expect(created.status).toBe(200);
    expect(fs.readFileSync(path.join(vault, "SLS-response.md"), "utf8"))
      .toBe("# From SLS");
    expect(fs.existsSync(path.join(vault, "Media", "sidecar.jpg"))).toBe(false);
    expect(fs.existsSync(path.join(vault, "Media", "secret-video.mp4"))).toBe(true);

    const events = await (await fetch(
      base + "/vaults/MarkdownTest/changes?since=0&limit=200", { headers },
    )).json();
    expect(events.changes.map((entry) => entry.path))
      .toEqual(["Mac.md", "SLS-response.md"]);
    expect(events.changes.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(store.contentScopeFor("MarkdownTest")).toBe("markdown-only");
  });
});
