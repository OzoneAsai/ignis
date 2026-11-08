#!/usr/bin/env node
// A human-readable local-only configuration console for the IGNIS Vault Sync
// server. The administrator token is read from the process environment,
// never pasted into Obsidian or printed to stdout.
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const { normalizeMediaBypassExtensions } =
  require("../packages/sync-policy/src/media-bypass");

const HELP = `IGNIS Vault file sharing — local administrator setup

  node scripts/ignis-sync-setup.mjs show --vault VAULT_ID [--port 3192]
  node scripts/ignis-sync-setup.mjs preview --vault VAULT_ID --mode markdown-only
  node scripts/ignis-sync-setup.mjs set --vault VAULT_ID --mode markdown-only
  node scripts/ignis-sync-setup.mjs bypass-show --vault VAULT_ID
  node scripts/ignis-sync-setup.mjs bypass-preview --vault VAULT_ID --types pdf,docx,xlsx,pptx
  node scripts/ignis-sync-setup.mjs bypass-set --vault VAULT_ID --types pdf,docx,xlsx,pptx

Run on the Mac hosting IGNIS with IGNIS_SYNC_TOKEN in the shell environment.
The server API is contacted ONLY through 127.0.0.1 (loopback).

Modes:
  markdown-only   Share .md notes; photos/videos stay on each device
  all             Share .md and small attachments (4 MiB per file)

Bypass exceptions are owner-approved types sent through IGNIS Sync regardless
of Syncthing status. The default is no exceptions. Device preferences may
narrow these choices. Removing an exception from a journaled Vault is blocked
until an explicit migration is complete.

First select the setting BEFORE enrolling devices or creating journal
history. Changing an active Vault is blocked until an explicit migration
workflow is available. Preview reads only metadata; no files are uploaded,
deleted, hashed or sent to Syncthing.

Use --yes for confirmed noninteractive administration, not normal setup.
`;

export function parseArgs(argv, env = process.env) {
  const [operation = "help", ...rest] = argv;
  const isBypass = operation.startsWith("bypass-");
  if (!["help", "show", "preview", "set",
    "bypass-show", "bypass-preview", "bypass-set"].includes(operation)) {
    throw new Error("Unknown command. Run help for supported operations.");
  }
  let vault;
  let mode;
  let types = null;
  let port = env.PORT || "3192";
  let yes = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--yes") { yes = true; continue; }
    const value = rest[++i];
    if (!value || value.startsWith("--")) {
      throw new Error("Missing value for an option");
    }
    if (flag === "--vault") vault = value;
    else if (flag === "--mode") mode = value;
    else if (flag === "--types") {
      if (!isBypass || types !== null) throw new Error("Invalid --types usage");
      types = normalizeMediaBypassExtensions(value.split(","));
    }
    else if (flag === "--port") port = value;
    else throw new Error("Unknown option");
  }
  if (operation !== "help") {
    if (!vault || vault.length > 200 ||
        [...vault].some((character) => character.charCodeAt(0) < 32)) {
      throw new Error("A valid --vault value is required");
    }
    if (!/^\d+$/.test(String(port)) || +port < 1024 || +port > 65535) {
      throw new Error("--port must be between 1024 and 65535");
    }
    if (isBypass) {
      if (mode || (operation === "bypass-show" && types !== null) ||
          (operation !== "bypass-show" && types === null)) {
        throw new Error("Bypass uses --types (except bypass-show), not --mode");
      }
    } else {
      if (types !== null || operation !== "show" &&
          !["all", "markdown-only"].includes(mode)) {
        throw new Error("--mode must be all or markdown-only");
      }
      if (operation === "show" && mode) {
        throw new Error("Use preview to inspect another mode");
      }
    }
    if (typeof env.IGNIS_SYNC_TOKEN !== "string" ||
        Buffer.byteLength(env.IGNIS_SYNC_TOKEN) < 32) {
      throw new Error("Set IGNIS_SYNC_TOKEN on this Mac before using the administrator API");
    }
  }
  return { operation, vault, mode, types, port: Number(port), yes };
}

function detail(state, output) {
  output.write(`Vault: ${state.vaultId}\n`);
  output.write(`Currently shared: ${state.contentScope === "markdown-only"
    ? "Markdown (.md) only" : "Markdown and attachments up to 4 MiB"}\n`);
  output.write(`Configuration: ${state.source}\n`);
  output.write(`Tracked files: ${state.trackedFiles} · Change history: ${state.journalEvents} · Registered devices: ${state.registeredDevices}\n`);
  if (state.requestedScope) {
    output.write(`Requested setting: ${state.requestedScope}\n`);
    output.write(state.canApply
      ? "Safe to apply: no migration is needed.\n"
      : "A migration/review is required; no changes were made.\n");
  }
}

