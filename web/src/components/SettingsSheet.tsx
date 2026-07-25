import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Theme } from '@/store';
import { LOCALES, type LocaleId } from '@/i18n';
import { ChevronIcon } from './icons';

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="set-row">
      <span className="set-label">{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.id}
            className={`seg ${value === o.id ? 'seg-on' : ''}`}
            aria-pressed={value === o.id}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="set-row">
      <span className="set-label">{label}</span>
      <button className={`switch ${on ? 'switch-on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
        <span className="switch-knob" aria-hidden />
      </button>
    </div>
  );
}

export function SettingsSheet() {
  const { t } = useTranslation();
  const open = useStore((s) => s.settingsOpen);
  const close = () => useStore.getState().openSettings(false);
  const ref = useRef<HTMLDivElement>(null);

  // Modal keyboard contract: focus moves in on open, Escape closes, Tab is
  // trapped within the dialog, and focus is restored to the opener on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(
      ref.current?.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((el) => !el.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); useStore.getState().openSettings(false); return; }
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

  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const locale = useStore((s) => s.locale);
  const setLocaleId = useStore((s) => s.setLocaleId);
  const units = useStore((s) => s.units);
  const setUnits = useStore((s) => s.setUnits);
  const largerText = useStore((s) => s.largerText);
  const setLargerText = useStore((s) => s.setLargerText);
  const highContrast = useStore((s) => s.highContrast);
  const setHighContrast = useStore((s) => s.setHighContrast);

  if (!open) return null;

  return (
    <div className="sheet-scrim" onClick={close}>
      <div ref={ref} className="settings-sheet glass" role="dialog" aria-modal="true" aria-label={t('settings.title')} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden />
        <div className="sheet-head">
          <h2 className="sheet-title">{t('settings.title')}</h2>
          <button className="btn btn-quiet sheet-close" onClick={close}>{t('settings.done')}</button>
        </div>

        <div className="settings-body scroll">
          <Segmented<Theme>
            label={t('settings.theme')}
            value={theme}
            options={[
              { id: 'system', label: t('settings.system') },
              { id: 'light', label: t('settings.light') },
              { id: 'dark', label: t('settings.dark') },
            ]}
            onChange={setTheme}
          />
          <Segmented<LocaleId>
            label={t('settings.language')}
            value={locale}
            options={LOCALES.map((l) => ({ id: l.id, label: l.label }))}
            onChange={setLocaleId}
          />
          <Segmented<'metric' | 'imperial'>
            label={t('settings.units')}
            value={units}
            options={[
              { id: 'metric', label: t('settings.metric') },
              { id: 'imperial', label: t('settings.imperial') },
            ]}
            onChange={setUnits}
          />
          <Toggle label={t('access.largerText')} on={largerText} onChange={setLargerText} />
          <Toggle label={t('access.highContrast')} on={highContrast} onChange={setHighContrast} />

          <button className="set-row set-link" onClick={() => useStore.getState().openAbout(true)}>
            <span className="set-label">{t('settings.about')}</span>
            <ChevronIcon width={18} height={18} aria-hidden />
          </button>

          <p className="settings-privacy">{t('privacy.body')}</p>
        </div>
      </div>
    </div>
  );
}
