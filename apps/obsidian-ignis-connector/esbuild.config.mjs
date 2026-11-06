import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
await build({
  entryPoints: [new URL("./src/main.ts", import.meta.url).pathname],
  outfile: new URL("./main.js", import.meta.url).pathname,
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  external: ["obsidian", "@codemirror/state", "@codemirror/view"],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  legalComments: "none",
  logLevel: "info",
  banner: { js: "/* Ignis Connector v" + pkg.version + " */" }
});
