import { useTranslation } from 'react-i18next';
import type { DepartureDto } from '@shared/types';
import { useLive, liveNow, selectedNearbyStop } from '@/hooks/useLive';
import { useStore } from '@/store';
import { StopHeader } from './StopHeader';
import { DepartureRow } from './DepartureRow';
import { OfflineCard } from './OfflineCard';
import { GhostEventCard } from './AlertsPanel';
import { SavedPlacesSection } from './SavedPlaces';
import { LocateIcon, WarningIcon } from './icons';
import { fmtServiceDate, fmtDistance } from '@/lib/format';

/** One row per route: the earliest departure, plus the following one of that route
 *  (its "Next X min" line). Groups are ordered by their earliest departure. */
function byRoute(departures: DepartureDto[]): { first: DepartureDto; next?: DepartureDto }[] {
  const groups = new Map<string, DepartureDto[]>();
  for (const d of departures) {
    const key = d.routeId ?? d.shortName ?? d.tripId;
    const arr = groups.get(key) ?? [];
    arr.push(d);
    groups.set(key, arr);
  }
  return [...groups.values()]
    .map((list) => list.slice().sort((a, b) => a.scheduledMs - b.scheduledMs))
    .map((list) => ({ first: list[0], next: list[1] }))
    .sort((a, b) => a.first.scheduledMs - b.first.scheduledMs);
}

