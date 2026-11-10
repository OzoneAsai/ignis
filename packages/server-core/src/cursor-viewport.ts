// All CodeMirror carets are anchored to a document position, but their DOM
// rectangles are visual-viewport coordinates. Ensure the overlay's containing
// block is the same editor whose rectangle supplies the coordinate origin,
// and repaint when ANY scroll ancestor or the iOS visual viewport changes.
export function observeCursorViewport(
  host: HTMLElement,
  scrollDOM: HTMLElement,
  repaint: () => void,
  viewportChange: () => void = repaint,
): () => void {
  const owner = host.ownerDocument.defaultView || window;
  const originalPosition = host.style.getPropertyValue("position");
  const originalPriority = host.style.getPropertyPriority("position");
  let adjusted = false;

  const ensureContainingBlock = () => {
    if (owner.getComputedStyle(host).position === "static") {
      host.style.setProperty("position", "relative", "important");
      adjusted = true;
    }
  };
  const onGeometryChange = () => {
    ensureContainingBlock();
    repaint();
  };
  const onCapturedScroll = (event: Event) => {
    const target = event.target;
    // Only movement of this editor, its descendants, or an ancestor can
    // affect its screen coordinates. Other panes' scrolling is unrelated.
    if (!(target instanceof Node) ||
        host.contains(target) || target.contains(host)) onGeometryChange();
  };
  const onViewportChange = () => {
    ensureContainingBlock();
    viewportChange();
  };

  ensureContainingBlock();
  // scroll does not bubble, but capture on window sees scrolling ancestors,
  // Obsidian wrappers and nested viewports as well as CodeMirror itself.
  owner.addEventListener("scroll", onCapturedScroll, { capture: true, passive: true });
  scrollDOM.addEventListener("scroll", onGeometryChange, { passive: true });
  owner.addEventListener("resize", onViewportChange);
  owner.visualViewport?.addEventListener("resize", onViewportChange);
  owner.visualViewport?.addEventListener("scroll", onViewportChange);

  return () => {
    owner.removeEventListener("scroll", onCapturedScroll, true);
    scrollDOM.removeEventListener("scroll", onGeometryChange);
    owner.removeEventListener("resize", onViewportChange);
    owner.visualViewport?.removeEventListener("resize", onViewportChange);
    owner.visualViewport?.removeEventListener("scroll", onViewportChange);
    if (adjusted && host.style.getPropertyValue("position") === "relative") {
      if (originalPosition) {
        host.style.setProperty("position", originalPosition, originalPriority);
      } else {
        host.style.removeProperty("position");
      }
    }
  };
}
