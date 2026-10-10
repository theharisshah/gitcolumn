import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------- types

export interface FieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface Field {
  name: string;
  label?: string;
  type?: 'text' | 'textarea' | 'checkbox' | 'select' | 'radio';
  value?: string | boolean;
  placeholder?: string;
  options?: FieldOption[];
  required?: boolean;
  mono?: boolean;
  hint?: string;
  /** Rendered next to a text field (e.g. "Browse…") */
  action?: { label: string; run: (values: FormValues) => Promise<Partial<FormValues> | void> };
}

export type FormValues = Record<string, string | boolean>;

export interface FormSpec {
  title: string;
  message?: ReactNode;
  fields?: Field[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  validate?: (values: FormValues) => string | null;
  /** Recompute derived fields when a value changes */
  onChange?: (name: string, values: FormValues) => Partial<FormValues> | void;
}

export type MenuItem =
  | { label: string; onClick: () => void; icon?: ReactNode; disabled?: boolean; danger?: boolean; shortcut?: string; checked?: boolean }
  | { header: string }
  | 'separator';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface UI {
  form(spec: FormSpec): Promise<FormValues | null>;
  confirm(spec: { title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  menu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]): void;
  toast(kind: ToastKind, title: string, message?: string): void;
}

const UIContext = createContext<UI | null>(null);

export function useUI(): UI {
  const ui = useContext(UIContext);
  if (!ui) throw new Error('useUI outside UIProvider');
  return ui;
}

// -------------------------------------------------------------- provider

interface DialogState {
  id: number;
  spec: FormSpec;
  resolve: (v: FormValues | null) => void;
}

export function UIProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const ui = useMemo<UI>(
    () => ({
      form: (spec) => new Promise((resolve) => setDialog({ id: nextId.current++, spec, resolve })),
      confirm: (spec) =>
        new Promise((resolve) =>
          setDialog({
            id: nextId.current++,
            spec: { ...spec, confirmLabel: spec.confirmLabel ?? 'OK' },
            resolve: (v) => resolve(v !== null),
          }),
        ),
      menu: (e, items) => {
        e.preventDefault?.();
        setMenu({ x: e.clientX, y: e.clientY, items });
      },
      toast: (kind, title, message) => {
        const id = nextId.current++;
        setToasts((t) => [...t.slice(-4), { id, kind, title, message }]);
        const ttl = kind === 'error' ? 12000 : kind === 'warning' ? 8000 : 4000;
        setTimeout(() => dismissToast(id), ttl);
      },
    }),
    [dismissToast],
  );

  return (
    <UIContext.Provider value={ui}>
      {children}
      {dialog && (
        <Dialog
          key={dialog.id}
          spec={dialog.spec}
          onClose={(v) => {
            dialog.resolve(v);
            setDialog(null);
          }}
        />
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-icon">
              {t.kind === 'success' ? <CheckCircle2 size={16} /> : t.kind === 'error' ? <XCircle size={16} /> : t.kind === 'warning' ? <AlertTriangle size={16} /> : <Info size={16} />}
            </span>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.message && <pre className="toast-message">{t.message}</pre>}
            </div>
            <button className="icon-button toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </UIContext.Provider>
  );
}

// ---------------------------------------------------------------- dialog

function Dialog({ spec, onClose }: { spec: FormSpec; onClose: (v: FormValues | null) => void }) {
  const [values, setValues] = useState<FormValues>(() => {
    const v: FormValues = {};
    for (const f of spec.fields ?? []) v[f.name] = f.value ?? (f.type === 'checkbox' ? false : f.options?.[0]?.value ?? '');
    return v;
  });
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const first = formRef.current?.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]), textarea, select');
    (first ?? formRef.current?.querySelector<HTMLElement>('button[type=submit]'))?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }, []);

  const update = (name: string, value: string | boolean) => {
    setValues((prev) => {
      const next = { ...prev, [name]: value };
      const derived = spec.onChange?.(name, next);
      return derived ? ({ ...next, ...derived } as FormValues) : next;
    });
    setError(null);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    for (const f of spec.fields ?? []) {
      if (f.required && !String(values[f.name] ?? '').trim()) {
        setError(`${f.label ?? f.name} is required`);
        return;
      }
    }
    const err = spec.validate?.(values);
    if (err) {
      setError(err);
      return;
    }
    onClose(values);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(null)}>
      <form
        ref={formRef}
        className="modal"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose(null);
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
        }}
      >
        <h2 className="modal-title">{spec.title}</h2>
        {spec.message && <div className="modal-message">{spec.message}</div>}
        {spec.fields?.map((f) => (
          <FieldInput key={f.name} field={f} value={values[f.name]} values={values} onChange={update} setValues={setValues} />
        ))}
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => onClose(null)}>
            {spec.cancelLabel ?? 'Cancel'}
          </button>
          <button type="submit" className={`button ${spec.danger ? 'button-danger' : 'button-primary'}`}>
            {spec.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  );
}

