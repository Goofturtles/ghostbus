import { useTranslation } from 'react-i18next';
import type { ArrivalsResponse } from '@shared/types';
import { PinIcon, HeartIcon } from './icons';
import { useStore, paceMps } from '@/store';
import { fmtDistance, walkSeconds } from '@/lib/format';

export function StopHeader({ arr, distanceM }: { arr: ArrivalsResponse; distanceM?: number }) {
  const { t } = useTranslation();
  const saved = useStore((s) => s.savedStops.includes(arr.stopId));
  const toggleSaved = useStore((s) => s.toggleSaved);
  const units = useStore((s) => s.units);
  const pace = useStore((s) => s.pace);

  const walkMin = distanceM != null ? Math.max(1, Math.round(walkSeconds(distanceM, paceMps(pace)) / 60)) : null;

  return (
    <div className="stop-header">
      <div className="stop-pin-tile" aria-hidden>
        <PinIcon width={20} height={20} />
      </div>
      <div className="stop-head-text">
        <h2 className="stop-name truncate balance">{arr.stopName ?? t('stop.code', { code: arr.stopId })}</h2>
        <p className="stop-sub truncate">
          <span className="stop-dir">{t('stop.code', { code: arr.stopId })}</span>
          {distanceM != null && (
            <>
              <span className="dot-sep">·</span>
              {fmtDistance(distanceM, units === 'imperial')}
            </>
          )}
          {walkMin != null && (
            <>
              <span className="dot-sep">·</span>
              {t('stop.walk', { min: walkMin })}
            </>
          )}
        </p>
      </div>
      <div className="stop-head-actions">
        <button
          className="icon-btn heart-btn"
          aria-pressed={saved}
          aria-label={saved ? t('stop.saved') : t('stop.save')}
          onClick={() => toggleSaved(arr.stopId)}
        >
          <HeartIcon width={20} height={20} filled={saved} />
        </button>
      </div>
    </div>
  );
}
