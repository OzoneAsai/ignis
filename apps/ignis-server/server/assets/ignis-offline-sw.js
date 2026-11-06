/* Offline application shell for already opened Ignis vaults.
 * Only same-origin GETs are cached. No proxy/auth/API mutations are cached.
 * CacheStorage and Yjs IndexedDB belong to the browser profile, not the server.
 */
const SHELL_CACHE = "ignis-collab-shell-v1";
const DATA_CACHE = "ignis-collab-vault-v1";
const STATIC_LIMIT = 180;
const DATA_LIMIT = 140;
const MAX_DATA_BYTES = 3 * 1024 * 1024;
const MAX_SHELL_BYTES = 32 * 1024 * 1024;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE)
    .then((cache) => cache.addAll(["/", "/index.html"]))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((names) => Promise.all(names
      .filter((name) => name.startsWith("ignis-collab-") &&
        name !== SHELL_CACHE && name !== DATA_CACHE)
      .map((name) => caches.delete(name)))),
    self.clients.claim(),
  ]));
});

function vaultDataPath(pathname) {
  return pathname === "/api/bootstrap" ||
    pathname === "/api/plugins" ||
    pathname === "/api/settings" ||
    pathname === "/api/vault/info" ||
    pathname === "/api/fs/tree" ||
    pathname === "/api/fs/stat" ||
    pathname === "/api/fs/readFile";
}

async function cacheResponse(request, response, cacheName, maxEntries) {
  if (!response.ok || response.redirected || response.type === "opaque") {
    return;
  }

  const control = response.headers.get("cache-control") || "";
  const bootstrap = new URL(request.url).pathname === "/api/bootstrap" &&
    response.headers.get("x-ignis-offline-cache") === "1";

  if ((control.includes("no-store") && !bootstrap) || response.headers.has("set-cookie")) {
    return;
  }

  const declared = Number(response.headers.get("content-length"));

  const maximum = cacheName === SHELL_CACHE ? MAX_SHELL_BYTES : MAX_DATA_BYTES;

  if (Number.isFinite(declared) && declared > maximum) {
    return;
  }

  const bytes = await response.clone().arrayBuffer();

  if (bytes.byteLength > maximum) {
    return;
  }

  const cache = await caches.open(cacheName);
  await cache.put(request, response);

  const keys = await cache.keys();

  if (keys.length > maxEntries) {
    await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
  }
}

async function load(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let response;

    try {
      response = await fetch(request, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      // The caller gets the live response immediately; cache in the background.
      return { response, update: cacheResponse(request, response.clone(), cacheName, maxEntries) };
    }

    // Do not bypass an actual HTTP authorization error with an old cache.
    return { response };
  } catch {
    const fallback = await cache.match(request);

    if (fallback) {
      return { response: fallback };
    }

    // A navigation for another vault can use the same static HTML shell.
    if (request.mode === "navigate") {
      const shell = await caches.open(SHELL_CACHE);
      const index = await shell.match("/");

      if (index) {
        return { response: index };
      }
    }

    return { response: Response.error() };
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin ||
      url.pathname === "/ignis-offline-sw.js" ||
      url.pathname.startsWith("/api/proxy") ||
      url.pathname.startsWith("/api/auth") ||
      url.pathname.startsWith("/vault-files/")) {
    return;
  }

  const isData = vaultDataPath(url.pathname);
  const cacheName = isData ? DATA_CACHE : SHELL_CACHE;
  const limit = isData ? DATA_LIMIT : STATIC_LIMIT;

  event.respondWith(load(request, cacheName, limit).then(({ response, update }) => {
    if (update) {
      event.waitUntil(update.catch(() => {}));
    }

    return response;
  }));
});
