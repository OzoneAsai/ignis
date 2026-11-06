import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The official 'obsidian' npm package provides TypeScript declarations only:
// it has no JS entrypoint. Obsidian itself supplies the runtime in its app.
// Resolve imports to an inert stub in Node tests, while individual suites
// can vi.mock('obsidian') with the API shape they need.
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./scripts/obsidian-vitest-stub.mjs", import.meta.url))
    }
  }
});
