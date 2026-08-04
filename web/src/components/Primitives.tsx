import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLive, liveNow } from '@/hooks/useLive';
import { useTick } from '@/hooks/useTick';
import { SignalIcon } from './icons';
// The contrast maths lives in lib/contrast.ts so it can be unit-tested without the i18n
// runtime this file drags in. Re-exported because the rest of the app imports it here.
import { readableOn, onBrandPair } from '@/lib/contrast';

export { readableOn, onBrandPair, AA_NORMAL, type BrandPair } from '@/lib/contrast';

export function Wordmark({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`wordmark ${className ?? ''}`} aria-label={`${t('brand.ghost')}${t('brand.bus')}`}>
      <span className="wm-ghost">{t('brand.ghost')}</span>
      <span className="wm-bus">{t('brand.bus')}</span>
    </span>
  );
}

/**
 * A ROUTE BADGE THAT CAN ACTUALLY BE READ.
 *
 * This used to be `background: route_color` with `readableOn` picking the foreground, and
 * measurement on production said that is not enough: a TTC 504 badge composited to
 * **4.382:1**, under AA, with no foreground able to rescue it. `readableOn` maximises over
 * white and near-black, and that maximum bottoms out around relative luminance 0.198 —
 * exactly where the TTC's red sits. Picking the better of two bad options is still bad.
 *
 * `onBrandPair` keeps the HUE and nudges the lightness until the pair genuinely clears,
 * and it only moves colours that fail: of the eight real agency colours on screen here,
 * six pass through untouched and the 504's red moves ED1C24 → D01018. So this is not a
 * repaint of the app's route furniture, it is the two or three badges that were failing
 * quietly being made legible.
 *
 * lib/contrast.ts deferred this as "an app-wide change". It is now made, deliberately and
 * in one place, so every badge in the app clears AA by construction rather than by luck of
 * which agency picked which red. contrast.test.ts is the proof.
 */
export function RouteBadge({ color, short, size = 'md' }: { color: string; short: string; size?: 'sm' | 'md' | 'lg' }) {
  const pair = onBrandPair(color);
  return (
    <span className={`route-badge rb-${size}`} style={{ background: pair.bg, color: pair.fg }}>
      {short}
    </span>
  );
}

/** Beyond this the strip is a wall of colour nobody reads, so the rest is counted. */
export const MAX_STOP_ROUTE_BADGES = 5;

/**
 * WHAT SERVES THIS STOP — the strip of route badges that replaced our internal stop id
 * on every stop row and stop-board header.
 *
 * "Stop 1425 · 8.4 km away" told a rider one useful thing and one thing that is ours,
 * not theirs: 1425 is a primary key. It is not printed on the pole, it is not unique
 * across agencies (2,824 TTC stop_ids collide with YRT's), and no rider has ever chosen
 * a stop by it. What they choose by is the route, so the route is what the row shows —
 * in the agency's own published `route_color`, which makes the strip real data rather
 * than decoration.
 *
 * THE ID IS NOT DELETED, IT IS DEMOTED. It stays in this strip's accessible label and on
 * the expanded board, because it is exactly what a rider needs when they phone the
 * agency or compare against a pole — it just is not the headline.
 *
 * Renders NOTHING for an empty or absent list. A stop we have no routes for gets no
 * strip, not an empty box or a placeholder: an absent claim is honest, an invented one
 * is not. The two cases are the same on screen because they are the same to a rider.
 */
export function StopRoutes({ routes, stopId, max = MAX_STOP_ROUTE_BADGES }: {
  routes: readonly { routeId: string; shortName: string; color: string }[] | undefined;
  /** Kept for the accessible label only — see above. */
  stopId: string;
  max?: number;
}) {
  const { t } = useTranslation();
  if (!routes || routes.length === 0) return null;
  const shown = routes.slice(0, max);
  const rest = routes.length - shown.length;
  return (
    <span
      className="stop-routes"
      role="img"
      aria-label={t('stop.servedBy', {
        routes: routes.map((r) => r.shortName).join(', '),
        code: stopId,
        count: routes.length,
      })}
    >
      {shown.map((r) => (
        <RouteBadge key={r.routeId} color={r.color} short={r.shortName} size="sm" />
      ))}
      {rest > 0 && <span className="stop-routes-more tnum">{t('stop.moreRoutes', { count: rest })}</span>}
    </span>
  );
}

