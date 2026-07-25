/*
 * GhostBus service worker — hand-rolled, zero dependencies, zero build step.
 *
 * This file lives in web/public/ and is copied verbatim into the build output
 * by Vite, so it is served from the origin root as /sw.js with root scope.
 * No Vite plugin and no vite.config.ts change is required to ship it.
 *
 * IMPORTANT — this worker is only ever registered from a PRODUCTION bundle.
 * See web/src/pwa.ts: registration is guarded on `import.meta.env.PROD`, so it
 * never runs under `vite dev`. A service worker caching during development
 * would hand other developers stale assets and silently break screenshot/QA
 * runs. If you are debugging this file, build first and serve the build.
 */

// Bump VERSION to force a full cache rebuild for every client.
const VERSION = 'v1';
const SHELL_CACHE = `ghostbus-shell-${VERSION}`;
const ASSET_CACHE = `ghostbus-assets-${VERSION}`;

/*
 * Stable, unhashed entry points. Vite content-hashes everything it emits into
 * /assets/, so those filenames CANNOT be hardcoded here — a guessed name would
 * 404 during install, install would fail, and the app would never become
 * installable. Instead the hashed list is derived at install time by parsing
 * the index.html we just fetched (see precacheHashedAssets below). That keeps
 * the precache honest against whatever the current build actually emitted,
 * with no build-time codegen step to fall out of sync.
 */
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon-180.png',
];

/** Cache each URL independently so one bad entry cannot fail the whole install. */
async function cacheAllTolerant(cache, urls) {
  await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await cache.put(url, res.clone());
      } catch {
        /* best effort: a missing optional asset must not break installation */
      }
    }),
  );
}

/** Pull every /assets/* URL referenced by the built index.html. */
function hashedAssetUrlsFrom(html) {
  const urls = new Set();
  const attr = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attr.exec(html)) !== null) {
    if (m[1].startsWith('/assets/')) urls.add(m[1]);
  }
  return [...urls];
}

async function precacheHashedAssets(html) {
  const urls = hashedAssetUrlsFrom(html);
  if (urls.length === 0) return;
  const cache = await caches.open(ASSET_CACHE);
  await cacheAllTolerant(cache, urls);
}

/*
 * /assets/* names are content-hashed, so a new build produces new names and the
 * old entries become dead weight. sw.js itself is byte-identical across builds
 * (nothing in it is hashed), so `activate` does not re-run on every deploy —
 * without this prune the asset cache would grow without bound. Called after
 * every successful navigation, which is when we learn the current asset set.
 */
async function pruneStaleAssets(html) {
  const live = new Set(hashedAssetUrlsFrom(html));
  if (live.size === 0) return;
  const cache = await caches.open(ASSET_CACHE);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/assets/') && !live.has(path)) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await cacheAllTolerant(shell, SHELL_URLS);
      const cached = await shell.match('/index.html');
      if (cached) await precacheHashedAssets(await cached.clone().text());
      // Take over immediately: a stale shell must never pin users to an old
      // build. Paired with clients.claim() in `activate`.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('ghostbus-') && k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  /*
   * ---------------------------------------------------------------------
   * /api/* is NEVER cached. Not cache-first, not stale-while-revalidate,
   * not "network-first with a cached fallback".
   *
   * GhostBus exists to tell riders the truth about whether a bus is
   * actually coming. A cached arrival time replayed from disk *looks*
   * exactly like a live one — same UI, same countdown — while being a
   * lie. That is precisely the failure mode this product was built to
   * prevent, so serving it from a cache would be worse than showing
   * nothing at all.
   *
   * Returning without calling respondWith() lets the request go straight
   * to the network. Offline, it fails, and the UI is expected to say so.
   * ---------------------------------------------------------------------
   */
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  /*
   * Cross-origin requests (map tiles + glyphs from tiles.openfreemap.org)
   * pass through untouched. Tiles are static geometry and are safe to cache
   * in principle, but the browser's own HTTP cache already honours the tile
   * server's freshness headers. Re-implementing that here would add a second,
   * dumber cache with no expiry story — the road layer would be fine, but we
   * would have built the machinery that makes it easy to accidentally cache
   * live data next. Not worth it.
   */
  if (url.origin !== self.location.origin) return;

  // --- Navigations: network-first, cached shell only as an offline fallback.
  // Always preferring the network means a new deploy is picked up on the very
  // next load; the cache exists so a cold offline start renders the app shell
  // instead of the browser's offline error page.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            const shell = await caches.open(SHELL_CACHE);
            const copy = res.clone();
            await shell.put('/index.html', copy.clone());
            const html = await copy.text();
            await precacheHashedAssets(html);
            await pruneStaleAssets(html);
          }
          return res;
        } catch {
          const shell = await caches.open(SHELL_CACHE);
          const hit = (await shell.match('/index.html')) || (await shell.match('/'));
          // NOTE: this serves the app SHELL only. It carries no transit data.
          // The app must render its own "offline / no live data" state — the
          // shell coming back must never be mistaken for live arrivals.
          return hit || Response.error();
        }
      })(),
    );
    return;
  }

  // --- Hashed build output: cache-first. The filename contains a content
  // hash, so a given URL's bytes can never change; there is nothing to
  // revalidate and no staleness risk.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  // --- Other same-origin static shell files (icons, favicon, manifest).
  // Cache-first with a background refresh so an updated icon lands next load.
  if (SHELL_URLS.includes(url.pathname) || url.pathname.startsWith('/icons/')) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    return Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then(async (res) => {
      if (res && res.ok) await cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) return hit;
  return (await network) || Response.error();
}
