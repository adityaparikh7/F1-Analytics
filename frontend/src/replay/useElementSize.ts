/**
 * Width and height of an element, tracked with a ResizeObserver (which also reports the
 * initial size as soon as it starts observing).
 */

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: Math.floor(box.width), height: Math.floor(box.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}
