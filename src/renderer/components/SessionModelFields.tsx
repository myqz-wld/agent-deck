import { useId, type JSX } from 'react';
import {
  CLAUDE_THINKING_LEVELS,
  CODEX_THINKING_LEVELS,
  GROK_THINKING_LEVELS,
  type SessionThinkingLevel,
} from '@shared/session-metadata';
import { DeckSelect, type DeckSelectOption } from '@renderer/components/DeckSelect';

export type SessionThinkingChoice = SessionThinkingLevel | '';

interface Props {
  adapterId: string;
  model: string;
  thinking: SessionThinkingChoice;
  disabled?: boolean;
  onModelChange: (model: string) => void;
  onThinkingChange: (thinking: SessionThinkingChoice) => void;
}

const DEFAULT_THINKING_OPTION: DeckSelectOption<SessionThinkingChoice> = {
  value: '',
  label: '跟随 provider 默认值',
};

function thinkingLevelsForAdapter(adapterId: string): readonly SessionThinkingLevel[] {
  if (adapterId === 'codex-cli') return CODEX_THINKING_LEVELS;
  if (adapterId === 'grok-build') return GROK_THINKING_LEVELS;
  if (adapterId === 'claude-code' || adapterId === 'deepseek-claude-code') {
    return CLAUDE_THINKING_LEVELS;
  }
  return [];
}

export function thinkingOptionsForAdapter(
  adapterId: string,
): readonly DeckSelectOption<SessionThinkingChoice>[] {
  return [
    DEFAULT_THINKING_OPTION,
    ...thinkingLevelsForAdapter(adapterId).map((value) => ({
      value,
      label: value.toUpperCase(),
    })),
  ];
}

/**
 * 新会话类入口共享的 model / thinking 控件。模型保持自由文本，由 provider 做最终校验；
 * thinking 只展示当前 adapter 支持的档位，空值表示不覆盖 provider 默认值。
 */
export function SessionModelFields({
  adapterId,
  model,
  thinking,
  disabled = false,
  onModelChange,
  onThinkingChange,
}: Props): JSX.Element {
  const modelId = useId();
  const thinkingId = useId();

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={modelId}
          className="text-[10px] uppercase tracking-wider text-deck-muted/70"
        >
          模型
        </label>
        <input
          id={modelId}
          type="text"
          value={model}
          maxLength={256}
          disabled={disabled}
          onChange={(event) => onModelChange(event.target.value)}
          placeholder="留空则使用 provider 默认模型"
          className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={thinkingId}
          className="text-[10px] uppercase tracking-wider text-deck-muted/70"
        >
          思考程度
        </label>
        <DeckSelect
          id={thinkingId}
          value={thinking}
          onChange={onThinkingChange}
          disabled={disabled}
          options={thinkingOptionsForAdapter(adapterId)}
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
          menuMinWidth={190}
        />
      </div>
    </div>
  );
}
