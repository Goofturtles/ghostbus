# DESIGN TARGET — the reference mockup, transcribed

The user supplied a full reference mockup (desktop + mobile light + mobile dark) and the
instruction: **"there should be absolutely nothing overlapping"** and **"do not stop until
you can exactly replicate those pictures with everything."**

**THE IMAGE IS NOW ON DISK — VIEW IT DIRECTLY, IT IS THE AUTHORITY:**

    C:\Users\arjun\Music\Documents\Desktop\Website\ghostbus-design-reference.png

This document was written as a transcription while the image was unavailable. It is
accurate, but it is prose about a picture. **Where this file and the image disagree, the
image wins.** Use this file for the acceptance criteria (§D zero-overlap rules, §F the
probe and its measured baseline) and the honesty guards in §E; use the image for every
visual judgement — proportions, spacing, type scale, colour, radii, density.

`ghostbus-screen.png` (the older, mobile-dark-only reference) remains consistent with this
but is less complete.

Two rules override everything below:
1. **ZERO OVERLAP.** No element may visually overlap another at any breakpoint, in any
   locale, at any data length. This is the user's primary complaint. Text must never sit on
   text, chips must never collide, map labels must never touch each other or app chrome.
2. **Match the reference.** Where this document and personal taste disagree, the document wins.

---

## A. DESKTOP (the large window in the reference)

A macOS-style window. Three traffic-light dots top-left (red/amber/green). The window
chrome IS the app bar.

### A1. Top bar (full width, ~48–52px tall, dark)
- **Left:** `GhostBus` wordmark — "Ghost" in brand purple `#8944ab`, "Bus" in near-white.
- **Centre:** a single rounded search pill, roughly 340–380px wide, dark surface, with a
  magnifier glyph at its left, placeholder `Where to?`, and a `⌘K` hint right-aligned
  INSIDE the pill. The pill is horizontally centred in the window, not in the remaining space.
- **Right:** a green `● Live` pill, then a circular purple avatar button.

### A2. Layout below the top bar
A two-column split with **no gap and no rounded map card**:
- **Left sidebar**, fixed ~300–320px, dark (`#0d0f1a` family), full height, scrolls internally.
- **Right: the map, full-bleed** — it runs to the window's right and bottom edges and sits
  directly against the sidebar. On desktop the map is NOT a rounded card.

### A3. Sidebar contents, top to bottom
1. `CURRENT STOP` — small-caps section label, muted, letter-spaced, ~11px.
2. **Stop card** (rounded ~14px, slightly lighter surface than the sidebar):
   - Left: a purple rounded-square tile (~34px) containing a white map-pin glyph.
   - `King St W at Spadina Ave` — bold, near-white, may wrap to two lines but must not clip.
   - Second line: `Eastbound · Stop 4197` — the direction word in accent purple, the rest muted.
   - Right: an outline **heart** icon button.
3. `NEARBY DEPARTURES` — section label.
4. **Departure card — live** (rounded, own surface, generous padding):
   - Row 1: red route badge `504A` (rounded ~6px, red fill, white bold text), route name
     `King` in muted text beside it; far right the countdown `7` large in green with a small
     `min` beside it.
   - Row 2: destination `Distillery Loop` — bold, near-white, larger than the route name;
     far right a green `Live` pill on a dark-green tint.
   - Row 3: `Next departures` — small, muted.
   - Row 4: a **full-width action bar** inside the card: a rounded dark button reading
     `Track` with a small location glyph on the left and a `›` chevron on the right.
5. **Departure card — scheduled:** identical structure. Blue badge `510`, route `Spadina`,
   destination `Union Station`, countdown `9 min` in near-white (not green), a grey
   `Scheduled` pill, `Next departures`, and the same full-width `Track ›` bar.
6. **Alert card** (red-tinted surface, rounded):
   - Left: a warning triangle in a soft red-tinted circle.
   - Line 1: `7:26 PM` in near-white bold, then `Trip cancelled` in red.
   - Line 2: a small red `504A` badge then `King → Distillery Loop` in muted text.
   - Line 3: `Next trip at 7:34 PM` — small, muted.
   - Bottom: a **full-width** button with a red outline and red label `View alternatives`.
