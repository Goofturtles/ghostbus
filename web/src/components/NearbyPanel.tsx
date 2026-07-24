import { useTranslation } from 'react-i18next';
import { useLive } from '@/hooks/useLive';
import { useStore } from '@/store';
import { StopHeader } from './StopHeader';
import { DepartureRow } from './DepartureRow';
import { AlertCard } from './AlertCard';
import { SavedPlaces } from './SavedPlaces';
import { LocateIcon } from './icons';
import type { Departure } from '@shared/types';

/** Collapse a stop's departures to one row per route (earliest), with the
 *  following departure of that route as the "Next N min" line. */
function byRoute(departures: Departure[]): { first: Departure; next?: Departure }[] {
  const groups = new Map<string, Departure[]>();
  for (const d of departures) {
    const arr = groups.get(d.routeShortName) ?? [];
    arr.push(d);
    groups.set(d.routeShortName, arr);
  }
  return [...groups.values()]
    .map((list) => list.sort((a, b) => a.etaMin - b.etaMin))
    .map((list) => ({ first: list[0], next: list[1] }))
    .sort((a, b) => a.first.etaMin - b.first.etaMin);
}

export function NearbyPanel({ layout, onCatch, onShowMap }: {
  layout: 'bar' | 'compact';
  onCatch?: (d: Departure) => void;
  onShowMap?: () => void;
}) {
  const { t } = useTranslation();
  const arr = useLive((s) => s.arrivals);
  const loaded = useLive((s) => s.loaded);
  const alerts = useLive((s) => s.alerts);
  const setTab = useStore((s) => s.setTab);

  if (!loaded || !arr) {
    return (
      <div className="nearby-panel">
        <div className="section-head"><span className="eyebrow">{t('sections.nearbyDepartures')}</span></div>
        {[0, 1, 2].map((i) => <div key={i} className="skeleton dep-skeleton" />)}
      </div>
    );
  }

  const rows = byRoute(arr.departures);
  const alert = alerts[0];
  const nextTracked = arr.departures.find((d) => d.routeShortName === '504A' && d.freshness === 'live') ?? null;

  return (
    <div className="nearby-panel">
      <section aria-label={t('sections.currentStop')}>
        <div className="section-head">
          <span className="eyebrow">{t('sections.currentStop')}</span>
        </div>
        <StopHeader arr={arr} onShowMap={onShowMap} />
      </section>

      <section aria-label={t('sections.nearbyDepartures')}>
        <div className="section-head">
          <span className="eyebrow eyebrow-icon"><LocateIcon width={13} height={13} />{t('sections.nearbyDepartures')}</span>
        </div>
        <div className="dep-list">
          {rows.map(({ first, next }) => (
            <DepartureRow
              key={first.routeShortName}
              dep={first}
              nextMin={next?.etaMin ?? null}
              layout={layout}
              onCatch={onCatch}
              onOpen={() => setTab('plan')}
            />
          ))}
        </div>
      </section>

      {alert && (
        <AlertCard
          alert={alert}
          routeShort="504A"
          routeColor="D6001C"
          headsign="Distillery Loop"
          nextTracked={nextTracked}
          layout={layout}
          onAlternatives={() => setTab('alerts')}
        />
      )}

      <SavedPlaces onViewAll={() => setTab('saved')} />
    </div>
  );
}
