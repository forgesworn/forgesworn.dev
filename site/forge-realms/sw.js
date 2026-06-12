const CACHE_NAME = "forge-realms-v24";
const CORE_ASSETS = ["", "index.html", "manifest.webmanifest", "icon.svg"].map((path) =>
  new URL(path, self.registration.scope).toString(),
);

function isCacheableResponse(response) {
  return response && response.ok;
}

// Retry a genuinely failed network fetch a couple of times before giving up.
// Booth/mobile links drop the odd request; without this a single dropped JS
// chunk or atlas page rejects the dynamic import ("Could not start the realm")
// or strands the artwork load with no second chance. Only thrown (transient)
// failures retry — a real HTTP error response is returned as-is so a genuinely
// missing asset still fails fast rather than looping.
async function fetchWithRetry(request, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(request);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }
  throw lastError;
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
      return cacheSuccessfulResponse(cache, event.request, await fetchWithRetry(event.request));
    }),
  );
});
