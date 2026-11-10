import { build } from "esbuild";
import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const out = join(root, "dist");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(out, "main.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["obsidian", "electron"],
  legalComments: "none",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  banner: { js: `/* Ignis Media Desktop v${manifest.version} */` },
});
copyFileSync(join(root, "manifest.json"), join(out, "manifest.json"));
