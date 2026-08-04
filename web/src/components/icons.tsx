// Inline SVG icons, currentColor, no icon-font download. 24px grid.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p,
});

export const PinIcon = (p: P) => (
  <svg {...base(p)}><path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10Z" /><circle cx="12" cy="11" r="2.2" /></svg>
);
export const RouteIcon = (p: P) => (
  <svg {...base(p)}><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="6" r="2.4" /><path d="M8 16.5 15.5 8" /><path d="M6 15.5V9a3 3 0 0 1 3-3h3" /></svg>
);
export const BookmarkIcon = (p: P) => (
  <svg {...base(p)}><path d="M7 4h10a1 1 0 0 1 1 1v15l-6-3.5L6 20V5a1 1 0 0 1 1-1Z" /></svg>
);
export const BellIcon = (p: P) => (
  <svg {...base(p)}><path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7Z" /><path d="M10.5 20a2 2 0 0 0 3 0" /></svg>
);
export const HeartIcon = (p: P & { filled?: boolean }) => {
  const { filled, ...rest } = p;
  return (
    <svg {...base(rest)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 20s-7-4.6-7-9.5A3.9 3.9 0 0 1 12 7a3.9 3.9 0 0 1 7 3.5C19 15.4 12 20 12 20Z" />
    </svg>
  );
};
export const StarIcon = (p: P & { filled?: boolean }) => {
  const { filled, ...rest } = p;
  return (
    <svg {...base(rest)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 4.2l2.35 4.76 5.25.77-3.8 3.7.9 5.23L12 16.19l-4.7 2.47.9-5.23-3.8-3.7 5.25-.77L12 4.2Z" />
    </svg>
  );
};
export const LocateIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3.2" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>
);
/** SWAP THE TWO ENDS — two arrows reversing past each other, the trip-planner
 *  convention. Vertical, because the two fields it sits between are stacked. */
export const SwapIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M7.5 4.5v13M7.5 4.5 4.5 7.6M7.5 4.5l3 3.1" />
    <path d="M16.5 19.5v-13M16.5 19.5l3-3.1M16.5 19.5l-3-3.1" />
  </svg>
);
/** The map's "locate me" glyph. A plain paper-plane navigation arrow — the notched
 *  five-point star the first version drew read as a fast-forward chevron, not as
 *  the navigation arrow the reference uses. */
export const NavIcon = (p: P) => (
  <svg {...base(p)}><path d="M20.5 3.5 3.8 10.2a.6.6 0 0 0 .05 1.12l6.6 2.23 2.23 6.6a.6.6 0 0 0 1.12.05L20.5 3.5Z" /></svg>
);
export const PlusIcon = (p: P) => (<svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>);
export const MinusIcon = (p: P) => (<svg {...base(p)}><path d="M5 12h14" /></svg>);
export const LayersIcon = (p: P) => (
  <svg {...base(p)}><path d="m12 4 8 4-8 4-8-4 8-4Z" /><path d="m4 12 8 4 8-4" /></svg>
);
export const SearchIcon = (p: P) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-3.5-3.5" /></svg>
);
export const SlidersIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></svg>
);
export const WarningIcon = (p: P) => (
  <svg {...base(p)}><path d="M12 4 3 19h18L12 4Z" /><path d="M12 10v4M12 17h.01" /></svg>
);
export const ChevronIcon = (p: P) => (<svg {...base(p)}><path d="m9 6 6 6-6 6" /></svg>);
export const CloseIcon = (p: P) => (<svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>);
export const ArrowRightIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 12h15" /><path d="m13 6 6 6-6 6" /></svg>
);
export const FlagIcon = (p: P) => (
  <svg {...base(p)}><path d="M6 21V4" /><path d="M6 5h10.5l-1.8 3.5L16.5 12H6" /></svg>
);
export const HomeIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 11 12 4l8 7" /><path d="M6 10v9h12v-9" /></svg>
);
export const WalkerIcon = (p: P) => (
  <svg {...base(p)}><circle cx="13" cy="4.5" r="1.6" /><path d="M13 8v4l3 3M13 12l-2 6M11 10 8 9M13 12l-3 1" /></svg>
);
export const SignalIcon = (p: P) => (
  <svg {...base(p)} strokeWidth={2}><path d="M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0" /><circle cx="12" cy="12.5" r="1.3" fill="currentColor" stroke="none" /></svg>
);
export const GearIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M4.5 7l1.7 1M17.8 16l1.7 1M4.5 17l1.7-1M17.8 8l1.7-1" /></svg>
);
export const PersonIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="8" r="3.4" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></svg>
);
export const InfoIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></svg>
);
export const NoEntryIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M7.5 12h9" /></svg>
);
export const AccessIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="4.6" r="1.7" />
    <path d="M12 8v4h4M12 12l-3.5 1M12 12v3.5l3 4M8.5 13a4.5 4.5 0 1 0 5.4 6.6" />
  </svg>
);
export const ClockIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.8" /></svg>
);
export const GhostIcon = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M12 3a7 7 0 0 0-7 7v9l2.2-1.6L9.4 19l2-1.6 2 1.6 2.2-1.6L19 19v-9a7 7 0 0 0-7-7Z" opacity="0.9" />
    <circle cx="9.5" cy="10" r="1.1" fill="var(--bg-deep, #0b0e1a)" />
    <circle cx="14.5" cy="10" r="1.1" fill="var(--bg-deep, #0b0e1a)" />
  </svg>
);
