// "Where to?" — the real one.
//
// This control used to be a `<div aria-hidden="true">` with a placeholder painted
// inside it: it looked exactly like a search field and did nothing at all. In an app
// whose entire argument is that it does not show riders things that are not true, a
// false affordance in the top bar was the worst possible bug. So: a real <input>, a
// real query against /api/stops, real results, and a selection that genuinely moves
// the app to the stop that was chosen.
//
// What each section is allowed to claim:
//   RECENTS  places this device has actually opened (localStorage, never the server).
//   STOPS    live hits from /api/stops. The distance is measured from the rider's own
//            fix and is simply ABSENT when there is no fix — never estimated.
//   ROUTES   built from departure boards already held, so every row carries the real
//            stop it leaves from and the real time it leaves. A route we cannot say
//            anything true about does not appear.
//
// The next-departure chip is fetched for the HIGHLIGHTED row only, debounced and
// cached. Fetching one per visible result would be four to twelve requests per
// keystroke against a 120 req/min budget — and a rate-limited search that silently
// showed nothing would be the same class of lie the field started out as.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArrivalsResponse, DepartureDto, StopDto } from '@shared/types';
import { api } from '@/lib/api';
import { useLive, liveNow } from '@/hooks/useLive';
import { useStore, type SearchMode } from '@/store';
import { fmtClock, fmtDistance, fmtServiceDate } from '@/lib/format';
import { parseHeadsign } from '@/lib/headsign';
import {
  shapeStopResults, matchRoutes, filterRecents, dedupeAgainst,
  type RecentPlace, type RouteResult, type StopResult,
} from '@/lib/search';
import { RouteBadge } from './Primitives';
import { SearchIcon, PinIcon, ClockIcon, StarIcon, RouteIcon, FlagIcon } from './icons';

/** Long enough that a normal typing burst is one request, short enough to feel live. */
const DEBOUNCE_MS = 220;
/** The highlighted row's board is fetched only after the highlight settles. */
const PEEK_DEBOUNCE_MS = 300;
/** A day's worth, so the chip can still name a real departure when tonight's board is
 *  empty and the next scheduled service is tomorrow morning. One request either way. */
const PEEK_WINDOW_MIN = 1440;

type Option =
  | { id: string; kind: 'recent'; row: RecentPlace }
  | { id: string; kind: 'stop'; row: StopResult }
  | { id: string; kind: 'route'; row: RouteResult };

interface Section {
  key: string;
  label: string;
  options: Option[];
}

/** The next real departure on a board, or null when the board is genuinely empty. */
function firstDeparture(arr: ArrivalsResponse | null): DepartureDto | null {
  if (!arr || arr.departures.length === 0) return null;
  return arr.departures.reduce((a, b) => (a.scheduledMs <= b.scheduledMs ? a : b));
}

function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

export function SearchSheet() {
  const mode = useStore((s) => s.searchMode);
  if (!mode) return null;
  // Remounted per open, so every piece of query state starts clean and the
  // focus/scroll-lock effect below runs exactly once per opening.
  return <SearchSheetOpen mode={mode} />;
}

