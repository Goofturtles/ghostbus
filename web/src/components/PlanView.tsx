// THE HOME. The map is above it, the journey planner is this, and there is no longer a
// feed of nearby buses anywhere in the app.
//
// What replaced the Nearby tab is not just "Plan moved to the front". Three things that
// were load-bearing about that panel and are NOT about any one stop moved here with it,
// because they are facts about the app's relationship with the rider rather than about a
// board:
//
//   · the location-permission entry point (which also carries the iOS compass grant —
//     see useLive.requestLocation; it must stay on a real tap);
//   · the honest out-of-coverage card, which is the one thing standing between a rider in
//     Mississauga and a downtown Toronto board presented as theirs;
//   · the three feed-attribution banners — demo, ours, theirs — kept strictly apart
//     exactly as DECISIONS §45 requires.
//
// The stop board itself did not move here. It became StopBoardSheet, opened by tapping a
// stop on the map or picking one out of search.
//
// Every number on screen still comes from the agency's published schedule or from
// observations GhostBus actually recorded.
//
// THE SCOPE IS DELIBERATE AND STATED. GhostBus plans ONE ride where one ride does it,
// and AT MOST TWO joined by a single short walk where one will not. It never goes to a
// third leg, and it never offers a connection it cannot check against both published
// schedules — a fabricated connection is precisely the kind of confident-sounding
// fiction this whole project exists to argue against. Where even two rides cannot do it,
// the planner says so and offers a maps app instead.
//
// The five outcomes are five different facts and are never collapsed into one shrug:
//   ride        · real single-ride options, ranked.
//   twoLeg      · two rides and the walk between them, each leg with its own evidence.
//   transfer    · neither one ride nor two walkable ones link the two ends.
//   noService   · a direct ride exists, but none departs in the window searched.
//   noStops…    · one end has no stop near it at all.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlanResponse } from '@shared/types';
import { api } from '@/lib/api';
import { useLive, liveNow, isBackedOff, selectedNearbyStop } from '@/hooks/useLive';
import { useTick } from '@/hooks/useTick';
import { useStore, paceMps } from '@/store';
import { fmtDistance } from '@/lib/format';
import { transitDirectionsUrl } from '@/lib/plan';
import { buildOptions, type OptionList } from '@/lib/journey';
import { planPointCoords, planPointKey, needsFix, HERE, type PlanPoint } from '@/lib/planpoint';
import { PlanOptions } from './PlanOptions';
import { SavedPlacesSection } from './SavedPlaces';
import { OfflineCard } from './OfflineCard';
import {
  SearchIcon, RouteIcon, FlagIcon, ClockIcon, WarningIcon, PinIcon, LocateIcon,
  ChevronIcon, CloseIcon, ArrowRightIcon, SwapIcon,
} from './icons';

/** How far ahead the first request looks. Matches the departure board's own window. */
const FIRST_WINDOW_MIN = 90;
/** When nothing runs in the next 90 minutes, one wider request walks forward to the
 *  next real service day rather than eight day-by-day probes. */
const NEXT_SERVICE_WINDOW_MIN = 4320;
/** How often a plan on screen is re-asked. Twice the board's 30s cadence, because a plan
 *  is a much heavier query — and it is what bounds how stale any live mark on the options
 *  list can be. See the re-plan effect for why once-and-never-again was a defect. */
const REPLAN_INTERVAL_MS = 60_000;

/**
 * WHAT AN END OF THE TRIP IS CALLED ON SCREEN.
 *
 * `here` is the only kind with no name of its own, and the word it gets depends on
 * whether the fix is really the rider's: a default city-centre location presented as
 * "Your location" would be the app telling somebody it knows where they are when it does
 * not. That distinction already existed for the old fixed origin line and is preserved.
 */
function usePointLabel() {
  const { t } = useTranslation();
  const geoStatus = useLive((s) => s.geoStatus);
  return (p: PlanPoint | null): string => {
    if (p == null) return t('plan.chooseDestination');
    if (p.kind === 'here') return geoStatus === 'granted' ? t('plan.fromYou') : t('plan.fromDefault');
    if (p.kind === 'pin') return p.label;
    return p.place.name;
  };
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'done'; res: PlanResponse; widened: boolean };

