import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AlertDto, GhostEventDto } from '@shared/types';
import { useLive, liveNow } from '@/hooks/useLive';
import { useStore } from '@/store';
import { useTick } from '@/hooks/useTick';
import { RouteBadge } from './Primitives';
import { GhostMascot } from './GhostMascot';
import { OfflineCard } from './OfflineCard';
import { ghostCopyKey } from '@/lib/ghostCopy';
import { fmtClock } from '@/lib/format';
import {
  WarningIcon, InfoIcon, NoEntryIcon, AccessIcon, RouteIcon, PinIcon, ClockIcon, BellIcon,
} from './icons';

/** Informed routes shown inline before the list collapses into "+N more". */
const MAX_INFORMED_BADGES = 4;

// ---------------------------------------------------------------------------------
// Ghost events
// ---------------------------------------------------------------------------------

/**
 * Render "{{time}} — never arrived" with the clock time in body colour and the claim in
 * the alert red, without ever rewriting the localized sentence. The time is interpolated
 * as a sentinel and the result split on it, so the exact translated wording — including
 * word order, which differs by locale — is preserved verbatim.
 */
const SENTINEL = String.fromCharCode(0xE000); // private-use codepoint: cannot occur in real copy

function ClaimLine({ event }: { event: GhostEventDto }) {
  const { t } = useTranslation();
  const time = fmtClock(event.scheduledStartMs);
  const parts = t(ghostCopyKey(event.kind), { time: SENTINEL }).split(SENTINEL);
  return (
    <p className="ge-claim">
      {parts[0]}
      <span className="ge-time">{time}</span>
      {parts[1] ?? ''}
    </p>
  );
}

/** The plain-text form of the same claim, for accessible names. */
function claimText(t: ReturnType<typeof useTranslation>['t'], event: GhostEventDto): string {
  return t(ghostCopyKey(event.kind), { time: fmtClock(event.scheduledStartMs) });
}

/** The reference's red alert card. Exported because the stop board shows one too — the
 *  mockup places it directly under the departures — and both must be the same
 *  card built from the same real ghost event, not a second lookalike. */
