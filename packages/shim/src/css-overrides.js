import bridgeCss from "@ignis/bridge/styles.css";

export function installCssOverrides() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  // The browser caches static CSS for several minutes. Use the build tag so
  // changing the toolbar placement works immediately after a deploy/reload.
  link.href = "/assets/overrides.css?v=" +
    encodeURIComponent(window.__ignis?.build || "dev");
  link.setAttribute("data-ignis", "css-overrides");
  document.head.appendChild(link);

  const bridgeStyle = document.createElement("style");
  bridgeStyle.textContent = bridgeCss;
  bridgeStyle.setAttribute("data-ignis", "bridge-css");
  document.head.appendChild(bridgeStyle);
}