export function PlanView() {
  const { t } = useTranslation();
  useTick(30_000);
  const target = useStore((s) => s.planTarget);
  const origin = useStore((s) => s.planOrigin);
  const swapPlanEnds = useStore((s) => s.swapPlanEnds);
  const recentTrips = useStore((s) => s.recentTrips);
  const setPlanTarget = useStore((s) => s.setPlanTarget);
  const setPlanOrigin = useStore((s) => s.setPlanOrigin);
  const label = usePointLabel();
  const openSearch = useStore((s) => s.openSearch);
  const pace = useStore((s) => s.pace);
  const imperial = useStore((s) => s.units) === 'imperial';
  const geo = useLive((s) => s.geo);
  // Subscribed, not read through getState(): a cold start resolves the geo fix before the
  // nearby query returns, and the selection effect below has to re-run when stops arrive.
  const nearby = useLive((s) => s.nearby);
  const geoStatus = useLive((s) => s.geoStatus);
  const online = useLive((s) => s.online);
  const requestLocation = useLive((s) => s.requestLocation);

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Same monotonic guard the rest of the app uses: a slow reply for a destination the
  // rider has since changed must never overwrite the current plan.
  const seqRef = useRef(0);
  /** Which question the phase currently on screen is the answer to — see the refresh
   *  note in the fetch effect. Null until the first plan is asked for. */
  const lastAskedRef = useRef<string | null>(null);

  /**
   * THE PLAN IS RE-ASKED, because the options list paints LIVE off it.
   *
   * This fetched once and never again — which was survivable when the tab rendered one
   * static summary card, and is not now. `optionIsLive` draws a live arc and a LIVE pill
   * from `liveEtaMs`, the countdown pins itself at "Due" the moment `boardMs` passes, and
   * `buildOptions` filters unreachable options against the `nowMs` it was handed. Left on
   * screen, the list would sit there showing a bus that departed forty minutes ago as
   * live and due — the app's strongest truth claim, attached to its stalest data.
   *
   * The departure board already solved this by refreshing every 30 seconds. A plan is a
   * heavier query, so it re-asks at 60, which is well inside the planner's own rate limit
   * and bounds the staleness of every live mark on the list to one minute.
   *
   * The shared backoff is honoured: a re-plan is exactly the kind of avoidable request
   * that must not be fired at a server which has just told us to stop.
   */
  const [replanNonce, setReplanNonce] = useState(0);
  useEffect(() => {
    if (!target || !geo) return;
    const bump = () => { if (!document.hidden && !isBackedOff()) setReplanNonce((n) => n + 1); };
    const timer = window.setInterval(bump, REPLAN_INTERVAL_MS);
    // Returning to a backgrounded tab is the worst case for staleness — the timer was
    // throttled or asleep, so the answer on screen may be many minutes old.
    const onVis = () => { if (!document.hidden) bump(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [origin, target, geo]);

  useEffect(() => {
    // BOTH ENDS RESOLVE THE SAME WAY. The origin used to be the rider's fix by
    // construction; now it is a value, so it can fail to resolve exactly as the
    // destination can — an unfixed `here`, or a stop the agency published with no
    // coordinate. Either way there is no question to ask, and none is asked.
    const from = planPointCoords(origin, geo);
    const to = planPointCoords(target, geo);
    if (!from || !to) {
      seqRef.current += 1;
      setPhase({ kind: 'idle' });
      return;
    }
    const seq = ++seqRef.current;
    const ctrl = new AbortController();
    /**
     * A REFRESH IS NOT A NEW QUESTION — but a NEW QUESTION MUST NEVER KEEP THE OLD ANSWER.
     *
     * Dropping to the skeleton on every 60s re-plan would make the answer flicker away and
     * back under the reader, so a refresh holds what is on screen. Deciding that on
     * `phase.kind === 'done'` alone would be the worse bug in the other direction: pick a
     * new destination while an answer is showing and the previous destination's options
     * would sit there, unlabelled, as though they were the answer to the new question.
     *
     * So the two cases are told apart by what the effect is actually running FOR. Same
     * question, keep the answer; anything else, show that we are working on it.
     */
    // U+001E between the two ends, for the same reason `planPointKey` uses U+001F inside
    // one: a printable separator is one agency's odd stop_id away from making two
    // different questions look like the same one.
    const key = `${planPointKey(origin, geo)}${planPointKey(target, geo)}`;
    const isRefresh = lastAskedRef.current === key;
    lastAskedRef.current = key;
    setPhase((cur) => (isRefresh && cur.kind === 'done' ? cur : { kind: 'loading' }));

    (async () => {
      try {
        const first = await api.plan(from, to, { windowMin: FIRST_WINDOW_MIN }, ctrl.signal);
        if (seq !== seqRef.current) return;
        // A direct ride exists but not in the next 90 minutes — reach forward to the
        // service day that actually has one instead of reporting a dead end.
        if (first.outcome === 'noService') {
          const wide = await api.plan(from, to, { windowMin: NEXT_SERVICE_WINDOW_MIN }, ctrl.signal);
          if (seq !== seqRef.current) return;
          setPhase({ kind: 'done', res: wide, widened: true });
          return;
        }
        setPhase({ kind: 'done', res: first, widened: false });
      } catch {
        if (seq !== seqRef.current || ctrl.signal.aborted) return;
        setPhase({ kind: 'error' });
      }
    })();

    return () => { ctrl.abort(); };
  }, [origin, target, geo, replanNonce]);

  /**
   * IS THERE A QUESTION WE CAN ACTUALLY ASK — both ends resolvable to a coordinate.
   *
   * Either end may be `here`, so either end may be waiting on the fix; a trip between two
   * named stops waits on neither.
   */
  const ready = (!needsFix(origin) || geo != null) && (!needsFix(target) || geo != null);

  const now = liveNow();

  /**
   * THE MENU, not a verdict.
   *
   * Every reachable option the server offered, ranked by when the rider actually arrives.
   * `now` is deliberately excluded from the dependencies for the same reason the single
   * best pick always excluded it: re-ranking every tick would let the list reorder itself
   * under the reader's thumb. `useTick` still re-renders the countdowns on the cards.
   */
  const walkLeg = useStore((s) => s.walkLeg);
  const options = useMemo<OptionList>(() => {
    if (phase.kind !== 'done') return { options: [], laterBoardMs: new Map(), hiddenCount: 0, totalCount: 0, asOfMs: 0 };
    return buildOptions(phase.res, { nowMs: now, paceMps: paceMps(pace), boardWalk: walkLeg });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pace, walkLeg]);

  /**
   * WHICH OPTION THE RIDER IS READING — lifted out of the list so the MAP can follow it.
   *
   * The map draws its beaded walk path to the selected stop, so if the rider opens the
   * third option the line under their feet has to become that option's first leg. Left
   * inside the list this would be a purely visual expansion while the map kept drawing a
   * walk to a different journey's boarding stop.
   *
   * Reset to the best option whenever the menu itself changes, so a selection can never
   * outlive the plan it belonged to. Keyed on the ids rather than the array, because the
   * memo above produces a fresh array on every re-plan even when the answer is identical.
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const optionsKey = options.options.map((o) => o.id).join('|');
  useEffect(() => { setSelectedId(options.options[0]?.id ?? null); }, [optionsKey]);
  const selected = options.options.find((o) => o.id === selectedId) ?? options.options[0] ?? null;

  const clear = useCallback(() => setPlanTarget(null), [setPlanTarget]);

  /**
   * A resolved plan takes the map with it: the selected stop becomes the plan's own
   * BOARDING stop.
   *
   * This is not decoration. On the desktop split the map stays mounted beside this panel
   * and draws its beaded walk path from the rider to whatever stop is selected — so after
   * a rider searches a stop across town, the map keeps drawing a walk to it, and a 7 km
   * dotted trail beside a trip plan reads as a suggested route. Moving the selection to
   * the boarding stop makes that path the plan's own first leg, which is exactly what it
   * is meant to depict.
   *
   * Only the boarding stop of the FIRST ride: a transfer happens out in the network, and
   * drawing a path to it would depict a walk the rider has not started.
   */
  const boardStop = selected == null
    ? null
    : selected.kind === 'ride'
      ? selected.plan.candidate.board
      : selected.plan.leg1.candidate.board;

  /**
   * AND THE MIRROR OF THAT: any plan that is NOT a usable option takes the map's geometry
   * away.
   *
   * Without this, the previous plan's first leg stayed drawn — a beaded walk path to a
   * boarding stop belonging to a different journey — sitting directly under a message
   * saying this journey has no answer. A route-like line beside a message saying there is
   * no route is exactly the kind of confident-sounding fiction this tab exists to refuse.
   *
   * THIS CONDITION HAS BEEN WRONG TWICE, in the same way both times: it enumerated the
   * failures somebody had thought of instead of the one success it can actually depict.
   * So it stays inverted — there is exactly ONE state in which a first leg exists to draw,
   * and every other state a pending destination can be in (loading, errored, or answered
   * with nothing reachable) is unresolved by construction rather than by remembering to
   * add it here.
   *
   * Scoped to `target`, because with no destination chosen there is no question on screen
   * and therefore nothing to contradict.
   */
  const resolved = phase.kind === 'done' && options.options.length > 0;
  const unresolved = target != null && !resolved;

  /**
   * The selection follows the plan in BOTH directions.
   *
   * The truthy branch alone left `selectedStopId` pinned to a stale boarding stop when a
   * re-plan failed. Falling back to the rider's own nearest stop returns the map to the
   * picture it shows when no plan exists at all — which is the truthful thing to show when
   * no plan exists at all.
   *
   * SETTLED outcomes only. `unresolved` deliberately includes `loading` so the geometry
   * disappears the instant a new question is asked, but re-selecting on `loading` would
   * bounce the selection to the nearest stop and back on every single re-plan.
   */
  const settled = phase.kind === 'done' || phase.kind === 'error';
  const nearest = nearby[0] ?? null;
  /**
   * A RUNNING JOURNEY OWNS THE SELECTION, and this yields to it.
   *
   * PlanView stays mounted underneath GO mode, and both write `selectedStopId`. Every
   * 60-second re-plan produces fresh candidate objects, so this effect re-runs and would
   * re-point the board at whatever the list's top option is now — while the journey view,
   * whose own effect does not re-run, keeps describing the stop the rider is walking to.
   * The live board would then belong to a different stop than the verdict on screen.
   */
  const journeyRunning = useStore((s) => s.journey != null);
  useEffect(() => {
    if (journeyRunning) return;
    if (boardStop) {
      // Matched on the PAIR: a bare stop id is ambiguous across the seeded agencies.
      if (useStore.getState().selectedStopId === boardStop.stopId
        && selectedNearbyStop()?.agency === boardStop.agency) return;
      useLive.getState().openStop(boardStop);
      return;
    }
    if (!unresolved || !settled || !nearest) return;
    if (useStore.getState().selectedStopId === nearest.stopId) return;
    useLive.getState().openStop(nearest);
  }, [boardStop, unresolved, settled, nearest, journeyRunning]);

  /**
   * `target` is a dependency, and without it this desynced permanently: `setPlanTarget`
   * resets the store flag to `false` the moment a new destination is picked, and if the
   * previous plan was ALSO unresolved React would see an unchanged dep, never re-run, and
   * the store would keep the `false` it wrote itself.
   */
  useEffect(() => {
    useStore.getState().setPlanUnresolved(unresolved);
  }, [unresolved, target]);
  // Leaving the tab (or the app) must not strand the map in a plan-failed state.
  useEffect(() => () => { useStore.getState().setPlanUnresolved(false); }, []);

  return (
    <div className="plan-panel">
      <FeedBanners />

      {/* The location entry point. It carries the iOS compass grant too (see
          useLive.requestLocation), which is why it must stay a real tap and can never be
          fired automatically. */}
      {geoStatus === 'default' && (
        <button className="loc-note" onClick={requestLocation}>
          <LocateIcon width={15} height={15} aria-hidden />
          <span>{t('empty.defaultLocation')}</span>
        </button>
      )}

      <OutOfCoverageCard />

      <header className="plan-head">
        <h2 className="plan-title">{t('plan.title')}</h2>
        <p className="plan-sub">{t('plan.sub')}</p>
      </header>

      {/* Origin, then destination — the shape every trip planner uses. The origin is
          STATED rather than assumed, so a default location can never quietly masquerade
          as one the rider gave. */}
      <div className="plan-route">
        {/* THE ORIGIN IS A CONTROL NOW, not a caption. It read "From your location" and
            could not be changed, which made the two most ordinary questions a rider
            asks — how do I get home from work, how do I get downtown tomorrow — things
            this app could not be asked at all. `here` is still the default, and it is
            still labelled honestly as a default location when the fix is not really
            theirs. */}
        <div className="plan-from">
          <button
            className="plan-from-btn"
            aria-haspopup="dialog"
            onClick={() => openSearch('origin')}
          >
            <span className="plan-from-glyph" aria-hidden>
              {origin.kind === 'here'
                ? <LocateIcon width={16} height={16} />
                : <PinIcon width={16} height={16} />}
            </span>
            <span className="plan-from-text truncate">{label(origin)}</span>
            <ChevronIcon width={16} height={16} aria-hidden />
          </button>
          {origin.kind !== 'here' && (
            <button
              className="plan-from-reset"
              aria-label={t('plan.originReset')}
              onClick={() => setPlanOrigin(HERE)}
            >
              <LocateIcon width={16} height={16} />
            </button>
          )}
        </div>

        {/* SWAP. Disabled rather than hidden with no destination chosen: a control that
            appears and disappears as the rider types is harder to find than one that is
            visibly not yet available, and there is nothing to reverse until both ends
            exist. */}
        <button
          className="plan-swap"
          onClick={swapPlanEnds}
          disabled={target == null}
          aria-label={t('plan.swapEnds')}
        >
          <SwapIcon width={17} height={17} aria-hidden />
        </button>

        <div className="plan-dest">
          <button
            className="plan-dest-btn"
            aria-haspopup="dialog"
            onClick={() => openSearch('destination')}
          >
            <span className="plan-dest-glyph" aria-hidden><SearchIcon width={18} height={18} /></span>
            <span className="plan-dest-text truncate">
              {target ? label(target) : t('plan.chooseDestination')}
            </span>
            <ChevronIcon width={17} height={17} aria-hidden />
          </button>
          {target && (
            <button className="plan-dest-clear" aria-label={t('plan.clearDestination')} onClick={clear}>
              <CloseIcon width={17} height={17} />
            </button>
          )}
        </div>
      </div>

      {!target && !online && <OfflineCard />}

      {!target && online && <PlanIdle recents={recentTrips} />}

      {/* THE FIX IS ONLY REQUIRED WHERE AN END ACTUALLY DEPENDS ON IT.
          This used to be `!geo`, which was right while the origin was always the rider.
          Now a trip from one named stop to another needs no fix at all, and refusing to
          plan it for want of a permission it does not use would be the app inventing a
          dependency. `needsFix` asks the two ends instead of assuming. */}
      {target && !ready && (
        <PlanState glyph={<WarningIcon width={24} height={24} />} tone="warn" title={t('plan.noGeoTitle')} body={t('plan.noGeoBody')} />
      )}

      {target && ready && phase.kind === 'loading' && (
        <div className="plan-legs" aria-hidden>
          {[0, 1, 2].map((i) => <div key={i} className="skeleton plan-skeleton" />)}
        </div>
      )}

      {target && ready && phase.kind === 'error' && (
        <PlanState
          glyph={<WarningIcon width={24} height={24} />}
          tone="warn"
          title={online ? t('plan.errorTitle') : t('offline.title')}
          body={online ? t('plan.errorBody') : t('offline.body')}
        />
      )}

      {target && ready && phase.kind === 'done' && (
        <PlanOutcomeView
          res={phase.res}
          widened={phase.widened}
          options={options}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          imperial={imperial}
          destinationName={label(target)}
        />
      )}

      {geoStatus === 'default' && target && (needsFix(origin) || needsFix(target)) && (
        <p className="plan-fineprint">{t('plan.defaultLocationNote')}</p>
      )}

      {!target && <SavedPlacesSection />}
    </div>
  );
}

/**
 * THE THREE ATTRIBUTION STATES, kept strictly apart — moved here verbatim from the Nearby
 * panel, because they are facts about whether anything on this screen can be trusted and
 * they could not go down with the tab that used to host them. See DECISIONS §45.
 *
 *   isDemo      (c) the server is replaying a recording. Stated FIRST, because a
 *                   recording's feeds are honestly `ok` and the badge is the only thing
 *                   that stops that reading as live.
 *   apiFailure  (a) OUR server: throttled, restarting, or unreachable. Ours to fix, and it
 *                   is retrying by itself. NEVER mentions the agency.
 *   feedTrouble (b) our server is reachable and ITS OWN health says an agency feed is down
 *                   or stale. The only state allowed to name the TTC.
 */
function FeedBanners() {
  const { t } = useTranslation();
  const apiFailure = useLive((s) => s.apiFailure);
  const feedTrouble = useLive((s) => s.apiFailure == null && s.health != null && !s.health.ok);
  const isDemo = useLive((s) => s.health?.mode === 'demo');

  return (
    <>
      {isDemo && (
        <div className="feed-banner feed-banner-demo" role="status">
          <span className="demo-badge">{t('status.demoBadge')}</span>
          <span>{t('status.demoNote', { agency: t('agency.short') })}</span>
        </div>
      )}
      {!isDemo && apiFailure != null && (
        <div className="feed-banner feed-banner-ours" role="status">
          <WarningIcon width={15} height={15} aria-hidden />
          <span>{t('status.catchingUpDetail')}</span>
        </div>
      )}
      {!isDemo && feedTrouble && (
        <div className="feed-banner" role="status">
          <WarningIcon width={15} height={15} aria-hidden />
          <span>{t('status.feedDownGeneric')}</span>
        </div>
      )}
    </>
  );
}

/**
 * THE RIDER IS SOMEWHERE WE DO NOT COVER — and nothing here substitutes a location.
 *
 * The bug this closes, reported by a rider and now homed on the front page: spoofed to
 * Mississauga, the default-location banner disappeared — so they believed their location
 * had taken effect — and a downtown Toronto board stayed on screen as though it were
 * theirs. The only way back to the default view is the button below, which says what it
 * does, and the view it returns to relabels itself honestly.
 *
 * The coverage claim is GENERATED from what is actually seeded, never hardcoded: a
 * hand-maintained "GhostBus only covers the TTC" would have become false the first time an
 * agency was added with nobody editing it.
 */
function OutOfCoverageCard() {
  const { t, i18n } = useTranslation();
  const outOfCoverage = useLive((s) => s.outOfCoverage);
  const health = useLive((s) => s.health);
  const requestLocation = useLive((s) => s.requestLocation);
  const useDefaultLocation = useLive((s) => s.useDefaultLocation);
  const imperial = useStore((s) => s.units) === 'imperial';

  if (!outOfCoverage) return null;
  const near = outOfCoverage.nearest;
  const covered = health?.agencies ?? [];
  const agencyNames = covered.length > 0
    ? new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' })
      .format(covered.map((a) => a.name))
    : null;
  const nearAgency = near ? covered.find((a) => a.id === near.agency)?.name ?? near.agency : null;

  return (
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
          : agencyNames
            ? t('empty.noCoverageUnknown', { agencies: agencyNames })
            : t('empty.noCoverageTitle', { dist: fmtDistance(outOfCoverage.radiusM, imperial) })}
      </p>
      <button className="btn btn-primary" onClick={useDefaultLocation}>
        {t('empty.noCoverageAction')}
      </button>
      {/* Geolocation is a one-shot fix, so nothing re-queries as the rider moves — and
          without this the card is a dead end for somebody who has since walked or driven
          back into the service area. */}
      <button className="btn btn-quiet" onClick={requestLocation}>
        {t('empty.noCoverageRetry')}
      </button>
      <p className="state-body state-fine">{t('empty.noCoverageActionNote')}</p>
    </div>
  );
}

function PlanIdle({ recents }: { recents: ReturnType<typeof useStore.getState>['recentTrips'] }) {
  const { t } = useTranslation();
  const openSearch = useStore((s) => s.openSearch);
  const setPlanTarget = useStore((s) => s.setPlanTarget);

  return (
    <>
      {recents.length > 0 && (
        <section className="gb-section plan-recents" aria-labelledby="gb-plan-recents">
          <div className="section-head">
            <span className="eyebrow" id="gb-plan-recents">{t('plan.recentTrips')}</span>
          </div>
          <ul className="saved-list">
            {recents.map((r) => (
              <li className="saved-row" key={r.stopId}>
                <button
                  className="saved-open"
                  disabled={r.lat == null || r.lon == null}
                  onClick={() => setPlanTarget({ kind: 'stop', place: { ...r, ts: Date.now() } })}
                >
                  <span className="saved-tile" aria-hidden><FlagIcon width={17} height={17} /></span>
                  <span className="saved-text">
                    <span className="saved-title">{r.name}</span>
                    <span className="saved-sub">{t('stop.code', { code: r.stopId })}</span>
                  </span>
                  <ArrowRightIcon width={17} height={17} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="state-card state-placeholder" role="status">
        <div className="state-glyph" aria-hidden><RouteIcon width={26} height={26} /></div>
        <h3 className="state-title">{t('plan.emptyTitle')}</h3>
        <p className="state-body">{t('plan.emptyBody')}</p>
        <button className="btn btn-primary plan-cta" onClick={() => openSearch('destination')}>
          <SearchIcon width={16} height={16} aria-hidden />
          <span>{t('plan.chooseDestination')}</span>
        </button>
      </div>
    </>
  );
}

/**
 * `tone` names what the card actually is, because a warning triangle in the brand colour
 * is neither a warning nor a brand mark:
 *   'neutral'  a normal answer that happens not to be a ride (transfer, no service, no
 *              stops nearby). Brand tile, and NOT a warning triangle.
 *   'warn'     something is actually wrong (no location fix, planner unreachable). Amber.
 */
function PlanState({ glyph, title, body, tone = 'neutral', children }: {
  glyph: React.ReactNode; title: string; body: string;
  tone?: 'neutral' | 'warn'; children?: React.ReactNode;
}) {
  return (
    <div className={`state-card state-placeholder ${tone === 'warn' ? 'state-down' : ''}`} role="status">
      <div className="state-glyph" aria-hidden>{glyph}</div>
      <h3 className="state-title">{title}</h3>
      <p className="state-body">{body}</p>
      {children}
    </div>
  );
}

function PlanOutcomeView({ res, widened, options, selectedId, onSelect, imperial, destinationName }: {
  res: PlanResponse;
  widened: boolean;
  options: OptionList;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  imperial: boolean;
  destinationName: string;
}) {
  const { t } = useTranslation();

  if (res.outcome === 'transfer') {
    return (
      <PlanState
        glyph={<RouteIcon width={24} height={24} />}
        title={t('plan.transferTitle')}
        body={t('plan.transferBody')}
      >
        {/* The disclosure comes BEFORE the control it qualifies, which is also the only
            arrangement that makes its own wording true: `plan.transferFine` says "The link
            below…". */}
        <p className="plan-fineprint">{t('plan.transferFine')}</p>
        {/* Destination only — the rider's own position is the one thing this app promises
            never to hand to anyone else, and a maps app already knows it. */}
        <a
          className="btn btn-quiet plan-maps"
          href={transitDirectionsUrl(res.to)}
          target="_blank"
          rel="noreferrer noopener"
        >
          <ArrowRightIcon width={16} height={16} aria-hidden />
          <span>{t('plan.openInMaps')}</span>
        </a>
      </PlanState>
    );
  }

  if (res.outcome === 'noStopsNearYou' || res.outcome === 'noStopsNearDestination') {
    return (
      <PlanState
        glyph={<PinIcon width={24} height={24} />}
        title={res.outcome === 'noStopsNearYou' ? t('plan.noStopsYouTitle') : t('plan.noStopsDestTitle')}
        body={t('plan.noStopsBody', { m: res.radiusM })}
      />
    );
  }

  if (res.outcome === 'noService') {
    return (
      <PlanState
        glyph={<ClockIcon width={24} height={24} />}
        title={t('plan.noServiceTitle')}
        body={t('plan.noServiceBody')}
      />
    );
  }

  /**
   * The server found options and this rider's own pace puts every one of them out of
   * reach. Two different sentences for the two tiers, because they fail differently: a
   * direct ride simply leaves before you get there, while a connection can also come apart
   * once the first leg's own delay is counted.
   */
  if (options.options.length === 0) {
    return (
      <PlanState
        glyph={<ClockIcon width={24} height={24} />}
        title={t('plan.unreachableTitle')}
        body={res.outcome === 'twoLeg'
          ? t('plan.unreachableBodyTwoLeg', { count: res.itineraries.length })
          : t('plan.unreachableBody', { count: res.candidates.length })}
      />
    );
  }

  return (
    <PlanOptions
      list={options}
      selectedId={selectedId}
      onSelect={onSelect}
      imperial={imperial}
      destinationName={destinationName}
      widened={widened}
    />
  );
}
