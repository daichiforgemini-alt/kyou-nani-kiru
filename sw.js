// きょう何着る？ — オフラインでも開けるようにアプリ本体をキャッシュ
const CACHE = "kyou-nani-kiru-v4";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // 天気APIなど外部は常にネットワーク（キャッシュしない）
  if (url.origin !== self.location.origin) return;
  // アプリ本体：ネット優先（ブラウザの古いキャッシュも使わず、必ず最新を確かめる）、つながらなければキャッシュ
  e.respondWith(
    fetch(new Request(e.request.url, { cache: "no-cache" })).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