7. `SAVED PLACES` section label, with a purple `View all` link right-aligned on the same line.
8. Saved rows, each: a rounded tile with a glyph (house / map-pin), a bold near-white title
   (`Home`, `Union Station`), a muted sub-line (`12 min walk`, `510 Spadina · 9 min`), and a
   right-aligned outline star.
9. **Tab bar at the foot of the sidebar** (inside the sidebar, full sidebar width, not floating):
   four tabs — `Nearby` (map-pin), `Plan` (route), `Saved` (bookmark), `Alerts` (bell).
   Icon above label. Active tab (`Nearby`) is accent purple, others muted. The `Alerts` bell
   carries a small red dot.

### A4. The map (desktop)
Isometric voxel city. See section C for the world itself. Overlaid markers:
- **Stop marker card** floating over the city: a dark rounded card with a purple
  rounded-square tile containing a transit glyph, and two lines of text
  (`King St W` / `at Spadina Ave`).
- A **purple circular map pin** sitting on the route where the stop is.
- A **dotted walking path** of round purple beads running from the stop pin to the You
  beacon, with a **circular purple node containing a walker glyph** partway along it.
- **You beacon:** a blue circular button with a white person glyph, with an attached blue
  card to its right reading `You` on line one and `4 min walk` on line two.
- **Vehicle:** a red voxel streetcar sitting on the red route line, with a red `504A` badge
  floating directly above it.
- **Street name labels rendered along the streets themselves**, rotated to follow the road
  angle, in white/near-white: e.g. `King St West`, `Wellington St W`.
- **Controls, right edge, vertically stacked, each a rounded dark surface:**
  a `+` / `−` zoom pair grouped in one pill, then a separate locate/navigate arrow button,
  then a separate layers button.

---

## B. MOBILE (both light and dark shown in the reference)

Phone frame, status bar at 9:41. Everything lays out in normal document flow — **the whole
screen scrolls**; the map is a card, not a background.

Order, top to bottom:
1. **Header row:** `GhostBus` wordmark left; `● Live` green pill right. (No avatar on mobile
   in the reference.)
2. **Search row:** a full-width rounded search field with magnifier and `Where to?`, and to
   its right a small square filter/settings button. Both on the same line, not overlapping.
3. **Map card:** rounded (~16px), roughly 4:3, containing the same voxel city and the same
   marker set as desktop (stop card, purple pin, beaded walk path, You card, 504A badge),
   plus the control stack on its right edge (+/−, locate, layers) inset from the card edge.
4. **Stop header:** `King St W at Spadina Ave` bold; second line `Eastbound · Stop 4197`
   with the direction in purple; right side a **filled purple star in a circle**.
5. **Departure rows** — more compact than desktop:
   - Left: route badge, then `King → Distillery Loop` on ONE line, then `Next departures`
     small and muted beneath.
   - Right: the countdown (`7` + `min`), a `Live`/`Scheduled` pill beneath it, and a
     pill-shaped `Track ›` button.
   - The right column has a reserved width; the destination text truncates with an ellipsis
     rather than colliding with it.
6. **Alert card:** same content as desktop, full width, `View alternatives` button at the bottom.
7. **Tab bar:** pinned to the bottom of the phone, four tabs, `Nearby` active in purple,
   `Alerts` bell with a red dot.

**Light mode** uses white/very light grey surfaces, a light map (pale buildings, visible
green trees, the same red route), dark text. **Dark mode** uses the deep navy-violet
surfaces. Both are first-class and both appear in the reference.

---

## C. THE VOXEL CITY (both themes)

- **Isometric/near-isometric pitch.** Steep — the reference reads as a diorama, not a tilted map.
- **Buildings as chunky flat-topped blocks** with clearly lit top faces and darker walls, so
  each reads as a solid cube. Heights quantised into a few stepped tiers, not a continuous
  gradient. Blocks are separated by visible dark gaps — they do not merge into one mass.
- **Palette:** muted violets and purples dominate, with occasional desaturated teal and
  mauve blocks for variation. Dark violet ground. Streets a quiet lavender-slate, one step
  lighter than the ground.
