// The honest empty state for "this device has no network".
//
// It exists because a blank column is the worst possible answer at the exact
// moment a rider starts doubting the app. It promises nothing: GhostBus has no
// offline schedule slice to fall back on, and the service worker deliberately
// never caches /api/* (a replayed departure time looks identical to a live one),
// so the truthful message is that there is nothing to show — not "check back for
// cached times" for a feature that does not exist.
import { useTranslation } from 'react-i18next';
import { useLive } from '@/hooks/useLive';
import { fmtClock } from '@/lib/format';
import { SignalIcon } from './icons';

export function OfflineCard({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  // The last time the SERVER told us it had successfully polled the agency.
  // Absent on a cold offline start — in which case the line is omitted entirely
  // rather than rendered with a placeholder time.
  const lastOkMs = useLive((s) => s.health?.lastPollAtMs ?? null);

  return (
    <div className="state-card state-offline" role="status">
      <div className="state-glyph" aria-hidden><SignalIcon width={22} height={22} /></div>
      <h3 className="state-title">{t('offline.title')}</h3>
      <p className="state-body">{t('offline.body')}</p>
      {!compact && <p className="state-body state-fine">{t('offline.noCache')}</p>}
      {lastOkMs != null && <p className="state-body state-fine">{t('offline.lastLive', { time: fmtClock(lastOkMs) })}</p>}
      <p className="state-body state-fine">{t('offline.retryAuto')}</p>
    </div>
  );
}
