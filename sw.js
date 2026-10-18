// Keeps Cardshare working offline once installed. The page is fetched fresh when there is
// signal and falls back to the cached copy without; everything else comes from cache first.
var CACHE = "cardshare-v7";
var CORE = ["./", "qrcode.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
  "fonts/inter-latin.woff2", "fonts/poppins-800-latin.woff2"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(CORE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  if (req.mode === "navigate") {
    // Only the app itself is kept for offline use. Other pages, such as About, always come from the network,
    // so they can never take the app's place in the cache.
    if (new URL(req.url).pathname !== new URL(self.registration.scope).pathname) return;
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put("./", copy); });
      return res;
    }).catch(function () { return caches.match("./"); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      if (res.ok || res.type === "opaque") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    });
  }));
});
