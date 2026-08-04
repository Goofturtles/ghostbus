// About & credits — the disqualification-proofing screen.
//
// Every claim on it is sourced from CREDITS.md, and every number in the Stats
// block is read live from /api/stats at the moment the screen opens. Nothing here
// is cached, rounded up, or held over from a better-looking earlier run: if the
// endpoint says zero, this screen says zero, and if it cannot be reached it says
// that instead of showing the last number it happened to have.
import { useEffect, useRef, useState } from 'react';
import { CREDITED_AGENCIES } from './agencyCredits';
import { useTranslation } from 'react-i18next';
import type { StatsResponse } from '@shared/types';
import { api } from '@/lib/api';
import { useLive } from '@/hooks/useLive';
import { useStore } from '@/store';
import { fmtClock, fmtNum } from '@/lib/format';
import { WarningIcon } from './icons';
import { DiagnosticsPanel } from './DiagnosticsPanel';

function Stat({ label, value, from, none = false }: { label: string; value: string; from: string; none?: boolean }) {
  return (
    <div className="abt-stat">
      <span className="gc-label">{label}</span>
      <b className={`abt-stat-num tnum ${none ? 'abt-stat-none' : ''}`}>{value}</b>
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

  /**
   * Several licences REQUIRE attribution wherever their data is shown (MiWay, DRT,
   * Oakville, Milton, Metrolinx…), so each credit block is keyed to the server's own
   * seeded-agency list — the same list the coverage card is generated from — rather than
   * hardcoded. A TTC-only deployment must not claim a Mississauga data source it does not
   * use, and a deployment that serves an agency must never open this sheet without its
   * credit. `health` is polled from app start, so it is present long before a rider can
   * reach this screen. The i18n key triplet per agency (`<id>Name/<id>Via/<id>Attribution`)
   * carries each descriptor's licence.attribution verbatim — see server/src/agencies.ts.
   */
  const healthAgencies = useLive((s) => s.health?.agencies);
  const servedIds = new Set((healthAgencies ?? []).map((a) => a.id));

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [statsError, setStatsError] = useState(false);

  /** Five taps on the version line opens the sensor diagnostics. Reset every time the
   *  sheet closes, so it is never already open the next time a rider opens About. */
  const [versionTaps, setVersionTaps] = useState(0);
  const diagOpen = versionTaps >= 5;
  useEffect(() => { if (!open) setVersionTaps(0); }, [open]);

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
        className="settings-sheet about-sheet"
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

        {/* Focusable so a keyboard-only reader can scroll eight sections of credits:
            the Done button is the only other focusable in the dialog. */}
        <div className="about-body scroll" tabIndex={0} role="group" aria-label={t('about.bodyLabel')}>
          <p className="abt-lede">{t('about.what')}</p>
          <p className="abt-p">{t('about.what2')}</p>
          {/* THE MAKER CREDIT, kept distinct from the licence attributions below it.
              Those are obligations — several agencies REQUIRE their wording wherever
              their data appears — and this is authorship. Folding ours in among them
              would dilute the ones that are legally load-bearing. */}
          <p className="abt-maker">{t('about.madeBy')}</p>

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
                    value={stats.avgDelayRecentSec == null ? t('eta.untrackedMark') : t('about.statDelaySec', { n: fmtNum(stats.avgDelayRecentSec) })}
                    from={stats.avgDelayRecentSec == null ? t('about.statDelayNone') : t('about.statDelayFrom')}
                    none={stats.avgDelayRecentSec == null}
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
            {/* A real list: at ten agencies a screen reader should announce "list, N
                items" and offer item-jumps, not a wall of undifferentiated paragraphs. */}
            <ul className="abt-credits">
              <li>
                <p className="abt-p"><b className="abt-b">{t('about.ttcName')}</b><br />{t('about.ttcVia')}</p>
                {/* The licence's own required wording, verbatim and untranslated. */}
                <p className="abt-attrib" lang="en">{t('about.ttcAttribution')}</p>
              </li>
              {CREDITED_AGENCIES.filter((id) => servedIds.has(id)).map((id) => (
                <li key={id}>
                  <p className="abt-p"><b className="abt-b">{t(`about.${id}Name`)}</b><br />{t(`about.${id}Via`)}</p>
                  {/* descriptor.licence.attribution (server/src/agencies.ts), verbatim. */}
                  <p className="abt-attrib" lang="en">{t(`about.${id}Attribution`)}</p>
                </li>
              ))}
              <li>
                <p className="abt-p"><b className="abt-b">{t('about.mapName')}</b><br />{t('about.mapLicence')}</p>
                <p className="abt-attrib" lang="en">{t('about.mapCredit')}</p>
              </li>
            </ul>
            {/* Required posture, not politeness: Metrolinx's agreement forbids any
                suggestion of official status, and it is equally true of every agency. */}
            <p className="abt-note">{t('about.agencyDisclaimer')}</p>
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

          {/* THE VERSION LINE, and the way into the sensor diagnostics.
              Five taps, because the compass and the location dot are the only parts of
              this app that cannot be verified from a desk, and a rider on a real phone is
              the only person who can read out what their hardware actually reports. It is
              a button rather than a tapped paragraph so that it is reachable, focusable
              and announced — a keyboard reader gets there with five presses of Enter, the
              same count. See DiagnosticsPanel for why it is English-only. */}
          <button
            className="abt-version"
            onClick={() => setVersionTaps((n) => n + 1)}
            aria-expanded={diagOpen}
          >
            {t('about.version', { version: __APP_VERSION__ })}
          </button>
          {diagOpen && <DiagnosticsPanel />}
        </div>
      </div>
    </div>
  );
}