function FieldInput({
  field: f,
  value,
  values,
  onChange,
  setValues,
}: {
  field: Field;
  value: string | boolean | undefined;
  values: FormValues;
  onChange: (name: string, v: string | boolean) => void;
  setValues: React.Dispatch<React.SetStateAction<FormValues>>;
}) {
  if (f.type === 'checkbox') {
    return (
      <label className="field field-checkbox">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(f.name, e.target.checked)} />
        <span>
          {f.label}
          {f.hint && <span className="field-hint">{f.hint}</span>}
        </span>
      </label>
    );
  }
  if (f.type === 'radio') {
    return (
      <div className="field">
        {f.label && <div className="field-label">{f.label}</div>}
        <div className="radio-group">
          {f.options?.map((o) => (
            <label key={o.value} className={`radio-option ${value === o.value ? 'selected' : ''}`}>
              <input type="radio" name={f.name} checked={value === o.value} onChange={() => onChange(f.name, o.value)} />
              <span>
                <span className="radio-label">{o.label}</span>
                {o.description && <span className="field-hint">{o.description}</span>}
              </span>
            </label>
          ))}
        </div>
      </div>
    );
  }
  return (
    <label className="field">
      {f.label && <span className="field-label">{f.label}</span>}
      <span className="field-row">
        {f.type === 'textarea' ? (
          <textarea
            className={`input ${f.mono ? 'mono' : ''}`}
            value={String(value ?? '')}
            placeholder={f.placeholder}
            rows={4}
            onChange={(e) => onChange(f.name, e.target.value)}
          />
        ) : f.type === 'select' ? (
          <select className="input" value={String(value ?? '')} onChange={(e) => onChange(f.name, e.target.value)}>
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className={`input ${f.mono ? 'mono' : ''}`}
            value={String(value ?? '')}
            placeholder={f.placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onChange(f.name, e.target.value)}
          />
        )}
        {f.action && (
          <button
            type="button"
            className="button"
            onClick={async () => {
              const patch = await f.action!.run(values);
              if (patch) setValues((v) => ({ ...v, ...patch }) as FormValues);
            }}
          >
            {f.action.label}
          </button>
        )}
      </span>
      {f.hint && <span className="field-hint">{f.hint}</span>}
    </label>
  );
}

// ---------------------------------------------------------- context menu

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - r.width - 6),
      top: y + r.height > window.innerHeight - 6 ? Math.max(6, y - r.height) : y,
    });
    el.focus();
  }, [x, y]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" style={pos} tabIndex={-1} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) => {
        if (item === 'separator') return <div key={i} className="menu-separator" />;
        if ('header' in item) return <div key={i} className="menu-header">{item.header}</div>;
        return (
          <button
            key={i}
            className={`menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            <span className="menu-icon">{item.checked ? '✓' : item.icon}</span>
            <span className="menu-label">{item.label}</span>
            {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}
