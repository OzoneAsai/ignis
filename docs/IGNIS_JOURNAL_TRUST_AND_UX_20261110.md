# Ignis: multi-origin UX and durable journal identity

**Date:** 2026-11-10 JST. **Scope:** server Sync journal, native Obsidian Connector (desktop/mobile code path), truthful recovery UI, isolated HTTP/SQLite/CodeMirror testing. **Production:** deliberately stopped; nothing in the production WebVault has been migrated, replaced or removed.

## Product model

Two independently editable native Obsidian Connectors and desktop/mobile Ignis Web are clients of the same shared Vault. No device becomes a subordinate source because another editor is online. A Sync server stores the canonical file identity, durable file receipts, file event journal and Yjs state, but the Connector retains local originals and any unacknowledged operation until an explicit durable outcome. The number of files on one device is never sufficient to decide which history should overwrite another.

Four distinct layers of evidence must not be conflated:

1. **Trusted journal origin:** per-Vault durable `journalLineage` persisted in server SQLite; it is not the URL, Vault name, device token, file hash, nor the mutable `vaultSeq`.
2. **Trusted journal checkpoint:** per-sequence `headProof` saved beside the Connector's last consumed `cursor`. A newer server sequence does not prove that the same history is present at the previously acknowledged sequence. Check exact historical sequence via indexed `/checkpoint?seq=N`.
3. **Trusted file generation:** per-file `fileId`, `generationId`, `hash`, revision and opId receipt, with preconditions for REST create/modify/delete/rename. A path alone or equal bytes alone does not establish ancestry.
4. **Trusted collaborative save:** CM6 binding attached, Yjs update's causality present, and exact `savedSeq >= sentSeq` from the server. File-journal reconciliation is not a collaborative ACK, and IME composing text is not human-confirmed conversion.

The Connector can claim whole-Vault synchronization only after all applicable layers are resolved. A blocked path is recoverable, not a reason to suppress independent paths; do not automatically delete, rewrite or invent new identities to make an error indicator green.

## User-visible states and actions

| Situation | What the user sees | Automatic behavior | Safe next action |
| --- | --- | --- | --- |
| Truly new empty server and no Connector prior tracked history | `Sharing local originals · n/N ...` | Upload eligible local originals with persisted immutable opIds; receipt-verify | Continue editing while eligible files are acknowledged |
| Open note whose CM6 text matches disk | Progress; then Yjs reconnecting/confirmed | Seed original, then retry JOIN once file generation exists | No manual action necessary |
| Open note with uncommitted text | Review: local draft is kept | Do not upload stale disk content | Save the native editor text, then retry |
| Same server journal through restart | Normal reconnect/sync | Preserve pinned lineage; verify older checkpoint | Continue normally |
| Recreated journal with same hostname/Vault/path/hash/sequence | `Server history changed · sync paused` | Preserve pending queue, original files, Yjs identities; block new writes | Restore correct server journal or explicitly choose a new Vault and review migration |
| Restored backup with same journal UUID but older sequence | `Server history is behind · sync paused` | No old-identity replay | Restore complete backup/history; `Recheck and resume` |
| Restored backup whose history diverged but sequence later caught up | `Server history diverged · sync paused` | Verify exact old journal checkpoint, not the latest sequence | Restore original journal; do not auto-merge unknown CRDT ancestry |
| Pre-upgrade Connector has tracked generations but no pinned journal ID | `Server history cannot be verified` when lineage has no provable continuity | Do not infer ancestry from filename or visible text | Verify original journal; use deliberate separate Vault migration if appropriate |
| Server lacks the new identity protocol | `Server update required · local notes retained` | Fail closed, retain local queue | Upgrade server before synchronization |
| Server changes after a manifest check but before a write | Clear history hold on REST 409 | `X-Ignis-Journal-Lineage` plus cursor and exact proof reject operation pre-commit | Recheck journal; original immutable `opId` remains reusable |
| User changes file-sharing scope, media bypass, or opens review | Existing status + current scope counts | No implicit deletion or reboot of live editor; pending incompatible files block preference change | Resolve queue independently |
| Empty local folders | `empty folder(s) remain local (not shared)` | Don't label the entire Vault synchronized merely because all files were processed | Keep the folder locally; empty-folder protocol remains future work |
| File exceeds 4MiB preview Sync bound | Explicit size warning; source remains | Do not silently skip and report fully synchronized | Keep file local or choose a separate media transport |
| Auth token lost/revoked or device offline | Explicit auth/reconnect/offline label | Local files and pending operations are not discarded | Reauthorize exact Vault device or restore network |

The existing preserve-first collision dialog still handles *document version conflicts*, not lost server history. On a journal hold, it displays a dedicated `role=alert` section with a `Recheck history and resume sync` control, disables `Save all versions`, and does not expose a destructive migration action. It retains file-by-file review and accessible content previews for valid conflicts. Settings include a persistent Sync history entry and manual verification button; safe success feedback does not assert that live Yjs editing is already acknowledged.

