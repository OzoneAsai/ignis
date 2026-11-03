# Experimental realtime collaboration (fork)

This fork adds realtime text collaboration and browser-local offline editing for previously opened Markdown notes using Yjs. It does not require Relay, a cloud service, or OAuth for localhost testing.

## Design

The bundled Ignis Bridge maintains **one Yjs document per open vault/note path**, regardless of the number of visible Obsidian Markdown panes. Each editor is an independent CodeMirror view of that same CRDT, with its own DOM, selection and scroll state. Switching focus or opening another note in an adjacent pane does not unsubscribe the still-visible first note. Local editor changes become Yjs operations; incoming changes update only the modified ranges. All open documents share Ignis's existing WebSocket connection and the `collab` channel.

### Identifiable collaborator cursors

The server allocates a unique participant ID and a distinguishable color for each active WebSocket participant. The name is an editable, browser-tab-local display name (default: a short random Guest identifier), **not an authenticated identity**. Click the `Collab: N online` status-bar indicator to see the people in the current note and edit your own display name. Duplicate names are disambiguated with a short participant ID.

Caret and selection endpoints are serialized as **Yjs relative positions**, so ordinary concurrent insertions can rebase remote positions without assuming stale absolute character offsets. Cursor awareness is ephemeral and is not saved in the Markdown or CRDT files. The renderer draws colored remote carets, name tags, and selection highlights over the active CodeMirror 6 editor. A departing participant is removed from the room roster and from all remote cursor overlays. The client clears the remote roster on connection loss and rejoins automatically when the WebSocket reconnects. The renderer reuses DOM nodes keyed by participant ID, rather than recreating all labels on every cursor event.

One browser participant has one currently focused cursor per document. When focus moves to another document, the old cursor is explicitly cleared rather than misleading collaborators with a stale caret. Each visible Markdown pane has a separate, non-destructively updated cursor overlay.

### Offline editing and startup

There are three different kinds of data, with different lifetimes and authorities:

1. **Yjs document (`IndexedDB` in the browser):** the actual offline-capable editing state. The browser journals CRDT operations for each exact `[vaultId, notePath]` in a committed IndexedDB transaction, even when disconnected or when a tab is reloaded. The journal reuses the original `y-indexeddb` schema to recover earlier drafts, batches old operations into a merged Yjs snapshot periodically, and never declares local storage complete until the corresponding transaction's `complete` event. A cold browser profile without the previously opened note cannot invent its content.
2. **Offline startup cache:** a `Service Worker` caches previously fetched application shell resources and a dedicated IndexedDB database stores the last online vault bootstrap, required Obsidian startup configuration, and bounded Markdown note previews. Obsidian needs synchronous filesystem reads during startup, so boot scripts wait for the IndexedDB snapshot rather than relying on synchronous XHR through the Service Worker. This makes it possible to reload *previously opened and cached vaults/notes* while the Ignis server is down.
3. **Ignis server:** records the authoritative merged Yjs state, Markdown projection, and a SHA-256 baseline watermark. It acknowledges a client update **only after** the CRDT state, Markdown and baseline watermark have been atomically replaced and synchronized to disk. On restart it uses the watermark to distinguish an external Markdown edit from the crash window between CRDT and Markdown writes.

Client and server availability are independent; the status bar differentiates **loading local draft**, **saving to device**, **offline · saved on device**, **reconnecting**, **syncing**, and **online · saved**. Saving to the browser is not presented as confirmation that the server also saved the content. The server confirms individual sequence numbers after persisted CRDT transactions. When offline startup data or a note is unavailable, the editor stays non-editable until it can actually establish a CRDT baseline, rather than accepting edits that might overwrite someone else's work. Clicking the status indicator also shows storage/server errors and permits a server-sync retry. An unusual competing draft created before CRDT initialization is preserved separately and can be copied from the status dialog rather than silently replacing someone else's changes.

The offline bootstrap saves a bounded subset of metadata/config/notes. Not all third-party plugins or large resources are cached. If the browser storage is cleared/evicted, the local CRDT log is no longer available. Offline state is browser-origin/profile-specific; another device does not receive changes until reconnection.

Tabs on the **same browser origin** can merge each other's updates while the server is down through BroadcastChannel, in addition to saving their independent updates in IndexedDB. A newly opened tab requests state from existing tabs. Updates originating from a server are labeled separately from local tab edits, avoiding pointless re-upload loops; when one tab is connected, it can forward genuine local peer edits to the server. Both WebSocket and BroadcastChannel updates are deferred during native IME composition, so neither path may overwrite uncommitted text.

### Editor transaction integrity

Local modifications are expressed as an ordered diff, **not** an encompassing replacement between the first and last difference. Unchanged content between independent edits is retained as such by the CRDT. Incoming Yjs deltas are applied as one ordered CodeMirror 6 `dispatch({ changes })` transaction. CodeMirror itself maps the existing cursor/selection through this transaction; code does not replace `contentDOM`, recreate the editor, or reset the cursor position. The remote cursor overlay updates only the affected participant elements.

