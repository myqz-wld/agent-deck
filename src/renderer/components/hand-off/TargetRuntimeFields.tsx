import type { JSX } from 'react';
import type {
  AdapterSessionMode,
  SessionAdapterId,
} from '@shared/types';
import { adapterSessionModeOptions } from '@renderer/lib/adapter-session-modes';
import { DeckSelect, type DeckSelectOption } from '../DeckSelect';
import { GrokSandboxPicker } from '../GrokSandboxPicker';
import {
  SessionModelFields,
  type SessionThinkingChoice,
} from '../SessionModelFields';

export interface HandOffAdapterOption extends DeckSelectOption<SessionAdapterId> {
  sessionModes: AdapterSessionMode[];
}

interface Props {
  adapters: readonly HandOffAdapterOption[];
  busy: boolean;
  targetAdapter: SessionAdapterId;
  targetProvider: string;
  targetModel: string;
  targetThinking: SessionThinkingChoice;
  targetSessionMode: AdapterSessionMode;
  targetGrokSandbox: string;
  onAdapterChange: (adapter: SessionAdapterId) => void;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
  onThinkingChange: (thinking: SessionThinkingChoice) => void;
  onSessionModeChange: (mode: AdapterSessionMode) => void;
  onGrokSandboxChange: (sandbox: string) => void;
}

export function TargetRuntimeFields({
  adapters,
  busy,
  targetAdapter,
  targetProvider,
  targetModel,
  targetThinking,
  targetSessionMode,
  targetGrokSandbox,
  onAdapterChange,
  onProviderChange,
  onModelChange,
  onThinkingChange,
  onSessionModeChange,
  onGrokSandboxChange,
}: Props): JSX.Element {
  const adapter = adapters.find((option) => option.value === targetAdapter);
  return (
    <div className="space-y-3 rounded border border-deck-border/80 bg-white/[0.02] p-3">
      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase tracking-wider text-deck-muted/70">
          目标运行时
        </label>
        <DeckSelect
          value={targetAdapter}
          ariaLabel="目标运行时"
          options={[...adapters]}
          disabled={busy || adapters.length === 0}
          onChange={onAdapterChange}
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px]"
          menuMinWidth={220}
        />
      </div>
      <SessionModelFields
        adapterId={targetAdapter}
        provider={targetProvider}
        model={targetModel}
        thinking={targetThinking}
        disabled={busy}
        onProviderChange={onProviderChange}
        onModelChange={onModelChange}
        onThinkingChange={onThinkingChange}
      />
      {(adapter?.sessionModes.length ?? 0) > 0 ? (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-deck-muted/70">
            工作模式
          </label>
          <DeckSelect
            value={targetSessionMode}
            ariaLabel="目标工作模式"
            options={adapterSessionModeOptions(adapter?.sessionModes ?? [])}
            disabled={busy}
            onChange={onSessionModeChange}
            buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px]"
          />
        </div>
      ) : null}
      {targetAdapter === 'grok-build' ? (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-deck-muted/70">
            Grok Build 沙盒请求档位
          </label>
          <GrokSandboxPicker
            value={targetGrokSandbox}
            onChange={onGrokSandboxChange}
            disabled={busy}
            ariaLabel="Grok Build 沙盒请求档位"
            followLabel="按同运行时继承 / Grok Build 全局设置"
          />
        </div>
      ) : null}
    </div>
  );
}