function SearchSheetOpen({ mode }: { mode: SearchMode }) {
  const { t } = useTranslation();
  const close = useCallback(() => useStore.getState().openSearch(null), []);

  const geo = useLive((s) => s.geo);
  const geoStatus = useLive((s) => s.geoStatus);
  const nearby = useLive((s) => s.nearby);
  const arrivals = useLive((s) => s.arrivals);
  const nextService = useLive((s) => s.nextService);
  const savedStops = useStore((s) => s.savedStops);
  const recentStops = useStore((s) => s.recentStops);
  const recentTrips = useStore((s) => s.recentTrips);

  const [q, setQ] = useState('');
  const [stops, setStops] = useState<StopDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ---------------- the query ----------------
  // Same request-generation guard `useLive` uses for arrivals, plus an abort so a
  // superseded request stops costing the rate-limit budget as well as being ignored.
  const seqRef = useRef(0);
  useEffect(() => {
    const query = q.trim();
    if (query.length === 0) {
      seqRef.current += 1; // invalidate anything still in flight
      setStops([]); setLoading(false); setFailed(false);
      return;
    }
    const seq = ++seqRef.current;
    const ctrl = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      api.stops(query, ctrl.signal)
        .then((res) => {
          if (seq !== seqRef.current) return;
          setStops(res.stops); setFailed(false); setLoading(false);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          // An aborted request is not a failure — it was replaced.
          if (ctrl.signal.aborted) return;
          setStops([]); setFailed(true); setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [q]);

  // ---------------- sections ----------------
  const from = geo;
  const recentsPool = mode === 'destination' ? recentTrips : recentStops;
  const recents = useMemo(() => filterRecents(recentsPool, q), [recentsPool, q]);

  const stopRows = useMemo(
    () => dedupeAgainst(shapeStopResults(stops, from, q), recents),
    [stops, from, q, recents],
  );

  /** Saved stops, named from whatever real data we already hold. */
  const savedRows = useMemo<StopResult[]>(() => savedStops.map((stopId) => {
    const near = nearby.find((s) => s.stopId === stopId);
    const onBoard = arrivals?.stopId === stopId ? arrivals : null;
    const lat = near?.lat ?? onBoard?.lat ?? null;
    const lon = near?.lon ?? onBoard?.lon ?? null;
    return {
      kind: 'stop',
      stopId,
      name: near?.name ?? onBoard?.stopName ?? stopId,
      lat, lon,
      distanceM: near?.distanceM ?? null,
      wheelchairBoarding: near?.wheelchairBoarding ?? null,
    };
  }), [savedStops, nearby, arrivals]);

  // Routes come only from boards we hold, so every row has a real stop and a real time.
  const routeRows = useMemo(() => {
    if (mode === 'destination') return []; // a route is not a place to travel TO
    const boards = [arrivals, nextService]
      .filter((b): b is ArrivalsResponse => b != null)
      .map((b) => ({ stopId: b.stopId, stopName: b.stopName, departures: b.departures }));
    return matchRoutes(boards, q);
  }, [arrivals, nextService, q, mode]);

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    if (recents.length > 0) {
      out.push({
        key: 'recents', label: t('search.recents'),
        options: recents.map((r) => ({ id: `rec-${r.stopId}`, kind: 'recent', row: r })),
      });
    }
    if (q.trim() === '') {
      if (savedRows.length > 0) {
        out.push({
          key: 'saved', label: t('sections.savedPlaces'),
          options: savedRows.map((r) => ({ id: `sav-${r.stopId}`, kind: 'stop', row: r })),
        });
      }
    } else {
      if (stopRows.length > 0) {
        out.push({
          key: 'stops', label: t('search.stops'),
          options: stopRows.map((r) => ({ id: `stp-${r.stopId}`, kind: 'stop', row: r })),
        });
      }
      if (routeRows.length > 0) {
        out.push({
          key: 'routes', label: t('search.routes'),
          options: routeRows.map((r) => ({ id: `rte-${r.routeId}-${r.directionLabel}`, kind: 'route', row: r })),
        });
      }
    }
    return out;
  }, [recents, savedRows, stopRows, routeRows, q, t]);

  const flat = useMemo(() => sections.flatMap((s) => s.options), [sections]);
  // A shrinking list must never leave the highlight pointing past the end.
  const activeIdx = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const activeOpt = activeIdx >= 0 ? flat[activeIdx] : null;
  useEffect(() => { setActive(0); }, [q]);

  // ---------------- next-departure chip for the highlighted row ----------------
  const [peek, setPeek] = useState<Record<string, DepartureDto | null>>({});
  const peekStopId = activeOpt?.kind === 'route'
    ? null
    : activeOpt?.kind === 'stop' ? activeOpt.row.stopId
      : activeOpt?.kind === 'recent' ? activeOpt.row.stopId : null;
  useEffect(() => {
    if (!peekStopId || peekStopId in peek) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      api.arrivals(peekStopId, { windowMin: PEEK_WINDOW_MIN }, ctrl.signal)
        .then((arr) => setPeek((p) => ({ ...p, [peekStopId]: firstDeparture(arr) })))
        // A stop we could not read simply has no chip. Nothing is guessed into it.
        .catch(() => { if (!ctrl.signal.aborted) setPeek((p) => ({ ...p, [peekStopId]: null })); });
    }, PEEK_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [peekStopId, peek]);

  // ---------------- choosing ----------------
  const chooseStop = useCallback(async (place: { stopId: string; name: string; lat: number | null; lon: number | null; wheelchairBoarding?: number | null }) => {
    const store = useStore.getState();
    let { lat, lon } = place;
    // A saved stop we have never had coordinates for still has to be plannable. The
    // exact-id branch of /api/stops answers that in one request with the agency's own
    // coordinates — which is a lookup, not an invention.
    if (mode === 'destination' && (lat == null || lon == null)) {
      try {
        const res = await api.stops(place.stopId);
        const hit = res.stops.find((s) => s.stopId === place.stopId);
        if (hit) { lat = hit.lat; lon = hit.lon; }
      } catch { /* leave them null — handled honestly below */ }
    }
    const remembered: RecentPlace = { stopId: place.stopId, name: place.name, lat, lon, ts: Date.now() };

    if (mode === 'destination') {
      // Without coordinates there is nothing to plan a journey to, so the destination
      // is not accepted at all rather than accepted and then quietly failing.
      if (lat == null || lon == null) return;
      store.setPlanTarget(remembered);
      store.setTab('plan');
    } else {
      store.rememberStop(remembered);
      useLive.getState().openStop({ ...place, lat, lon });
      store.setTab('nearby');
    }
    close();
  }, [mode, close]);

  const choose = useCallback((opt: Option) => {
    if (opt.kind === 'route') {
      // A route row IS a departure, so opening it opens the stop that departure leaves
      // from — the one place the app can show a rider something true about it. The
      // board it came from carries that stop's real coordinates, so the distance
      // survives the jump instead of the header losing it.
      const board = [arrivals, nextService].find((b) => b?.stopId === opt.row.stopId) ?? null;
      void chooseStop({
        stopId: opt.row.stopId,
        name: opt.row.stopName ?? opt.row.stopId,
        lat: board?.lat ?? null,
        lon: board?.lon ?? null,
        wheelchairBoarding: board?.wheelchairBoarding ?? null,
      });
      return;
    }
    void chooseStop({
      stopId: opt.row.stopId,
      name: opt.row.name,
      lat: opt.row.lat, lon: opt.row.lon,
      wheelchairBoarding: opt.kind === 'stop' ? opt.row.wheelchairBoarding : null,
    });
  }, [chooseStop, arrivals, nextService]);

  // ---------------- modal keyboard contract ----------------
  // Same shape as CatchView / SettingsSheet / AboutSheet: focus moves in on open,
  // Escape closes, Tab is trapped, focus returns to whatever opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    document.documentElement.setAttribute('data-modal', 'search');
    const focusables = () => Array.from(
      sheetRef.current?.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((el) => !el.hasAttribute('disabled'));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); useStore.getState().openSearch(null); return; }
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
      // Restore focus to whatever opened this. Opening with ⌘K or "/" means nothing
      // had focus at all, and handing it back to <body> would strand a keyboard
      // rider at the top of the document with no idea where they had been. The
      // search trigger is the control this sheet belongs to, so that is the fallback.
      const stranded = !opener || !opener.isConnected || opener === document.body
        || typeof opener.focus !== 'function';
      const target = stranded
        ? document.querySelector<HTMLElement>('.searchfield-trigger')
        : opener;
      target?.focus?.();
    };
  }, []);

  // Keep the highlighted row in view when the arrows walk past the fold.
  useEffect(() => {
    if (activeIdx < 0) return;
    listRef.current?.querySelector(`#gb-so-${activeIdx}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (flat.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (Math.min(i, flat.length - 1) + 1) % flat.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (Math.min(i, flat.length - 1) - 1 + flat.length) % flat.length); }
    else if (e.key === 'Enter' && activeOpt) { e.preventDefault(); choose(activeOpt); }
  };

  const imperial = useStore((s) => s.units) === 'imperial';
  const now = liveNow();

  const chipFor = (stopId: string) => {
    const d = peek[stopId];
    if (!d) return null;
    const at = d.liveEtaMs ?? d.scheduledMs;
    const time = sameLocalDay(at, now)
      ? fmtClock(at)
      : `${fmtServiceDate(at)} ${fmtClock(at)}`;
    return { short: d.shortName ?? d.routeId ?? '—', color: d.color, time, live: d.liveEtaMs != null };
  };

  const title = mode === 'destination' ? t('search.destinationTitle') : t('search.title');
  const placeholder = mode === 'destination' ? t('search.destinationPlaceholder') : t('search.placeholder');
  const noResults = q.trim() !== '' && !loading && flat.length === 0;
  const nearestKnown = nearby[0]?.name ?? null;

  return (
    <div className="sheet-scrim search-scrim" onClick={close}>
      <div
        ref={sheetRef}
        className="search-sheet glass"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="search-bar">
          {/*
            A STATIC MAGNIFIER. It used to cross-fade into a ✕ as soon as the field had text —
            inside an `aria-hidden` span with no handler, so clicking it did nothing.

            A ✕ inside a search field is universally read as "clear", so this was a dead
            affordance in the most prominent position in the sheet, with the real control (the
            named `Clear` button) 300px away at the other end of the bar. That is precisely the
            defect this file's own header says it exists to remove: a control that looks live
            and does nothing.

            The alternative was to promote it to a real button, but then the sheet would ship
            two clear affordances for one action, and the text button is already the better
            one — it has an accessible name, it is in the tab order, and its focus contract is
            verified. So the icon goes back to meaning exactly one thing: this is a search
            field. It no longer pretends to be a control.
          */}
          <span className="search-glyphs" aria-hidden>
            <SearchIcon width={18} height={18} />
          </span>
          <label className="sr-only" htmlFor="gb-search-input">{title}</label>
          <input
            ref={inputRef}
            id="gb-search-input"
            className="search-input"
            type="text"
            role="combobox"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-expanded={flat.length > 0}
            aria-controls="gb-search-list"
            aria-autocomplete="list"
            aria-activedescendant={activeIdx >= 0 ? `gb-so-${activeIdx}` : undefined}
            placeholder={placeholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
          />
          {q && (
            <button className="search-clear" onClick={() => { setQ(''); inputRef.current?.focus(); }}>
              {t('search.clear')}
            </button>
          )}
          <button className="btn btn-quiet search-close" onClick={close}>{t('search.close')}</button>
        </div>

        <div className="search-results scroll" id="gb-search-list" role="listbox" aria-label={title} ref={listRef}>
          {sections.map((section) => (
            <div className="search-section" key={section.key} role="group" aria-labelledby={`gb-sec-${section.key}`}>
              <div className="search-section-head">
                <span className="eyebrow" id={`gb-sec-${section.key}`}>{section.label}</span>
              </div>
              <div className="search-rows">
                {section.options.map((opt) => {
                  const i = flat.indexOf(opt);
                  const isActive = i === activeIdx;
                  const chip = opt.kind === 'route' ? null : chipFor(opt.row.stopId);
                  return (
                    <div
                      key={opt.id}
                      id={`gb-so-${i}`}
                      className={`search-row ${isActive ? 'search-row-active' : ''}`}
                      role="option"
                      aria-selected={isActive}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(opt)}
                    >
                      {opt.kind === 'route' ? (
                        <RouteRow row={opt.row} />
                      ) : (
                        <StopRow
                          name={opt.row.name}
                          stopId={opt.row.stopId}
                          distanceM={opt.kind === 'stop' ? opt.row.distanceM : null}
                          imperial={imperial}
                          recent={opt.kind === 'recent'}
                          saved={section.key === 'saved'}
                          chip={chip}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {loading && flat.length === 0 && (
            <div className="search-rows search-skeletons" aria-hidden>
              {[0, 1, 2].map((i) => <div key={i} className="skeleton search-skeleton" />)}
            </div>
          )}

          {failed && (
            <p className="search-note" role="status">{t('search.failed')}</p>
          )}

          {noResults && !failed && (
            <div className="search-empty" role="status">
              <p className="search-empty-title">{t('search.noResults', { q: q.trim() })}</p>
              <p className="search-note">
                {nearestKnown ? t('search.coverageNear', { area: nearestKnown }) : t('search.coverage')}
              </p>
            </div>
          )}

          {q.trim() === '' && flat.length === 0 && (
            <p className="search-note" role="status">
              {mode === 'destination' ? t('search.emptyDestination') : t('search.empty')}
            </p>
          )}

          {geoStatus === 'default' && (
            <p className="search-note search-note-quiet">{t('search.defaultLocationNote')}</p>
          )}
        </div>

        {/* Counts, spoken once per settled query rather than on every keystroke. */}
        <p className="sr-only" role="status">
          {loading ? t('search.searching') : t('search.resultCount', { count: flat.length })}
        </p>

        <p className="search-hints" aria-hidden>
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('search.hintMove')}</span>
          <span><kbd>↵</kbd> {t('search.hintOpen')}</span>
          <span><kbd>esc</kbd> {t('search.hintClose')}</span>
        </p>
      </div>
    </div>
  );
}

function StopRow({ name, stopId, distanceM, imperial, recent, saved, chip }: {
  name: string;
  stopId: string;
  distanceM: number | null;
  imperial: boolean;
  recent: boolean;
  saved: boolean;
  chip: { short: string; color: string; time: string; live: boolean } | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      <span className="search-tile" aria-hidden>
        {recent ? <ClockIcon width={17} height={17} />
          : saved ? <StarIcon width={17} height={17} filled />
            : <PinIcon width={17} height={17} />}
      </span>
      <span className="search-text">
        <span className="search-title">{name}</span>
        <span className="search-sub">
          <span className="search-fact">{t('stop.code', { code: stopId })}</span>
          {/* Distance is printed only when it was actually measured. */}
          {distanceM != null && (
            <span className="search-fact">{t('stop.away', { dist: fmtDistance(distanceM, imperial) })}</span>
          )}
        </span>
      </span>
      {chip && (
        <span className={`search-chip ${chip.live ? 'search-chip-live' : ''}`}>
          <RouteBadge color={chip.color} short={chip.short} size="sm" />
          <span className="search-chip-time">{chip.time}</span>
        </span>
      )}
    </>
  );
}

function RouteRow({ row }: { row: RouteResult }) {
  const { t } = useTranslation();
  const destination = parseHeadsign(row.directionLabel).destination || row.directionLabel;
  return (
    <>
      <span className="search-tile" aria-hidden><RouteIcon width={17} height={17} /></span>
      <span className="search-text">
        <span className="search-title">
          <RouteBadge color={row.color} short={row.shortName} size="sm" />
          <span className="search-route-dest">{destination}</span>
        </span>
        <span className="search-sub">
          <span className="search-fact">{row.stopName ?? t('stop.code', { code: row.stopId })}</span>
          <span className="search-fact">{fmtClock(row.departureMs)}</span>
        </span>
      </span>
      <span className="search-go" aria-hidden><FlagIcon width={16} height={16} /></span>
    </>
  );
}
