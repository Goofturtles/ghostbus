// The single place that knows where maplibre's web worker actually lives.
//
// maplibre-gl v6 resolves its worker at RUNTIME with
// `new URL('./maplibre-gl-worker.mjs', import.meta.url)`. No bundler can see that,
// so `vite build` never emits the worker; the built chunk asks the server for a
// sibling that does not exist, the SPA fallback answers with index.html, the module
// worker refuses the text/html MIME type, and the map dies in production while dev
// (which serves maplibre from source, next to its real worker) keeps working.
// `?worker&url` makes Rollup bundle the worker into a real hashed chunk and hands
// us its URL. `vite.config.ts` sets `worker.format: 'es'` because maplibre
// constructs it with `{ type: 'module' }`. See DECISIONS §28.
//
// IMPORTING THIS MODULE IS THE SETUP — the call runs at module scope, exactly once,
// and every entry point that constructs a `maplibregl.Map` must import it BEFORE
// doing so. Any new map surface that forgets is a blank map in production and a
// perfect map in dev, which is the worst possible failure shape.
//
// NOTE FOR INTEGRATION: `MapCard.tsx` currently carries its own copy of these two
// lines. Replacing them with `import './mapWorker';` makes this the only place the
// worker URL is named. Until that lands the literal exists in two files.

import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

/** The resolved worker URL, exported for assertions in tests / build verification. */
export const MAPLIBRE_WORKER_URL = maplibreWorkerUrl;
