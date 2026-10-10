import { useCallback, useState } from 'react';

export function usePersistentSize(key: string, initial: number): [number, (n: number) => void] {
  const storageKey = `gitcolumn.size:${key}`;
  const [size, setSize] = useState(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      return v > 0 ? v : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (n: number) => {
      setSize(n);
      try {
        localStorage.setItem(storageKey, String(Math.round(n)));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );
  return [size, set];
}

/** A draggable divider. `invert` for panes whose size grows when dragging left/up. */
export function Splitter({
  value,
  onChange,
  min,
  max,
  vertical,
  invert,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  vertical?: boolean;
  invert?: boolean;
}) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const start = vertical ? e.clientY : e.clientX;
    const startValue = value;
    const move = (ev: MouseEvent) => {
      const delta = (vertical ? ev.clientY : ev.clientX) - start;
      onChange(Math.max(min, Math.min(max, startValue + (invert ? -delta : delta))));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing', 'resizing-v');
    };
    document.body.classList.add(vertical ? 'resizing-v' : 'resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return <div className={`splitter ${vertical ? 'splitter-v' : 'splitter-h'}`} onMouseDown={onMouseDown} />;
}
