# Ignis empty-server bootstrap from the only authoritative Connector

**Date:** 2026-11-10 JST. **Decision:** production deployment remains paused. This acceptance exercises a genuinely empty local Ignis Vault and SQLite journal, a real local HTTP Sync server, real device enrollment, the production Connector reconciliation method, and a real CodeMirror 6 / Yjs collaboration flow over WebSocket. The Obsidian Vault API in the isolated test is a controlled adapter; this is not an iOS hardware or two-physical-site acceptance.

## Correct ownership model

- The server's initial `files=[]`, `vaultSeq=0` mean **the server has no originals**, not that the Connector has nothing to upload.
- A new Connector connection with no tracked server generations uploads eligible local files using immutable, receipt-verified `CREATE` operations. Never use mere absence in a server manifest as proof that an existing local note was deleted.
- A markdown note open in native CodeMirror is still a locally authoritative original. It can be seeded only if *every* open editing buffer exactly matches the source bytes from Obsidian's Vault API. An unsaved candidate is neither a safe file snapshot nor an automatic deletion.
- After the first durable `CREATE` receipt, a previously failed native Yjs JOIN is retried. File generation, native editing binding, and Yjs durability must converge independently; a file-level ACK alone is insufficient to assert that a native edit is saved.
- A Connector that remembers a previous generation must not silently treat a reset server as a new, unrelated blank Vault. In particular, a server journal behind the local cursor, or a completely empty journal against existing file/Yjs baselines, requires review; queued old-generation operations must not replay before that check.

## Reproduced defect and repairs

**Red test:** Prior `syncNow()` skipped `live.isManaged()` notes and open Markdown views in the local-only upload loop. With a completely empty server, an open note could remain *absent* from the server while Connector presented **`Synced · server acknowledged`** and had zero outbound operations. This was actually reproduced against the isolated server, not inferred from code alone.

**Connector repair** (`apps/obsidian-ignis-connector/src/main.ts`): `openOriginalMatchesDisk` verifies all current open views before seeding the server. An open, verified original can upload and then retry its Yjs JOIN; an uncommitted or unverified editor is preserved locally with a review status. An additional journal-frontier check prevents old queued writes from reaching a rolled-back server, including when the old local cursor is zero but generation baselines are present. Baselines excluded by a device's narrower content scope remain intact but do not independently count as active shared-file generations when determining a completely empty journal. No implicit deletion or replacement is introduced.

**Server repair** (`apps/ignis-server/server/collab/index.js`): when a nonexistent note is requested by `collab.join`, the canonical-path check now distinguishes a genuinely absent path (`ENOENT` / `Note not found`) from a different-case alias. This preserves case-collision protection while making the empty-file state actionable.

## Actual isolated experiments

The durable test source is `apps/obsidian-ignis-connector/src/empty-server-authority.integration.test.mjs`. Each run starts **one** child Ignis Server bound to loopback port 38426 using new QA-only `server-vaults/` and `server-state/` roots under `.ignis-local-tools/empty-server-authority-20261110/run-<pid>/`. Device credentials are generated in memory and never emitted in the checkpoint. The test's server receives SIGTERM and exits on teardown. Existing release roots, the real `WebVault`, original Connectors, Tailscale proxy settings, and production launchd are untouched.

1. **Sole source, unopened files:** A real empty Sync manifest and empty journal accepted multiple new Connector originals: nested Japanese Markdown, nested English Markdown, README, zero-byte Markdown, and small binary media. Each server file matched its source SHA-256. The Connector saved file/generation baselines, drained its queue, and repeated synchronization caused no duplicate operations. The Web's `/api/fs/tree` metadata also displayed the newly created paths, not just the Sync manifest.
2. **Sole source, opened file:** A saved and currently open Markdown editor was previously skipped; after repair, the real Sync operation reached the server, and native Yjs JOIN was retried after generation confirmation. The UI no longer claimed total synchronization before the new generation existed.
3. **Unsaved open edit:** With the editor buffer ahead of the disk snapshot, no source bytes were uploaded and a review state appeared. When the Obsidian source snapshot was advanced to match the buffer, its exact new hash was uploaded without replacing the previous state prematurely.
4. **Real CodeMirror 6 and Yjs recovery:** A live native `EditorView` first attempted JOIN against an absent server note and received the explicit `Note not found`. After Connector's REST CREATE, JOIN succeeded, the native editor remained attached, and a subsequent CodeMirror text edit reached the server's physical file. The SQLite Sync manifest eventually advanced to the exact new hash and the native Yjs save sequence received its ACK. (Manifest indexing is asynchronous after the physical file projection, so the acceptance waits for both.)
5. **Reset server, previously known original:** With an old baseline/generation and cursor ahead of a fresh server journal, the note and baseline were retained while the UI displayed `Server history mismatch`. This also covered queued old operations and `applyRemoteDeletes=true`; the queued operations were preserved without replay and the local original was not moved to trash. A prior baseline with cursor 0 also triggered protection.

These tests distinguish a **legitimate virgin server paired with an untracked native original** from a **recreated server that has lost a previously tracked generation**. The latter requires explicit recovery of the correct journal or a deliberate new server scope and migration; a guessed automatic overwrite is not acceptable.

## Scope limits and deployment note

The test does **not** claim on-device iOS Japanese candidate picker, 2+ physical sites, full restart/power-loss durability, or unsupported file transfer sizes. Individual files over 4 MiB, empty folders, and excluded `.obsidian`/protected directories remain outside the current Sync mechanism. As with the prior production deployment history, free disk space must be checked before any release because an `ENOSPC` event can prevent Yjs persistence.

**Operational outcome:** No production deployment or restart performed. The production Ignis backend and its launchd auto-start remain disabled pending the user's separate instruction to resume deployment. Keep QA evidence and snapshots; do not overwrite production Vaults with a test dataset.
