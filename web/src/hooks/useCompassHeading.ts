// Which way the rider is FACING — the one thing a paper map never told you, and the
// reason a rider standing at an intersection still walks the wrong way for half a block.
//
// This is a shared module rather than a plain hook because its two halves live in
// different components: the permission has to be asked from a user GESTURE (iOS refuses
// otherwise, silently), and the gesture the app already has is the "use my location" tap
// on the home panel — while the thing that draws the heading is the map's You marker. One
// module-level source, many subscribers, exactly one listener on the device.
//
// THREE HONESTY RULES, in the same spirit as the rest of the app:
//
//  1. NEVER AUTO-PROMPT. `start()` runs only from the location tap. A rider who never
//     asks the app where they are is never asked for their compass either. This is now
//     ENFORCED rather than trusted — see `startCompass`.
//  2. NEVER SHOW A HEADING WE DO NOT HAVE. `heading` stays null until a reading arrives
//     that is genuinely measured against the world. A relative `alpha` is measured from
//     whatever direction the device happened to boot facing, so drawing it would be a
//     confidently-wrong arrow, which is worse than no arrow. Denied, unsupported, or
//     relative-only all render exactly the dot that shipped before this file existed.
//  3. PHONES ONLY. Desktop browsers fire nothing here, but some laptops with
//     accelerometers do; a heading wedge on a desktop map is noise, so a coarse pointer
//     is required before we even listen.
//
// THREE SOURCES, in falling order of trust, and all three are real measurements:
//
//   ios         · `webkitCompassHeading`, already true-north corrected. Safari only.
//   absolute    · the `deviceorientationabsolute` event (Chrome/Android's earth-referenced
//                 feed) or a plain `deviceorientation` event that declares `absolute`.
//   gpsCourse   · `GeolocationCoordinates.heading` while the rider is actually MOVING.
//                 This is direction of travel, not facing, and the device only reports it
//                 when it has a real course to report — a phone with no magnetometer (a
//                 large share of mid-range Android) has nothing else to offer. Standing
//                 still with no compass is still no wedge at all, by rule 2.
//
// EVERY SOURCE EXPIRES. A heading is a claim about NOW; a magnetometer that stopped
// reporting five seconds ago, or a course from a fix taken in a tunnel a minute ago, is
// not evidence about which way the rider is pointing. Both are dropped back to null.

/** Degrees clockwise from true north, or null when we have no honest reading. */
type Heading = number | null;

/** Where the current heading came from. Diagnostics and tests read this; the wedge does
 *  not — a real measurement is a real measurement and none of the three is drawn
 *  differently from the others. */
export type HeadingSource = 'ios' | 'absolute' | 'gpsCourse';

/**
 * HOW LONG A READING IS STILL EVIDENCE.
 *
 * The orientation sensors fire at tens of hertz, so five seconds of silence means the
 * feed stopped (backgrounded tab, revoked permission, sensor error) rather than a slow
 * update. A geolocation watch fires every second or two while a rider walks, so fifteen
 * seconds covers an ordinary GPS gap without letting a course survive a subway platform.
 */
const MAG_STALE_MS = 5_000;
const GPS_STALE_MS = 15_000;

/**
 * The speed below which `coords.heading` is not a direction anybody is going.
 *
 * Devices report a course computed from consecutive fixes, and at walking-pause speeds
 * that course is GPS noise rotating on the spot — the exact "confidently wrong arrow"
 * rule 2 exists to prevent. 1 m/s is a slow walk; below it we publish nothing.
 */
const GPS_COURSE_MIN_MPS = 1;

let magHeading: Heading = null;
let magSource: HeadingSource | null = null;
let magAtMs = 0;
let gpsHeading: Heading = null;
let gpsAtMs = 0;

let started = false;
let listening = false;
let expiryTimer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<() => void>();

/** What `compassHeading()` last told the world, so a change is only announced once. */
let announced: Heading = null;

