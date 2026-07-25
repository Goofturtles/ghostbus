import { useEffect, useState } from 'react';

/** The one breakpoint the shell changes shape at: below it the app is a single
 *  scrolling phone column, at or above it the reference's sidebar + full-bleed
 *  map split. Kept in JS as well as CSS because the map is mounted on the nearby
 *  tab only on phones, and stays mounted across tabs on the desktop split. */
export const DESKTOP_QUERY = '(min-width: 880px)';

export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof matchMedia === 'function' ? matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}
