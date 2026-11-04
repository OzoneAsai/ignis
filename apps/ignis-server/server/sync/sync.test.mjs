import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { VaultSyncStore, permittedPath } = require("./store");
const { secureEqual, createSyncRouter } = require("./http");
const { base32, luhn32, deviceIdFromCert, parseDiscoverySettings } = require("./discovery");

const active = [];
function testStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-sync-test-"));
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  const collab = {
    getActive: () => null,
    peekDocumentId: () => null,
    isCollaborative: () => false,
    checkLivePath: () => {},
    renameNote: async (_id, _from, _to, fn) => fn(),
    deleteNote: async (_id, _rel, fn) => fn()
  };
  const store = new VaultSyncStore({
    dataRoot: root,
    getVaultPath: (id) => id === "vault" ? vault : null,
    collaboration: collab,
    writeCoalescer: { flushPending: async () => {} }
  });
  active.push({ store, root });
  return { store, vault, root, collab };
}
afterEach(() => {
  for (const entry of active.splice(0)) {
    entry.store.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("one durable Vault change journal", () => {
  it("returns a durable operation receipt after a lost HTTP acknowledgement", async () => {
    const { store } = testStore();
    const op = { type: "create", path: "lost-ack.md",
      content: "survives", opId: "lost-ack-0001" };
    expect(store.operationReceipt("vault", op.opId)).toBe(null);
    const result = await store.apply("vault", op);
    expect(store.operationReceipt("vault", op.opId)).toEqual(result);
    expect(store.operationReceipt("vault", "never-sent-0001")).toBe(null);
    expect(() => store.operationReceipt("vault", "../bad")).toThrow();
  });
  it("refuses a huge server download before allocating the response in memory", async () => {
    const { store, vault } = testStore();
    fs.writeFileSync(path.join(vault, "huge.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    const entry = (await store.scan("vault")).files[0];
    expect(entry.size).toBe(4 * 1024 * 1024 + 1);
    await expect(store.read("vault", entry.fileId))
      .rejects.toMatchObject({ status: 413 });
  });

  it("does not follow a final-path symlink even if its contents match the old hash", async () => {
    const { store, vault, root } = testStore();
    fs.writeFileSync(path.join(vault, "secret.bin"), "same bytes");
    const entry = (await store.scan("vault")).files[0];
    const outside = path.join(root, "outside.bin");
    fs.writeFileSync(outside, "same bytes");
    fs.unlinkSync(path.join(vault, "secret.bin"));
    fs.symlinkSync(outside, path.join(vault, "secret.bin"));
    await expect(store.read("vault", entry.fileId))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
  });

  it("creates and conditionally updates binary attachments without text conversion", async () => {
    const { store } = testStore();
    // Server owns the Vault projection, including required parent folders.
    const first = Buffer.from([0, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x00]);
    const created = await store.apply("vault", {
      type: "create", path: "media/scan.png",
      contentBase64: first.toString("base64"),
      opId: "binary-0001"
    });
    expect((await store.read("vault", created.fileId)).bytes).toEqual(first);
    const changed = Buffer.from([0, 0x01, 0xfe, 0x89, 0x50, 0x4e, 0x47]);
    const updated = await store.apply("vault", {
      type: "modify", path: "media/scan.png",
      fileId: created.fileId, generationId: created.generationId,
      baseHash: created.hash, contentBase64: changed.toString("base64"),
      opId: "binary-0002"
    });
    expect(updated.generationId).toBe(created.generationId);
    expect((await store.read("vault", created.fileId)).bytes).toEqual(changed);
    expect(store.changes("vault", 0).changes.map((x) => x.type))
      .toEqual(["create", "modify"]);
    await expect(store.apply("vault", {
      type: "modify", path: "media/scan.png",
      fileId: created.fileId, generationId: created.generationId,
      baseHash: created.hash, contentBase64: first.toString("base64"),
      opId: "binary-0003"
    })).rejects.toMatchObject({ code: "BASE_MISMATCH" });
    await expect(store.apply("vault", {
      type: "create", path: "media/bad.png",
      contentBase64: "invalid!!!", opId: "binary-0004"
    })).rejects.toMatchObject({ status: 413 });
    await expect(store.apply("vault", {
      type: "create", path: "media/pretend.md",
      contentBase64: first.toString("base64"), opId: "binary-0005"
    })).rejects.toMatchObject({ status: 400 });
  });
  it("recognizes a dormant Yjs history during the first scan", async () => {
    const { store, vault, collab } = testStore();
    fs.writeFileSync(path.join(vault, "historic.md"), "saved note");
    const documentId = "11111111-1111-4111-8111-111111111111";
    collab.peekDocumentId = (_vault, name) =>
      name === "historic.md" ? documentId : null;
    const [entry] = (await store.scan("vault")).files;
    expect(entry.generationId).toBe(documentId);
    expect(await store.ensureDocumentId("vault", "historic.md", documentId))
      .toBe(documentId);
    expect(store.head("vault")).toBe(1);
  });

  it("recognizes a unique historical Yjs generation after an external rename", async () => {
    const { store, vault, collab } = testStore();
    const documentId = "22222222-2222-4222-8222-222222222222";
    let livePath = "before.md";
    collab.peekDocumentId = (_vault, name) =>
      name === livePath ? documentId : null;
    fs.writeFileSync(path.join(vault, "before.md"), "stable text");
    const [before] = (await store.scan("vault")).files;
    expect(before.generationId).toBe(documentId);
    fs.renameSync(path.join(vault, "before.md"), path.join(vault, "after.md"));
    livePath = "after.md";
    const second = await store.scan("vault");
    expect(second.files).toHaveLength(1);
    expect(second.files[0]).toMatchObject({
      path: "after.md", fileId: before.fileId, generationId: documentId
    });
    expect(store.changes("vault", 1).changes).toMatchObject([{
      type: "rename", path: "before.md", toPath: "after.md"
    }]);
  });

  it("uses one generation for a native file and its brand-new Yjs room", async () => {
    const { store, vault } = testStore();
    fs.writeFileSync(path.join(vault, "joined.md"), "initial");
    const before = await store.scan("vault");
    const original = before.files[0];
    const documentId = await store.ensureDocumentId("vault", "joined.md");
    expect(documentId).toBe(original.generationId);
    expect(store.head("vault")).toBe(1);
    const content = "initial plus shared text";
    fs.writeFileSync(path.join(vault, "joined.md"), content);
    const digest = require("node:crypto").createHash("sha256").update(content).digest("hex");
    const event = await store.recordCollaborationSave(
      "vault", "joined.md", documentId, digest, Buffer.byteLength(content)
    );
    expect(event).toMatchObject({
      seq: 2, type: "modify", generationId: original.generationId,
      fileId: original.fileId, hash: digest
    });
    expect(store.manifest("vault").files[0].generationId).toBe(documentId);
    expect(await store.recordCollaborationSave(
      "vault", "joined.md", documentId, digest, Buffer.byteLength(content)
    )).toBe(null);
    expect(store.head("vault")).toBe(2);
  });

  it("migrates an established Yjs generation instead of forking its history", async () => {
    const { store, vault } = testStore();
    fs.writeFileSync(path.join(vault, "history.md"), "historical");
    const original = (await store.scan("vault")).files[0];
    const historic = "12345678-1234-4123-8123-123456789012";
    expect(await store.ensureDocumentId("vault", "history.md", historic))
      .toBe(historic);
    const after = store.manifest("vault").files[0];
    expect(after.fileId).toBe(original.fileId);
    expect(after.generationId).toBe(historic);
    expect(store.changes("vault", 1).changes[0]).toMatchObject({
      type: "identity", generationId: historic
    });
    expect(await store.ensureDocumentId("vault", "history.md", historic))
      .toBe(historic);
    expect(store.head("vault")).toBe(2);
  });

  it("tracks stable IDs, monotonic cursors and restarts", async () => {
    const { store, vault, root } = testStore();
    fs.writeFileSync(path.join(vault, "a.md"), "original");
    let manifest = await store.scan("vault");
    const file = manifest.files[0];
    expect(file.path).toBe("a.md");
    expect(file.generationId).toMatch(/-/);
    expect(manifest.vaultSeq).toBe(1);
    const renamed = await store.apply("vault", {
      type: "rename", opId: "rename-0001", path: "a.md",
      fileId: file.fileId, generationId: file.generationId,
      baseHash: file.hash, toPath: "b.md"
    });
    expect(renamed.seq).toBe(2);
    expect(renamed.fileId).toBe(file.fileId);
    manifest = await store.scan("vault");
    expect(manifest.files[0].path).toBe("b.md");
    expect(manifest.files[0].generationId).toBe(file.generationId);
    expect(store.changes("vault", 1).changes).toHaveLength(1);
    store.close();
    active.splice(active.findIndex((x) => x.store === store), 1);
    const reopened = new VaultSyncStore({
      dataRoot: root, getVaultPath: (id) => id === "vault" ? vault : null,
      collaboration: { getActive: () => null },
      writeCoalescer: { flushPending: async () => {} }
    });
    active.push({ store: reopened, root });
    expect(reopened.manifest("vault").files[0].fileId).toBe(file.fileId);
    expect(reopened.head("vault")).toBe(2);
  });

  it("renames into a new nested folder while preserving file ID and generation", async () => {
    const { store, vault } = testStore();
    fs.writeFileSync(path.join(vault, "note.md"), "contents");
    const original = (await store.scan("vault")).files[0];
    const event = await store.apply("vault", {
      type: "rename", path: "note.md", toPath: "Archive/2026/note.md",
      opId: "rename-nested-0001", fileId: original.fileId,
      generationId: original.generationId, baseHash: original.hash
    });
    expect(event.fileId).toBe(original.fileId);
    expect(event.generationId).toBe(original.generationId);
    expect(event.toPath).toBe("Archive/2026/note.md");
    expect(fs.readFileSync(path.join(vault, "Archive/2026/note.md"), "utf8"))
      .toBe("contents");
    expect(store.manifest("vault").files).toMatchObject([{
      path: "Archive/2026/note.md", fileId: original.fileId,
      generationId: original.generationId
    }]);
    expect(await store.apply("vault", {
      type: "rename", path: "note.md", toPath: "Archive/2026/note.md",
      opId: "rename-nested-0001", fileId: original.fileId,
      generationId: original.generationId, baseHash: original.hash
    })).toEqual(event);
  });

  it("refuses modify, delete and rename when another writer saves after the Vault scan", async () => {
    for (const type of ["modify", "delete", "rename"]) {
      const { store, vault } = testStore();
      const absolute = path.join(vault, "racing.md");
      fs.writeFileSync(absolute, "original");
      const [file] = (await store.scan("vault")).files;
      let flushes = 0;
      store.writeCoalescer.flushPending = async (target) => {
        if (target === absolute && ++flushes === 2) {
          fs.writeFileSync(absolute, "a newer edit");
        }
      };
      await expect(store.apply("vault", {
        type, path: "racing.md", fileId: file.fileId,
        generationId: file.generationId, baseHash: file.hash,
        opId: "race-" + type + "-0001",
        ...(type === "modify" ? { content: "stale replacement" } : {}),
        ...(type === "rename" ? { toPath: "Archive/racing.md" } : {})
      })).rejects.toMatchObject({ code: "BASE_MISMATCH" });
      expect(fs.readFileSync(absolute, "utf8")).toBe("a newer edit");
      expect(fs.existsSync(path.join(vault, "Archive/racing.md"))).toBe(false);
      const scanned = await store.scan("vault");
      expect(scanned.files[0].fileId).toBe(file.fileId);
      expect(scanned.files[0].hash).not.toBe(file.hash);
      expect(store.operationReceipt("vault", "race-" + type + "-0001")).toBe(null);
    }
  });

  it("rejects stale writes and deduplicates opId without losing data", async () => {
    const { store, vault } = testStore();
    const op = { type: "create", path: "x.md", content: "", opId: "create-0001" };
    const result = await store.apply("vault", op);
    expect(result.seq).toBe(1);
    expect(await store.apply("vault", op)).toEqual(result);
    expect(store.head("vault")).toBe(1);
    await expect(store.apply("vault", { ...op, content: "other" }))
      .rejects.toMatchObject({ code: "OP_ID_REUSED" });
    const original = store.manifest("vault").files[0];
    fs.writeFileSync(path.join(vault, "x.md"), "external");
    await expect(store.apply("vault", {
      type: "modify", path: "x.md", fileId: original.fileId,
      generationId: original.generationId, baseHash: original.hash,
      content: "stale", opId: "modify-0001"
    })).rejects.toMatchObject({ code: "BASE_MISMATCH" });
    expect(fs.readFileSync(path.join(vault, "x.md"), "utf8")).toBe("external");
    expect(store.changes("vault", 0).changes.map((x) => x.type))
      .toEqual(["create", "modify"]);
  });

  it("keeps deletion tombstones separate from recreated generations", async () => {
    const { store } = testStore();
    const created = await store.apply("vault", {
      type: "create", path: "note.md", content: "a", opId: "create-0002"
    });
    await store.apply("vault", {
      type: "delete", path: "note.md", fileId: created.fileId,
      generationId: created.generationId, baseHash: created.hash, opId: "delete-0002"
    });
    const next = await store.apply("vault", {
      type: "create", path: "note.md", content: "b", opId: "create-0003"
    });
    expect(next.generationId).not.toBe(created.generationId);
    await expect(store.apply("vault", {
      type: "modify", path: "note.md", fileId: created.fileId,
      generationId: created.generationId, baseHash: created.hash,
      content: "old-device", opId: "modify-0003"
    })).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
  });

  it("protects hidden settings and symlink parents", async () => {
    const { store, vault, root } = testStore();
    fs.mkdirSync(path.join(vault, ".obsidian"));
    fs.writeFileSync(path.join(vault, ".obsidian", "workspace.json"), "secret");
    expect((await store.scan("vault")).files).toEqual([]);
    expect(permittedPath(".obsidian/plugins/x")).toBe(false);
    expect(permittedPath(".trash/deleted-note.md")).toBe(false);
    expect(permittedPath(".Trash/deleted-note.md")).toBe(false);
    expect(permittedPath(".OBSIDIAN/plugins/settings.json")).toBe(false);
    expect(permittedPath(".IGNIS-SYNC-TMP-evil")).toBe(false);
    fs.mkdirSync(path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), path.join(vault, "link"));
    await expect(store.apply("vault", {
      type: "create", path: "link/evil.md", content: "evil",
      opId: "create-0004"
    })).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(fs.existsSync(path.join(root, "outside", "evil.md"))).toBe(false);
  });
});

describe("Discovery and authorization primitives", () => {
  it("issues unique per-device credentials, Vault scopes and immediate revocation", () => {
    const { store, root, vault } = testStore();
    const one = store.enrollDevice("vault", "iPhone");
    const two = store.enrollDevice("vault", "MacBook");
    expect(one.deviceId).not.toBe(two.deviceId);
    expect(one.token).toMatch(/^ignis_dev_[A-Za-z0-9_-]{43}$/);
    expect(one.token).not.toBe(two.token);
    expect(store.authenticateDevice(one.token, "vault")).toMatchObject({
      deviceId: one.deviceId, vaultId: "vault", label: "iPhone"
    });
    expect(store.authenticateDevice(one.token, "other")).toBe(null);
    expect(store.authenticateDevice("a".repeat(8000), "vault")).toBe(null);
    expect(store.authenticateDevice(two.token, "vault")?.deviceId).toBe(two.deviceId);
    expect(JSON.stringify(store.listDevices("vault"))).not.toContain("ignis_dev_");
    expect(store.listDevices("vault")).toHaveLength(2);
    expect(store.listDevices("vault")[0].revokedAt).toBe(null);
    let revocations = 0;
    const detach = store.onRevoke((id) => {
      expect(id).toBe(one.deviceId);
      revocations++;
    });
    expect(store.revokeDevice(one.deviceId)).toBe(true);
    expect(revocations).toBe(1);
    detach();
    expect(store.authenticateDevice(one.token, "vault")).toBe(null);
    expect(store.deviceActive(one.deviceId, "vault")).toBe(false);
    expect(store.authenticateDevice(two.token, "vault")?.deviceId).toBe(two.deviceId);
    const meta = store.listDevices("vault").find((item) => item.deviceId === one.deviceId);
    expect(typeof meta.revokedAt).toBe("number");
    expect(meta.token).toBeUndefined();
    expect(meta.tokenHash).toBeUndefined();
    expect(() => store.enrollDevice("vault", "bad\nlabel"))
      .toThrow(/label/);
    expect(() => store.enrollDevice("missing", "Another device"))
      .toThrow(/not found/i);

    store.close();
    active.splice(active.findIndex((item) => item.store === store), 1);
    const reopened = new VaultSyncStore({
      dataRoot: root, getVaultPath: (id) => id === "vault" ? vault : null,
      collaboration: { getActive: () => null },
      writeCoalescer: { flushPending: async () => {} }
    });
    active.push({ store: reopened, root });
    expect(reopened.authenticateDevice(one.token, "vault")).toBe(null);
    expect(reopened.authenticateDevice(two.token, "vault")?.deviceId).toBe(two.deviceId);
    expect(reopened.listDevices("vault")).toHaveLength(2);
  });

  it("matches the Syncthing checksummed canonical Device ID format", () => {
    expect(base32(Buffer.alloc(32))).toHaveLength(52);
    expect(luhn32("AAAAAAAAAAAAA")).toBe("A");
    expect(parseDiscoverySettings({
      discoveryUrl: "https://disco.example/v2/",
      publicUrl: "https://ignis.example/"
    }).address).toBe("https://ignis.example:443");
    expect(() => parseDiscoverySettings({
      discoveryUrl: "http://disco.example/v2/",
      publicUrl: "https://ignis.example/"
    })).toThrow();
    expect(deviceIdFromCert).toBeTypeOf("function");
  });
  it("rejects missing and malformed credentials", () => {
    expect(secureEqual("Bearer foo", "Bearer foo")).toBe(true);
    expect(secureEqual("Bearer foo", "Bearer fo")).toBe(false);
    expect(secureEqual(undefined, "Bearer foo")).toBe(false);
    expect(() => createSyncRouter({ store: {}, token: "short" })).toThrow();
    expect(vi.isMockFunction).toBeTypeOf("function");
  });
});