- **TREES.** The reference clearly shows small green voxel trees scattered along streets and
  in blocks. They are small, muted, and numerous — set dressing, not focal points. (NOTE:
  earlier project docs said "omit trees"; the user's reference has them, so they are IN.
  Keep them small and muted — no bright saturated greens.)
- **The red route line is the only loud stroke.** Thick, bright red, and it **follows the
  streets with real turns** — never an abstract straight slash across the city.
- Buildings must never occlude the route, stops, markers, labels, vehicles or the You beacon.

---

## D. ZERO-OVERLAP ACCEPTANCE CRITERIA

The user's words: *"there's a lot of overlapping stuff, fix it, there should be absolutely
nothing overlapping."* Every one of these must hold:

1. No two floating map elements (stop card, You card, route badge, walker node, street
   labels, control stack, attribution) may visually intersect at any zoom, at any viewport,
   in either theme. Where two would collide, offset them or hide the lower-priority one.
2. No map element may sit underneath the top bar, the sidebar, the tab bar, or the map's own
   control stack.
3. Attribution must remain visible and unobstructed — it is a licence requirement.
4. In the sidebar and in mobile rows: the destination/route text column and the
   times/actions column must have reserved widths. Long text truncates with an ellipsis. No
   text may run under another element at any locale (French runs ~25% longer than English).
5. Nothing may be clipped: run the overflow probe — flag every element whose computed
   `overflow` is hidden and whose `scrollHeight > clientHeight`, excluding deliberate
   `-webkit-line-clamp`. Zero hits required.
6. No horizontal page scroll at 390px in any locale.
7. Verify at minimum: 390×844 and 1280×800, in light and dark, in `en` and `fr-CA`.

---

## E. NOTES / CONFLICTS TO RAISE, NOT SILENTLY RESOLVE

- The reference labels the primary row action **`Track`**. Earlier project docs made `Catch`
  the primary verb and explicitly vetoed `Track` on scheduled rows (offering to track an
  untracked vehicle is a promise the data cannot keep). **The user's reference wins on
  visual design.** Implement the reference's layout and button treatment; if you believe the
  wording creates a factual problem on scheduled rows, report it to the orchestrator rather
  than silently choosing — do not invent a third option.
- The reference shows illustrative data (`7 min`, `9 min`, `Trip cancelled at 7:26 PM`).
  GhostBus renders **real** data. Match the LAYOUT and TREATMENT exactly; never hardcode the
  reference's example values, and never fabricate a departure, countdown or alert to make a
  screenshot resemble the mockup. If the real state is empty, the honest empty state is what
  ships — and say so in your report.

---

## F. THE OVERLAP PROBE (shared, objective, non-negotiable)

**CORRECTED 2026-07-25. The first version of this probe was WRONG and produced false
positives. If you acted on the old "23 overlaps at 390x844, all content under the tab bar"
baseline, discard it — the tab-bar padding was already correct.**

The bug in the old probe: it compared `getBoundingClientRect()` directly. An element
scrolled below a scroll container's visible edge still reports a geometric position down
there, so every row scrolled out of view registered as "overlapping" the tab bar beneath
it. That is ordinary scrolling, not an overlap.

The corrected probe intersects each element's rect with every clipping ancestor, so it only
compares what is ACTUALLY VISIBLE. Run it against a production build at 390x844 and
1280x800, in light and dark, in `en` and `fr-CA`. It must return `trueOverlaps: 0`.

Map-internal elements are excluded here (they legitimately sit on the canvas), so
**map label collisions are NOT covered by this probe and must be checked by eye** — see D1.

