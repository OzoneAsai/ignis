# Ignis Vault Sync: experimental implementation

The existing Ignis HTTP server now supports a single HTTPS/WSS sync path for
native Obsidian desktop and mobile. The ordinary Obsidian Connector supports
closed Markdown file synchronization **and an experimental native CodeMirror 6
Yjs live-editing binding** using the existing Ignis collaboration rooms.
Small binary attachments (up to 4 MiB per file) use the same conditional
operations and durable journal. Resumable large-file upload, automatic
deletion propagation and empty-folder synchronization are not implemented.

## Architecture

| Component | Responsibility |
| --- | --- |
| server/sync/store.js | One SQLite WAL/FULL journal, file identities, sequences, conditional operations |
| server/sync/http.js | Bearer-guarded REST API and authenticated sync channel on the existing WebSocket |
| server/sync/discovery.js | Optional HTTPS Global Discovery v3 announcement with client certificate |
| apps/obsidian-ignis-connector | One desktop/iOS/Android plugin using Obsidian Vault APIs, CodeMirror 6, Yjs and HTTPS/WSS |

No extra raw TCP listener, desktop-only transport, or Syncthing BEP exists.
The existing reverse proxy should terminate HTTPS/WSS on the same hostname.

## Isolated development

Export a random secret of at least 32 bytes in IGNIS_SYNC_TOKEN. Never commit it.
Example:

    export IGNIS_SYNC_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
    PORT=3192 IGNIS_BIND_HOST=127.0.0.1 \
      VAULT_ROOT="$PWD/local-state/vaults" \
      DATA_ROOT="$PWD/local-state/data" \
      node apps/ignis-server/server/index.js

Run the plugin build:

    npm run build --workspace @ignis/obsidian-connector

Copy the resulting main.js and manifest.json into the local Vault plugin
folder (.obsidian/plugins/ignis-connector), then enable the community plugin.
Configure its trusted HTTPS server origin, Vault ID, and access token.
If supported, the token is stored with Obsidian SecretStorage rather than in
the plugin settings JSON. Loopback HTTP is allowed only for local development.

**Network security limitation:** The access token only protects the new
Sync API and sync channel. Existing Ignis file APIs, collaboration WebSocket
and file-resource endpoints are still unauthenticated. A network-facing
deployment must protect the *entire* Ignis origin using a trusted network
or an authenticated HTTPS reverse proxy. Do not publish a bare instance.

## Optional Syncthing Discovery

With a pre-provisioned long-lived certificate and private key on the server:

    IGNIS_DISCOVERY_URL=https://discovery.example/v2/
    IGNIS_DISCOVERY_CERT=/private/path/ignis-discovery.crt
    IGNIS_DISCOVERY_KEY=/private/path/ignis-discovery.key
    IGNIS_SYNC_PUBLIC_URL=https://ignis.example/

The server announces its HTTPS endpoint by a client-certificate-authenticated
HTTPS POST. Its Syncthing Device ID is derived from SHA-256 of the certificate
DER and formatted as checksummed Base32. The Connector looks up that Device ID
using ordinary HTTPS GET. The current plugin only checks that Discovery
reports the *manually approved* HTTPS origin; it never sends the token to an
unapproved discovered origin.

An explicitly port-qualified HTTPS address is accepted by inspected versions
of self-hosted stdiscosrv, but it is **not** a standardized Syncthing transport
address. Private stdiscosrv is the initial supported deployment. Discovery
does not perform NAT traversal and does not relay Vault contents.

Sources:
- https://docs.syncthing.net/specs/globaldisco-v3.html
- https://docs.syncthing.net/dev/device-ids.html
- https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development

## Server and client invariants

The server keeps one SQLite database under DATA_ROOT/sync/vault.sqlite.
Files carry fileId, generationId, path, hash, size, revision and tombstone.
Each Vault has a monotonic sequence, and a durable operation ID records the
result of a retried request. Renaming through the Sync API preserves IDs;
deleting and recreating produces new IDs.

The initial implementation scans the Vault at manifest/change requests and
after debounced watcher events. Full scans are appropriate for small test
Vaults; incremental indexing is still needed before large-Vault production.
The Sync generationId and the Yjs documentId now refer to **one generation**.
Brand-new Yjs rooms inherit the indexed Vault generation; established Yjs
histories take precedence over old file-only metadata during migration.
A durable Yjs save also advances the same Vault change journal *before* the
server acknowledges the editor. A rename with a unique persisted Yjs history
is recognized as a rename in a later filesystem scan, preserving fileId and
generationId. Files without stable historical evidence may still appear as
delete/create after an out-of-band move. Live Yjs rooms are still located by
path, so concurrent folder-move and live-editor safety needs further work.

The server checks the supplied generation and previous content hash before
accepting changes. Collaborative notes with existing Yjs histories reject
whole-file updates. Writes use synced temporary files and atomic replacement,
followed by SQLite commit before an ACK. A crash between file replacement
and journal commit appears as an unacknowledged external modification during
recovery, not as a falsely acknowledged operation.

