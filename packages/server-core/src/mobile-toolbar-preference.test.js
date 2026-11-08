// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOBILE_TOOLBAR_KEY, readMobileToolbarPlacement,
  applyMobileToolbarPlacement, installMobileToolbarPlacement,
} from "./mobile-toolbar-preference.js";

afterEach(() => {
  document.body.removeAttribute("data-ignis-mobile-toolbar");
});

function storage(value) {
  const values = new Map(value === undefined ? [] : [[MOBILE_TOOLBAR_KEY, value]]);
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, next) => values.set(key, next),
  };
}

function toolbar() {
  return {
    isVisible: false,
    show: vi.fn(function () { this.isVisible = true; }),
    hide: vi.fn(function () { this.isVisible = false; }),
    update: vi.fn(function () { this.show(); }),
  };
}

describe("native Obsidian editor toolbar placement preference", () => {
  it("defaults to bottom and treats corrupt storage as bottom", () => {
    expect(readMobileToolbarPlacement(storage())).toBe("bottom");
    expect(readMobileToolbarPlacement(storage("left"))).toBe("bottom");
    expect(readMobileToolbarPlacement({ getItem() { throw Error("blocked"); } }))
      .toBe("bottom");
  });

  it("persists all three choices without changing native toolbar command IDs", () => {
    const store = storage();
    const commands = ["editor:undo", "editor:redo"];
    const app = { mobileToolbar: toolbar(), vault: {
      getConfig: () => commands,
    } };
    const stop = installMobileToolbarPlacement(app, { storage: store });
    for (const value of ["top", "hidden", "bottom"]) {
      applyMobileToolbarPlacement(value, { storage: store });
      expect(readMobileToolbarPlacement(store)).toBe(value);
      expect(document.body.dataset.ignisMobileToolbar).toBe(value);
      expect(app.vault.getConfig("mobileToolbarCommands")).toEqual(commands);
    }
    stop();
  });

  it("suppresses native show() when hidden and restores the nav on a transition", () => {
    const store = storage("bottom");
    const control = toolbar();
    const original = control.show;
    const stop = installMobileToolbarPlacement({ mobileToolbar: control }, { storage: store });
    control.show();
    expect(control.isVisible).toBe(true);
    applyMobileToolbarPlacement("hidden", { storage: store });
    expect(control.isVisible).toBe(false);
    control.show();
    expect(control.isVisible).toBe(false);
    applyMobileToolbarPlacement("top", { storage: store });
    expect(control.isVisible).toBe(true);
    stop();
    expect(control.show).toBe(original);
  });

  it("allows immediate display if Safari rejects localStorage writes", () => {
    const denied = {
      getItem() { throw Error("SecurityError"); },
      setItem() { throw Error("SecurityError"); },
    };
    const control = toolbar();
    const stop = installMobileToolbarPlacement({ mobileToolbar: control }, { storage: denied });
    applyMobileToolbarPlacement("hidden", { storage: denied });
    expect(document.body.dataset.ignisMobileToolbar).toBe("hidden");
    control.show();
    expect(control.isVisible).toBe(false);
    stop();
  });

  it("rejects unexpected placement values", () => {
    expect(() => applyMobileToolbarPlacement("sidebar", { storage: storage() }))
      .toThrow(TypeError);
  });
});
