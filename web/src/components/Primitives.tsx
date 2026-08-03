import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLive, liveNow } from '@/hooks/useLive';
import { useTick } from '@/hooks/useTick';
import { SignalIcon } from './icons';
// The contrast maths lives in lib/contrast.ts so it can be unit-tested without the i18n
// runtime this file drags in. Re-exported because the rest of the app imports it here.
import { readableOn } from '@/lib/contrast';

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

export function RouteBadge({ color, short, size = 'md' }: { color: string; short: string; size?: 'sm' | 'md' | 'lg' }) {
  const bg = `#${color.replace('#', '')}`;
  return (
    <span className={`route-badge rb-${size}`} style={{ background: bg, color: readableOn(color) }}>
      {short}
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
