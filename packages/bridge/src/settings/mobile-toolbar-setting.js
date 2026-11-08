import { mobileUiLanguage } from "../../../server-core/src/mobile-ui-copy.ts";
import {
  readMobileToolbarPlacement, applyMobileToolbarPlacement,
} from "../../../server-core/src/mobile-toolbar-preference.js";

const copy = {
  ja: {
    heading: "モバイルツールバー",
    name: "ツールバーの表示位置",
    desc: "ノート編集中のツールバーを表示する位置です。コマンドの並び順はそのまま保持されます。",
    hidden: "表示しない",
    top: "上に表示",
    bottom: "下に表示（既定）",
  },
  en: {
    heading: "Mobile toolbar",
    name: "Toolbar position",
    desc: "Where to display the toolbar while editing a note. Your configured commands are preserved.",
    hidden: "Don't show",
    top: "At the top",
    bottom: "At the bottom (default)",
  },
};

function mobileToolbarPlacementDefinition(language = mobileUiLanguage()) {
  const t = copy[language] || copy.en;
  return {
    name: t.name,
    desc: t.desc,
    render(setting) {
      setting.addDropdown((dropdown) => {
        dropdown.addOption("hidden", t.hidden);
        dropdown.addOption("top", t.top);
        dropdown.addOption("bottom", t.bottom);
        dropdown.setValue(readMobileToolbarPlacement());
        dropdown.onChange((next) => {
          applyMobileToolbarPlacement(next);
        });
      });
    },
  };
}

// This is the EXACT built-in settings page opened by Obsidian's
// "Configure mobile toolbar" command (buildToolbarPageDef in extracted
// app.js). Keep the standard command list and prepend the placement setting.
export function patchNativeMobileToolbarSettings(app) {
  const tab = app.setting?.settingTabs?.find(
    item => typeof item.buildToolbarPageDef === "function",
  );
  if (!tab) return () => {};

  const original = tab.buildToolbarPageDef;
  tab.buildToolbarPageDef = function (...args) {
    const page = original.apply(this, args);
    if (page?.id === "mobile-toolbar" && Array.isArray(page.items)) {
      page.items.unshift(mobileToolbarPlacementDefinition());
    }
    return page;
  };
  return () => {
    tab.buildToolbarPageDef = original;
  };
}

export function mobileToolbarSettingsGroup() {
  return {
    type: "group",
    heading: (copy[mobileUiLanguage()] || copy.en).heading,
    items: [mobileToolbarPlacementDefinition()],
  };
}
