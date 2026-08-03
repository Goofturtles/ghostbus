// THE STOP BOARD — what used to be the Nearby tab's whole reason to exist.
//
// The board itself did nothing wrong. What was wrong was handing it to a rider unasked, as
// the first thing they saw: "here are the buses near you" answers a question almost nobody
// opens a transit app with. So the board stopped being a feed and became a surface you
// REACH FOR — by tapping a stop on the map, or by searching one. Same rows, same evidence,
// same Catch, arrived at deliberately.
//
// Everything that was load-bearing about the old panel and is NOT about one stop moved to
// the home instead: the location-permission entry point, the honest out-of-coverage card,
// and the three feed-attribution banners all live in PlanView now.

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DepartureDto } from '@shared/types';
import { useLive, liveNow, selectedNearbyStop } from '@/hooks/useLive';
import { useStore } from '@/store';
import { fmtServiceDate } from '@/lib/format';
import { StopHeader } from './StopHeader';
import { DepartureRow } from './DepartureRow';
import { GhostEventCard } from './AlertsPanel';
import { CloseIcon, WarningIcon } from './icons';

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

export function StopBoardSheet({ onCatch }: { onCatch?: (d: DepartureDto) => void }) {
  const { t } = useTranslation();
  const open = useStore((s) => s.stopSheet);
  const close = useStore((s) => s.openStopSheet);
  const ref = useRef<HTMLDivElement>(null);

  const arr = useLive((s) => s.arrivals);
  const error = useLive((s) => s.arrivalsError);
  const nextService = useLive((s) => s.nextService);
  const apiFailure = useLive((s) => s.apiFailure);
  const ghosts = useLive((s) => s.ghosts);
  const stop = selectedNearbyStop();
  const distanceM = stop?.distanceM;

  // The same modal keyboard contract every other sheet in this app honours: Escape closes,
  // Tab cycles inside, and the opener gets focus back on the way out.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    /**
     * JOIN THE APP'S EXISTING FULL-SCREEN-MODAL MECHANISM rather than growing a second one.
     *
     * `:root[data-modal]` is what SearchSheet has always set, and at phone width it takes
     * `.mobile-top`, `.pane-side` and `.tabbar` out of the picture entirely — not painted,
     * not in the accessibility tree, and not something this sheet's text is read on top of.
     * The map is deliberately left alone; hiding a live WebGL canvas to satisfy a DOM probe
     * would be a real risk taken for a cosmetic reason.
     *
     * Measured, not assumed: with the §F probe run against a full-screen sheet that does
     * NOT set this, everything behind it counts as an intersection (the corrected probe
     * models clipping, but nothing models occlusion). The search sheet, which does set it,
     * measures zero. So this is the difference between a surface that passes §F and one
     * that only looks like it should.
     */
    document.documentElement.setAttribute('data-modal', 'stopboard');
    const focusables = () => Array.from(
      ref.current?.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((el) => !el.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(false); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.documentElement.removeAttribute('data-modal');
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const rows = arr ? byRoute(arr.departures) : [];
  const nextRows = nextService ? byRoute(nextService.departures).slice(0, 6) : [];

  // Only a ghost that touches a route on THIS board — a cancellation three neighbourhoods
  // away is not this stop's news. No match, no card; nothing here is ever synthesised.
  const boardRoutes = new Set((arr?.departures ?? []).map((d) => d.routeId).filter(Boolean));
  const localGhost = ghosts?.events.find((e) => e.routeId && boardRoutes.has(e.routeId)) ?? null;

  return (
    <div className="sheet-scrim stopsheet-scrim" onClick={() => close(false)}>
      <div
        ref={ref}
        className="stopsheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('stopSheet.label', { stop: arr?.stopName ?? t('stopSheet.thisStop') })}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="stopsheet-head">
          <span className="eyebrow">{t('sections.currentStop')}</span>
          <button className="btn btn-quiet stopsheet-close" onClick={() => close(false)}>
            <CloseIcon width={16} height={16} aria-hidden />
            <span>{t('search.close')}</span>
          </button>
        </header>

        <div className="stopsheet-body scroll" tabIndex={0} role="group" aria-label={t('stopSheet.bodyLabel')}>
          {/* Our own server did not answer. Named as ours — never as the agency's. */}
          {!arr && (error || apiFailure) ? (
            <div className="state-card state-down" role="status">
              <div className="state-glyph" aria-hidden><WarningIcon width={22} height={22} /></div>
              <h3 className="state-title">{t('empty.apiDownTitle')}</h3>
              <p className="state-body">
                {apiFailure === 'throttled' ? t('empty.apiDownThrottled') : t('empty.apiDownBody')}
              </p>
              <p className="state-body state-fine">{t('empty.apiDownRetrying')}</p>
            </div>
          ) : !arr ? (
            // Skeleton rows shaped like real ones, never a spinner and never nothing.
            <>
              <div className="skeleton stophead-skeleton" />
              <div className="dep-list">
                {[0, 1, 2].map((i) => <div key={i} className="skeleton dep-skeleton" />)}
              </div>
            </>
          ) : (
            <>
              <StopHeader
                arr={arr}
                distanceM={distanceM}
                headsigns={(arr.departures.length > 0 ? arr.departures : nextService?.departures ?? [])
                  .map((d) => d.directionLabel)}
              />

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
                    />
                  ))}
                </div>
              ) : (
                <div className="state-card state-empty" role="status">
                  <h3 className="state-title">{t('empty.noWindow', { min: Math.round(arr.windowMinutes) })}</h3>
                  <p className="state-body">
                    {nextRows.length > 0 ? t('empty.nextServiceNote') : t('empty.noneScheduled')}
                  </p>
                </div>
              )}

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
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
