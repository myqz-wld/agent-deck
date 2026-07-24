import { type JSX } from 'react';

/**
 * 资产库 Dialog 公共 sub-tab 切换组件（plan assets-codex-user-and-ui-unify-20260521 §D1 §D6
 * §Step 3.1 抽公共组件让 Skills/Agents/应用约定 三 tab 共用）。
 *
 * **plan reviewer-claude R2 MED-3 修订**：onSwitch prop 设 optional —— Skills/Agents tab
 * sub-tab 切换无 dirty 拦截需求（filter 视图变更不丢草稿），不传即直接切换；应用约定 tab
 * （ClaudeMdTab）传 dirty 检查 callback（子 editor 持有未保存草稿时弹 confirmDialog 拦截）。
 *
 * onSwitch 返 false 拦截切换 / 返 true 或 undefined 不拦截。
 */

export type AssetAdapter = 'claude-code' | 'codex-cli' | 'grok-build';

export function AdapterSubTab({
  current,
  onSelect,
  onSwitch,
  showGrok = false,
}: {
  current: AssetAdapter;
  onSelect: (next: AssetAdapter) => void;
  /** 切换前 hook,返 false 拦截切换。Skills/Agents 不传(无 dirty)/应用约定传(子 editor dirty)。 */
  onSwitch?: (next: AssetAdapter) => Promise<boolean>;
  /** Grok has bundled read-only assets; user assets and baseline editing stay app-owned. */
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
    <div className="flex items-center gap-1 text-[11px]">
      <span className="text-[10px] text-deck-muted/70">视角:</span>
      <SubTabBtn active={current === 'claude-code'} onClick={() => void guardedSelect('claude-code')}>
        Claude
      </SubTabBtn>
      <SubTabBtn active={current === 'codex-cli'} onClick={() => void guardedSelect('codex-cli')}>
        Codex
      </SubTabBtn>
      {showGrok && (
        <SubTabBtn active={current === 'grok-build'} onClick={() => void guardedSelect('grok-build')}>
          Grok
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
