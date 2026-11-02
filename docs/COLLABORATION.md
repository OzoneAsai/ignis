# Experimental realtime collaboration (fork)

This fork adds realtime text collaboration for Markdown notes using Yjs. It does not require Relay, a cloud service, or OAuth for localhost testing.

## Design

The bundled Ignis Bridge binds the active Obsidian `MarkdownView.editor` to a `Y.Text` document. Local editor changes become Yjs operations; incoming changes update only the modified range, preserving the cursor where possible. Both directions use Ignis's existing single WebSocket connection and the `collab` channel.

The server creates rooms keyed by `[vaultId, relativeMarkdownPath]`. Each room maintains a Yjs document, relays Yjs updates to the other participants, and periodically saves two representations:

- `VAULT_ROOT/<vault>/note.md`: ordinary Markdown for Obsidian and external tools.
- `DATA_ROOT/collaboration/<sha256(room-key)>.yjs`: full CRDT document state, needed for reliable reload/reconnection.

The Yjs state file is saved atomically before the Markdown snapshot. Ordinary whole-file autosaves received while a room is active are acknowledged but **not allowed to overwrite the Yjs state**. The authoritative Markdown write is serialized behind any preexisting queued filesystem write. After the final participant leaves and the document has flushed, ordinary file writes resume.

On rejoin, the full document state is exchanged in both directions, so offline edits made in an already initialized browser session can be merged on reconnect. External disk edits made while a document was inactive are reconciled on the next room open.

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
```

The final script uses a separate headless Chrome profile and the `Collab Lab` development vault; create `Browser CRDT Test.md` before running it. It does not modify an existing Ignis installation.

## Current scope and limitations

- Collaboration is automatic for the *active* Markdown editor. Multiple open panes in one browser are not yet independently bound.
- Shared remote cursors, selection highlighting, identities, and document-level access controls are not implemented. Participant counts are available.
- Editing through external file tools, non-CRDT plugins, rename/delete operations, and third-party sync engines while a room is active need additional coordination. Test with a dedicated vault before mounting production notes.
- The service retains the parent Ignis project's authentication model: it has **no built-in user authentication**. Protect any network-facing deployment with HTTPS and authentication at a reverse proxy. Local testing does not need OAuth.
- Collaboration state is currently held in one server process. Sticky WebSocket routing or a shared-room backend is required before scaling to multiple Ignis workers.

Implementation entry points: `packages/bridge/src/collaboration.js`, `apps/ignis-server/server/collab/index.js`, `packages/server-core/src/ws.js`, and `apps/ignis-server/server/routes/fs.js`.
