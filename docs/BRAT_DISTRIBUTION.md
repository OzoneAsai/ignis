# Ignis Connector beta distribution

This is the **native Obsidian** connector for the self-hosted Ignis server,
not the web-based Ignis application itself.

## BRAT installation

Install the current BRAT plugin from Obsidian's Community plugins. Use a BRAT
version that supports **GitHub Release assets** (v1.1.0 or later). In BRAT:

1. Choose **Add a beta plugin for testing**.
2. Enter the repository **`OzoneAsai/ignis`**.
3. Select the available Ignis Connector prerelease and enable
   **Ignis Connector** in Obsidian's Community plugins settings.
4. Open Ignis Connector settings. Enter the full **HTTPS server address** (including
   its port), the exact **Vault ID**, and an enrolled **ignis_dev_ device token**.
5. Tap **Connect and verify**. Nothing is sent while you type; rejected credentials
   stay in the masked input so you can correct the Vault ID or server address.
6. After verification succeeds, tap **Sync** or let the Connector synchronize.

The URL, Vault ID, and token are checked **together**. A 404 from the Sync API
is reported separately from an unauthorized device. Tailscale protects the
network route but does not substitute for per-Vault authorization in this beta.

The matching `main.js` and `manifest.json` are served from
[GitHub Releases](https://github.com/OzoneAsai/ignis/releases), so BRAT does
not need to interpret the monorepo's nested plugin directory. If BRAT does
not list a beta release, check the Releases page before retrying.

Obsidian and BRAT have their own minimum-app-version requirements; update
Obsidian if the installed BRAT version is incompatible.

## Manual installation

Download `main.js` and `manifest.json` from the **same** Ignis Connector
prerelease. Copy them into:

    <Obsidian Vault>/.obsidian/plugins/ignis-connector/

Enable the plugin in Community plugins. `SHA256SUMS.txt` in the release
records the hashes of both downloaded files. There is no separate
`styles.css` dependency in this build.

## Beta release procedure

The **`brat-preview` branch** is the distribution snapshot. Its
`apps/obsidian-ignis-connector/manifest.json` is the sole version source.

Each new prerelease must **increase the beta version** (for example,
`0.1.0-beta.1` → `0.1.0-beta.2`). Pushing a version to the distribution
branch triggers `.github/workflows/ignis-connector-brat.yml`.
The workflow installs pinned dependencies, runs quality checks, builds the
browser-compatible plugin and validates the release assets. It publishes
the assets only if the corresponding tag does not already exist. GitHub
Releases are immutable version snapshots; previously published tags and
assets must not be silently replaced.

Do not merge the Draft collaboration PR merely to produce a BRAT preview.
Do not change the default `main` branch to publish this plugin beta.

## Current limitations

This is experimental, server-led Vault synchronization, not an independent
Obsidian Sync service. The server must be deployed and reachable. Avoid
pointing multiple Vault sync plugins at the same files. Start with a
disposable Vault or a verified backup.

Native Yjs editing and collaborator cursors have been tested on macOS.
Large attachments, device enrollment UX, stable large-Vault indexing and
iOS hardware lifecycle are not yet production-certified. The transport
tests currently use localhost HTTP/WS; external HTTPS/WSS deployment
requires its own testing and whole-origin access control.

For the protocol and data-safety design, see
[VAULT_SYNC.md](VAULT_SYNC.md) and
[Mac two-client validation](MAC_TWO_CLIENT_CURSOR_VALIDATION_2026-11-05.md).
