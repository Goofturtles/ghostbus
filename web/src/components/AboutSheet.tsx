// About & credits — the disqualification-proofing screen.
//
// Every claim on it is sourced from CREDITS.md, and every number in the Stats
// block is read live from /api/stats at the moment the screen opens. Nothing here
// is cached, rounded up, or held over from a better-looking earlier run: if the
// endpoint says zero, this screen says zero, and if it cannot be reached it says
// that instead of showing the last number it happened to have.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StatsResponse } from '@shared/types';
import { api } from '@/lib/api';
import { useStore } from '@/store';
import { fmtClock, fmtNum } from '@/lib/format';
import { WarningIcon } from './icons';

function Stat({ label, value, from }: { label: string; value: string; from: string }) {
  return (
    <div className="abt-stat">
      <span className="gc-label">{label}</span>
      <b className="abt-stat-num tnum">{value}</b>
      <span className="abt-stat-from">{from}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="abt-section">
      <h3 className="abt-h">{title}</h3>
      {children}
    </section>
  );
}

export function AboutSheet() {
  const { t } = useTranslation();
  const open = useStore((s) => s.aboutOpen);
  const close = () => useStore.getState().openAbout(false);
  const ref = useRef<HTMLDivElement>(null);

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [statsError, setStatsError] = useState(false);

  // One read, when the screen opens. A polling counter here would be theatre —
  // these are provenance figures, not a live board.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setStats(null);
    setStatsError(false);
    api.stats()
      .then((s) => { if (alive) setStats(s); })
      .catch(() => { if (alive) setStatsError(true); });
    return () => { alive = false; };
  }, [open]);

  // Same modal keyboard contract as the settings sheet: focus in, Escape out,
  // Tab trapped, focus restored to whatever opened it.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(
      ref.current?.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((el) => !el.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); useStore.getState().openAbout(false); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, [open]);

  if (!open) return null;

  return (
    <div className="sheet-scrim" onClick={close}>
      <div
        ref={ref}
        className="settings-sheet about-sheet glass"
        role="dialog"
        aria-modal="true"
        aria-label={t('about.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden />
        <div className="sheet-head">
          <h2 className="sheet-title">{t('about.title')}</h2>
          <button className="btn btn-quiet sheet-close" onClick={close}>{t('settings.done')}</button>
        </div>

        <div className="about-body scroll">
          <p className="abt-lede">{t('about.what')}</p>
          <p className="abt-p">{t('about.what2')}</p>

          <Section title={t('about.statsTitle')}>
            {statsError ? (
              <p className="abt-p abt-warn">
                <WarningIcon width={14} height={14} aria-hidden />
                <span>{t('about.statsUnavailable')}</span>
              </p>
            ) : stats ? (
              <>
                <div className="abt-stats">
                  <Stat label={t('about.statVehicles')} value={fmtNum(stats.vehiclesTracked)} from={t('about.statVehiclesFrom')} />
                  <Stat label={t('about.statObs')} value={fmtNum(stats.obsCollected)} from={t('about.statObsFrom')} />
                  <Stat label={t('about.statGhosts')} value={fmtNum(stats.ghostsThisWeek)} from={t('about.statGhostsFrom')} />
                  <Stat label={t('about.statCancelled')} value={fmtNum(stats.cancelledThisWeek)} from={t('about.statCancelledFrom')} />
                  <Stat
                    label={t('about.statDelay')}
                    value={stats.avgDelayRecentSec == null ? '—' : t('about.statDelaySec', { n: fmtNum(stats.avgDelayRecentSec) })}
                    from={stats.avgDelayRecentSec == null ? t('about.statDelayNone') : t('about.statDelayFrom')}
                  />
                </div>
                <p className="abt-note">{t('about.statsNote', { time: fmtClock(stats.updatedAtMs) })}</p>
                {/* A zero ghost count is a real zero, and this is why it is one. */}
                {stats.ghostsThisWeek === 0 && <p className="abt-note">{t('about.ghostZeroNote')}</p>}
              </>
            ) : (
              <div className="abt-stats">
                {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton abt-stat-skeleton" />)}
              </div>
            )}
          </Section>

          <Section title={t('about.dataTitle')}>
            <p className="abt-p"><b className="abt-b">{t('about.ttcName')}</b><br />{t('about.ttcVia')}</p>
            {/* The licence's own required wording, verbatim and untranslated. */}
            <p className="abt-attrib" lang="en">{t('about.ttcAttribution')}</p>
            <p className="abt-p"><b className="abt-b">{t('about.mapName')}</b><br />{t('about.mapLicence')}</p>
            <p className="abt-attrib" lang="en">{t('about.mapCredit')}</p>
          </Section>

          <Section title={t('about.libsTitle')}>
            <p className="abt-p">{t('about.libsBody')}</p>
            <p className="abt-note">{t('about.libsNote')}</p>
          </Section>

          <Section title={t('about.fontsTitle')}>
            <p className="abt-p">{t('about.fontsBody')}</p>
            <p className="abt-note">{t('about.fontsMap')}</p>
          </Section>

          <Section title={t('about.assetsTitle')}>
            <p className="abt-p">{t('about.assetsBody')}</p>
          </Section>

          <Section title={t('about.aiTitle')}>
            <p className="abt-p">{t('about.aiBody')}</p>
          </Section>

          <p className="abt-built">{t('about.builtBy')}</p>
          <p className="abt-note">{t('about.docs')}</p>
        </div>
      </div>
    </div>
  );
}
