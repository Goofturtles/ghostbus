import { useEffect, useState } from 'react';

/** Re-render on an interval so countdowns stay live. Pauses when tab hidden. */
export function useTick(ms = 1000): number {
  const [, set] = useState(0);
  useEffect(() => {
    let id: number;
    const loop = () => {
      if (!document.hidden) set((n) => n + 1);
      id = window.setTimeout(loop, ms);
    };
    id = window.setTimeout(loop, ms);
    return () => window.clearTimeout(id);
  }, [ms]);
  return Date.now();
}
