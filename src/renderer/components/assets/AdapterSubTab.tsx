import { type JSX } from 'react';

export type AssetAdapter = 'claude-code' | 'codex-cli' | 'grok-build';

export function AdapterSubTab({
  current,
  onSelect,
  onSwitch,
  showGrok = false,
}: {
  current: AssetAdapter;
  onSelect: (next: AssetAdapter) => void;
  /** Return false to keep the current adapter selected. */
  onSwitch?: (next: AssetAdapter) => Promise<boolean>;
  showGrok?: boolean;
}): JSX.Element {
  const guardedSelect = async (next: AssetAdapter): Promise<void> => {
    if (next === current) return;
    if (onSwitch) {
      const ok = await onSwitch(next);
      if (!ok) return;
    }
    onSelect(next);
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-[11px]">
      <span className="text-[10px] text-deck-muted/70">视角：</span>
      <SubTabBtn active={current === 'claude-code'} onClick={() => void guardedSelect('claude-code')}>
        Claude Code
      </SubTabBtn>
      <SubTabBtn active={current === 'codex-cli'} onClick={() => void guardedSelect('codex-cli')}>
        Codex CLI
      </SubTabBtn>
      {showGrok && (
        <SubTabBtn active={current === 'grok-build'} onClick={() => void guardedSelect('grok-build')}>
          Grok Build
        </SubTabBtn>
      )}
    </div>
  );
}

function SubTabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
        active
          ? 'bg-status-working/20 text-status-working'
          : 'bg-white/5 text-deck-muted hover:bg-white/10 hover:text-deck-text'
      }`}
    >
      {children}
    </button>
  );
}
