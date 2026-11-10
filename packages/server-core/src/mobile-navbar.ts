// Obsidian has TWO exclusive iPhone bottom bars. The navigation bar exists
// when browsing; focusing an editor destroys it and creates the editing
// toolbar. Use one action element and relocate it between the built-in bars.
// This deliberately never creates a permanently floating toolbar.
export function mountMobileNavbarAction(action: HTMLElement, doc: Document = document): () => void {
  const attach = () => {
    const navbar = doc.querySelector(".mobile-navbar .mobile-navbar-actions");
    const editing = doc.querySelector(".mobile-toolbar .mobile-toolbar-options-list");
    const useEditing = Boolean(editing && (
      doc.body.classList.contains("mod-toolbar-open") || !navbar
    ));
    const target = useEditing ? editing : navbar;
    if (!target || action.parentElement === target) return;
    action.classList.toggle("mobile-navbar-action", !useEditing);
    action.classList.toggle("mobile-toolbar-option", useEditing);
    if (useEditing) {
      // Formatting options scroll horizontally. Prepend the action to keep
      // Ignis discoverable without scrolling through a long button ribbon.
      target.prepend(action);
    } else {
      target.appendChild(action);
    }
  };
  const observer = new MutationObserver(attach);
  observer.observe(doc.body, { childList: true, subtree: true });
  // Watch class transitions only on body, not every editor span: live
  // Markdown syntax highlighting changes thousands of classes while typing.
  const modeObserver = new MutationObserver(attach);
  modeObserver.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
  attach();
  return () => {
    observer.disconnect();
    modeObserver.disconnect();
    action.remove();
  };
}