/** The current honest answer, freshness included. Evaluated at READ time so a feed that
 *  simply stops cannot leave a stale wedge on screen. */
function currentHeading(): { heading: Heading; source: HeadingSource | null } {
  const now = Date.now();
  if (magHeading != null && now - magAtMs < MAG_STALE_MS) return { heading: magHeading, source: magSource };
  if (gpsHeading != null && now - gpsAtMs < GPS_STALE_MS) return { heading: gpsHeading, source: 'gpsCourse' };
  return { heading: null, source: null };
}

function notify(): void {
  const next = currentHeading().heading;
  if (next === announced) return;
  announced = next;
  for (const fn of subscribers) fn();
}

/**
 * A heading can go stale with no event to notice it — a sensor that stops firing sends
 * nothing, by definition. One second-hand ticks only while there IS something on screen
 * that can expire, and stops itself the moment there is not.
 */
function armExpiry(): void {
  if (expiryTimer != null || currentHeading().heading == null) return;
  const t = setInterval(() => {
    if (currentHeading().heading == null) {
      clearInterval(expiryTimer!);
      expiryTimer = null;
    }
    notify();
  }, 1_000);
  // Node's timer keeps the process alive; the browser's is a number and has no `unref`.
  // Without this the unit tests below would never exit.
  (t as unknown as { unref?: () => void }).unref?.();
  expiryTimer = t;
}

/**
 * A phone, by the only test that matters here: a coarse pointer. `ontouchstart` alone
 * says yes to a touch-capable laptop, and `maxTouchPoints` says yes to a trackpad on
 * some browsers.
 */
