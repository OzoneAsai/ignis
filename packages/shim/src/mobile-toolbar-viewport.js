// Obsidian's extracted mobile toolbar is positioned using --keyboard-height,
// normally supplied by its native iOS/Android shell. Safari does not provide
// those keyboardWillShow events, and 100dvh is not guaranteed to shrink when
// the software keyboard opens. Use the visible viewport's real bottom edge.
export function installMobileToolbarViewport(win = window, doc = document) {
  const root = doc.documentElement;
  const property = "--ignis-mobile-visual-bottom";
  const viewport = win.visualViewport;
  if (!viewport) return () => {};

  const update = () => {
    // visualViewport.offsetTop/height are in layout CSS pixels; the toolbar's
    // absolute top is likewise positioned in layout CSS pixels.
    const bottom = viewport.offsetTop + viewport.height;
    const layoutHeight = doc.documentElement.clientHeight || win.innerHeight;
    if (!Number.isFinite(bottom) || !Number.isFinite(layoutHeight) ||
        bottom <= 0 || layoutHeight <= 0) return;
    const px = `${Math.round(Math.min(bottom, layoutHeight) * 100) / 100}px`;
    if (root.style.getPropertyValue(property) !== px) {
      root.style.setProperty(property, px);
    }
  };

  viewport.addEventListener("resize", update, { passive: true });
  viewport.addEventListener("scroll", update, { passive: true });
  win.addEventListener("resize", update, { passive: true });
  win.addEventListener("orientationchange", update);
  win.addEventListener("focusin", update);
  update();

  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    win.removeEventListener("resize", update);
    win.removeEventListener("orientationchange", update);
    win.removeEventListener("focusin", update);
    root.style.removeProperty(property);
  };
}
