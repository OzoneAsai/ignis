const path = require("node:path");

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function dictEntry(key, value) {
  return `  <key>${xml(key)}</key>\n  <string>${xml(value)}</string>`;
}

// Pure generator. Installing a LaunchAgent and invoking launchctl must be
// explicit higher-level operations; merely starting Ignis does neither.
function createLaunchAgent({ instanceId, executable, homeDir,
  guiPort = 8386, keepAlive = true } = {}) {
  if (typeof instanceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(instanceId)) {
    throw new Error("Invalid Syncthing instance ID");
  }
  if (typeof executable !== "string" || !path.isAbsolute(executable) ||
      typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    throw new Error("Syncthing executable and homeDir must be absolute");
  }
  if (!Number.isInteger(guiPort) || guiPort < 1024 || guiPort > 65535) {
    throw new Error("Invalid loopback GUI port");
  }
  const label = `dev.ignis.syncthing.${instanceId}`;
  const args = [
    executable,
    "serve",
    `--home=${path.resolve(homeDir)}`,
    `--gui-address=127.0.0.1:${guiPort}`,
    "--no-browser",
    "--no-restart",
  ];
  const entries = args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
  return {
    label,
    programArguments: args,
    xml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ',
      '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      dictEntry("Label", label),
      '  <key>ProgramArguments</key>',
      '  <array>',
      entries,
      '  </array>',
      dictEntry("WorkingDirectory", path.resolve(homeDir)),
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '  <key>KeepAlive</key>',
      keepAlive ? '  <true/>' : '  <false/>',
      '</dict>',
      '</plist>',
      '',
    ].join("\n"),
  };
}

module.exports = { createLaunchAgent };
