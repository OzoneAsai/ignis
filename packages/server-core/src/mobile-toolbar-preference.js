// Device-local preference for Obsidian's built-in editor toolbar.
// Keep this separate from mobileToolbarCommands: those are the user's chosen
// commands, and changing placement must never destroy the command list.
export const MOBILE_TOOLBAR_KEY = "ignis.mobile-toolbar-placement";
export const MOBILE_TOOLBAR_EVENT = "ignis:mobile-toolbar-placement";

export const MOBILE_TOOLBAR_PLACEMENTS = ["hidden", "top", "bottom"];

export function readMobileToolbarPlacement(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(MOBILE_TOOLBAR_KEY);
    return MOBILE_TOOLBAR_PLACEMENTS.includes(value) ? value : "bottom";
  } catch {
    return "bottom";
  }
}

export function applyMobileToolbarPlacement(
  placement,
  { storage = globalThis.localStorage, doc = document, win = window } = {},
) {
  if (!MOBILE_TOOLBAR_PLACEMENTS.includes(placement)) {
    throw new TypeError("Invalid mobile toolbar placement");
  }
  // Effective change is immediate, even when Safari storage is unavailable.
  doc.body.dataset.ignisMobileToolbar = placement;
  try {
    storage?.setItem(MOBILE_TOOLBAR_KEY, placement);
  } catch { /* The UI still works for this session. */ }
  win.dispatchEvent(new CustomEvent(MOBILE_TOOLBAR_EVENT, { detail: placement }));
}

export function installMobileToolbarPlacement(
  app,
  { doc = document, win = window, storage = globalThis.localStorage } = {},
) {
  const toolbar = app?.mobileToolbar;
  if (!toolbar) return () => {};

  const originalShow = toolbar.show;
  const current = () => doc.body.dataset.ignisMobileToolbar ||
    readMobileToolbarPlacement(storage);

  // The extracted Obsidian MobileToolbar.update() calls .show() when the
  // editor has focus. Intercept that method, not the editor's focus logic,
  // so the 'hidden' mode doesn't hide the normal mobile navigation as well.
  toolbar.show = function (...args) {
    if (current() === "hidden") {
      if (this.isVisible) this.hide();
      return;
    }
    return originalShow.apply(this, args);
  };

  const update = () => {
    const mode = readMobileToolbarPlacement(storage);
    if (doc.body.dataset.ignisMobileToolbar !== mode) {
      doc.body.dataset.ignisMobileToolbar = mode;
    }
    if (mode === "hidden") {
      if (toolbar.isVisible) toolbar.hide();
    } else {
      toolbar.update?.();
    }
  };

  // Prefer the dispatched value to another storage read: Safari may allow a
  // temporary preference even if storage writes are denied.
  const onChange = (event) => {
    const value = MOBILE_TOOLBAR_PLACEMENTS.includes(event.detail)
      ? event.detail : readMobileToolbarPlacement(storage);
    doc.body.dataset.ignisMobileToolbar = value;
    if (value === "hidden") {
      if (toolbar.isVisible) toolbar.hide();
    } else {
      toolbar.update?.();
    }
  };
  win.addEventListener(MOBILE_TOOLBAR_EVENT, onChange);
  update();

  return () => {
    win.removeEventListener(MOBILE_TOOLBAR_EVENT, onChange);
    toolbar.show = originalShow;
  };
}
