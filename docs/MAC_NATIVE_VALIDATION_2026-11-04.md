# Native macOS validation — 2026-11-04

## Environment and isolation

- macOS 26.7 on Apple Silicon; Node.js 25.6.1.
- Installed Obsidian launcher 1.10.6, running with a disposable HOME and Chromium user-data directory. The isolated profile downloaded Obsidian 1.15.0 on startup.
- Dedicated native Obsidian Vault, plugin copy and independent Ignis server on 127.0.0.1:3198. No regular Vault or existing Ignis process was changed.

## Results

| Check | Result |
| --- | --- |
| Ordinary Obsidian plugin loads on macOS | PASS. Fresh isolated profile required enabling community plugins in its own restricted-mode setting |
| Native CodeMirror 6 and Yjs editor binding | PASS. The live room attached to a real editor only after the exact baseline matched |
| Local editor change | PASS. Native CM6 and Y.Text matched; outgoing Yjs update emitted |
| Independent peer Yjs update | PASS. Local and remote edits merged and the real Obsidian editor converged |
| Native Vault file persistence | PASS. File contents on disk matched both edits |
| Native Cmd-Z / Shift-Cmd-Z | INCONCLUSIVE. The automated key event did not reach a focused editor; no Undo failure is claimed |
| Native authenticated HTTPS/WSS session | NOT VERIFIED in the Obsidian application. The standalone isolated HTTP/WSS integration test passed |
| Restart into downloaded Obsidian 1.15.0 | INCONCLUSIVE. The isolated relaunch did not expose a responsive renderer via its local test debug port |
| Obsidian 1.10.6 SecretStorage | ABSENT; Connector fell back to in-memory token and requires re-entry after restart |

The native editor test injected synthetic peer Yjs frames into the actual Obsidian renderer. It is not a claim of a verified authenticated native-to-server session or physical Japanese IME test.

## macOS filesystem regression: fixed

The test APFS volume is case-insensitive: CaseNote.md and casenote.md resolve to the same inode. Before the fix, a case-only rename returned DESTINATION_EXISTS. The server now recognizes a self-alias only when both names refer to the same regular file inode in the same directory and no distinct exact destination entry exists. A case-only rename preserves fileId and generationId without permitting unrelated destination overwrites. The permanent Mac-sensitive regression test failed before the change and passed after.

## Automated verification on this Mac

- 969 tests passing across 97 test files (Vitest).
- Connector TypeScript typecheck and build passed.
- Oxlint and server error-leak checks passed.
- Isolated HTTP/WSS Sync smoke passed, covering concurrent peer Yjs convergence, durable ACK, operation retries, per-device credential revocation, binary attachments, and server restart.

Remaining validation: real macOS keyboard Undo/Redo and Japanese IME, real native authenticated transport, full app restart/reconnect on a stable Obsidian build, and iOS hardware testing.
