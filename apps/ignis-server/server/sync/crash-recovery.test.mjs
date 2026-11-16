import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { VaultSyncStore } = require("./store");
const roots = [];
const collab = {
  getActive: () => null, peekDocumentId: () => null,
  isCollaborative: () => false, checkLivePath: () => {},
  renameNote: async (_id, _from, _to, move) => move(),
  deleteNote: async (_id, _path, remove) => remove()
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignis-crash-intent-"));
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  const options = {
    dataRoot: root,
    getVaultPath: (id) => id === "vault" ? vault : null,
    collaboration: collab,
    writeCoalescer: { flushPending: async () => {} }
  };
  const handle = {
    root, vault, store: new VaultSyncStore(options),
    reopen() {
      this.store.close();
      this.store = new VaultSyncStore(options);
      return this.store;
    }
  };
  roots.push(handle);
  return handle;
}
afterEach(() => {
  for (const handle of roots.splice(0)) {
    handle.store.close();
    fs.rmSync(handle.root, { recursive: true, force: true });
  }
});

function crashAfterFileChange(store, opId) {
  const record = store._record.bind(store);
  store._record = (...args) => {
    if (args[4] === opId) throw Error("SIMULATED_CRASH_AFTER_FILESYSTEM_COMMIT");
    return record(...args);
  };
}
const payloads = {
  create: (file) => ({ type: "create", path: "note.md", content: "new contents",
    opId: "post-file-create-0001" }),
  modify: (file) => ({ type: "modify", path: "note.md",
    content: "new contents", opId: "post-file-modify-0001",
    fileId: file.fileId, generationId: file.generationId, baseHash: file.hash }),
  delete: (file) => ({ type: "delete", path: "note.md",
    opId: "post-file-delete-0001", fileId: file.fileId,
    generationId: file.generationId, baseHash: file.hash }),
  rename: (file) => ({ type: "rename", path: "note.md", toPath: "archive/note.md",
    opId: "post-file-rename-0001", fileId: file.fileId,
    generationId: file.generationId, baseHash: file.hash })
};

describe("durable Sync operation recovery across disk/SQLite commit gap", () => {
  for (const type of ["create", "modify", "delete", "rename"]) {
    it(`recovers ${type} after bytes changed but before SQLite receipt`, async () => {
      const state = fixture();
      let base = null;
      if (type !== "create") {
        fs.writeFileSync(path.join(state.vault, "note.md"), "old contents");
        base = (await state.store.scan("vault")).files[0];
      }
      const op = payloads[type](base);
      const beforeSeq = state.store.head("vault");
      crashAfterFileChange(state.store, op.opId);
      await expect(state.store.apply("vault", op)).rejects.toThrow(
        "SIMULATED_CRASH_AFTER_FILESYSTEM_COMMIT"
      );
      const recovered = state.reopen();
      const manifest = await recovered.scan("vault");
      const receipt = recovered.operationReceipt("vault", op.opId);
      expect(receipt).toMatchObject({
        opId: op.opId, type, seq: beforeSeq + 1,
        ...(base ? { fileId: base.fileId, generationId: base.generationId } : {})
      });
      expect(await recovered.apply("vault", op)).toEqual(receipt);
      expect(recovered.head("vault")).toBe(beforeSeq + 1);
      expect(recovered.changes("vault", beforeSeq).changes).toHaveLength(1);
      if (type === "delete") {
        expect(manifest.files).toHaveLength(0);
        expect(fs.existsSync(path.join(state.vault, "note.md"))).toBe(false);
      } else {
        expect(manifest.files).toHaveLength(1);
        const expectedPath = type === "rename" ? "archive/note.md" : "note.md";
        expect(manifest.files[0].path).toBe(expectedPath);
        expect(fs.readFileSync(path.join(state.vault, expectedPath), "utf8"))
          .toBe(type === "rename" ? "old contents" : "new contents");
      }
    });
  }

  it("replays a prepared create when the filesystem write was not durable", async () => {
    const state = fixture();
    const op = payloads.create(null);
    crashAfterFileChange(state.store, op.opId);
    await expect(state.store.apply("vault", op)).rejects.toThrow(
      "SIMULATED_CRASH_AFTER_FILESYSTEM_COMMIT"
    );
    fs.unlinkSync(path.join(state.vault, op.path));
    const recovered = state.reopen();
    expect((await recovered.scan("vault")).files).toHaveLength(1);
    expect(fs.readFileSync(path.join(state.vault, op.path), "utf8")).toBe(op.content);
    expect(recovered.operationReceipt("vault", op.opId)?.seq).toBe(1);
  });

  it("replays create when killed right after SQLite intent, before source inode staging", async () => {
    const state = fixture();
    const op = payloads.create(null);
    const original = state.store._stageIntent.bind(state.store);
    state.store._stageIntent = (...args) => {
      original(...args);
      if (args[1]?.opId === op.opId) {
        throw Error("SIMULATED_CRASH_AFTER_INTENT_BEFORE_INODE");
      }
    };
    await expect(state.store.apply("vault", op)).rejects.toThrow(
      "SIMULATED_CRASH_AFTER_INTENT_BEFORE_INODE"
    );
    expect(fs.existsSync(path.join(state.vault, op.path))).toBe(false);
    expect(fs.readdirSync(state.vault).some(x =>
      x.startsWith(".ignis-sync-tmp-intent-"))).toBe(false);
    const recovered = state.reopen();
    const manifest = await recovered.scan("vault");
    expect(manifest.files).toHaveLength(1);
    expect(fs.readFileSync(path.join(state.vault, op.path), "utf8"))
      .toBe(op.content);
    expect(recovered.operationReceipt("vault", op.opId)?.opId).toBe(op.opId);
  });

  it("fails closed if an unrelated writer changed the crashed operation's target", async () => {
    const state = fixture();
    const op = payloads.create(null);
    crashAfterFileChange(state.store, op.opId);
    await expect(state.store.apply("vault", op)).rejects.toThrow(
      "SIMULATED_CRASH_AFTER_FILESYSTEM_COMMIT"
    );
    fs.writeFileSync(path.join(state.vault, op.path), "unrelated draft");
    const recovered = state.reopen();
    await expect(recovered.scan("vault")).rejects.toMatchObject({
      code: "RECOVERY_BLOCKED", status: 409
    });
    expect(fs.readFileSync(path.join(state.vault, op.path), "utf8"))
      .toBe("unrelated draft");
    expect(recovered.operationReceipt("vault", op.opId)).toBe(null);
  });

  it("does not claim an unrelated inode merely because its bytes are identical", async () => {
    const state = fixture();
    const op = payloads.create(null);
    crashAfterFileChange(state.store, op.opId);
    await expect(state.store.apply("vault", op)).rejects.toThrow(
      "SIMULATED_CRASH_AFTER_FILESYSTEM_COMMIT"
    );
    // Another writer atomically replaces our target with identical bytes.
    // The content hash cannot distinguish this independent origin.
    fs.writeFileSync(path.join(state.vault, "unrelated.tmp"), op.content);
    fs.renameSync(path.join(state.vault, "unrelated.tmp"),
      path.join(state.vault, op.path));
    const recovered = state.reopen();
    await expect(recovered.scan("vault")).rejects.toMatchObject({
      code: "RECOVERY_BLOCKED", status: 409
    });
    expect(fs.readFileSync(path.join(state.vault, op.path), "utf8"))
      .toBe(op.content);
    expect(recovered.operationReceipt("vault", op.opId)).toBe(null);
  });
});
