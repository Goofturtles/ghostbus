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

// Synthetic cache key holding the id of the build the asset cache belongs to.
// Kept in the cache rather than a module variable because a service worker is
// terminated and restarted freely, which would wipe any in-memory state.
const BUILD_ID_KEY = '/__ghostbus-build-id';

/*
 * Stable, unhashed entry points. Vite content-hashes everything it emits into
 * /assets/, so those filenames CANNOT be hardcoded here — a guessed name would
 * 404 during install, install would fail, and the app would never become
 * installable. Instead the hashed list is derived at install time by parsing
 * the index.html we just fetched (see syncAssetsWith). That keeps the precache
 * honest against whatever the current build actually emitted, with no
 * build-time codegen step to fall out of sync.
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
  '/icons/icon.svg',
];

/*
 * The production server (server/src/api.ts) answers ANY non-/api/ 404 with
 * index.html at HTTP 200 text/html, so that deep links reach the SPA router.
 * That means a request for a hashed asset that is missing — a half-finished
 * deploy, a rolled-back build — comes back "successful" with an HTML body.
 * Caching that under a .js URL would permanently poison the cache: hashed URLs
 * are cache-first and never revalidated, so the app would execute HTML forever.
 * Any response that looks like the SPA fallback is therefore refused.
 */
function isSpaFallback(res) {
  const type = res.headers.get('content-type') || '';
  return type.includes('text/html');
}

/** The only two paths where an HTML body is the correct answer. */
function expectsHtml(pathname) {
  return pathname === '/' || pathname === '/index.html';
}

function pathOf(url) {
  try {
    return new URL(url, self.location.origin).pathname;
  } catch {
    return '';
  }
}

/**
 * @param {string} url  request URL (absolute or root-relative)
 * @param {Response} res
 */
function isCacheable(url, res) {
  if (!res || !res.ok || res.type === 'opaque') return false;
  // Everything except the shell HTML must reject an HTML body — that body is
  // the SPA fallback standing in for a file that does not exist.
  if (!expectsHtml(pathOf(url)) && isSpaFallback(res)) return false;
  return true;
}

/**
 * Cache each URL independently so one bad entry cannot fail the whole install.
 * @param {Cache} cache
 * @param {string[]} urls
 * @param {{skipIfCached?: boolean}} opts
 * @returns {Promise<boolean>} true if every URL is now present in the cache
 */
async function cacheAllTolerant(cache, urls, opts = {}) {
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        // /assets/* filenames contain a content hash, so a cached copy can
        // never be stale — re-fetching one is pure waste. This is what keeps
        // repeat navigations off the network.
        if (opts.skipIfCached && (await cache.match(url))) return true;
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!isCacheable(url, res)) return false;
        await cache.put(url, res);
        return true;
      } catch {
        return false; // best effort: one missing asset must not fail install
      }
    }),
  );
  return results.every(Boolean);
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

/** Stable id for "the set of assets this build emitted" (FNV-1a, 32-bit). */
function buildIdFrom(html) {
  const urls = hashedAssetUrlsFrom(html).sort().join('|');
  if (!urls) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < urls.length; i++) {
    h ^= urls.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

async function readStoredBuildId() {
  const shell = await caches.open(SHELL_CACHE);
  const res = await shell.match(BUILD_ID_KEY);
  return res ? res.text() : null;
}

/*
 * Reconcile the asset cache with the build that this index.html describes.
 *
 * Not all of a build's chunks appear in index.html — App.tsx lazy-imports the
 * map, and maplibre pulls its own worker chunk — so we cannot prune by "is it
 * referenced right now?": that would delete every dynamic chunk on each load
 * and the map would never survive offline. Instead the whole asset cache is
 * keyed to a build id. A new deploy rewrites every hashed filename, which
 * changes the id, which drops the previous build's assets wholesale — dynamic
 * chunks included — while leaving the current build's runtime-cached chunks
 * untouched. Bounded growth, no per-file guesswork.
 */
async function syncAssetsWith(html) {
  const id = buildIdFrom(html);
  if (!id) return;

  const prev = await readStoredBuildId();
  if (prev !== id) await caches.delete(ASSET_CACHE);

  const cache = await caches.open(ASSET_CACHE);
  const complete = await cacheAllTolerant(cache, hashedAssetUrlsFrom(html), { skipIfCached: true });

  // Only claim this build once its entry assets are genuinely cached. If a
  // deploy race made them unfetchable, leaving the id unset means we retry on
  // the next navigation instead of recording a build we cannot actually serve.
  if (complete && prev !== id) {
    const shell = await caches.open(SHELL_CACHE);
    await shell.put(BUILD_ID_KEY, new Response(id, { headers: { 'content-type': 'text/plain' } }));
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await cacheAllTolerant(shell, SHELL_URLS);
      const cached = await shell.match('/index.html');
      if (cached) await syncAssetsWith(await cached.text());
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
          if (res && res.ok && !res.redirected) {
            const copy = res.clone();
            // Off the critical path: the document is returned immediately and
            // the cache reconciliation continues under waitUntil.
            event.waitUntil(
              (async () => {
                try {
                  const shell = await caches.open(SHELL_CACHE);
                  await shell.put('/index.html', copy.clone());
                  await syncAssetsWith(await copy.text());
                } catch {
                  /* cache upkeep must never surface as a page error */
                }
              })(),
            );
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
    event.respondWith(staleWhileRevalidate(event, req, SHELL_CACHE));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // isCacheable rejects the SPA HTML fallback — see its comment.
    if (isCacheable(req.url, res)) await cache.put(req, res.clone());
    return res;
  } catch {
    return Response.error();
  }
}

async function staleWhileRevalidate(event, req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then(async (res) => {
      if (isCacheable(req.url, res)) await cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) {
    // Hold the worker alive until the background refresh finishes, otherwise
    // the browser may terminate it mid-write and the refresh never lands.
    event.waitUntil(network);
    return hit;
  }
  return (await network) || Response.error();
}