export function NearbyPanel({ onCatch, onOpen }: {
  onCatch?: (d: DepartureDto) => void;
  onOpen?: (d: DepartureDto) => void;
}) {
  const { t, i18n } = useTranslation();
  const arr = useLive((s) => s.arrivals);
  const error = useLive((s) => s.arrivalsError);
  const nextService = useLive((s) => s.nextService);
  /**
   * THE THREE ATTRIBUTION STATES, kept strictly apart. See DECISIONS §45.
   *
   *   apiFailure   (a) OUR server: throttled, restarting, or unreachable. Ours to fix,
   *                    and it is retrying by itself. NEVER mentions the agency.
   *   feedTrouble  (b) our server is reachable and ITS OWN health says an agency feed is
   *                    down or stale. The only state allowed to name the TTC.
   *   isDemo       (c) the server is replaying a recording.
   *
   * The banner below used to be driven by `healthError` — a boolean that was true whenever
   * the HEALTH FETCH failed — and it rendered "TTC feed unreachable". So our own rate
   * limiter printed an accusation against the transit agency, which is the bug a rider
   * reported and the reason this component now reads three separate facts.
   */
  const apiFailure = useLive((s) => s.apiFailure);
  const feedTrouble = useLive((s) => s.apiFailure == null && s.health != null && !s.health.ok);
  const isDemo = useLive((s) => s.health?.mode === 'demo');
  const outOfCoverage = useLive((s) => s.outOfCoverage);
  const health = useLive((s) => s.health);
  const geoStatus = useLive((s) => s.geoStatus);
  const online = useLive((s) => s.online);
  const ghosts = useLive((s) => s.ghosts);
  const requestLocation = useLive((s) => s.requestLocation);
  const useDefaultLocation = useLive((s) => s.useDefaultLocation);
  const imperial = useStore((s) => s.units) === 'imperial';
  const stop = selectedNearbyStop();
  const distanceM = stop?.distanceM;

  // ---- No board to show. The reason is always on screen — this column is never
  // blank, because an unexplained empty space is exactly when a rider decides the
  // app is broken. Most specific reason first.

  // ----- the device has no network -----
  if (!arr && !online) {
    return <div className="nearby-panel"><OfflineCard /></div>;
  }

  /**
   * ----- the rider is genuinely outside the agency's coverage -----
   *
   * Checked BEFORE the error and skeleton branches, because it is the most specific fact
   * available and it is not an error at all: the query worked and the honest answer is
   * "nothing here". Set only for a fix the rider actually granted (see `loadNearby`).
   *
   * The bug this closes: spoofed to Mississauga, the default-location banner disappeared —
   * so the rider believed their location had taken effect — and a downtown Toronto board
   * stayed on screen as though it were theirs. Nothing here substitutes a location; the
   * only way back to the default view is the button below, which says what it does.
   */
  if (outOfCoverage) {
    const near = outOfCoverage.nearest;
    /**
     * The coverage claim is GENERATED from what is actually seeded, never hardcoded.
     * "GhostBus only covers the TTC, in Toronto" was maintained by hand and would have
     * become false the moment MiWay was added with nobody editing it — the app asserting
     * something untrue about itself, which is the failure §45 exists to prevent.
     * `health.agencies` is the server's own list, so the sentence cannot drift.
     */
    const covered = health?.agencies ?? [];
    const agencyNames = covered.length > 0
      ? new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' })
        .format(covered.map((a) => a.name))
      : null;
    const nearAgency = near ? covered.find((a) => a.id === near.agency)?.name ?? near.agency : null;
    return (
      <div className="nearby-panel">
        <div className="state-card state-down" role="status">
          <div className="state-glyph" aria-hidden><WarningIcon width={22} height={22} /></div>
          <h3 className="state-title">
            {t('empty.noCoverageTitle', { dist: fmtDistance(outOfCoverage.radiusM, imperial) })}
          </h3>
          <p className="state-body">
            {near && near.distanceM != null
              ? t('empty.noCoverageNearest', {
                stop: near.name ?? t('stop.code', { code: near.stopId }),
                agency: nearAgency ?? near.agency,
                dist: fmtDistance(near.distanceM, imperial),
              })
              // No nearest stop at all is only possible with an empty database, so this
              // falls back to naming what we cover rather than to a bare apology.
              : agencyNames
                ? t('empty.noCoverageUnknown', { agencies: agencyNames })
                : t('empty.noCoverageTitle', { dist: fmtDistance(outOfCoverage.radiusM, imperial) })}
          </p>
          <button className="btn btn-primary" onClick={useDefaultLocation}>
            {t('empty.noCoverageAction')}
          </button>
          {/* Geolocation is a one-shot fix, so nothing re-queries as the rider moves — and
              without this the card is a dead end for somebody who has since walked or
              driven back into the service area. It is the only other way out, so it is on
              screen rather than implied. */}
          <button className="btn btn-quiet" onClick={requestLocation}>
            {t('empty.noCoverageRetry')}
          </button>
          <p className="state-body state-fine">{t('empty.noCoverageActionNote')}</p>
        </div>
      </div>
    );
  }

  /**
   * ----- OUR server did not answer: throttled, restarting, or unreachable -----
   *
   * State (a). This is also the captive-portal case, where navigator.onLine claims we are
   * connected and the fetch says otherwise. Every branch of it is about US, and the copy
   * says so — the previous version said "GhostBus can't reach the TTC data right now",
   * which blamed the agency for our own rate limiter.
   */
  if (!arr && (error || apiFailure)) {
    return (
      <div className="nearby-panel">
        <div className="state-card state-down" role="status">
          <div className="state-glyph" aria-hidden><WarningIcon width={22} height={22} /></div>
          <h3 className="state-title">{t('empty.apiDownTitle')}</h3>
          <p className="state-body">
            {apiFailure === 'throttled' ? t('empty.apiDownThrottled') : t('empty.apiDownBody')}
          </p>
          <p className="state-body state-fine">{t('empty.apiDownRetrying')}</p>
        </div>
      </div>
    );
  }

  // ----- still working on it: skeleton rows shaped like real ones, never a
  // spinner, and never nothing (this also covers the brief window after a fix
  // lands but before the first arrivals request resolves) -----
  if (!arr) {
    return (
      <div className="nearby-panel">
        <div className="skeleton stophead-skeleton" />
        <div className="dep-list">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton dep-skeleton" />)}
        </div>
      </div>
    );
  }

  const rows = byRoute(arr.departures);
  const nextRows = nextService ? byRoute(nextService.departures).slice(0, 6) : [];

  // The reference puts an alert card straight under the departures. Ours is a real
  // ghost event off the live feed, and only one that touches a route on THIS board
  // — a cancellation three neighbourhoods away is not this stop's news. No match,
  // no card; nothing here is ever synthesised to fill the slot.
  const boardRoutes = new Set(arr.departures.map((d) => d.routeId).filter(Boolean));
  const localGhost = ghosts?.events.find((e) => e.routeId && boardRoutes.has(e.routeId)) ?? null;

  return (
    <div className="nearby-panel">
      {geoStatus === 'default' && (
        <button className="loc-note" onClick={requestLocation}>
          <LocateIcon width={15} height={15} />
          <span>{t('empty.defaultLocation')}</span>
        </button>
      )}

      {/* (c) A recording. Stated first, because a recording's feeds are honestly `ok`
          and the badge is the only thing that stops that from reading as live. */}
      {isDemo && (
        <div className="feed-banner feed-banner-demo" role="status">
          <span className="demo-badge">{t('status.demoBadge')}</span>
          <span>{t('status.demoNote', { agency: t('agency.short') })}</span>
        </div>
      )}

      {/* (a) OURS. Named as ours, and it is already retrying — no rider action needed. */}
      {!isDemo && apiFailure != null && (
        <div className="feed-banner feed-banner-ours" role="status">
          <WarningIcon width={15} height={15} aria-hidden />
          <span>{t('status.catchingUpDetail')}</span>
        </div>
      )}

      {/* (b) THEIRS — and the only banner in the app that may say so. It fires only when
          our own server answered and its `health.feeds` reports the outage itself. */}
      {!isDemo && feedTrouble && (
        <div className="feed-banner" role="status">
          <WarningIcon width={15} height={15} aria-hidden />
          <span>{t('status.feedDownGeneric')}</span>
        </div>
      )}

      <section className="gb-section" aria-labelledby="gb-stop-head">
        <div className="section-head only-desktop">
          <span className="eyebrow" id="gb-stop-head">{t('sections.currentStop')}</span>
        </div>
        <StopHeader
          arr={arr}
          distanceM={distanceM}
          headsigns={(arr.departures.length > 0 ? arr.departures : nextService?.departures ?? [])
            .map((d) => d.directionLabel)}
        />
      </section>

      <section className="gb-section" aria-labelledby="gb-dep-head">
        <div className="section-head only-desktop">
          <span className="eyebrow" id="gb-dep-head">{t('sections.nearbyDepartures')}</span>
        </div>

        {rows.length > 0 ? (
          <div className="dep-list" role="list">
            {rows.map(({ first, next }) => (
              <DepartureRow
                key={first.routeId ?? first.tripId}
                dep={first}
                nextMin={next ? (next.scheduledMs - liveNow()) / 60000 : null}
                distanceM={distanceM}
                stopId={arr.stopId}
                onCatch={onCatch}
                onOpen={onOpen}
              />
            ))}
          </div>
        ) : (
          <div className="state-card state-empty" role="status">
            <h3 className="state-title">{t('empty.noWindow', { min: Math.round(arr.windowMinutes) })}</h3>
            {nextRows.length > 0 ? (
              <p className="state-body">{t('empty.nextServiceNote')}</p>
            ) : (
              <p className="state-body">{t('empty.noneScheduled')}</p>
            )}
          </div>
        )}
      </section>

      {localGhost && (
        <section className="gb-section" aria-label={t('sections.ghosts')}>
          <GhostEventCard event={localGhost} />
        </section>
      )}

      {rows.length === 0 && nextRows.length > 0 && (
        <section className="gb-section" aria-labelledby="gb-next-head">
          <div className="section-head">
            <span className="eyebrow" id="gb-next-head">{t('sections.nextService')}</span>
            <span className="eyebrow eyebrow-date">{fmtServiceDate(nextRows[0].first.scheduledMs)}</span>
          </div>
          <div className="dep-list" role="list">
            {nextRows.map(({ first, next }) => (
              <DepartureRow
                key={first.routeId ?? first.tripId}
                dep={first}
                nextMin={next ? (next.scheduledMs - first.scheduledMs) / 60000 : null}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      )}

      <SavedPlacesSection />
    </div>
  );
}