type PillKind = 'live' | 'stale' | 'scheduled' | 'catchingUp' | 'demo' | 'loading';

/**
 * Honest status pill, driven entirely by /api/health.
 *
 * FOUR REAL STATES, and the distinction between two of them is the whole point. The pill
 * used to read "Offline" whenever the health FETCH failed — which lumped our own rate
 * limiter and our own restarts in with a genuine network outage, and fed the copy that
 * blamed the TTC. Now:
 *
 *   demo        · the server is replaying a recording (amber). Nothing here is live.
 *   catchingUp  · WE could not be reached or WE throttled ourselves. Ours, and retrying.
 *   stale/sched · our server is fine and says an AGENCY feed is stale/down. Theirs.
 *   live        · a feed is genuinely fresh.
 *
 * See `attributionOf` in hooks/useLive.ts and DECISIONS §45.
 */
export function StatusPill({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const health = useLive((s) => s.health);
  const apiFailure = useLive((s) => s.apiFailure);
  const [open, setOpen] = useState(false);
  useTick(1000);

  const kind: PillKind = health?.mode === 'demo'
    ? 'demo'
    : apiFailure != null
      ? 'catchingUp'
      : !health
        ? 'loading'
        : health.ok
          ? 'live'
          : Object.values(health.feeds).some((f) => f.status === 'stale')
            ? 'stale'
            : 'scheduled';

  const lastMs = health?.lastPollAtMs ?? null;
  const secs = lastMs ? Math.max(0, Math.round((liveNow() - lastMs) / 1000)) : 0;
  const freshness = kind === 'catchingUp'
    // Our own trouble explains itself rather than quoting a feed age that is not the issue.
    ? t('status.catchingUpDetail')
    : kind === 'demo'
      ? t('status.demoNote', { agency: t('agency.short') })
      : lastMs == null
        ? t('status.scheduledTimes')
        : secs < 90
          ? t('status.updatedAgo', { secs })
          : t('status.updatedMinAgo', { mins: Math.round(secs / 60) });

  const cfg: Record<PillKind, { label: string; cls: string; dot: boolean }> = {
    live: { label: t('status.live'), cls: 'sp-live', dot: true },
    stale: { label: t('status.stale'), cls: 'sp-stale', dot: false },
    scheduled: { label: t('status.scheduled'), cls: 'sp-sched', dot: false },
    catchingUp: { label: t('status.catchingUp'), cls: 'sp-catchup', dot: false },
    demo: { label: t('status.demoBadge'), cls: 'sp-demo', dot: false },
    loading: { label: t('status.scheduled'), cls: 'sp-sched', dot: false },
  };
  const c = cfg[kind];
  /**
   * Stale surfaces its age inline (per spec: "Stale — last updated X min ago"). Catching-up
   * does NOT, and that reversed an earlier decision here.
   *
   * The reasoning for adding it was that a rider seeing a changed pill deserves the reason
   * without tapping. The measurement says the pill was the wrong place to put it: at 1280px
   * the pill went 64px (Live) -> 366px (en) / 384px (fr-CA) — 30% of the window, 4.3x its
   * own previous width — and STILL did not fit, truncating fr-CA mid-word as
   * "nouvelle te…". DESIGN-TARGET §F already bans mid-word truncation in a short metadata
   * line, and nothing else in the reference's chrome re-proportions itself on a state change.
   *
   * The reason is not lost, it is just not duplicated: the sidebar banner prints the same
   * sentence in full, which is where a sentence belongs. The pill stays a chip that names
   * the state, and the full text is still available to assistive tech via `aria-label` and
   * to a pointer via the tap-to-expand `sp-detail` every other state already uses.
   */
  const inlineDetail = kind === 'stale' && !compact;

  return (
    <button
      className={`status-pill ${c.cls} ${compact ? 'sp-compact' : ''}`}
      onClick={() => setOpen((o) => !o)}
      aria-label={`${c.label} — ${freshness}`}
      aria-expanded={open}
    >
      {c.dot ? <span className="sp-dot" aria-hidden /> : <SignalIcon width={13} height={13} aria-hidden />}
      <span className="sp-label">{c.label}</span>
      {inlineDetail && <span className="sp-inline truncate">{freshness}</span>}
      {open && !inlineDetail && <span className="sp-detail truncate">{freshness}</span>}
    </button>
  );
}
