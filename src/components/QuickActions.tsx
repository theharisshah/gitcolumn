import type { Command } from '../repo/commands';

// Placeholder — replaced by the fuzzy palette in a later milestone.
export function QuickActions({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        {commands.filter((c) => c.enabled !== false).map((c) => (
          <button key={c.id} className="menu-item" onClick={() => { onClose(); c.run(); }}>
            {c.title}
          </button>
        ))}
      </div>
    </div>
  );
}
