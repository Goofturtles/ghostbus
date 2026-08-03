import React from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './styles/tokens.css';
import './styles/global.css';
import './styles/app.css';
// After app.css on purpose: the journey surfaces reuse its primitives (.plan-leg,
// .state-card, .dep-list) and a few rules here refine them, so they must land later.
import './styles/journey.css';
import { initClientState } from './store';
import { registerServiceWorker } from './pwa';
import App from './App';

initClientState();

/**
 * Start the map chunk downloading NOW, in parallel with React's first render.
 *
 * `App.tsx` loads the map with `lazy(() => import('./map/MapCard'))`, which keeps
 * maplibre-gl and three out of the initial bundle — that is deliberate and stays.
 * But `lazy` does not call its factory until React renders the Suspense boundary, so
 * the chunk request was queued BEHIND app boot rather than running alongside it, and
 * nothing about the map — not the style, not the TileJSON, not one tile — could start
 * until it landed. The map is on the first screen of the app; there is no version of
 * this session where it is not wanted.
 *
 * This is a warm-up, not a second copy: the module registry dedupes, so `lazy`'s own
 * `import()` resolves against this very promise. `catch` is required — an unhandled
 * rejection here (offline, chunk 404 after a redeploy) would be a console error, and
 * the real error path already lives in App's Suspense/error boundary.
 */
void import('./map/MapCard').catch(() => { /* App's boundary reports it */ });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

registerServiceWorker();
