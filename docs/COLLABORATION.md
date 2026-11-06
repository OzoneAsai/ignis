# Experimental realtime collaboration (fork)

This fork adds realtime text collaboration and browser-local offline editing for previously opened Markdown notes using Yjs. It does not require Relay, a cloud service, or OAuth for localhost testing.

## Design

The bundled Ignis Bridge maintains **one Yjs document per open vault/note path**, regardless of the number of visible Obsidian Markdown panes. Each editor is an independent CodeMirror view of that same CRDT, with its own DOM, selection and scroll state. Switching focus or opening another note in an adjacent pane does not unsubscribe the still-visible first note. Local editor changes become Yjs operations; incoming changes update only the modified ranges. All open documents share Ignis's existing WebSocket connection and the `collab` channel.

### Identifiable collaborator cursors

The server allocates a unique participant ID and a distinguishable color for each active WebSocket participant. The name is an editable, browser-tab-local display name (default: a short random Guest identifier), **not an authenticated identity**. Click the `Collab: N online` status-bar indicator to see the people in the current note and edit your own display name. Duplicate names are disambiguated with a short participant ID.

Caret and selection endpoints are serialized as **Yjs relative positions**, so ordinary concurrent insertions can rebase remote positions without assuming stale absolute character offsets. Cursor awareness is ephemeral and is not saved in the Markdown or CRDT files. The shared wire format now uses `selections: [{anchor, head}, ...]` and `mainIndex` for multiple local CodeMirror 6 selections. The server validates **every** position against the joined Y.Text, checks the document generation when supplied, and rejects an invalid or greater-than-32 selection batch as a whole with `INVALID_SELECTION`. Older clients with one `anchor/head` pair still work: new messages carry these legacy primary-selection fields as well. Both WebUI and native Obsidian Connector draw every remote caret and visible selection range, with one name label on the primary selection. The initial `init` and subsequent `presence` messages include all joined participants and their latest selections, including when joining late. A departing participant is removed from the roster and from all remote overlays; disconnect clears the local roster immediately.

One participant publishes all selections from their currently focused editor per document, up to the explicit 32-selection protocol limit. When focus leaves that document the cursor set becomes empty, while the participant may remain listed as online. Each visible Markdown pane has a separate, non-destructively updated cursor overlay. The editor's accessible, collapsible people roster includes **every** remote participant (not just the former first 32), including members with no visible caret or a caret outside the viewport. Selecting a member scrolls to their primary cursor without changing the local editor selection. Carets themselves are never silently dropped for performance; only the visible **selection highlights** share a global 480-rectangle per-frame budget, and the roster reports when that budget is exhausted.

### Offline editing and startup

There are three different kinds of data, with different lifetimes and authorities:

1. **Yjs document (`IndexedDB` in the browser):** the actual offline-capable editing state. The browser journals CRDT operations by vault/path and, after a note replacement, by its durable *document generation*. The journal reuses the original `y-indexeddb` schema to recover earlier drafts, batches old operations into a merged Yjs snapshot periodically, and never declares local storage complete until the corresponding transaction's `complete` event. A cold browser profile without the previously opened note cannot invent its content.
2. **Offline startup cache:** a `Service Worker` caches previously fetched application shell resources and a dedicated IndexedDB database stores the last online vault bootstrap, required Obsidian startup configuration, and bounded Markdown note previews. Obsidian needs synchronous filesystem reads during startup, so boot scripts wait for the IndexedDB snapshot rather than relying on synchronous XHR through the Service Worker. This makes it possible to reload *previously opened and cached vaults/notes* while the Ignis server is down.
3. **Ignis server:** records the authoritative merged Yjs state, Markdown projection, and a SHA-256 baseline watermark containing a stable UUID for this document generation. It acknowledges a client update **only after** the CRDT state, Markdown and baseline watermark have been atomically replaced and synchronized to disk. On restart it uses the watermark to distinguish an external Markdown edit from the crash window between CRDT and Markdown writes. The UUID is committed before it is first announced to browsers.

Client and server availability are independent; the status bar differentiates **loading local draft**, **saving to device**, **offline · saved on device**, **reconnecting**, **syncing**, and **online · saved**. Saving to the browser is not presented as confirmation that the server also saved the content. The server confirms individual sequence numbers after persisted CRDT transactions. A separate recoverable draft appears as an **additional indicator**; it never hides an incomplete save, an offline state, or a server error. When offline startup data or a note is unavailable, the editor stays non-editable until it can establish a CRDT baseline. Clicking the status indicator shows storage/server errors and permits a server-sync retry. A competing startup draft can be copied from this dialog instead of silently replacing another person's edits.