function isHandheld(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/**
 * Circular low-pass. A raw magnetometer jitters several degrees a second, and a wedge
 * that twitches reads as broken rather than as precise. Averaged as a UNIT VECTOR, not
 * as degrees: the naive mean of 359 and 1 is 180, i.e. exactly backwards.
 *
 * ONE FILTER PER SOURCE. A magnetometer heading and a GPS course are two different
 * measurements of two different things; blending them across a handover would produce a
 * number that neither sensor ever reported.
 */
const SMOOTHING = 0.25;
class Smoother {
  private vx = 0; private vy = 0; private primed = false;
  push(deg: number): number {
    const r = (deg * Math.PI) / 180;
    const x = Math.cos(r), y = Math.sin(r);
    if (!this.primed) { this.vx = x; this.vy = y; this.primed = true; }
    else { this.vx += (x - this.vx) * SMOOTHING; this.vy += (y - this.vy) * SMOOTHING; }
    return ((Math.atan2(this.vy, this.vx) * 180) / Math.PI + 360) % 360;
  }
  reset(): void { this.vx = this.vy = 0; this.primed = false; }
}
const magSmooth = new Smoother();
const gpsSmooth = new Smoother();

interface CompassEvent extends DeviceOrientationEvent {
  /** iOS only, and already true-north corrected: degrees CLOCKWISE from north. */
  webkitCompassHeading?: number;
  /** iOS only: accuracy in degrees, negative when the magnetometer is uncalibrated. */
  webkitCompassAccuracy?: number;
}

// ---------------------------------------------------------------------------------
// diagnostics — read-only, on-device, and never sent anywhere. See DiagnosticsPanel.
// ---------------------------------------------------------------------------------
const DIAG_WINDOW_MS = 5_000;
const seen = { deviceorientation: [] as number[], deviceorientationabsolute: [] as number[], webkit: [] as number[] };
let lastAlpha: number | null = null;
let lastAbsoluteFlag: boolean | null = null;
let lastWebkitHeading: number | null = null;
let lastWebkitAccuracy: number | null = null;
/** Why the compass is or is not listening. Named rather than inlined so the diagnostics
 *  interface can refer to it: `typeof permissionState` in a type position collapses to
 *  the initializer's literal type, which made the panel's field unassignable. */
export type CompassPermission =
  'not-asked' | 'not-required' | 'granted' | 'denied' | 'error' | 'no-gesture';
let permissionState: CompassPermission = 'not-asked';
let lastFix: { atMs: number; accuracyM: number | null; speedMps: number | null; courseDeg: number | null } | null = null;

function note(bucket: keyof typeof seen, now: number): void {
  const a = seen[bucket];
  a.push(now);
  while (a.length > 0 && now - a[0] > DIAG_WINDOW_MS) a.shift();
}
function countIn(bucket: keyof typeof seen, now: number): number {
  return seen[bucket].filter((t) => now - t <= DIAG_WINDOW_MS).length;
}

function onOrientation(e: DeviceOrientationEvent): void {
  const ev = e as CompassEvent;
  const now = Date.now();
  const absoluteEvent = ev.type === 'deviceorientationabsolute';
  note(absoluteEvent ? 'deviceorientationabsolute' : 'deviceorientation', now);
  if (typeof ev.alpha === 'number') lastAlpha = ev.alpha;
  if (typeof ev.absolute === 'boolean') lastAbsoluteFlag = ev.absolute;

  // iOS hands us a finished answer — degrees clockwise from true north, already
  // corrected for how the phone is being held. A NEGATIVE accuracy is Safari's way of
  // saying the magnetometer is uncalibrated (the figure-of-eight wave), and the value
  // that comes with it is not a direction; refuse it rather than draw it.
  if (typeof ev.webkitCompassHeading === 'number' && Number.isFinite(ev.webkitCompassHeading)) {
    lastWebkitHeading = ev.webkitCompassHeading;
    lastWebkitAccuracy = typeof ev.webkitCompassAccuracy === 'number' ? ev.webkitCompassAccuracy : null;
    if (typeof ev.webkitCompassAccuracy === 'number' && ev.webkitCompassAccuracy < 0) return;
    note('webkit', now);
    magHeading = magSmooth.push(ev.webkitCompassHeading);
    magSource = 'ios'; magAtMs = now;
    armExpiry(); notify();
    return;
  }

  /**
   * ANDROID, AND THE BUG THAT KEPT THE WEDGE OFF EVERY SAMSUNG.
   *
   * Chrome on Android fires TWO orientation feeds. Plain `deviceorientation` is the
   * game-rotation one: `absolute: false`, measured from wherever the device booted, and
   * correctly refused below. The earth-referenced feed is a SEPARATE event —
   * `deviceorientationabsolute` — and per spec that event type IS the absolute claim.
   *
   * The previous version tested only `event.absolute`, so any implementation that fires
   * the absolute event without setting the flag (observed in the wild, and the flag is
   * redundant on an event whose name is its contract) published nothing at all. The
   * honesty rule is unchanged: absolute-only. What changed is that the event's TYPE is
   * now accepted as the absolute declaration it is, alongside the flag.
   */
  if (!absoluteEvent && ev.absolute !== true) return;
  if (typeof ev.alpha !== 'number' || !Number.isFinite(ev.alpha)) return;

  // `alpha` is degrees COUNTER-clockwise from north, so it inverts, and it is measured
  // against the DEVICE's frame — turn the phone to landscape and the frame turns with
  // it, which is what `screen.orientation.angle` puts back.
  const screenAngle = screen?.orientation?.angle ?? 0;
  magHeading = magSmooth.push((360 - ev.alpha + screenAngle) % 360);
  magSource = 'absolute'; magAtMs = now;
  armExpiry(); notify();
}

/**
 * Every geolocation fix, whether or not it carries a usable course.
 *
 * Called from the one geolocation watch the app runs (useLive.requestLocation). Two jobs:
 *
 *  · DIAGNOSTICS. The fix's age, accuracy and speed are what tell a rider on a real phone
 *    whether the problem is the compass or the GPS, so they are recorded even on a
 *    desktop where no wedge will ever be drawn.
 *  · THE THIRD SOURCE. `coords.heading` is the device's own course over ground, in the
 *    same units as the compass — degrees clockwise from true north — and it is a real
 *    measurement, so rule 2 allows it. It is only taken while the rider is genuinely
 *    moving; a course computed at a standstill is noise, and a phone with no
 *    magnetometer standing still correctly shows no wedge at all.
 *
 * The magnetometer wins whenever it has a fresh reading: it answers "facing", which is
 * the question the wedge asks, while a course answers "travelling".
 */
export function noteGpsFix(pos: GeolocationPosition): void {
  const now = Date.now();
  const { heading: course, speed, accuracy } = pos.coords;
  lastFix = {
    atMs: now,
    accuracyM: Number.isFinite(accuracy) ? accuracy : null,
    speedMps: typeof speed === 'number' && Number.isFinite(speed) ? speed : null,
    courseDeg: typeof course === 'number' && Number.isFinite(course) ? course : null,
  };

  const moving = typeof speed === 'number' && Number.isFinite(speed) && speed >= GPS_COURSE_MIN_MPS;
  const usable = typeof course === 'number' && Number.isFinite(course) && moving && isHandheld();
  if (!usable) {
    // The rider stopped, or the device withdrew its course. Drop it rather than let the
    // last direction of travel stand in for a direction they may since have turned from.
    if (gpsHeading != null) { gpsHeading = null; gpsSmooth.reset(); notify(); }
    return;
  }
  gpsHeading = gpsSmooth.push(course);
  gpsAtMs = now;
  armExpiry(); notify();
}

function listen(): void {
  if (listening) return;
  listening = true;
  // `deviceorientationabsolute` is the event that actually promises true north on
  // Chrome/Android; plain `deviceorientation` is the iOS one. Both are attached and the
  // handler decides — a browser that fires only the relative event publishes nothing,
  // by rule 2.
  addEventListener('deviceorientationabsolute', onOrientation);
  addEventListener('deviceorientation', onOrientation);
}

/**
 * Ask for the compass. MUST be called synchronously from a user gesture on iOS, where
 * `DeviceOrientationEvent.requestPermission()` rejects outright otherwise.
 *
 * THE GESTURE IS NOW CHECKED, NOT ASSUMED, and that is a bug fix rather than a belt.
 * The app's location request runs once at mount as well as from the rider's tap, so this
 * function was reached with no user activation behind it. On iOS that call is refused —
 * and on the versions where the refusal arrives as a RESOLVED `'denied'` rather than a
 * rejection, the old code took its early return with `started` still latched to true, so
 * the rider's later tap became a no-op and the permission sheet never appeared at all.
 * A compass that can never be granted on iPhone is exactly the reported symptom.
 *
 * So: no user activation, no request, no latch. And a request that comes back anything
 * other than `granted` releases the latch too, because the next tap is a fresh gesture
 * and a rider who has since changed their mind in Settings deserves it to work.
 *
 * Safe to call repeatedly — the location button it is wired to is a button a rider taps
 * more than once — and it never throws: every failure path is "no heading", which the
 * marker already renders as the plain dot.
 */
export async function startCompass(): Promise<void> {
  if (started || !isHandheld()) return;
  const DOE = (globalThis as { DeviceOrientationEvent?: { requestPermission?: () => Promise<PermissionState> } })
    .DeviceOrientationEvent;
  if (!DOE) return;

  if (typeof DOE.requestPermission !== 'function') {
    // Android and every other engine: no permission gate, so nothing to ask and nothing
    // that needs a gesture. Listening is free and silent.
    permissionState = 'not-required';
    started = true;
    listen();
    return;
  }

  // iOS. `navigator.userActivation` is the browser's own answer to "is a gesture in
  // flight", which is the precondition the permission call has. Engines without it fall
  // through and ask, exactly as before — a missing API is not evidence of a missing tap.
  const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
  if (activation != null && !activation.isActive) { permissionState = 'no-gesture'; return; }

  started = true;
  try {
    const res = await DOE.requestPermission();
    permissionState = res === 'granted' ? 'granted' : 'denied';
    if (res !== 'granted') { started = false; return; } // denied: the dot, as before
    listen();
  } catch {
    // Denied, or called outside a gesture. Cleared so a LATER tap — which is a fresh
    // gesture, and the rider's second try — is allowed to ask again.
    permissionState = 'error';
    started = false;
  }
}

/** Subscribe to heading changes. Returns an unsubscribe. */
export function subscribeCompass(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** The current heading, or null when there is nothing honest to draw. */
export function compassHeading(): Heading {
  return currentHeading().heading;
}

/** Which sensor the current heading came from, or null when there is none. */
export function headingSource(): HeadingSource | null {
  return currentHeading().source;
}

/**
 * A snapshot of everything the device has told us, for the on-device diagnostics panel.
 *
 * Read-only and local: nothing here is sent anywhere, stored, or logged. It exists so a
 * rider on a real phone can read out what their hardware actually reports, which is the
 * only way to tell "no magnetometer" apart from "permission refused" apart from "we have
 * a bug" from the other side of a support message.
 */
export interface CompassDiagnostics {
  handheld: boolean;
  permissionApi: boolean;
  permission: CompassPermission;
  listening: boolean;
  events5s: { deviceorientation: number; deviceorientationabsolute: number; webkitReadings: number };
  lastAlpha: number | null;
  lastAbsoluteFlag: boolean | null;
  lastWebkitHeading: number | null;
  lastWebkitAccuracy: number | null;
  heading: number | null;
  source: HeadingSource | null;
  screenAngle: number;
  screenType: string | null;
  lastFixAgeMs: number | null;
  lastFixAccuracyM: number | null;
  lastFixSpeedMps: number | null;
  lastFixCourseDeg: number | null;
}

export function compassDiagnostics(): CompassDiagnostics {
  const now = Date.now();
  const { heading, source } = currentHeading();
  const DOE = (globalThis as { DeviceOrientationEvent?: { requestPermission?: () => Promise<PermissionState> } })
    .DeviceOrientationEvent;
  return {
    handheld: isHandheld(),
    permissionApi: typeof DOE?.requestPermission === 'function',
    permission: permissionState,
    listening,
    events5s: {
      deviceorientation: countIn('deviceorientation', now),
      deviceorientationabsolute: countIn('deviceorientationabsolute', now),
      webkitReadings: countIn('webkit', now),
    },
    lastAlpha,
    lastAbsoluteFlag,
    lastWebkitHeading,
    lastWebkitAccuracy,
    heading,
    source,
    screenAngle: screen?.orientation?.angle ?? 0,
    screenType: screen?.orientation?.type ?? null,
    lastFixAgeMs: lastFix ? now - lastFix.atMs : null,
    lastFixAccuracyM: lastFix?.accuracyM ?? null,
    lastFixSpeedMps: lastFix?.speedMps ?? null,
    lastFixCourseDeg: lastFix?.courseDeg ?? null,
  };
}

/** Test seam: forget everything, including the permission state. */
export function __resetCompassForTest(): void {
  if (listening) {
    removeEventListener('deviceorientationabsolute', onOrientation);
    removeEventListener('deviceorientation', onOrientation);
  }
  if (expiryTimer != null) { clearInterval(expiryTimer); expiryTimer = null; }
  magHeading = null; magSource = null; magAtMs = 0;
  gpsHeading = null; gpsAtMs = 0;
  announced = null; started = false; listening = false;
  magSmooth.reset(); gpsSmooth.reset();
  lastAlpha = null; lastAbsoluteFlag = null; lastWebkitHeading = null; lastWebkitAccuracy = null;
  permissionState = 'not-asked'; lastFix = null;
  seen.deviceorientation.length = 0;
  seen.deviceorientationabsolute.length = 0;
  seen.webkit.length = 0;
  subscribers.clear();
}

/** Test seam: the raw event handler, so the traps above can be driven without a device. */
export const __onOrientationForTest = onOrientation;
