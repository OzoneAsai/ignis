import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

describe("boot splash and tab branding", () => {
  it("references the shipped ORIGINAL splash image, not an absent release-root favicon", () => {
    const splashImage = html.match(/<div id="ignis-status">\s*<img src="([^"]+)"/);
    expect(splashImage?.[1]).toBe("/assets/ignis-splash.png");
    const image = path.join(root, splashImage[1].replace(/^\/assets\//, ""));
    expect(fs.statSync(image).size).toBeGreaterThan(1000);
    expect(fs.readFileSync(image).subarray(1, 4).toString()).toBe("PNG");
  });

  it("tab icon points to an existing PNG", () => {
    const href = html.match(/<link rel="icon" type="image\/png" href="([^"]+)"/)?.[1];
    expect(href).toBe("/assets/ignis-splash.png");
    const file = path.join(root, href.replace(/^\/assets\//, ""));
    expect(fs.readFileSync(file).subarray(1, 4).toString()).toBe("PNG");
    expect(html).not.toContain('src="favicon.png"');
  });

  it("preserves the splash until scripts finish and its pulsing animation", () => {
    expect(html).toContain("id=\"ignis-status-label\"");
    expect(html).toContain("animation: ignis-pulse 1.6s");
    expect(html).toContain('status.classList.add("fade")');
  });
});
