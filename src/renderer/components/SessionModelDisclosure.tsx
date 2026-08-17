import type { JSX } from 'react';
import {
  SessionModelFields,
  type SessionThinkingChoice,
} from './SessionModelFields';
import type { DeckSelectOption } from './DeckSelect';

interface Props {
  adapterId: string;
  provider: string;
  model: string;
  thinking: SessionThinkingChoice;
  disabled?: boolean;
  providerOptions?: readonly { id: string; name?: string }[];
  thinkingOptions?: readonly DeckSelectOption<SessionThinkingChoice>[];
  disabledReasons?: {
    provider?: string | null;
    model?: string | null;
    thinking?: string | null;
  };
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
  providerOptions,
  thinkingOptions,
  disabledReasons,
  onProviderChange,
  onModelChange,
  onThinkingChange,
}: Props): JSX.Element {
  const providerLabel =
    adapterId === 'grok-build'
      ? null
      : `模型网关：${
          disabledReasons?.provider ? '不可用' : provider || '原生'
        }`;
  const modelLabel = disabledReasons?.model ? '不可用' : model || '配置文件';
  const thinkingLabel = disabledReasons?.thinking
    ? '不可用'
    : thinking
      ? thinking.toUpperCase()
      : '跟随当前助手默认值';
  const summary = [
    providerLabel,
    `模型：${modelLabel}`,
    `思考：${thinkingLabel}`,
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
          providerOptions={providerOptions}
          thinkingOptions={thinkingOptions}
          disabledReasons={disabledReasons}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
          onThinkingChange={onThinkingChange}
        />
      </div>
    </details>
  );
}
