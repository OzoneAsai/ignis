# Ignis upstream v0.9.0 integration — 2026-11-06

Upstream: Nystik-gh/ignis at `5703ec8ac880e9910233fdbc5715ad7650ea1c2c` (13 commits ahead of the previous fork main).
Fork collaboration baseline: `b2c66203c2ed03dfe8ee964a42bd592adbe3d56d`.

## Accepted
- Browser/Obsidian shims: filesystem write-order durability, binary append, fs transport timeouts, stable cache and .trash events, Node/Electron stubs.
- PWA and Obsidian 1.15 boot compatibility, mobile navigation/theme integrations.
- Upstream tests and the version bump to 0.9.0, keeping the fork's additional workspaces and dependencies.
- New fs route 4xx error codes and binary append semantics, retaining existing Yjs-authoritative write/rename/delete protections.
- Upstream watcher resync and echo-guard behavior, retaining the fork's active-collaboration watcher guard.

## Deliberately excluded
- Upstream README marketing edits and the new preview.webp animation: they do not affect runtime behavior and would overwrite fork-specific project guidance.
- No automatic merge of the fork's `main` or `brat-preview` branches. BRAT prereleases continue to be explicit version snapshots.

## Integration checks
- Isolated macOS archive build: `npm ci`, Lint 0 warnings/errors.
- Vitest: 1196 tests / 115 files passed.
- Full `npm run build` passed (one preexisting Svelte accessibility warning).
- Isolated `node scripts/sync-smoke.mjs` passed, including Yjs two-client convergence, Vault generations, durable ACKs and device revocation.
- All touched content committed by GitHub Git-data APIs using an expected-head check. Never modifies the live Mac worktree or runtime Vaults.
