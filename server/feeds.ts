import type { FeedDef } from '../shared/types.ts';

// Hand-curated launch feeds. Catalog-discovered feeds normalize into the same
// shape (see scripts/buildCatalog.ts). Every activated feed's license + required
// attribution string flows into the footer and Credits screen dynamically.
export const FEEDS: Record<string, FeedDef> = {
  toronto: {
    cityId: 'toronto',
    name: 'Toronto (TTC)',
    bbox: [-79.6393, 43.5810, -79.1152, 43.8555],
    timezone: 'America/Toronto',
    staticGtfsUrl: 'https://ckan0.cf.opendata.inter.prod-toronto.ca/download_resource/ttc-routes-and-schedules',
    rtVehiclesUrl: 'https://bustime.ttc.ca/gtfsrt/vehicles',
    rtTripUpdatesUrl: 'https://bustime.ttc.ca/gtfsrt/trips',
    rtAlertsUrl: 'https://bustime.ttc.ca/gtfsrt/alerts',
    license: 'Open Government Licence – Toronto',
    attribution: 'Contains information licensed under the Open Government Licence – Toronto.',
    tier: 1,
  },
  vancouver: {
    cityId: 'vancouver',
    name: 'Vancouver (TransLink)',
    bbox: [-123.2247, 49.0016, -122.4174, 49.3958],
    timezone: 'America/Vancouver',
    staticGtfsUrl: 'https://gtfs-static.translink.ca/gtfs/google_transit.zip',
    rtVehiclesUrl: 'https://gtfsapi.translink.ca/v3/gtfsposition',
    rtTripUpdatesUrl: 'https://gtfsapi.translink.ca/v3/gtfsrealtime',
    rtAlertsUrl: 'https://gtfsapi.translink.ca/v3/gtfsalerts',
    license: 'TransLink Open API Terms of Use',
    attribution: 'Route and arrival data used under the TransLink Open API Terms of Use.',
    tier: 1,
  },
};

export function feedForPoint(lon: number, lat: number): FeedDef | null {
  for (const f of Object.values(FEEDS)) {
    const [w, s, e, n] = f.bbox;
    if (lon >= w && lon <= e && lat >= s && lat <= n) return f;
  }
  return null;
}
