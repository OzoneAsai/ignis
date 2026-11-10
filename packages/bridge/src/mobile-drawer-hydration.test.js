import { describe, expect, it, vi } from "vitest";
import {
  findUnhydratedMobileLeaves,
  installMobileDrawerHydration,
} from "./mobile-drawer-hydration.js";

function fixture({ mobile = true, mounted = false, active = true } = {}) {
  const drawer = {
    classList: { contains: (name) => name === "workspace-drawer" },
    contains: (node) => node === host,
  };
  const host = {
    querySelector: () => ({ getAttribute: () => mounted ? "file-explorer" : "undefined" }),
  };
  const leaf = {
    containerEl: host,
    getViewState: () => ({ type: "file-explorer" }),
    view: { getViewType: () => "file-explorer" },
  };
  const doc = {
    body: { classList: { contains: () => mobile } },
    querySelectorAll: () => active ? [drawer] : [],
  };
  const workspace = {
    iterateAllLeaves: (callback) => callback(leaf),
    revealLeaf: vi.fn(async () => { mounted = true; }),
  };
  return { doc, workspace, leaf, drawer };
}

describe("mobile drawer hydration", () => {
  it("finds an active unmounted leaf without creating one", () => {
    const f = fixture();
    expect(findUnhydratedMobileLeaves({ workspace: f.workspace }, f.doc)).toEqual([f.leaf]);
  });
  it("leaves desktop, closed drawers, and mounted views alone", () => {
    for (const opts of [{ mobile: false }, { active: false }, { mounted: true }]) {
      const f = fixture(opts);
      expect(findUnhydratedMobileLeaves({ workspace: f.workspace }, f.doc)).toEqual([]);
    }
  });
  it("reveals the stale view once and disconnects on unload", async () => {
    const f = fixture();
    let tick;
    let onChange;
    const Observer = class {
      constructor(callback) { onChange = callback; }
      observe() {}
      disconnect() { this.disconnected = true; }
    };
    const uninstall = installMobileDrawerHydration({ workspace: f.workspace }, {
      doc: f.doc, Observer, schedule: (callback) => { tick = callback; },
    });
    tick();
    await vi.waitFor(() => expect(f.workspace.revealLeaf).toHaveBeenCalledOnce());
    onChange([{ target: f.drawer }]);
    tick();
    expect(f.workspace.revealLeaf).toHaveBeenCalledOnce();
    uninstall();
    onChange([{ target: f.drawer }]);
    expect(f.workspace.revealLeaf).toHaveBeenCalledOnce();
  });
});
