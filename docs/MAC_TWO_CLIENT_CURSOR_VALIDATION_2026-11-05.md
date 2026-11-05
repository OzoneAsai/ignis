# Two native macOS Obsidian clients: live editing and cursor validation

**Date:** November 5, 2026 (JST). **Environment:** Apple Silicon macOS,
Obsidian 1.10.6, isolated localhost Ignis server.

## Isolation

Two independently running native Obsidian processes, each with its own
Chromium profile and local Vault, connected to one isolated Ignis server
Vault (lab, on 127.0.0.1:3218). Each client was enrolled independently
and had its own device and collaboration participant IDs. Neither used
the existing user Ignis process or regular Vault.

This uses loopback **HTTP/WS**, not public HTTPS/WSS.

## Mac measurements

| Operation | Observed result |
| --- | --- |
| Authenticated sync and Yjs room join | Both native clients connected with distinct device identities and bound CM6 |
| AppleScript keys typed on A | Both native editor/Yjs documents updated; server projected Markdown |
| AppleScript keys typed on B | Both native editor/Yjs documents updated; server projected Markdown |
| Cursor from A on B | Real native CM6 DOM showed a positioned and non-hidden caret and peer name |
| Cursor from B on A | Same behavior in the other direction |
| B physically selects all with Cmd-A | A displayed three bounded, colored remote selection marks |
| Simultaneous editor transactions | 12 A operations and 12 B operations, each present exactly once in both clients and server |
| Server and local file convergence | All three files reached 197 characters and identical content |
| B disconnects | A cleared the remote participant and removed caret DOM immediately |
| B reconnects | Both rooms rejoined the same document generation and remote cursor reappeared |

The local Obsidian files took longer to settle than live CM6 state. At
0.8 seconds after concurrent edits the two local files still showed their
old content, while the server had all operations. Two seconds later all
three disk files matched. Do not equate unsaved editor projection with a
CRDT convergence failure.

## Implemented fix

The Ignis server and browser bridge already supported presence, cursor,
and cursor-away messages using **Yjs relative positions**, but the native
Connector did not send, receive, or draw them.

The native Connector now shares that existing protocol. It emits
debounced relative selections and cursor-away, accepts the authenticated
room's people list, renders noninteractive remote caret labels and bounded
selection highlights inside CM6, and cleans up on blur, leave, disconnect
and plugin unload. Peer text uses textContent rather than HTML, and
colors and cursor payloads are validated. No parallel y-websocket
Awareness wire protocol was introduced.

## Verification

The new presence unit tests cover relative positions, rebasing after
insertions, cross-document/malformed input rejection, duplicate/malicious
peers, visual caret rendering and immediate removal.

The isolated Sync smoke additionally verifies two independent WS clients,
server-validated cursor broadcasts and cursor-away, alongside Yjs
convergence and restart durability.

**Final macOS suite:** 98 test files / **973 tests passed**, TypeScript
typecheck passed, Connector build passed, lint clean, HTTP/WS smoke passed.

## Limits

Public HTTPS/WSS, real iOS rendering and Syncthing Discovery were outside
this test. A fresh second Mac profile reverted to restricted mode after
one renderer reload; re-enabling the plugin and re-entering its ephemeral
device credential restored the connection. Screen rendering was verified
through the native CM6 DOM, positioned caret bounds, peer labels and
selection marks; no image-based pixel-diff test was performed.
