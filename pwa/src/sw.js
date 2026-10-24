// Service worker: przechowuje aplikację i bazę leków w telefonie, żeby działała offline.
// Wersję i listę plików uzupełnia pwa/build.py; nowa wersja = nowa nazwa pamięci podręcznej.
const VERSION = "__VERSION__";
const FILES = __FILES__;
const CACHE = `pomocnik-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
});

self.addEventListener("activate", (event) => {
  // Usuwamy poprzednie wersje, żeby nie zajmowały miejsca w telefonie.
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pomocnik-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("message", (event) => {
  if (event.data === "aktualizuj") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true })
        || (req.mode === "navigate" ? await cache.match("./") : undefined);
      return hit || fetch(req);
    }),
  );
});