Small images, PDFs and other non-Markdown attachments use the same create
and modify operation receipts with the binary payload in a canonical
contentBase64 field. The server rejects a binary payload for .md files and
enforces a 4 MiB decoded limit. Its create operation can safely establish
missing parent folders while refusing symlinked parents. This is a
deliberately bounded, memory-resident *preview* of binary synchronization,
not the eventual streamed content-addressed blob protocol. Large files are
retained locally and reported as needing review, not silently skipped as
fully synced. The HTTP file download independently enforces the 4 MiB bound
before allocating a response. It reads a size-verified regular-file handle,
not a final-path symlink, and refuses stale file content.

The Connector keeps local user text in the ordinary Obsidian Vault and records
observed pending rename/delete operations in plugin data. It never infers a
deletion simply from an absent file; first-sync collisions and concurrent
edits require review. Open native Markdown editors are **never overwritten by
the whole-file REST sync**. Instead, they join the existing Yjs collaboration
channel, using a shared Y.Doc and CodeMirror 6 compartment that only activates
when the native editor and the established document state match.

Local Yjs state is also stored in IndexedDB, scoped to the origin, Vault and
immutable document generation, **not the mutable path**. Earlier path-based
v1 caches are merged once into the generation-scoped v2 cache when a known
note is opened. This preserves offline CRDT edits across ordinary renames.
The client sends its full Yjs
state on reconnect; the server acknowledges only after persisting its merged
CRDT state and Markdown projection. Native Obsidian save events continue to
persist the local Vault file. IndexedDB may be evicted on iOS, so a changed
native file that lacks a matching Yjs baseline is **not** silently merged:
the Connector keeps the draft locally and requests review. If a deleted note
is recreated under the same path with a new document ID, old offline Yjs
updates are not transmitted to it. IME composition defers incoming Yjs
updates until the native editor has committed the composition transaction;
the Yjs UndoManager tracks local operations, not remote author changes.

The current native binding has no remote-selection overlay. Existing Ignis
browser collaboration remains unchanged and interoperates through the same
Yjs room wire format. Sync and Yjs now share generation identity; fileId
remains the stable entity ID across moves. An actively joined collaborative
note cannot be renamed/deleted by the old server APIs until the room is
released. The Connector keeps unsent rename operations pending until it
receives a server ACK, then rejoins the new room path.

### Offline transitions and iOS resumption

A pending operation describes a transition of a confirmed **file identity**,
not a detached filename. The Connector evaluates the ordered pending queue
over its last acknowledged baselines before recording a new rename or
deletion. Thus a sequence such as A.md -> B.md -> C.md -> delete(C.md)
replays in the original order with stable fileId, generationId, baseHash and
per-operation opId, even after restart. A mismatched operation receipt cannot
consume another pending transition. Untracked collaborative moves are not
silently uploaded as unrelated replacement files.

Mobile WebViews may suspend without firing WebSocket close. On
visibilitychange (return to visible), pageshow or an online network event,
the Connector tears down an apparently open but potentially stale socket,
re-authenticates to the **same approved origin**, rejoins Yjs rooms and
reconciles native Vault files. Messages and onopen callbacks belonging to
an old socket are ignored; a newly entered token is never sent by an
obsolete socket. Transport errors use capped exponential reconnection
delays, while rejected authentication or a mismatched server Vault stops
automatic retries until reconfiguration. This is foreground recovery, **not
background synchronization**.

After a transient Yjs save-error, the Connector resends its idempotent full
CRDT state with bounded backoff; a successful durability ACK cancels the
retry. If an individual Yjs update exceeds the current WebSocket protocol's
1 MiB limit, the room stops transmitting dependent partial updates and keeps
the local draft rather than claiming synchronization. A later resumable
transport upgrade is required for such histories.

The configured HTTPS origin and Vault ID form a persistent client state
scope. Access tokens are stored under this scope in Obsidian SecretStorage.
Changing either requires explicitly archiving the previous pending queue and
restarting the plugin; the archive remains in plugin data so unsent metadata
is not silently thrown away. Tokens from the earlier unscoped preview
must be entered again. If a particular Obsidian build has no SecretStorage,
the access token can only be kept in memory, not in plugin data; it survives
unrelated settings edits but must be re-entered after restarting Obsidian.

Hidden Obsidian settings and plugin state are excluded, and iOS background
execution is not promised. The Connector is built from a single JavaScript
bundle for desktop and mobile, with no Node-only networking path.

## Validation

    npm run lint
    npm test
    npm run typecheck --workspace @ignis/obsidian-connector
    npm run build --workspace @ignis/obsidian-connector
    node scripts/sync-smoke.mjs

The smoke script creates an isolated temporary Vault and Ignis process,
checks REST auth, manifest and cursor behavior, WSS notifications,
collaborative edits and their durable journal ACK, binary create/download/
modify, chained offline rename/delete operations, bounded downloads, duplicate
operation retries, stale-write refusal and server restart,
then cleans up.
No installed Ignis process is stopped or modified.

## Next milestones

1. Verify the native CodeMirror 6 / Yjs binding on **real iOS hardware**,
   especially Japanese IME, native background suspension and Undo in
   multiple editor panes. Automated CM6/IndexedDB tests are not a substitute.
   Harden active-room cross-device renames and path transitions.
2. Replace the shared preview token with per-device pairing and revocation.
3. Incremental journal capture, recovery UI, and out-of-band rename
   recognition for files without collaborative identity.
4. Resumable content-addressed binary attachments exceeding 4 MiB, with
   streaming IO and tighter iOS memory budgets.
5. Real iOS lifecycle, initial migration, Unicode/case and crash-injection tests.
