// Obsidian may restore a leaf's view state before mounting the DOM for that
// view. Desktop keeps the pane visible, but a collapsed phone drawer can
// leave its active leaf with data-type="undefined" until revealLeaf is called.
//
// Hydrate only the currently visible drawer, and only when its model already
// names a concrete view. Never manufacture a new leaf or change saved layout.
export function findUnhydratedMobileLeaves(app, doc = document) {
  if (!doc.body?.classList?.contains("is-phone")) return [];
  const drawers = [...doc.querySelectorAll(".workspace-drawer.mod-active")];
  if (!drawers.length || !app.workspace?.iterateAllLeaves) return [];

  const leaves = [];
  app.workspace.iterateAllLeaves((leaf) => {
    const host = leaf.containerEl;
    if (!host || !drawers.some((drawer) => drawer.contains(host))) return;
    const content = host.querySelector?.(".workspace-leaf-content");
    if (content?.getAttribute("data-type") !== "undefined") return;
    const type = leaf.getViewState?.()?.type;
    if (!type || type === "empty" || leaf.view?.getViewType?.() !== type) return;
    leaves.push(leaf);
  });
  return leaves;
}

export function installMobileDrawerHydration(app, {
  doc = document,
  Observer = MutationObserver,
  schedule = (callback) => requestAnimationFrame(callback),
} = {}) {
  if (!doc.body || !app.workspace) return () => {};
  const pending = new WeakSet();
  let scheduled = false;
  let disposed = false;

  const hydrate = () => {
    scheduled = false;
    if (disposed) return;
    for (const leaf of findUnhydratedMobileLeaves(app, doc)) {
      if (pending.has(leaf)) continue;
      pending.add(leaf);
      Promise.resolve().then(() => app.workspace.revealLeaf(leaf))
        .catch((err) => console.warn("[ignis-bridge] Drawer hydration failed", err))
        .finally(() => pending.delete(leaf));
    }
  };
  const trigger = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    schedule(hydrate);
  };
  const observer = new Observer((changes) => {
    if (changes.some((change) => change.target?.classList?.contains("workspace-drawer"))) {
      trigger();
    }
  });
  observer.observe(doc.body, {
    attributes: true, attributeFilter: ["class"], subtree: true,
  });
  // Also handles a drawer that was active before the Bridge finished loading.
  trigger();
  return () => { disposed = true; observer.disconnect(); };
}
