import type { JSX } from 'react';
import {
  SessionModelFields,
  type SessionThinkingChoice,
} from './SessionModelFields';

interface Props {
  adapterId: string;
  provider: string;
  model: string;
  thinking: SessionThinkingChoice;
  disabled?: boolean;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
  onThinkingChange: (thinking: SessionThinkingChoice) => void;
}

/** Compact new-session runtime summary with the editable fields behind one disclosure. */
export function SessionModelDisclosure({
  adapterId,
  provider,
  model,
  thinking,
  disabled = false,
  onProviderChange,
  onModelChange,
  onThinkingChange,
}: Props): JSX.Element {
  const providerLabel =
    adapterId === 'grok-build'
      ? null
      : `${adapterId === 'claude-code' ? 'Gateway' : 'Profile'}：${provider || '原生'}`;
  const summary = [
    providerLabel,
    `模型：${model || '配置文件'}`,
    `思考：${thinking ? thinking.toUpperCase() : 'HIGH'}`,
  ].filter(Boolean);

  return (
    <details className="rounded border border-deck-border bg-white/[0.025] px-2 py-1.5">
      <summary className="cursor-pointer select-none text-[11px] text-deck-muted">
        <span className="text-deck-text">模型配置</span>
        <span className="ml-2 text-[10px]">{summary.join(' · ')}</span>
      </summary>
      <div className="mt-2">
        <SessionModelFields
          adapterId={adapterId}
          provider={provider}
          model={model}
          thinking={thinking}
          disabled={disabled}
          allowUnsetThinking={false}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
          onThinkingChange={onThinkingChange}
        />
      </div>
    </details>
  );
}
