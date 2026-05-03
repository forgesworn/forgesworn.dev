const CACHE_NAME = "forge-realms-v21";
const CORE_ASSETS = ["", "index.html", "manifest.webmanifest", "icon.svg"].map((path) =>
  new URL(path, self.registration.scope).toString(),
);

function isCacheableResponse(response) {
  return response && response.ok;
}

async function cacheSuccessfulResponse(cache, request, response) {
  if (isCacheableResponse(response)) {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  if (event.request.mode === "navigate" || CORE_ASSETS.includes(event.request.url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          return await cacheSuccessfulResponse(cache, event.request, await fetch(event.request));
        } catch {
          const cached = await cache.match(event.request);
          if (isCacheableResponse(cached)) {
            return cached;
          }
          return cache.match(new URL("index.html", self.registration.scope).toString());
        }
      }),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (isCacheableResponse(cached)) {
        return cached;
      }
      if (cached) {
        await cache.delete(event.request);
      }
      return cacheSuccessfulResponse(cache, event.request, await fetch(event.request));
    }),
  );
});
