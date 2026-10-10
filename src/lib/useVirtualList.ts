import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

/** Windowing for long fixed-height lists: which rows to render for the current scroll position. */
export function useVirtualList(scrollRef: RefObject<HTMLElement | null>, count: number, rowHeight: number, overscan = 8) {
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    el.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(el);
    setHeight(el.clientHeight);
    setScrollTop(el.scrollTop);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [scrollRef]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan);

  /** Scroll just enough to show a row. */
  const scrollToIndex = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el || index < 0) return;
      const top = index * rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
    },
    [scrollRef, rowHeight],
  );

  return { start, end, totalHeight: count * rowHeight, scrollToIndex };
}
