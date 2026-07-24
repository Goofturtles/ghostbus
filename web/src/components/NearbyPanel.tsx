import { useTranslation } from 'react-i18next';
import type { DepartureDto } from '@shared/types';
import { useLive, liveNow, selectedNearbyStop } from '@/hooks/useLive';
import { StopHeader } from './StopHeader';
import { DepartureRow } from './DepartureRow';
import { LocateIcon, WarningIcon } from './icons';
import { fmtServiceDate } from '@/lib/format';

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
  const { t } = useTranslation();
  const arr = useLive((s) => s.arrivals);
  const loading = useLive((s) => s.arrivalsLoading);
  const error = useLive((s) => s.arrivalsError);
  const nextService = useLive((s) => s.nextService);
  const healthError = useLive((s) => s.healthError);
  const geoStatus = useLive((s) => s.geoStatus);
  const requestLocation = useLive((s) => s.requestLocation);
  const stop = selectedNearbyStop();
  const distanceM = stop?.distanceM;

  // ----- loading (skeleton rows shaped like real ones, never a spinner) -----
  if ((loading || geoStatus === 'pending') && !arr) {
    return (
      <div className="nearby-panel">
        <div className="skeleton stophead-skeleton" />
        <div className="dep-list">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton dep-skeleton" />)}
        </div>
      </div>
    );
  }

  // ----- API unreachable -----
  if (error && !arr) {
    return (
      <div className="nearby-panel">
        <div className="state-card state-down" role="status">
          <div className="state-glyph" aria-hidden><WarningIcon width={22} height={22} /></div>
          <h3 className="state-title">{t('empty.apiDownTitle')}</h3>
          <p className="state-body">{t('empty.apiDownBody')}</p>
        </div>
      </div>
    );
  }

  if (!arr) return null;

  const rows = byRoute(arr.departures);
  const nextRows = nextService ? byRoute(nextService.departures).slice(0, 6) : [];

  return (
    <div className="nearby-panel">
      {geoStatus === 'default' && (
        <button className="loc-note" onClick={requestLocation}>
          <LocateIcon width={15} height={15} />
          <span className="truncate">{t('empty.defaultLocation')}</span>
        </button>
      )}

      {healthError && (
        <div className="feed-banner" role="status">
          <WarningIcon width={15} height={15} aria-hidden />
          <span className="truncate">{t('status.feedDownGeneric')}</span>
        </div>
      )}

      <section aria-label={t('sections.currentStop')}>
        <StopHeader arr={arr} distanceM={distanceM} />
      </section>

      <section aria-label={t('sections.nearbyDepartures')}>
        <div className="section-head">
          <span className="eyebrow eyebrow-icon"><LocateIcon width={13} height={13} />{t('sections.nearbyDepartures')}</span>
        </div>

        {rows.length > 0 ? (
          <div className="dep-list" role="list">
            {rows.map(({ first, next }) => (
              <DepartureRow
                key={first.routeId ?? first.tripId}
                dep={first}
                nextMin={next ? (next.scheduledMs - liveNow()) / 60000 : null}
                distanceM={distanceM}
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

      {rows.length === 0 && nextRows.length > 0 && (
        <section aria-label={t('sections.nextService')}>
          <div className="section-head">
            <span className="eyebrow">{t('sections.nextService')}</span>
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
    </div>
  );
}