export async function runSyncSetup(argv, {
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  error = process.stderr,
  fetchImpl = globalThis.fetch,
  ask: askOverride,
} = {}) {
  const options = parseArgs(argv, env);
  if (options.operation === "help") {
    output.write(HELP);
    return 0;
  }
  const uri = "http://127.0.0.1:" + options.port +
    "/api/sync/v1/admin/vaults/" + encodeURIComponent(options.vault) +
    (options.operation.startsWith("bypass-") ? "/media-bypass" : "/content-scope");
  const request = async (method, payload, preview = false) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    timer.unref?.();
    try {
      const target = preview ?
        uri + (options.operation.startsWith("bypass-") ?
          "?extensions=" + encodeURIComponent(options.types.join(",")) :
          "?mode=" + encodeURIComponent(options.mode)) : uri;
      const response = await fetchImpl(target, {
        method, redirect: "error", signal: controller.signal,
        headers: {
          Authorization: "Bearer " + env.IGNIS_SYNC_TOKEN,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      const length = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(length) && length > 65536) throw new Error("Unexpected API response size");
      const body = await response.text();
      if (body.length > 65536) throw new Error("Unexpected API response size");
      if (response.status === 401) {
        throw new Error("Administrator token not accepted by this IGNIS server");
      }
      if (response.status >= 400) {
        const message = response.status === 409
          ? "Vault state changed or migration required; refresh the preview"
          : "Server refused settings request (HTTP " + response.status + ")";
        throw new Error(message);
      }
      return JSON.parse(body);
    } finally {
      clearTimeout(timer);
    }
  };
  const state = await request("GET", null,
    options.operation !== "show" && options.operation !== "bypass-show");
  if (options.operation.startsWith("bypass-")) {
    output.write("Vault: " + state.vaultId + "\n");
    output.write("Allowed bypass types: " +
      (state.extensions?.join(", ") || "none") + "\n");
    if (options.operation !== "bypass-show") {
      output.write("Requested: " + options.types.join(", ") + "\n");
      output.write(state.canApply ? "Safe to apply.\n" :
        "Removing existing exceptions requires migration.\n");
    }
    if (options.operation !== "bypass-set") return 0;
    if (!state.canApply) {
      error.write("A migration is required. No changes were made.\n");
      return 2;
    }
    if (JSON.stringify(state.extensions) === JSON.stringify(options.types)) {
      output.write("Already saved. No change needed.\n");
      return 0;
    }
    if (!options.yes && !input.isTTY && !askOverride) {
      error.write("Interactive confirmation required; or use --yes.\n");
      return 2;
    }
    const rl = askOverride ? null : createInterface({
      input, output, terminal: !!input.isTTY,
    });
    try {
      const ask = askOverride || ((question) => rl.question(question));
      if (!options.yes &&
          (await ask("Authorize these file types for IGNIS Sync? yes/no: "))
            .trim().toLowerCase() !== "yes") {
        output.write("No changes were made.\n");
        return 0;
      }
    } finally { rl?.close(); }
    const saved = await request("PUT", {
      extensions: options.types, expectedExtensions: state.extensions,
    });
    output.write(saved.applied ?
      "Media bypass saved durably; Syncthing state is unchanged.\n" :
      "Media bypass was already active.\n");
    return 0;
  }
  detail(state, output);
  if (options.operation === "show" || options.operation === "preview") return 0;
  if (!state.canApply) {
    error.write("The Vault has existing history or devices; settings were not changed.\n");
    return 2;
  }
  if (state.contentScope === options.mode && state.source === "owner") {
    output.write("Already saved by the owner. No change needed.\n");
    return 0;
  }
  if (!options.yes && !input.isTTY && !askOverride) {
    error.write("Interactive confirmation is required; or pass --yes explicitly.\n");
    return 2;
  }
  const rl = askOverride ? null : createInterface({
    input, output, terminal: !!input.isTTY,
  });
  try {
    const ask = askOverride || ((question) => rl.question(question));
    if (!options.yes &&
        (await ask("Save this sharing scope for the selected Vault? yes/no: "))
          .trim().toLowerCase() !== "yes") {
      output.write("No changes were made.\n");
      return 0;
    }
  } finally {
    rl?.close();
  }
  const saved = await request("PUT", {
    contentScope: options.mode,
    expectedScope: state.contentScope,
  });
  output.write(saved.applied
    ? "Saved. This Vault will keep its preference after the server restarts.\n"
    : "No change needed. The saved preference is already active.\n");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSyncSetup(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((failure) => {
    // Never write raw responses or credentials into the terminal.
    const message = failure instanceof Error ? failure.message : "Unknown setup failure";
    process.stderr.write("IGNIS Sync setup: " + message + "\n");
    process.exitCode = 1;
  });
}
