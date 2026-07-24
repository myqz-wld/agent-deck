import { useCallback, useRef, useState, type JSX } from 'react';
import { ClaudeMdEditor } from '../settings/ClaudeMdEditor';
import { CodexAgentsMdEditor } from '../settings/CodexAgentsMdEditor';
import { GrokAgentsMdEditor } from '../settings/GrokAgentsMdEditor';
import { AdapterSubTab, type AssetAdapter } from './AdapterSubTab';

export function ApplicationConventionTab({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [adapter, setAdapter] = useState<AssetAdapter>('claude-code');
  const [resetKeys, setResetKeys] = useState<Record<AssetAdapter, number>>({
    'claude-code': 0,
    'codex-cli': 0,
    'grok-build': 0,
  });
  const dirtyByAdapterRef = useRef<Record<AssetAdapter, boolean>>({
    'claude-code': false,
    'codex-cli': false,
    'grok-build': false,
  });

  const onSubDirty = useCallback(
    (source: AssetAdapter, dirty: boolean) => {
      dirtyByAdapterRef.current[source] = dirty;
      onDirtyChange(Object.values(dirtyByAdapterRef.current).some(Boolean));
    },
    [onDirtyChange],
  );
  const onClaudeDirty = useCallback(
    (dirty: boolean) => onSubDirty('claude-code', dirty),
    [onSubDirty],
  );
  const onCodexDirty = useCallback(
    (dirty: boolean) => onSubDirty('codex-cli', dirty),
    [onSubDirty],
  );
  const onGrokDirty = useCallback(
    (dirty: boolean) => onSubDirty('grok-build', dirty),
    [onSubDirty],
  );

  const guardSwitchAdapter = async (): Promise<boolean> => {
    if (!dirtyByAdapterRef.current[adapter]) return true;
    const confirmed = await window.api.confirmDialog({
      title: '切换视角',
      message: '应用约定有未保存的草稿，确定要丢弃吗？',
      detail: '切换后改动将丢失，无法恢复。',
      okLabel: '丢弃并切换',
      cancelLabel: '继续编辑',
      destructive: true,
    });
    if (confirmed) {
      dirtyByAdapterRef.current[adapter] = false;
      onDirtyChange(Object.values(dirtyByAdapterRef.current).some(Boolean));
      setResetKeys((current) => ({
        ...current,
        [adapter]: current[adapter] + 1,
      }));
    }
    return confirmed;
  };

  return (
    <div className="flex min-h-[310px] flex-col gap-2">
      <AdapterSubTab
        current={adapter}
        onSelect={setAdapter}
        onSwitch={guardSwitchAdapter}
        showGrok
      />
      <ConventionPane adapter={adapter} value="claude-code">
        <div className="text-[10px] leading-snug text-deck-muted/70">
          应用内置的 CLAUDE.md，会随新建的 Claude 会话自动加载。改动只对新建会话生效。
        </div>
        <ClaudeMdEditor key={resetKeys['claude-code']} onDirtyChange={onClaudeDirty} />
      </ConventionPane>
      <ConventionPane adapter={adapter} value="codex-cli">
        <div className="text-[10px] leading-snug text-deck-muted/70">
          应用内置的 CODEX_AGENTS.md，会随新建的 Codex 会话自动加载。改动只对新建会话生效。
        </div>
        <CodexAgentsMdEditor key={resetKeys['codex-cli']} onDirtyChange={onCodexDirty} />
      </ConventionPane>
      <ConventionPane adapter={adapter} value="grok-build">
        <div className="text-[10px] leading-snug text-deck-muted/70">
          应用内置的 GROK_AGENTS.md，通过 ACP 注入新建的 Grok Build 会话。改动只对新建会话生效。
        </div>
        <GrokAgentsMdEditor key={resetKeys['grok-build']} onDirtyChange={onGrokDirty} />
      </ConventionPane>
    </div>
  );
}

function ConventionPane({
  adapter,
  value,
  children,
}: {
  adapter: AssetAdapter;
  value: AssetAdapter;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className={adapter === value ? 'flex flex-col gap-2' : 'hidden'}
      aria-hidden={adapter !== value}
    >
      {children}
    </div>
  );
}