The offline bootstrap saves a bounded subset of metadata/config/notes. Not all third-party plugins or large resources are cached. If the browser storage is cleared/evicted, the local CRDT log is no longer available. Offline state is browser-origin/profile-specific; another device does not receive changes until reconnection.

Tabs on the **same browser origin** can merge each other's updates while the server is down through BroadcastChannel, in addition to saving their independent updates in IndexedDB. A newly opened tab requests state from existing tabs. Updates originating from a server are labeled separately from local tab edits, avoiding pointless re-upload loops; when one tab is connected, it can forward genuine local peer edits to the server. Both WebSocket and BroadcastChannel updates are deferred during native IME composition, so neither path may overwrite uncommitted text.

**Replacing a note is not editing the old note.** If `note.md` is deleted and a different note is created with that same path, the server allocates a new generation UUID. A browser with the old note's offline journal must **not** upload or merge that journal into the replacement. Instead the previous editor becomes non-editable and clearly reports `Collab: note replaced · old draft protected`. Its status dialog lets the user copy the old draft, then explicitly **Open new server note (preserve old draft)**. This action commits an archive of the old text and a generation pointer together, starts a fresh Yjs/IndexedDB journal and leaves the old history untouched. The archived text remains accessible after a browser reload until the user explicitly discards the recovery copy. Same-origin tab exchange also tags updates with document generation so the old and new note cannot mix through BroadcastChannel. A durable `.protected` file alongside the server's Yjs state records that a path *previously* hosted a collaborative note, even after its Yjs history is intentionally deleted. It rejects conventional whole-file autosaves during the interval **before** the recreated note has established a new CRDT room; otherwise a disconnected browser could overwrite its replacement before the generation mismatch is checked. The marker also follows inactive note renames, and ordinary non-CRDT Markdown remains writable. Older browser journals created before UUID tracking can be read for backward compatibility, though no retrospective UUID can be inferred for them.

### Editor transaction integrity

Local modifications are expressed as an ordered diff, **not** an encompassing replacement between the first and last difference. Unchanged content between independent edits is retained as such by the CRDT. Incoming Yjs deltas are applied as one ordered CodeMirror 6 `dispatch({ changes })` transaction. CodeMirror itself maps the existing cursor/selection through this transaction; code does not replace `contentDOM`, recreate the editor, or reset the cursor position. The remote cursor overlay updates only the affected participant elements.

The editor's Undo/Redo commands are routed to a per-note Yjs `UndoManager` tracking only this browser participant's local changes. Undo/Redo themselves become shared CRDT operations, while another participant's changes remain intact. The implementation intercepts Ctrl/Cmd-Z and redo keyboard shortcuts for every bound collaborative editor and restores its original handlers when that pane closes. **Obsidian may reassign `editor.undo` and `editor.redo` while reinitializing Markdown views.** Replacing these commands once was unsafe: a native CodeMirror Undo could roll the editor back independently, then its editor-change event could send a *new local Yjs deletion* of a peer's text. The binding now owns stable command accessors throughout the pane's lifetime: any later native method assignments are captured for eventual teardown, but cannot bypass the current Yjs UndoManager. During native text composition (including Japanese IME), inbound updates from every transport are buffered until the composition has committed, then merged; no remote edit is allowed to replace a composing DOM node. Inbound deltas are validated against the actual resulting document, not just text length, before applying a CodeMirror transaction.

The server creates rooms keyed by `[vaultId, relativeMarkdownPath]`. Each room maintains a Yjs document, relays Yjs updates to the other participants, and periodically saves two representations:

- `VAULT_ROOT/<vault>/note.md`: ordinary Markdown for Obsidian and external tools.
- `DATA_ROOT/collaboration/<sha256(room-key)>.yjs`: full CRDT document state, needed for reliable reload/reconnection.

The Yjs state file is saved atomically before the Markdown snapshot. Ordinary whole-file autosaves received **while the CRDT room is active** are acknowledged but **not allowed to overwrite the Yjs state**. Between sessions, a conventional whole-file write to a previously collaborative note is **rejected with HTTP 409** rather than pretending the write succeeded. The authoritative Markdown write is serialized behind any preexisting queued filesystem write. Non-CRDT consumers of these notes must coordinate writes through the CRDT channel.

On rejoin, the full document state is exchanged in both directions **only after matching document generations**; offline edits made in a previously initialized browser session or a reloaded browser then merge on reconnect. External disk edits made while a document was inactive are reconciled on the next room open. The server uses a committed hash watermark to ensure that a crash after writing `.yjs` but before writing Markdown does not cause the newer CRDT state to be silently overwritten by a stale Markdown projection. Join paths must use exact filesystem spelling and may not contain traversal, ambiguous separators, or symlink aliases; otherwise one physical note could accidentally acquire competing CRDT identities.

