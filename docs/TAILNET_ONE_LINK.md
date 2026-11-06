# One-link connection with Tailscale Serve

The native Ignis Connector can use a **secret-free invitation link** rather
than asking for a server URL, Vault ID and bearer token separately.

    https://your-mac.your-tailnet.ts.net:8452/join/IOSLab

Open the link in Safari and tap **Open in Obsidian**, then review and confirm
the connection. Or paste the complete link into the Connector's
**Connection link** field. A plain server origin triggers automatic Vault
discovery. Multiple Vaults are shown as a picker instead of manual IDs.

The invite link contains no authorization credentials. Possession of this
link does not grant Vault access.

## Authentication and revocation

Tailscale Serve authenticates the user's Tailnet identity and removes
spoofed identity headers from incoming traffic. Ignis maps the login name
to an **explicit per-Vault allowlist**. For Tailnet users, there is no
additional browser sign-in or manually copied device token. Tailscale's
identity provider can itself use OAuth/OIDC. A separate public OAuth/PKCE
adapter is not implemented by this feature.

Ignis creates one **server-side, revocable principal per user and Vault**,
identified by an HMAC of the server administrator secret and identity.
No bearer token is returned to the client, and revoked identities stay
revoked until deliberately re-enrolled. HTTP sessions, Vault changes and
file operations, WebSocket Sync and collaborative Yjs join all enforce
authorization. Multiple devices belonging to the same Tailnet user
share a Vault principal; each editor has its own socket-level presence.

## Private server configuration

The following example assumes a private Mac server. Set a private
administrator secret of at least 32 bytes, use the exact Tailscale user
login in lowercase and specify Vault permissions explicitly.

    IGNIS_BIND_HOST=127.0.0.1
    PORT=32960
    IGNIS_SYNC_TOKEN=<private administrator secret>
    IGNIS_TAILNET_ACCESS='{"alice@example.com":["IOSLab"]}'

Keep VAULT_ROOT and DATA_ROOT separate from your existing installation.
An empty policy disables Tailnet login. Wildcards are not accepted. The
server refuses to enable Tailnet authentication on a non-loopback bind
address or without the administrator credential.

The HTTPS gateway must expose only Sync, join links and a Vault-scoped
WebSocket. The following is an example Caddyfile:

    {
      admin off
      auto_https off
    }
    :32961 {
      bind 127.0.0.1
      handle /api/sync/v1/admin/* {
        respond "Not found" 404
      }
      handle /api/sync/v1/* {
        reverse_proxy http://127.0.0.1:32960
      }
      handle /join/* {
        reverse_proxy http://127.0.0.1:32960
      }
      @syncSocket {
        path /ws
        query vault=IOSLab
      }
      handle @syncSocket {
        reverse_proxy http://127.0.0.1:32960 {
          header_up X-Ignis-Tailnet-Only "1"
        }
      }
      handle {
        respond "Not found" 404
      }
    }

Publish privately with:

    tailscale serve --bg --https=8452 http://127.0.0.1:32961

**Do not enable Funnel** for this endpoint. Restrict the gateway to Mac
loopback. Tailscale Serve removes forged Tailscale-User-Login headers
from Tailnet requests, but a process that can send requests directly
on the same Mac could forge local headers. Local execution access is
within the trusted boundary. Tagged Tailnet devices do not supply user
identity headers and are denied by this user-based authorization mode.

## Existing servers, offline operation and errors

- A self-hosted server that does not support Tailscale identity can still
  use **Advanced → Device token**, preserving legacy compatibility.
- No network calls happen while typing. Settings change only after the
  explicit **Connect and verify** action has succeeded.
- Unknown Tailnet users and Vaults fail closed with an actionable error;
  the connection link does not silently create a Vault or grant permission.
- Switching origin/Vault with unsent operations is refused. The old local
  data and pending edits are retained for recovery.
- Offline local edits remain available. The Connector reconnects over
  HTTPS/WSS and reconciles server changes when network access returns.

Run the optional read-only live test from a Tailnet-connected Mac:

    IGNIS_JOIN_URL=https://your-mac.your-tailnet.ts.net:8452/join/IOSLab node scripts/tailnet-ux-smoke.mjs

For users outside Tailscale, a proper OAuth/OIDC PKCE adapter can be added
without changing the Vault model. This initial feature deliberately
avoids making every Tailnet device pass through a second login screen.
