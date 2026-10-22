// Keeps Cardshare working offline once installed. The page is fetched fresh when there is
// signal and falls back to the cached copy without; everything else comes from cache first.
// v2 branch: its own cache name, so a v2 preview never shares or evicts the production cache.
var CACHE = "cardshare-v2-dev-5";
var CORE = ["./", "qrcode.js", "icons.js", "sync.js", "logo.js", "brand.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
  "fonts/inter-latin.woff2", "fonts/poppins-800-latin.woff2",
  // v2 brand fonts, so a managed Work card keeps its typeface offline
  "fonts/fraunces-400-latin.woff2", "fonts/fraunces-600-latin.woff2", "fonts/fraunces-700-latin.woff2",
  "fonts/outfit-400-latin.woff2", "fonts/outfit-600-latin.woff2", "fonts/outfit-700-latin.woff2"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { // cache: "reload" skips the browser/host HTTP cache, so a new version never stores an old file.
    return c.addAll(CORE.map(function (u) { return new Request(u, { cache: "reload" }); })); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    // Only this branch's older caches are cleared; production's "cardshare-vN" caches are left alone.
    return Promise.all(keys.filter(function (k) { return k !== CACHE && k.indexOf("cardshare-v2-dev") === 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  // v2: server calls (sync.js) and anything from another origin always go to the network, never to the cache.
  var u = new URL(req.url);
  if (u.origin !== self.location.origin || u.pathname.indexOf("/v1/") >= 0) return;
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
  // Code (scripts, styles, pages, manifest) comes from the network first, so an update is never mixed with an older
  // cached copy; the cache is the offline fallback. Fonts and images stay cache-first.
  var code = /\.(js|css|html|webmanifest)$/.test(u.pathname);
  if (code) {
    e.respondWith(fetch(req, { cache: "no-cache" }).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return caches.match(req, { ignoreSearch: true }); }));
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