## Development instance

Keep the test instance completely separate from any installed Ignis instance. For example:

```sh
npm ci
npm run build
mkdir -p local-state/vaults/lab/.obsidian local-state/data
PORT=3191 \
  IGNIS_BIND_HOST=127.0.0.1 \
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
BASE_URL=http://127.0.0.1:3191 COLLAB_UNDO_ROUNDS=20 node scripts/collab-undo-browser-e2e.mjs
node scripts/collab-offline-browser-e2e.mjs
```

The final script uses a separate headless Chrome profile and the `Collab Lab` development vault; create `Browser CRDT Test.md` before running it. It does not modify an existing Ignis installation.

The offline browser test launches its own loopback-only Ignis server, Chrome profile, and vault on an ephemeral port. It stops the test server, reloads the browser while disconnected, verifies that both local edits merge with an independent server-side edit after restart, then deliberately recreates the note under the same filename to verify generation protection, safe switching and archived draft recovery. It never touches the existing Ignis instance.

The dedicated Undo/Redo browser stress script uses **two actual Obsidian editors**, alternates concurrent local and remote insertions, deliberately reinstalls obsolete native editor commands, and then runs both direct command calls and Cmd-Z/Cmd-Shift-Z. It verifies after each reversal and reapplication that the two browsers converge without deleting the remote author's content, then switches notes in one pane and confirms the original note regains the correct command binding. Its default is 16 cycles; set `COLLAB_UNDO_ROUNDS` to increase it. Offline Chrome integration additionally exercises Undo/Redo across disconnected same-origin tabs and verifies that deletion/recreation tombstones reject obsolete full-file snapshots.

## Current scope and limitations

- Collaboration is automatic for **all visible Markdown panes**, including multiple views of one note and multiple notes in one browser window. Every open note has its own Yjs session, server ACK sequence, and editor bindings. A shared UndoManager per note means Undo/Redo follows the document's local author history rather than one pane's isolated history.
- Completely new vaults and never-opened notes cannot be loaded offline. Offline startup requires a previously cached browser profile and the same site origin. Some plugins and non-Markdown resources are not cached, so they may be unavailable offline.
- The IndexedDB snapshot is not an indefinite backup: browser eviction, clearing site data, or storage errors may remove it. The status bar distinguishes local and remote persistence; verify the `online · saved` status before discarding browser data.
- Renaming an *inactive* collaborative Markdown note moves its Yjs state and baseline with the Markdown file; deleting it removes its history so a newly created note under the same path starts clean. Active rooms reject rename/delete with HTTP 409 rather than losing edits. Directory operations containing historical CRDT documents are blocked pending full directory-tree migration. Undo history across tab reloads, cross-tab cursor presence, and fully offline plugin-managed files remain future work.
- The offline startup cache has bounded file counts and sizes. Large notes beyond its per-note preview limit may still have a durable Yjs journal, but are not guaranteed to be reopenable while the server is unavailable; the status bar reports a storage limitation instead of silently promising reload safety.
- Remote multi-cursors, selection highlighting, a navigable all-participant roster, and editable display names are implemented for WebUI and the native Obsidian Connector. **Authenticated identities** and document-level access controls on the older collab channel remain incomplete. Names are self-declared.
- For performance, WebUI retains a global 480-rectangle overlay budget with a 250-line per-range limit. The native Obsidian Connector instead uses CodeMirror 6 `Decoration.mark` with a bounded 480 logical text ranges (no simulated rectangular highlights); CodeMirror handles wrapping and inline syntax. iOS provides a viewport-anchored, touch-accessible participant button with ribbon and command-palette alternatives because mobile custom status-bar items are unsupported. Native display names are editable in plugin settings or from the collaborator panel, and changes broadcast over `collab.identity` without disconnecting. Real iOS device performance must still be measured. Up to 32 selections per participant are accepted; greater batches produce an explicit protocol error, not a truncated selection set.
- External filesystem rename/delete tools bypassing the HTTP API cannot yet move the Yjs sidecar automatically; non-CRDT plugins and third-party sync engines still require coordination. Test with a dedicated vault before mounting production notes.
- The service retains the parent Ignis project's authentication model: it has **no built-in user authentication**. Protect any network-facing deployment with HTTPS and authentication at a reverse proxy. Local testing does not need OAuth.
- Collaboration state is currently held in one server process. Sticky WebSocket routing or a shared-room backend is required before scaling to multiple Ignis workers.

Implementation entry points: `packages/bridge/src/collaboration.js`, `apps/ignis-server/server/collab/index.js`, `packages/server-core/src/ws.js`, and `apps/ignis-server/server/routes/fs.js`.
