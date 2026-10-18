const CACHE_NAME = "ldm-desktop-shell-v3";
const APP_SHELL = ["/", "/app.css", "/transfer-metrics.js", "/media-options.js", "/app.js", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((name) => name.startsWith("ldm-desktop-shell-") && name !== CACHE_NAME)
      .map((name) => caches.delete(name))
  )));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => {
      const cached = await caches.match("/");
      return cached || Response.error();
    }));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
