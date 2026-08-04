// SENSOR DIAGNOSTICS — hidden behind five taps on the version line in About.
//
// WHY THIS EXISTS. The compass and the location dot are the only two things in GhostBus
// that cannot be verified from a desk. A browser at 390×844 reports no magnetometer, no
// course over ground, and a permission model that is not Safari's, so every claim this
// app makes about "which way you are facing" is, from a developer's chair, untested. The
// gap between "the wedge is missing because this phone has no magnetometer" and "the
// wedge is missing because we have a bug" is invisible from the outside and decisive from
// the inside — and a rider reporting it has no vocabulary for the difference. This screen
// gives them one: it prints what the hardware actually said, and they can read it back.
//
// WHY IT IS HIDDEN. It is not a feature. It is a diagnostic for a defect a rider is
// already experiencing, and a rider who is not experiencing one should never meet it.
//
// WHY IT IS ENGLISH ONLY, and deliberately so rather than by omission. Every other string
// in this app is translated because riders read them. These are sensor names, event types
// and units — `deviceorientationabsolute`, `webkitCompassAccuracy`, m/s — which are
// identifiers from the web platform, not prose, and they are quoted verbatim into a
// support message that someone will read against this source file. Translating the labels
// around them would make the readout harder to match up, not easier, and inventing
// French for `alpha` helps nobody. The panel is marked `lang="en"` so a screen reader
// switches voice for it instead of reading English with a French pronunciation.
//
// NOTHING HERE LEAVES THE DEVICE. There is no logging, no upload, no persistence: it is a
// live read of values the app already holds in memory, rendered and then forgotten.

import { useEffect, useState } from 'react';
import { compassDiagnostics, type CompassDiagnostics } from '@/hooks/useCompassHeading';
import { useLive } from '@/hooks/useLive';

/** A value with its label. `mono` for anything a reader will compare character by character. */
function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="diag-row">
      <span className="diag-label">{label}</span>
      <span className={`diag-value ${mono ? 'diag-mono' : ''}`}>{value}</span>
    </div>
  );
}

function num(v: number | null | undefined, digits = 0, unit = ''): string {
  return v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${unit}`;
}

/**
 * The browser's own record of whether the rider has granted location, which is a
 * different question from whether we currently hold a fix — a rider can have granted it
 * and still be indoors with nothing to show. Not every engine implements the query, and
 * one that does not is reported as unknown rather than as denied.
 */
function useGeoPermission(): string {
  const [state, setState] = useState('unsupported');
  useEffect(() => {
    const perms = navigator.permissions;
    if (perms?.query == null) return;
    let alive = true;
    let status: PermissionStatus | null = null;
    const onChange = () => { if (alive && status) setState(status.state); };
    perms.query({ name: 'geolocation' as PermissionName })
      .then((s) => {
        if (!alive) return;
        status = s;
        setState(s.state);
        s.addEventListener('change', onChange);
      })
      .catch(() => { if (alive) setState('unavailable'); });
    return () => { alive = false; status?.removeEventListener('change', onChange); };
  }, []);
  return state;
}

export function DiagnosticsPanel() {
  const [diag, setDiag] = useState<CompassDiagnostics>(() => compassDiagnostics());
  const geoStatus = useLive((s) => s.geoStatus);
  const geo = useLive((s) => s.geo);
  const geoPermission = useGeoPermission();

  // Once a second, because the whole point is the counts: a feed firing at 30 Hz and a
  // feed that has stopped look identical in a single sample. Only while mounted, and the
  // panel is only mounted when a rider has deliberately opened it.
  useEffect(() => {
    const t = setInterval(() => setDiag(compassDiagnostics()), 1_000);
    return () => clearInterval(t);
  }, []);

  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;

  return (
    <section className="diag" lang="en">
      <h3 className="abt-h">Sensor diagnostics</h3>
      <p className="diag-note">
        On-device only — nothing on this screen is sent anywhere, stored, or logged. Read it
        aloud or screenshot it if you are reporting a compass or location problem.
      </p>

      <h4 className="diag-h">Environment</h4>
      <Row label="Secure context" value={String(isSecureContext)} />
      <Row
        label="Handheld (coarse pointer)"
        value={diag.handheld ? 'yes' : 'no — no wedge is drawn on desktop, by design'}
      />
      <Row label="Screen angle" value={`${diag.screenAngle}° ${diag.screenType ?? ''}`.trim()} />

      <h4 className="diag-h">Location</h4>
      <Row label="Permission (browser)" value={geoPermission} />
      <Row label="App geo status" value={geoStatus} />
      <Row label="Have coordinates" value={geo == null ? 'no' : 'yes'} />
      <Row label="Last fix age" value={num(diag.lastFixAgeMs == null ? null : diag.lastFixAgeMs / 1000, 1, ' s')} />
      <Row label="Last fix accuracy" value={num(diag.lastFixAccuracyM, 0, ' m')} />
      <Row label="Last fix speed" value={num(diag.lastFixSpeedMps, 2, ' m/s')} />
      <Row label="Last fix course" value={num(diag.lastFixCourseDeg, 0, '°')} />

      <h4 className="diag-h">Compass</h4>
      <Row label="Permission API present" value={diag.permissionApi ? 'yes (iOS)' : 'no (Android/other)'} />
      <Row label="Permission state" value={diag.permission} mono />
      <Row label="Listening" value={String(diag.listening)} />
      <Row label="deviceorientation / 5s" value={String(diag.events5s.deviceorientation)} mono />
      <Row label="deviceorientationabsolute / 5s" value={String(diag.events5s.deviceorientationabsolute)} mono />
      <Row label="webkitCompassHeading / 5s" value={String(diag.events5s.webkitReadings)} mono />
      <Row label="Last alpha" value={num(diag.lastAlpha, 1, '°')} />
      <Row label="Last absolute flag" value={diag.lastAbsoluteFlag == null ? '—' : String(diag.lastAbsoluteFlag)} mono />
      <Row label="Last webkitCompassHeading" value={num(diag.lastWebkitHeading, 1, '°')} />
      <Row label="Last webkitCompassAccuracy" value={num(diag.lastWebkitAccuracy, 1, '°')} />

      <h4 className="diag-h">Result</h4>
      <Row label="Heading" value={num(diag.heading, 1, '°')} />
      <Row label="Source" value={diag.source ?? 'none — the plain dot is drawn'} mono />

      {/* The three shapes of "no wedge" that are NOT bugs, named, so a rider can rule
          themselves out before writing to us — and so can we, reading it back. */}
      <p className="diag-note">
        No heading is the honest answer when: the absolute counter above stays at 0 (this
        phone has no magnetometer, or the browser withholds it); permission is{' '}
        <code>denied</code>; or you are standing still with no compass, since a course over
        ground below 1 m/s is GPS noise rather than a direction.
      </p>

      <h4 className="diag-h">Build</h4>
      <Row label="Version" value={__APP_VERSION__} mono />
      <Row label="User agent" value={ua} mono />
    </section>
  );
}