```js
(() => {
  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    let b = { l: r.left, t: r.top, right: r.right, bottom: r.bottom };
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const s = getComputedStyle(p);
      if (/hidden|auto|scroll|clip/.test(s.overflowY + s.overflowX)) {
        const pr = p.getBoundingClientRect();
        b.l = Math.max(b.l, pr.left); b.t = Math.max(b.t, pr.top);
        b.right = Math.min(b.right, pr.right); b.bottom = Math.min(b.bottom, pr.bottom);
      }
      p = p.parentElement;
    }
    b.l = Math.max(b.l, 0); b.t = Math.max(b.t, 0);
    b.right = Math.min(b.right, innerWidth); b.bottom = Math.min(b.bottom, innerHeight);
    return b;
  };
  const area = b => Math.max(0, b.right - b.l) * Math.max(0, b.bottom - b.t);
  const lab = e => `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/)[0] : ''}${(e.innerText || '').trim() ? ` "${(e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 24)}"` : ''}`;
  const inMap = e => !!e.closest('.maplibregl-map, .map-card');
  const cand = [...document.querySelectorAll('body *')].filter(e => {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity <= 0.05) return false;
    if (e.tagName === 'CANVAS' || inMap(e)) return false;
    if (area(visibleRect(e)) < 25) return false;
    const own = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    return own || /^(BUTTON|A|INPUT|IMG)$/.test(e.tagName);
  });
  const out = [];
  for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
    const a = cand[i], b = cand[j]; if (a.contains(b) || b.contains(a)) continue;
    const ra = visibleRect(a), rb = visibleRect(b);
    const ix = Math.min(ra.right, rb.right) - Math.max(ra.l, rb.l);
    const iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.t, rb.t);
    if (ix > 2 && iy > 2) out.push({ area: Math.round(ix * iy), a: lab(a), b: lab(b) });
  }
  out.sort((x, y) => y.area - x.area);
  return { trueOverlaps: out.length, top: out.slice(0, 10),
           hScroll: document.documentElement.scrollWidth > innerWidth };
})()
```

### Corrected baseline (orchestrator, 2026-07-25, production build, 390x844)
**`trueOverlaps: 0`, `hScroll: false`.** The DOM layer is already clean.

### What the user actually saw, and what still needs fixing
The complaint was real; the mechanism was not DOM overlap. The genuine issues:

1. **Scroll edges have no affordance.** Sidebar/list content clips mid-card at the tab bar
   with nothing to signal "this scrolls" — so it reads as sliding *under* the bar. Add a
   scrim/fade or a visible boundary at the scroll container's bottom edge.
2. **Mid-word truncation.** The stop card renders `Stop 15647 · 160 m · 2 mi...`, cutting
   "2 min walk" mid-word. Never truncate mid-word in a short metadata line — reserve the
   width or drop a whole field.
3. **Map label collisions — NOT covered by the probe.** A street label was measured behind
   a building, and the attribution box sits over map content. These are real and must be
   fixed with genuine collision avoidance plus by-eye verification.

---

## H. MEASURED NOTE FOR THE REPAIR PASS — the route line

A visual judge reported the red route as *"hairline, no casing, and it runs dead straight."*
Those are two findings and only one of them is a defect. Measured by the orchestrator
against the real shape geometry in Postgres:

| route | points | total heading change | net bearing |
|---|---|---|---|
| 310 Spadina | 133 | 847° | 351° (due north) |
| 510 Spadina | 145 | 1350° | 171° |
| 504 King | 177 | 741° | 179° |

**The straightness is honest.** The map currently focuses a Spadina route (it picks the
selected vehicle's route, else the top live departure, else the next real scheduled service
— and with today's empty board that resolves to Spadina). Spadina Avenue *is* a straight
north–south street: its 847° of accumulated heading change is road-following jitter across
132 segments (~6° each), not turns. The reference image shows **504 King**, which has a
genuine dogleg. So the compositions differ because the focused route differs, not because
the line is being simplified.

**Do NOT add curvature, smoothing, or a decorative dogleg to make the line resemble the
reference.** The geometry is the agency's published shape; bending it would be fabricating
map data in an app whose entire argument is that it does not fabricate. Route geometry was
already densified this session (504: 36 → 177 points, p90 segment 994 m → ~160 m), so the
line is consuming real detail.

**The casing and weight ARE a real gap.** The reference's route is a thick red stroke with a
visible darker casing beneath it; ours renders thin and flat. `route-casing` and `route-line`
layers already exist in `MapCard.tsx` (~lines 358 and 368) — the fix is their paint
properties (width, colour, and width interpolation by zoom), not the data.

If a reviewer wants the reference's dogleg specifically, the honest lever is which route is
focused, not what shape is drawn.