export function GhostEventCard({ event }: { event: GhostEventDto }) {
  const { t } = useTranslation();
  useTick(30_000);
  const arrivals = useLive((s) => s.arrivals);
  const openStopSheet = useStore((s) => s.openStopSheet);
  const selectStop = useStore((s) => s.selectStop);

  const now = liveNow();
  const short = event.shortName ?? event.routeId ?? '—';
  const destination = event.headsign ?? event.longName ?? null;

  // "Next tracked departure" is only shown when it is genuinely derivable: the same route
  // has a real, still-future departure on the board we already loaded. We never invent a
  // follow-up time, and never query a stop the rider is not looking at.
  const nextTracked = useMemo(() => {
    if (!arrivals || !event.routeId) return null;
    const hit = arrivals.departures
      .filter((d) => d.routeId === event.routeId && d.scheduledMs > now)
      .sort((a, b) => a.scheduledMs - b.scheduledMs)[0];
    return hit ? { ms: hit.liveEtaMs ?? hit.scheduledMs, stopId: arrivals.stopId } : null;
  }, [arrivals, event.routeId, now]);

  const detectedMin = Math.floor((now - event.detectedAtMs) / 60_000);
  const detected = detectedMin < 1
    ? t('ghost.detectedJustNow')
    : detectedMin < 60
      ? t('ghost.detectedAgo', { mins: detectedMin })
      : t('ghost.detectedAt', { time: fmtClock(event.detectedAtMs) });

  const viewAlternatives = () => {
    // Real navigation only: when we could name the stop the follow-up departs from, take
    // the rider to its board; otherwise open the board for wherever they already are.
    if (nextTracked) selectStop(nextTracked.stopId);
    openStopSheet(true);
  };

  return (
    <article
      className="ghost-card"
      aria-label={t('ghost.eventAria', {
        route: short,
        headsign: destination ?? short,
        claim: claimText(t, event),
      })}
    >
      {/* The reference's shape: the glyph is a sibling of the text column, not a
          row inside it, so the three claim lines and the full-width action all
          share one left edge. */}
      <span className="ghost-glyph" aria-hidden><WarningIcon width={20} height={20} /></span>

      <div className="ghost-body">
        <ClaimLine event={event} />

        <div className="ghost-card-route">
          <RouteBadge color={event.color} short={short} size="sm" />
          {destination && <span className="ghost-dest">{destination}</span>}
        </div>

        {nextTracked && (
          <p className="ghost-next">{t('ghost.nextTracked', { time: fmtClock(nextTracked.ms) })}</p>
        )}

        <p className="ghost-detected">
          <ClockIcon width={13} height={13} aria-hidden />
          <span>{detected}</span>
        </p>

        <button className="ghost-alt" onClick={viewAlternatives}>{t('alert.viewAlternatives')}</button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------------
// Service alerts
// ---------------------------------------------------------------------------------

/** Glyph chosen from what the feed actually says. An alert flagged as an accessibility
 *  issue wins, because that is the fact riders act on; otherwise the GTFS `effect` enum
 *  picks the shape and an unstated effect gets a neutral information mark rather than a
 *  severity we would be inventing. */
function glyphFor(alert: AlertDto) {
  if (alert.isAccessibility) return <AccessIcon width={20} height={20} />;
  switch (alert.effect) {
    case 'NO_SERVICE': return <NoEntryIcon width={20} height={20} />;
    case 'DETOUR': return <RouteIcon width={20} height={20} />;
    case 'SIGNIFICANT_DELAYS':
    case 'REDUCED_SERVICE':
    case 'ADDITIONAL_SERVICE':
    case 'MODIFIED_SERVICE': return <WarningIcon width={20} height={20} />;
    case 'STOP_MOVED': return <PinIcon width={20} height={20} />;
    default: return <InfoIcon width={20} height={20} />;
  }
}

function toneFor(alert: AlertDto): string {
  if (alert.isAccessibility) return 'tone-access';
  switch (alert.effect) {
    case 'NO_SERVICE': return 'tone-danger';
    case 'DETOUR':
    case 'SIGNIFICANT_DELAYS':
    case 'REDUCED_SERVICE':
    case 'MODIFIED_SERVICE': return 'tone-warn';
    default: return 'tone-neutral';
  }
}

function AlertCard({ alert }: { alert: AlertDto }) {
  const { t } = useTranslation();
  // Measured on the live feed: TTC's `headerText` is the description cut mid-word at ~32
  // characters ("996 Wilson Express: Buses are no"), and sometimes cut from a *different*
  // sentence than the description carries. Rendering it as a heading would put a broken
  // fragment at the top of the card, so the card shows the agency's complete sentence —
  // the description — and only falls back to the header when there is no description.
  // Both fields stay on the wire for any consumer that wants them. See DECISIONS §29.
  const text = alert.description ?? alert.header;

  const routes = alert.informed
    .filter((e) => e.routeId)
    .map((e) => ({ id: e.routeId as string, label: e.routeShortName ?? (e.routeId as string) }));
  const shown = routes.slice(0, MAX_INFORMED_BADGES);
  const extra = routes.length - shown.length;

  return (
    <li className={`alert-card ${toneFor(alert)}`}>
      <span className="alert-glyph" aria-hidden>{glyphFor(alert)}</span>
      <div className="alert-body">
        {text && <p className="alert-text">{text}</p>}
        {alert.isAccessibility && (
          <p className="alert-access">
            <AccessIcon width={13} height={13} aria-hidden />
            <span>{t('alert.accessibility')}</span>
          </p>
        )}
        {shown.length > 0 && (
          <p className="alert-routes">
            <span className="alert-affects">{t('alert.affects')}</span>
            {/* Neutral chips, not livery badges: the alerts feed names routes, it does
                not carry their colours, and a coloured badge would imply one. */}
            {shown.map((r) => <span key={r.id} className="alert-route-chip">{r.label}</span>)}
            {extra > 0 && <span className="alert-more">{t('alert.moreRoutes', { count: extra })}</span>}
          </p>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------------

export function AlertsPanel() {
  const { t } = useTranslation();
  useTick(30_000);
  const alerts = useLive((s) => s.alerts);
  const alertsError = useLive((s) => s.alertsError);
  const ghosts = useLive((s) => s.ghosts);
  const ghostsError = useLive((s) => s.ghostsError);
  const online = useLive((s) => s.online);
  const announcement = useLive((s) => s.ghostAnnouncement);

  // A polite live region: new ghost detections are announced once, and the message is
  // re-set (not just re-rendered) so repeated identical counts still reach the reader.
  const [announced, setAnnounced] = useState('');
  const lastSeq = useRef(0);
  useEffect(() => {
    if (!announcement || announcement.seq === lastSeq.current) return;
    lastSeq.current = announcement.seq;
    setAnnounced(t('ghost.newDetected', { count: announcement.count }));
  }, [announcement, t]);

  const updated = (() => {
    const ms = alerts?.feedUpdatedMs ?? null;
    if (ms == null) return t('alert.updatedUnknown');
    const mins = Math.floor((liveNow() - ms) / 60_000);
    return mins < 1 ? t('alert.updatedJustNow') : t('alert.updatedAgo', { mins });
  })();

  const counters = ghosts?.counters;
  const events = ghosts?.events ?? [];

  return (
    <div className="alerts-panel">
      <header className="alerts-head">
        <h2 className="alerts-title">{t('alerts.title')}</h2>
        <p className="alerts-sub">{t('alerts.body')}</p>
      </header>

      <p className="sr-only" role="status" aria-live="polite">{announced}</p>

      {/* ---------------- GHOSTS ---------------- */}
      <section className="alerts-section" aria-labelledby="gb-ghosts-head">
        <div className="section-head">
          <span className="eyebrow" id="gb-ghosts-head">{t('sections.ghosts')}</span>
        </div>

        {counters && (
          <div className="ghost-counters">
            <div className="gc-cell">
              <span className="gc-label">{t('ghost.today')}</span>
              <span className="gc-nums tnum">
                <b className="gc-ghost">{counters.todayGhosts}</b>
                <span className="gc-unit">{t('ghost.ghostsLabel')}</span>
                <b className="gc-cancel">{counters.todayCancelled}</b>
                <span className="gc-unit">{t('ghost.cancelledLabel')}</span>
              </span>
            </div>
            <div className="gc-cell">
              <span className="gc-label">{t('ghost.week')}</span>
              <span className="gc-nums tnum">
                <b className="gc-ghost">{counters.weekGhosts}</b>
                <span className="gc-unit">{t('ghost.ghostsLabel')}</span>
                <b className="gc-cancel">{counters.weekCancelled}</b>
                <span className="gc-unit">{t('ghost.cancelledLabel')}</span>
              </span>
            </div>
          </div>
        )}

        {!ghosts && !online ? (
          <OfflineCard compact />
        ) : ghostsError && !ghosts ? (
          <div className="state-card state-down" role="status">
            <div className="state-glyph" aria-hidden><WarningIcon width={22} height={22} /></div>
            <p className="state-body">{t('ghost.unreachable')}</p>
          </div>
        ) : events.length > 0 ? (
          <>
            <div className="ghost-list" role="list">
              {events.map((e) => (
                <div role="listitem" key={`${e.tripId}-${e.scheduledStartMs}`}>
                  <GhostEventCard event={e} />
                </div>
              ))}
            </div>
            <p className="ghost-window-note">{t('ghost.windowNote', { hours: ghosts?.hours ?? 24 })}</p>
          </>
        ) : (
          <div className="state-card ghost-empty" role="status">
            <GhostMascot />
            <h3 className="state-title">{t('ghost.feedEmptyTitle')}</h3>
            <p className="state-body">{t('ghost.feedEmpty')}</p>
          </div>
        )}
      </section>

      {/* ---------------- SERVICE ALERTS ---------------- */}
      <section className="alerts-section" aria-labelledby="gb-alerts-head">
        <div className="section-head">
          <span className="eyebrow" id="gb-alerts-head">{t('alert.sectionTitle')}</span>
          <span className="eyebrow alerts-updated">{updated}</span>
        </div>

        {!alerts && !online ? (
          <OfflineCard compact />
        ) : alertsError && !alerts ? (
          <div className="state-card state-down" role="status">
            <div className="state-glyph" aria-hidden><WarningIcon width={22} height={22} /></div>
            <p className="state-body">{t('alert.unreachable')}</p>
          </div>
        ) : alerts && alerts.count > 0 ? (
          <ul className="alert-list" aria-label={t('alert.listLabel')}>
            {alerts.alerts.map((a) => <AlertCard key={a.alertId} alert={a} />)}
          </ul>
        ) : alerts ? (
          <div className="state-card" role="status">
            <div className="state-glyph" aria-hidden><BellIcon width={22} height={22} /></div>
            <h3 className="state-title">{t('alert.none')}</h3>
            <p className="state-body">{t('alert.noneBody')}</p>
          </div>
        ) : (
          <div className="alert-list">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton alert-skeleton" />)}
          </div>
        )}
      </section>
    </div>
  );
}
