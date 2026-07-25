/**
 * Service-worker registration for the installable GhostBus PWA.
 *
 * PRODUCTION ONLY — BY DESIGN, DO NOT REMOVE THE GUARD.
 * The worker is registered only when `import.meta.env.PROD` is true, i.e. only
 * from a `vite build` bundle. It is never registered under `vite dev`. A
 * service worker caching assets during development would serve stale JS/CSS to
 * everyone working in this repo and silently invalidate screenshot and QA runs,
 * which is a much more expensive failure than losing offline support in dev.
 *
 * Every failure path here is swallowed. Service workers are unavailable on
 * insecure origins, in some private-browsing modes, and behind enterprise
 * policy; none of that is a reason for the transit app to stop working.
 */

/** Set once we know a worker was already controlling this page at startup. */
let hadControllerAtStartup = false;
let reloadingForUpdate = false;

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  // The dev guard. See the file header before touching this line.
  if (!import.meta.env.PROD) {
    // Self-healing: if a production build was ever served from this origin
    // (e.g. someone ran `vite preview` on the dev port), its worker would
    // still be installed and would keep serving cached assets under
    // `vite dev`. Tear it down rather than leaving a trap for the next
    // person who wonders why their edit "didn't apply".
    void navigator.serviceWorker
      .getRegistrations()
      .then((regs) => regs.forEach((r) => void r.unregister()))
      .catch(() => {});
    return;
  }

  hadControllerAtStartup = navigator.serviceWorker.controller !== null;

  // A brand-new registration calls clients.claim(), which fires
  // `controllerchange` on the very first visit. Reloading then would be a
  // pointless flash, so only reload when a PREVIOUS worker is being replaced —
  // that is the case where the page is running code from a superseded build.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadControllerAtStartup || reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });

  // `load` has already fired if this module evaluated late or the page came
  // back from the bfcache; waiting for an event that will never arrive would
  // mean never registering at all.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

function register(): void {
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((registration) => {
      // Ask the browser to re-check sw.js now rather than on its own
      // schedule, so a shipped fix reaches an already-installed client fast.
      void registration.update().catch(() => {});

      // sw.js calls skipWaiting() during install, so a new worker normally
      // activates on its own. These are the belt-and-braces paths for when it
      // ends up waiting anyway (e.g. several tabs open on the old build).
      promoteWaiting(registration);
      registration.addEventListener('updatefound', () => {
        const incoming = registration.installing;
        if (!incoming) return;
        incoming.addEventListener('statechange', () => {
          if (incoming.state === 'installed') promoteWaiting(registration);
        });
      });
    })
    .catch(() => {
      /* SW unsupported or blocked — the app runs fine without it. */
    });
}

/**
 * A worker may already be sitting in `waiting` by the time register() resolves,
 * in which case its `updatefound` fired before we could listen for it. Checking
 * directly covers that race.
 */
function promoteWaiting(registration: ServiceWorkerRegistration): void {
  registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
}
