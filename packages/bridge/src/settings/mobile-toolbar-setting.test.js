// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  patchNativeMobileToolbarSettings, mobileToolbarSettingsGroup,
} from "./mobile-toolbar-setting.js";
import { MOBILE_TOOLBAR_KEY } from "../../../server-core/src/mobile-toolbar-preference.js";

beforeEach(() => {
  const values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.removeAttribute("data-ignis-mobile-toolbar");
});

function nativeSettingsHarness() {
  const existing = { type: "list", heading: "Manage toolbar options", items: ["Undo"] };
  const original = vi.fn(() => ({
    type: "page", id: "mobile-toolbar", items: [existing],
  }));
  const tab = { buildToolbarPageDef: original };
  return { app: { setting: { settingTabs: [tab] } }, tab, original, existing };
}

function dropdownFromDefinition(definition) {
  const values = new Map();
  const select = {
    addOption(value, label) { values.set(value, label); return this; },
    setValue(value) { this.value = value; return this; },
    onChange(callback) { this.change = callback; return this; },
  };
  definition.render({ addDropdown(callback) { callback(select); } });
  return { select, values };
}

describe("Ignis placement selector inside the extracted Obsidian toolbar page", () => {
  it("prepends one three-choice selector without replacing native toolbar options", () => {
    localStorage.setItem("language", "ja");
    const { app, tab, existing, original } = nativeSettingsHarness();
    const stop = patchNativeMobileToolbarSettings(app);
    const page = tab.buildToolbarPageDef();
    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toBe(existing);
    expect(page.items[0].name).toContain("ツールバーの表示位置");
    const { select, values } = dropdownFromDefinition(page.items[0]);
    expect([...values.keys()]).toEqual(["hidden", "top", "bottom"]);
    expect([...values.values()]).toEqual([
      "表示しない", "上に表示", "下に表示（既定）",
    ]);
    expect(select.value).toBe("bottom");
    select.change("top");
    expect(localStorage.getItem(MOBILE_TOOLBAR_KEY)).toBe("top");
    expect(document.body.dataset.ignisMobileToolbar).toBe("top");
    stop();
    expect(tab.buildToolbarPageDef).toBe(original);
  });

  it("loads the persisted mode in Japanese and English settings", () => {
    localStorage.setItem(MOBILE_TOOLBAR_KEY, "hidden");
    localStorage.setItem("language", "en");
    const { app, tab } = nativeSettingsHarness();
    const stop = patchNativeMobileToolbarSettings(app);
    const { select, values } = dropdownFromDefinition(tab.buildToolbarPageDef().items[0]);
    expect(select.value).toBe("hidden");
    expect(values.get("top")).toBe("At the top");
    stop();
  });

  it("preserves the page and other settings when the expected native tab is absent", () => {
    expect(() => patchNativeMobileToolbarSettings({
      setting: { settingTabs: [] },
    })()).not.toThrow();
    expect(mobileToolbarSettingsGroup().items).toHaveLength(1);
  });
});
