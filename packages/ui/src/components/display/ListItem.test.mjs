import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";

const component = fileURLToPath(new URL("./ListItem.svelte", import.meta.url));

describe("Vault list item keyboard accessibility", () => {
  it("compiles without accessibility warnings", () => {
    const source = readFileSync(component, "utf8");
    const result = compile(source, { filename: component, generate: "dom" });
    expect(result.warnings.filter((item) => item.code.startsWith("a11y-"))).toEqual([]);
  });

  it("keeps row selection independent of the nested action menu", () => {
    const source = readFileSync(component, "utf8");
    expect(source).toContain('<button type="button" class="item-main"');
    expect(source.indexOf('</button>')).toBeLessThan(source.indexOf('class="item-action"'));
    expect(source).toContain('aria-current={active ? "true" : undefined}');
  });
});
