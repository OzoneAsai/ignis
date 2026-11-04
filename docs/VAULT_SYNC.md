# Ignis Vault Sync: experimental implementation

The existing Ignis HTTP server now supports a single HTTPS/WSS sync path for
native Obsidian desktop and mobile. The ordinary Obsidian Connector supports
closed Markdown file synchronization **and an experimental native CodeMirror 6
Yjs live-editing binding** using the existing Ignis collaboration rooms.
Small binary attachments (up to 4 MiB per file) use the same conditional
operations and durable journal. Verified remote deletions can optionally
move unchanged local files into recoverable Obsidian trash; this is disabled
by default. Resumable large-file upload and empty-folder synchronization
are not implemented.

## Architecture

| Component | Responsibility |
| --- | --- |
| server/sync/store.js | One SQLite WAL/FULL journal, file identities, sequences, conditional operations, per-device credentials and revocation |
| server/sync/http.js | Device-authenticated REST API, administrator-only enrollment and authenticated sync channel on the existing WebSocket |
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
Configure its trusted HTTPS server origin and Vault ID. The server owner
must now **enroll each device separately**; the original IGNIS_SYNC_TOKEN is
only an administrator bootstrap secret, NOT a native Obsidian sync token.

From the trusted server host, with IGNIS_SYNC_TOKEN in the shell environment,
enroll one device for the selected Vault:

    curl --fail-with-body -X POST \
      -H "Authorization: Bearer $IGNIS_SYNC_TOKEN" \
      -H "Content-Type: application/json" \
      --data '{"label":"iPhone 17"}' \
      'http://127.0.0.1:3192/api/sync/v1/admin/vaults/<vault-id>/devices'

The response contains a newly generated deviceId and an
**ignis_dev_... token shown once**. Copy this device token into the
Connector settings on that device. The plugin verifies the credential
against GET /api/sync/v1/vaults/<vault-id>/session at the manually approved
HTTPS origin *before* saving it. If supported, Obsidian SecretStorage holds
the credential; it is never included in the plugin's data.json. Loopback
HTTP is only for trusted local development.

To list or revoke devices, again from the trusted server host:

    curl -H "Authorization: Bearer $IGNIS_SYNC_TOKEN" \
      'http://127.0.0.1:3192/api/sync/v1/admin/vaults/<vault-id>/devices'

    curl -X DELETE -H "Authorization: Bearer $IGNIS_SYNC_TOKEN" \
      'http://127.0.0.1:3192/api/sync/v1/admin/devices/<device-id>'

Revocation is immediate for the new Sync API. Existing authenticated Sync
WebSocket sessions are closed with code 4003, and a revoked client will not
automatically reconnect with the rejected credential. Another device
enrolled to the same Vault remains authorized. Device tokens are random
256-bit secrets, stored **only as SHA-256 hashes** in the server SQLite DB;
the admin device-list endpoint never returns them. These are intentionally
simple, explicit admin-approved enrollments; unattended QR pairing and
device approval screens are separate UX work.

**Network security limitation:** The device token only protects the new
Sync API and sync channel. Existing Ignis file APIs, the separate browser-facing collaboration WebSocket handlers
and file-resource endpoints are still unauthenticated. A network-facing
deployment must protect the *entire* Ignis origin using a trusted network
or an authenticated HTTPS reverse proxy. Device revocation alone is **not**
complete server-wide access control, and must not be represented as such.
Do not publish a bare instance. The bootstrap administrator token should
remain on a trusted host and never be entered in an Obsidian client.

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
The same DB has a small devices table with deviceId, Vault assignment, label,
hashed token, enrollment time and optional revocation time. Administrator
enrollment/list/revocation is a distinct authorization boundary from
per-device Vault synchronization. Existing Ignis deployments that used the
old shared token inside Connector settings need to enroll each device and
replace the credential; the administrator token no longer authorizes normal
Sync REST or Sync WSS.

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
The Sync API has its own 6 MiB JSON parser ceiling, applied before Ignis's
legacy global parser, including requests with chunked transfer encoding.
This bounds server memory consumption even when the legacy API permits
larger request bodies.

The Connector keeps local user text in the ordinary Obsidian Vault and records
observed pending rename/delete operations in plugin data. Create and modify
requests are also staged with their exact immutable payload and opId **before
network transmission**. If an HTTP response is lost, the client queries the
server's durable operation receipt and either acknowledges the original
request or retries exactly the same bytes. A changed local file cannot cause
a different request to be replayed under the old opId. These staged payloads
are bounded to 4 MiB per file but can increase plugin data size; larger
Vaults need an IndexedDB-backed outbound queue.

The Connector never infers a deletion simply from an absent file.
It reads the contiguous server change journal, including pagination, before
advancing its synchronization cursor. An optional setting can move a local
file to Obsidian's recoverable .trash only when the journal contains a
matching deletion tombstone for the same fileId and generationId, and the
local SHA-256 still equals its last confirmed baseline. The .trash folder,
Obsidian settings and Ignis temporary files are excluded from synchronization
even with different capitalization. Without explicit opt-in, remote deletion
remains a review item and the local file stays untouched.

First-sync collisions and concurrent edits require review. The "Review Ignis
sync issues" command displays persistent file-specific reasons and lets the
user open existing local notes without inventing missing files. Open native
Markdown editors are **never overwritten by
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
The deferred IME update queue is capped at 4 MiB: exceeding that limit
blocks the room and preserves the native draft rather than exhausting
mobile WebView memory or applying a partial remote history.

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
All plugin settings writes are serialized in FIFO order with immutable
snapshots. A slower earlier Obsidian saveData call therefore cannot overwrite
a newer queued operation, even if the earlier write fails.

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
two concurrent Yjs clients and their convergent edits, collaborative edits
and their durable journal ACK, binary create/download/
modify, chained offline rename/delete operations, bounded downloads, duplicate
operation retries, durable lost-response receipt lookup, stale-write refusal,
per-device Vault scope, server
restart, individual device revocation with immediate WSS closure and
another device's continued access,
then cleans up.
No installed Ignis process is stopped or modified.

## Next milestones

1. Verify the native CodeMirror 6 / Yjs binding on **real iOS hardware**,
   especially Japanese IME, native background suspension and Undo in
   multiple editor panes. Automated CM6/IndexedDB tests are not a substitute.
   Harden active-room cross-device renames and path transitions.
2. Add user-friendly device approval and pairing UI, plus complete
   authentication for existing browser file APIs and collaboration channels.
3. Incremental journal capture, richer conflict-resolution UI, and out-of-band rename
   recognition for files without collaborative identity.
4. Resumable content-addressed binary attachments exceeding 4 MiB, with
   streaming IO and tighter iOS memory budgets.
5. Real iOS lifecycle, initial migration, Unicode/case and crash-injection tests.
