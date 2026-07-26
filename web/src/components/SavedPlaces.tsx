import { useTranslation } from 'react-i18next';
import { useLive, liveNow } from '@/hooks/useLive';
import { useTick } from '@/hooks/useTick';
import { useStore, paceMps } from '@/store';
import { PinIcon, StarIcon, BookmarkIcon } from './icons';
import { walkLegSeconds, walkMinutes } from '@/lib/walk';

/**
 * The reference's SAVED PLACES rows, built only from stops the rider has actually
 * starred (localStorage `gb.saved`). Nothing is seeded: with nothing saved the
 * section is the honest empty state, never a decorative "Home / 12 min walk".
 *
 * Each row's sub-line is derived, never invented:
 *  - the loaded board's own stop shows its next real departure ("510 · 9 min");
 *  - a stop that came back from /stops/nearby shows its real walk time;
 *  - anything else shows no sub-line at all, because we hold no fact about it.
 */
function useSavedRows() {
  const { t } = useTranslation();
  // The "510 · 9 min" sub-line is a countdown. Without a tick it would only move
  // when the 30s arrivals poll happens to land, and read stale in between.
  useTick(30_000);
  const savedStops = useStore((s) => s.savedStops);
  const pace = useStore((s) => s.pace);
  const nearby = useLive((s) => s.nearby);
  const arrivals = useLive((s) => s.arrivals);

  return savedStops.map((saved) => {
    const { agency, stopId } = saved;
    // Matched on the PAIR: another agency can carry the same stop id, and matching on the
    // id alone would label a saved stop with a different city's name and countdown.
    const near = nearby.find((s) => s.agency === agency && s.stopId === stopId);
    const onThisStop = arrivals?.agency === agency && arrivals?.stopId === stopId;
    const name = near?.name ?? (onThisStop ? arrivals.stopName : null);

    let sub: string | null = null;
    if (onThisStop && arrivals.departures.length > 0) {
      const d = arrivals.departures[0];
      const eta = d.liveEtaMs ?? d.honest.estimateMs ?? d.scheduledMs;
      const min = Math.max(0, Math.round((eta - liveNow()) / 60_000));
      sub = t('saved.liveContext', { route: d.shortName ?? d.routeId ?? '—', min });
    } else if (near?.distanceM != null) {
      // Saved places are never the walk the map has drawn, so this is always the
      // straight-line estimate and always wears the mark that says so.
      sub = t('stop.walkEst', { min: walkMinutes(walkLegSeconds('direct', near.distanceM, paceMps(pace))) });
    }

    return { agency, stopId, title: name ?? t('stop.code', { code: stopId }), sub };
  });
}

function SavedRow({ agency, stopId, title, sub }: { agency: string; stopId: string; title: string; sub: string | null }) {
  const { t } = useTranslation();
  const selectStop = useStore((s) => s.selectStop);
  const setTab = useStore((s) => s.setTab);
  const toggleSaved = useStore((s) => s.toggleSaved);

  return (
    <li className="saved-row">
      <button
        className="saved-open"
        onClick={() => { selectStop(stopId); setTab('nearby'); }}
        aria-label={t('a11y.openStop', { name: title })}
      >
        <span className="saved-tile" aria-hidden><PinIcon width={17} height={17} /></span>
        <span className="saved-text">
          <span className="saved-title">{title}</span>
          {sub && <span className="saved-sub">{sub}</span>}
        </span>
      </button>
      <button
        className="saved-star is-saved"
        aria-pressed="true"
        aria-label={t('stop.saved')}
        onClick={() => toggleSaved({ agency, stopId })}
      >
        <StarIcon width={18} height={18} filled />
      </button>
    </li>
  );
}

/** The section as it appears inside Nearby: label, "View all", up to two rows. */
export function SavedPlacesSection() {
  const { t } = useTranslation();
  const setTab = useStore((s) => s.setTab);
  const rows = useSavedRows();

  return (
    <section className="gb-section" aria-labelledby="gb-saved-head">
      <div className="section-head">
        <span className="eyebrow" id="gb-saved-head">{t('sections.savedPlaces')}</span>
        {rows.length > 0 && (
          <button className="section-link" onClick={() => setTab('saved')}>{t('sections.viewAll')}</button>
        )}
      </div>
      {rows.length > 0 ? (
        <ul className="saved-list">
          {rows.slice(0, 2).map((r) => <SavedRow key={`${r.agency}/${r.stopId}`} {...r} />)}
        </ul>
      ) : (
        <p className="saved-empty">{t('saved.empty')}</p>
      )}
    </section>
  );
}

/** The whole Saved tab — the same rows, uncapped. */
export function SavedPanel() {
  const { t } = useTranslation();
  const rows = useSavedRows();

  if (rows.length === 0) {
    return (
      <div className="placeholder-view">
        <div className="state-card state-placeholder" role="status">
          <div className="state-glyph" aria-hidden><BookmarkIcon width={26} height={26} /></div>
          <h2 className="state-title">{t('saved.title')}</h2>
          <p className="state-body">{t('saved.body')}</p>
        </div>
      </div>
    );
  }

  return (
    <section className="gb-section" aria-labelledby="gb-savedtab-head">
      <div className="section-head">
        <span className="eyebrow" id="gb-savedtab-head">{t('sections.savedPlaces')}</span>
      </div>
      <ul className="saved-list">
        {rows.map((r) => <SavedRow key={`${r.agency}/${r.stopId}`} {...r} />)}
      </ul>
    </section>
  );
}