The editor's Undo/Redo commands are routed to a per-note Yjs `UndoManager` tracking only this browser participant's local changes. Undo/Redo themselves become shared CRDT operations, while another participant's changes remain intact. The implementation intercepts Ctrl/Cmd-Z and redo keyboard shortcuts for every bound collaborative editor and restores its original handlers when that pane closes. During native text composition (including Japanese IME), inbound updates from every transport are buffered until the composition has committed, then merged; no remote edit is allowed to replace a composing DOM node. Inbound deltas are validated against the actual resulting document, not just text length, before applying a CodeMirror transaction.

The server creates rooms keyed by `[vaultId, relativeMarkdownPath]`. Each room maintains a Yjs document, relays Yjs updates to the other participants, and periodically saves two representations:

- `VAULT_ROOT/<vault>/note.md`: ordinary Markdown for Obsidian and external tools.
- `DATA_ROOT/collaboration/<sha256(room-key)>.yjs`: full CRDT document state, needed for reliable reload/reconnection.

The Yjs state file is saved atomically before the Markdown snapshot. Ordinary whole-file autosaves received **while the CRDT room is active** are acknowledged but **not allowed to overwrite the Yjs state**. Between sessions, a conventional whole-file write to a previously collaborative note is **rejected with HTTP 409** rather than pretending the write succeeded. The authoritative Markdown write is serialized behind any preexisting queued filesystem write. Non-CRDT consumers of these notes must coordinate writes through the CRDT channel.

On rejoin, the full document state is exchanged in both directions, so offline edits made in a previously initialized browser session or a reloaded browser can be merged on reconnect. External disk edits made while a document was inactive are reconciled on the next room open. The server uses a committed hash watermark to ensure that a crash after writing `.yjs` but before writing Markdown does not cause the newer CRDT state to be silently overwritten by a stale Markdown projection.

## Development instance

Keep the test instance completely separate from any installed Ignis instance. For example:

```sh
npm ci
npm run build
mkdir -p local-state/vaults/lab/.obsidian local-state/data
PORT=3191 \
  VAULT_ROOT="$PWD/local-state/vaults" \
  DATA_ROOT="$PWD/local-state/data" \
  OBSIDIAN_ASSETS_PATH="/path/to/extracted/obsidian-app" \
  npm run dev:server
```

Open `http://localhost:3191/?vault=lab` in two browsers, then open the same Markdown note. The Ignis status bar displays `Collab: N online` for the active note.

Run the automated tests:

```sh
npm run lint
npm test
node scripts/collab-e2e.mjs
BASE_URL=http://127.0.0.1:3191 node scripts/collab-browser-e2e.mjs
node scripts/collab-offline-browser-e2e.mjs
```

The final script uses a separate headless Chrome profile and the `Collab Lab` development vault; create `Browser CRDT Test.md` before running it. It does not modify an existing Ignis installation.

The offline browser test launches its own Ignis server, Chrome profile, and vault on an ephemeral port, stops the test server, reloads the browser while disconnected, makes another offline edit, and verifies that both local edits merge with an independent server-side edit after restart. It never touches the existing Ignis instance.

## Current scope and limitations

- Collaboration is automatic for **all visible Markdown panes**, including multiple views of one note and multiple notes in one browser window. Every open note has its own Yjs session, server ACK sequence, and editor bindings. A shared UndoManager per note means Undo/Redo follows the document's local author history rather than one pane's isolated history.
- Completely new vaults and never-opened notes cannot be loaded offline. Offline startup requires a previously cached browser profile and the same site origin. Some plugins and non-Markdown resources are not cached, so they may be unavailable offline.
- The IndexedDB snapshot is not an indefinite backup: browser eviction, clearing site data, or storage errors may remove it. The status bar distinguishes local and remote persistence; verify the `online · saved` status before discarding browser data.
- Renaming an *inactive* collaborative Markdown note moves its Yjs state and baseline with the Markdown file; deleting it removes its history so a newly created note under the same path starts clean. Active rooms reject rename/delete with HTTP 409 rather than losing edits. Directory operations containing historical CRDT documents are blocked pending full directory-tree migration. Undo history across tab reloads, cross-tab cursor presence, and fully offline plugin-managed files remain future work.
- The offline startup cache has bounded file counts and sizes. Large notes beyond its per-note preview limit may still have a durable Yjs journal, but are not guaranteed to be reopenable while the server is unavailable; the status bar reports a storage limitation instead of silently promising reload safety.
- Remote cursors, selection highlighting, and editable display names are implemented for the active editor; **authenticated identities** and document-level access controls are not. Names are self-declared.
- For performance, multi-line selections are drawn per logical document line (up to 250 highlighted lines); especially long soft-wrapped lines do not yet have pixel-perfect highlighted segments.
- External filesystem rename/delete tools bypassing the HTTP API cannot yet move the Yjs sidecar automatically; non-CRDT plugins and third-party sync engines still require coordination. Test with a dedicated vault before mounting production notes.
- The service retains the parent Ignis project's authentication model: it has **no built-in user authentication**. Protect any network-facing deployment with HTTPS and authentication at a reverse proxy. Local testing does not need OAuth.
- Collaboration state is currently held in one server process. Sticky WebSocket routing or a shared-room backend is required before scaling to multiple Ignis workers.

Implementation entry points: `packages/bridge/src/collaboration.js`, `apps/ignis-server/server/collab/index.js`, `packages/server-core/src/ws.js`, and `apps/ignis-server/server/routes/fs.js`.
