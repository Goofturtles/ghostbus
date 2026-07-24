import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLive, liveNow } from '@/hooks/useLive';
import { SignalIcon } from './icons';
import type { ModeKind } from '@shared/types';

export function Wordmark({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`wordmark ${className ?? ''}`} aria-label={`${t('brand.ghost')}${t('brand.bus')}`}>
      <span className="wm-ghost">{t('brand.ghost')}</span>
      <span className="wm-bus">{t('brand.bus')}</span>
    </span>
  );
}

/** Text color that stays legible on any GTFS route_color. */
function readableOn(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length < 6) return '#fff';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#14161d' : '#ffffff';
}

export function RouteBadge({ color, short, size = 'md' }: { color: string; short: string; size?: 'sm' | 'md' | 'lg' }) {
  const bg = `#${color.replace('#', '')}`;
  return (
    <span className={`route-badge rb-${size}`} style={{ background: bg, color: readableOn(color) }}>
      {short}
    </span>
  );
}

const MODE_KEY: Record<ModeKind, string> = {
  bus: 'Bus', tram: 'Streetcar', metro: 'Metro', rail: 'Rail', ferry: 'Ferry', cable: 'Cable', other: 'Transit',
};
export function ModeChip({ mode }: { mode: ModeKind }) {
  return <span className="mode-chip">{MODE_KEY[mode]}</span>;
}

/** Honest status pill. Demo data is always the amber DEMO badge — never faked live. */
export function StatusPill({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const source = useLive((s) => s.source);
  const lastPollMs = useLive((s) => s.lastPollMs);
  const [open, setOpen] = useState(false);

  const secs = lastPollMs ? Math.max(0, Math.round((liveNow() - lastPollMs) / 1000)) : 0;
  const detail =
    source === 'offline'
      ? t('status.offlineSince', { time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(lastPollMs || Date.now()) })
      : secs < 90
        ? t('status.updatedAgo', { secs })
        : t('status.updatedMinAgo', { mins: Math.round(secs / 60) });

  const map: Record<string, { label: string; cls: string; dot?: boolean }> = {
    live: { label: t('status.live'), cls: 'sp-live', dot: true },
    demo: { label: t('status.demoBadge'), cls: 'sp-demo' },
    stale: { label: t('status.stale'), cls: 'sp-stale' },
    scheduled: { label: t('status.scheduled'), cls: 'sp-sched' },
    offline: { label: t('status.offline'), cls: 'sp-offline' },
  };
  const cfg = map[source] ?? map.demo;

  return (
    <button
      className={`status-pill ${cfg.cls} ${compact ? 'sp-compact' : ''}`}
      onClick={() => setOpen((o) => !o)}
      aria-label={`${cfg.label} — ${detail}`}
      aria-expanded={open}
    >
      {cfg.dot ? <span className="sp-dot" /> : <SignalIcon width={13} height={13} />}
      <span className="sp-label">{cfg.label}</span>
      {open && <span className="sp-detail">{detail}</span>}
    </button>
  );
}
