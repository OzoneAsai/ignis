import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLaunchAgent } = require("./launchd");

describe("launchd configuration for a Syncthing sidecar service", () => {
  it("generates a persistent user agent without installing or starting it", () => {
    const definition = createLaunchAgent({
      instanceId: "fixed-a",
      executable: "/opt/homebrew/bin/syncthing",
      homeDir: "/Users/test/Library/Application Support/Ignis/Syncthing",
    });
    expect(definition.label).toBe("dev.ignis.syncthing.fixed-a");
    expect(definition.programArguments).toContain("serve");
    expect(definition.programArguments).toContain("--gui-address=127.0.0.1:8386");
    expect(definition.programArguments).toContain("--no-browser");
    expect(definition.xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(definition.xml).toContain("<key>KeepAlive</key>\n  <true/>");
  });

  it("escapes untrusted path characters in plist XML", () => {
    const result = createLaunchAgent({
      instanceId: "fixed-a",
      executable: "/Applications/Syncthing & Friends/bin/syncthing",
      homeDir: "/Users/test/My <Vault> & Friends",
    });
    expect(result.xml).toContain("Syncthing &amp; Friends");
    expect(result.xml).toContain("My &lt;Vault&gt; &amp; Friends");
    expect(result.xml).not.toContain("My <Vault>");
  });

  it("rejects invalid labels, relative executables, and privileged ports", () => {
    const base = { instanceId: "fixed-a", executable: "/bin/syncthing", homeDir: "/tmp/st" };
    expect(() => createLaunchAgent({ ...base, instanceId: "../../evil" })).toThrow();
    expect(() => createLaunchAgent({ ...base, executable: "syncthing" })).toThrow();
    expect(() => createLaunchAgent({ ...base, guiPort: 80 })).toThrow();
  });
});
