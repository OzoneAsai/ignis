"use strict";

// A small, explicit authorization model for Tailscale Serve. Serve removes
// spoofed identity headers and populates these only for authenticated users.
// Trust them ONLY on a loopback-bound Ignis instance behind Serve; never
// expose the same origin through Funnel or a directly reachable public proxy.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const USER = /^[a-z0-9][a-z0-9._+@-]{0,253}$/;
const VAULT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseTailnetAccess(json = "") {
  if (!json) return new Map();
  let raw;
  try { raw = JSON.parse(json); }
  catch { throw new Error("IGNIS_TAILNET_ACCESS must be a JSON object"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("IGNIS_TAILNET_ACCESS must map login names to Vault IDs");
  }
  const result = new Map();
  for (const [name, vaults] of Object.entries(raw)) {
    const login = name.toLowerCase();
    if (!USER.test(login) || name !== login || !Array.isArray(vaults) ||
        !vaults.length || vaults.length > 64 ||
        vaults.some((vault) => typeof vault !== "string" || !VAULT.test(vault))) {
      throw new Error("Invalid Tailscale user/Vault access policy");
    }
    result.set(login, new Set(vaults));
  }
  return result;
}

function tailnetPrincipal(headers, remoteAddress, access, vaultId) {
  if (!LOOPBACK.has(remoteAddress) || access.size === 0) return null;
  const header = headers?.["tailscale-user-login"];
  if (typeof header !== "string" || !USER.test(header.toLowerCase())) return null;
  const login = header.toLowerCase();
  if (vaultId && !access.get(login)?.has(vaultId)) return null;
  return access.has(login) ? login : null;
}

function authorizedVaults(access, login) {
  return login && access.has(login) ? [...access.get(login)] : [];
}

module.exports = { parseTailnetAccess, tailnetPrincipal, authorizedVaults };
