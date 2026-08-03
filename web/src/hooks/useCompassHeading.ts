// Which way the rider is FACING — the one thing a paper map never told you, and the
// reason a rider standing at an intersection still walks the wrong way for half a block.
//
// This is a shared module rather than a plain hook because its two halves live in
// different components: the permission has to be asked from a user GESTURE (iOS refuses
// otherwise, silently), and the gesture the app already has is the "use my location" tap
// in NearbyPanel — while the thing that draws the heading is the map's You marker. One
// module-level source, many subscribers, exactly one listener on the device.
//
// THREE HONESTY RULES, in the same spirit as the rest of the app:
//
//  1. NEVER AUTO-PROMPT. `start()` runs only from the location tap. A rider who never
//     asks the app where they are is never asked for their compass either.
//  2. NEVER SHOW A HEADING WE DO NOT HAVE. `heading` stays null until a reading that is
//     genuinely absolute arrives. On the non-iOS path that means `event.absolute` is
//     true — a relative `alpha` is measured from whatever direction the device happened
//     to boot facing, so drawing it would be a confidently-wrong arrow, which is worse
//     than no arrow. Denied, unsupported, or relative-only all render exactly the dot
//     that shipped before this file existed.
//  3. PHONES ONLY. Desktop browsers fire nothing here, but some laptops with
//     accelerometers do; a heading wedge on a desktop map is noise, so a coarse pointer
//     is required before we even listen.

/** Degrees clockwise from true north, or null when we have no honest reading. */
type Heading = number | null;

let heading: Heading = null;
let started = false;
let listening = false;
const subscribers = new Set<() => void>();

function publish(next: Heading): void {
  if (next === heading) return;
  heading = next;
  for (const fn of subscribers) fn();
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
 */
const SMOOTHING = 0.25;
let vx = 0, vy = 0, primed = false;
function smooth(deg: number): number {
  const r = (deg * Math.PI) / 180;
  const x = Math.cos(r), y = Math.sin(r);
  if (!primed) { vx = x; vy = y; primed = true; }
  else { vx += (x - vx) * SMOOTHING; vy += (y - vy) * SMOOTHING; }
  const out = (Math.atan2(vy, vx) * 180) / Math.PI;
  return (out + 360) % 360;
}

interface CompassEvent extends DeviceOrientationEvent {
  /** iOS only, and already true-north corrected: degrees CLOCKWISE from north. */
  webkitCompassHeading?: number;
  /** iOS only: accuracy in degrees, negative when the magnetometer is uncalibrated. */
  webkitCompassAccuracy?: number;
}

function onOrientation(e: DeviceOrientationEvent): void {
  const ev = e as CompassEvent;

  // iOS hands us a finished answer — degrees clockwise from true north, already
  // corrected for how the phone is being held. A NEGATIVE accuracy is Safari's way of
  // saying the magnetometer is uncalibrated (the figure-of-eight wave), and the value
  // that comes with it is not a direction; refuse it rather than draw it.
  if (typeof ev.webkitCompassHeading === 'number' && Number.isFinite(ev.webkitCompassHeading)) {
    if (typeof ev.webkitCompassAccuracy === 'number' && ev.webkitCompassAccuracy < 0) return;
    publish(smooth(ev.webkitCompassHeading));
    return;
  }

  // Everyone else: `alpha` is degrees COUNTER-clockwise from north, so it inverts, and
  // it is measured against the DEVICE's frame — turn the phone to landscape and the
  // frame turns with it, which is what `screen.orientation.angle` puts back.
  if (!ev.absolute || typeof ev.alpha !== 'number' || !Number.isFinite(ev.alpha)) return;
  const screenAngle = screen?.orientation?.angle ?? 0;
  publish(smooth((360 - ev.alpha + screenAngle) % 360));
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
 * Safe to call repeatedly — the location button it is wired to is a button a rider taps
 * more than once — and it never throws: every failure path is "no heading", which the
 * marker already renders as the plain dot.
 */
export async function startCompass(): Promise<void> {
  if (started || !isHandheld()) return;
  started = true;
  const DOE = (globalThis as { DeviceOrientationEvent?: { requestPermission?: () => Promise<PermissionState> } })
    .DeviceOrientationEvent;
  if (!DOE) { started = false; return; }
  try {
    if (typeof DOE.requestPermission === 'function') {
      if ((await DOE.requestPermission()) !== 'granted') return; // denied: the dot, as before
    }
    listen();
  } catch {
    // Denied, or called outside a gesture. Cleared so a LATER tap — which is a fresh
    // gesture, and the rider's second try — is allowed to ask again.
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
  return heading;
}

/** Test seam: forget everything, including the permission state. */
export function __resetCompassForTest(): void {
  if (listening) {
    removeEventListener('deviceorientationabsolute', onOrientation);
    removeEventListener('deviceorientation', onOrientation);
  }
  heading = null; started = false; listening = false; primed = false; vx = vy = 0;
  subscribers.clear();
}

/** Test seam: the raw event handler, so the traps above can be driven without a device. */
export const __onOrientationForTest = onOrientation;
