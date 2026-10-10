import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fuzzyFilter } from '../lib/fuzzy';

export interface PickerItem<T = unknown> {
  key: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  value: T;
}

/** A searchable dropdown list (↑ ↓ ↩ Esc), positioned below its `.picker-anchor` parent. */
export function PickerPopover<T>({
  items,
  placeholder,
  onChoose,
  onClose,
  footer,
  custom,
  className = '',
}: {
  items: PickerItem<T>[];
  placeholder: string;
  onChoose: (item: PickerItem<T>) => void;
  onClose: () => void;
  footer?: ReactNode;
  /** Extra entry for free-form input (e.g. "Use revision …") */
  custom?: (query: string) => PickerItem<T> | null;
  className?: string;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const list = useMemo(() => {
    const matched = fuzzyFilter(items, q, (i) => i.label, { limit: 200 }).map((r) => r.item);
    const extra = q.trim() ? custom?.(q.trim()) : null;
    return extra && !matched.some((m) => m.label === extra.label) ? [...matched, extra] : matched;
  }, [items, q, custom]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [onClose]);
  useEffect(() => {
    listRef.current?.querySelector('.popover-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (i: number) => {
    const item = list[i];
    if (!item) return;
    onClose();
    onChoose(item);
  };

  return (
    <div className={`popover picker-popover ${className}`} ref={ref}>
      <div className="search-box popover-search">
        <Search size={13} />
        <input
          autoFocus
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(list.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') choose(active);
          }}
          spellCheck={false}
        />
      </div>
      <div className="popover-list" ref={listRef}>
        {list.map((item, i) => (
          <button key={item.key} className={`popover-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
            <span className="popover-check">{item.icon}</span>
            <span className="popover-label">{item.label}</span>
            {item.hint && <span className="muted small">{item.hint}</span>}
          </button>
        ))}
        {!list.length && <div className="popover-empty">No matches</div>}
      </div>
      {footer}
    </div>
  );
}
