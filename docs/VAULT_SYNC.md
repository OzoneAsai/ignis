# Ignis Vault Sync: experimental implementation

The existing Ignis HTTP server now supports a single HTTPS/WSS sync path for
native Obsidian desktop and mobile. The ordinary Obsidian Connector currently
synchronizes **closed Markdown files**. Native live Yjs/CodeMirror editing,
binary files, and automatic deletion propagation are not implemented.

## Architecture

| Component | Responsibility |
| --- | --- |
| server/sync/store.js | One SQLite WAL/FULL journal, file identities, sequences, conditional operations |
| server/sync/http.js | Bearer-guarded REST API and authenticated sync channel on the existing WebSocket |
| server/sync/discovery.js | Optional HTTPS Global Discovery v3 announcement with client certificate |
| apps/obsidian-ignis-connector | One desktop/iOS/Android plugin using Obsidian Vault APIs and HTTPS/WSS |

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
External filesystem renames can currently appear as delete/create. Existing
browser Yjs rooms still use paths, so this migration remains incomplete.

The server checks the supplied generation and previous content hash before
accepting changes. Collaborative notes with existing Yjs histories reject
whole-file updates. Writes use synced temporary files and atomic replacement,
followed by SQLite commit before an ACK. A crash between file replacement
and journal commit appears as an unacknowledged external modification during
recovery, not as a falsely acknowledged operation.

The Connector keeps local user text in the ordinary Obsidian Vault and records
observed pending rename/delete operations in plugin data. It never infers a
deletion simply from an absent file; first-sync collisions and concurrent
edits require review. Open native Markdown editors are never overwritten:
native CodeMirror/Yjs integration is a separate future step. Hidden Obsidian
settings and plugin state are excluded, and iOS background execution is not
promised. Current plugin sync is Markdown-only.

## Validation

    npm run lint
    npm test
    npm run build --workspace @ignis/obsidian-connector
    node scripts/sync-smoke.mjs

The smoke script creates an isolated temporary Vault and Ignis process,
checks REST auth, manifest and cursor behavior, WSS notifications, duplicate
operation retries, stale-write refusal and server restart, then cleans up.
No installed Ignis process is stopped or modified.

## Next milestones

1. Link stable file identities to existing Yjs room generations; bind native
   Obsidian CodeMirror 6 and verify composition/Undo on a real iPhone.
2. Replace the shared preview token with per-device pairing and revocation.
3. Incremental journal capture, external rename reconciliation, recovery UI.
4. Content-addressed resumable binary attachments and bounded iOS memory use.
5. Real iOS lifecycle, initial migration, Unicode/case and crash-injection tests.