## Implementation

- `apps/ignis-server/server/sync/store.js`: durable SQLite journal UUID; historical indexed checkpoint proof; `manifest`, `changes`, session and WSS surface trusted identity. Recreated DB receives another lineage; unchanged DB retains it.
- `apps/ignis-server/server/sync/http.js`: conditional mutation guard checks `X-Ignis-Journal-Lineage` and optional exact cursor/proof **before** opId/receipt processing. On mismatch HTTP 409 exposes a typed code without committing a new operation. Credential remains scoped to a Vault; the Sync administrator bootstrap secret is not a device token.
- `apps/obsidian-ignis-connector/src/journal-lineage.ts`: pure journal-trust function separating `trusted`, `unsupported`, `changed`, `behind`, `diverged` and `legacy-unproven` outcomes. No per-example condition on a filename or source text is used for identity.
- `apps/obsidian-ignis-connector/src/main.ts`: persist lineage and exact proof in connector settings; stop queue replay and Yjs join until verified; preflight pending operations; block invalid history during WSS handshake and REST writes; preserve old scope identities and undeleted originals; show truthful non-green status. Safe history recheck resumes only after validation.
- `apps/obsidian-ignis-connector/src/migration-ui-copy.ts`: Japanese/English, actionable explanations for journal mismatch, unsaved draft, oversize and staged operations; `MigrationModal` and `ConnectorSettings` provide recovery controls.

## Evidence and remaining limits

The isolated QA suite directly starts one **fresh loopback** server per test run at 38426, with separate `server-vaults/` and `server-state/` paths. Tests exercise actual SQLite journal and HTTP/WS surfaces, native `syncNow()` against a controlled Obsidian Vault adapter, and an actual CM6/Yjs editor over a Sync-authenticated WebSocket. The test server exits via SIGTERM; it is not production. Regression files include `journal-lineage.test.mjs`, `connection.test.mjs`, `migration-ui.test.mjs`, `connection-ui.test.mjs`, `empty-server-authority.integration.test.mjs`, `sync.test.mjs`, `content-scope.integration.test.mjs`, `reconcile.integration.test.mjs`.

Checks include new journal vs old with identical files and same numerical sequence, server restart persistence, independent concurrent server writes advancing the head, exact historical checkpoint comparison, wrong checkpoint rejected pre-commit while preserving the same opId, zero-file seed, open/unsaved drafts, zero-byte/Japanese/binary, Web metadata discovery, initial Yjs JOIN rejection then recovery and save ACK, old queue preservation and opt-in deletion isolation, and empty-folder truthfulness. Test counts and asset hashes must be taken from the final command results, not inferred from an earlier source revision.

**Limitations:** A checkpoint proof currently fingerprints the exact *last journal row at its sequence* plus lineage, not a Merkle proof or cumulative commitment over every earlier row. This detects the normal restored-backup fork with a different row at the saved cursor, but does not formally prove that *every earlier row* is identical if the last row has been replaced with matching fields. A full append-only chain/Merkle root with verified import migration is a separate hardening task. File Sync currently lacks empty-directory identity and files over 4MiB, and iOS-specific lifecycle/IME and actual two-physical-site network fault injection are not certified by these Mac tests. Older unupgraded clients do not automatically enforce the new conditional headers: coordinate client/server rollout.

**Operational guard:** No production release was started. Preserve all old Vault/Yjs and credentials; never use a test Vault to replace an existing user Vault. All changes remain in the Mac source workspace. Changes to run scripts/launchctl/Tailscale 8450 require explicit authorization to resume deployment.

## Acceptance result, 2026-11-10 19:12 JST

- **Full Vitest:** 187 test files / **1,645 tests PASS**; no failing cases (`.ignis-local-tools/empty-server-authority-20261110/evidence/ux-all-tests-1909.log`). Existing reconciliation/content-scope fixtures were updated to return the new journal identity, rather than weakening the fail-closed protocol to satisfy old mock servers.
- **Web/shim/server assets:** `npm run build` completed successfully. The build reported **two warnings** (not errors); the combined build log does not include explanatory messages for those warnings. No production artifacts were swapped.
- **Native Connector:** `npm run build --workspace @ignis/obsidian-connector` completed; `main.js` size ~537.1kb. `npm run typecheck --workspace @ignis/obsidian-connector` passed. `npm run lint` found **zero warnings and zero errors**, and the error-leak check was clean.
- **Isolation:** the QA localhost port 38426 had no listener after testing, no Ignis backend process was running, and neither `com.o3.obsidian-webui` nor `com.o3.ignis-testvault` was bootstrapped. Disk space had about 5.7GiB free at this check; keep monitoring before any production restart.

One practical rollout requirement remains: the same compatible server and native Connector must be updated together. Old Connector binaries do not provide the new journal-precondition headers. The existing production server is intentionally not started by these checks.
