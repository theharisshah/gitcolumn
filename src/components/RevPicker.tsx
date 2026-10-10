import { ChevronDown, Cloud, GitBranch, GitCommit, Laptop, Tag } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';
import { PickerPopover, type PickerItem } from './PickerPopover';

/** A revision: null means the working copy. */
export type Rev = string | null;

/** Button + popover to choose the working copy, a branch, a tag or any revision. */
export function RevPicker({
  rev,
  label,
  onChange,
  workingCopy = true,
}: {
  rev: Rev;
  label?: string;
  onChange: (rev: Rev, label: string) => void;
  workingCopy?: boolean;
}) {
  const { repo, refs, status } = useRepo();
  const ui = useUI();
  const [open, setOpen] = useState(false);

  const items = useMemo(() => {
    const out: PickerItem<Rev>[] = [];
    if (workingCopy) out.push({ key: 'wc', label: 'Working Copy', icon: <Laptop size={12} />, value: null });
    const heads = refs.filter((r) => r.type === 'head').sort((a, b) => Number(!!b.current) - Number(!!a.current) || b.date - a.date);
    for (const r of heads) out.push({ key: r.ref, label: r.name, hint: r.current ? 'current' : undefined, icon: <GitBranch size={12} />, value: r.name });
    for (const r of refs.filter((x) => x.type === 'tag').sort((a, b) => b.date - a.date)) out.push({ key: r.ref, label: r.name, icon: <Tag size={12} />, value: r.name });
    for (const r of refs.filter((x) => x.type === 'remote')) out.push({ key: r.ref, label: r.name, icon: <Cloud size={12} />, value: r.name });
    return out;
  }, [refs, workingCopy]);

  const custom = useCallback(
    (q: string): PickerItem<Rev> => ({ key: `rev:${q}`, label: q, hint: 'revision', icon: <GitCommit size={12} />, value: q }),
    [],
  );

  const choose = async (item: PickerItem<Rev>) => {
    if (item.key.startsWith('rev:') && item.value) {
      const hash = await api.revParse(repo.path, `${item.value}^{commit}`).catch(() => null);
      if (!hash) return ui.toast('error', `Unknown revision “${item.value}”`);
    }
    onChange(item.value, item.label);
  };

  const shown = rev === null ? 'Working Copy' : label ?? rev;
  const Icon = rev === null ? Laptop : refs.some((r) => r.type === 'tag' && r.name === rev) ? Tag : refs.some((r) => r.name === rev) ? GitBranch : GitCommit;
  return (
    <span className="picker-anchor">
      <button className="rev-picker" onClick={() => setOpen((o) => !o)} title="Choose a branch, tag or revision">
        <Icon size={13} />
        <span className="rev-picker-label">{shown}</span>
        {rev === null && status?.branch && <span className="muted small">{status.branch}</span>}
        <ChevronDown size={12} />
      </button>
      {open && <PickerPopover items={items} placeholder="Branch, tag or revision…" onChoose={choose} onClose={() => setOpen(false)} custom={custom} />}
    </span>
  );
}
