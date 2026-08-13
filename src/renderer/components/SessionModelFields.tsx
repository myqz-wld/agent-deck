import { useEffect, useId, useState, type JSX } from 'react';
import {
  CLAUDE_THINKING_LEVELS,
  CODEX_THINKING_LEVELS,
  GROK_THINKING_LEVELS,
  type SessionThinkingLevel,
} from '@shared/session-metadata';
import { DeckSelect, type DeckSelectOption } from '@renderer/components/DeckSelect';
import { ProviderCombobox } from '@renderer/components/assets/ProviderCombobox';

export type SessionThinkingChoice = SessionThinkingLevel | '';

interface Props {
  adapterId: string;
  provider?: string;
  model: string;
  thinking: SessionThinkingChoice;
  disabled?: boolean;
  allowUnsetThinking?: boolean;
  providerOptions?: readonly { id: string; name?: string }[];
  providerClosed?: boolean;
  thinkingOptions?: readonly DeckSelectOption<SessionThinkingChoice>[];
  disabledReasons?: {
    provider?: string | null;
    model?: string | null;
    thinking?: string | null;
  };
  onProviderChange?: (provider: string) => void;
  onModelChange: (model: string) => void;
  onModelBlur?: () => void;
  onThinkingChange: (thinking: SessionThinkingChoice) => void;
}

const DEFAULT_THINKING_OPTION: DeckSelectOption<SessionThinkingChoice> = {
  value: '',
  label: '跟随助手默认值',
};

function thinkingLevelsForAdapter(adapterId: string): readonly SessionThinkingLevel[] {
  if (adapterId === 'codex-cli') return CODEX_THINKING_LEVELS;
  if (adapterId === 'grok-build') return GROK_THINKING_LEVELS;
  if (adapterId === 'claude-code') {
    return CLAUDE_THINKING_LEVELS;
  }
  return [];
}

export function thinkingOptionsForAdapter(
  adapterId: string,
  includeDefault = true,
): readonly DeckSelectOption<SessionThinkingChoice>[] {
  return [
    ...(includeDefault ? [DEFAULT_THINKING_OPTION] : []),
    ...thinkingLevelsForAdapter(adapterId).map((value) => ({
      value,
      label: value.toUpperCase(),
    })),
  ];
}

/**
 * 新会话类入口共享的 model / thinking 控件。模型保持自由文本，由 provider 做最终校验；
 * thinking 只展示当前 adapter 支持的档位；新建入口可隐藏空值并显示配置解析结果。
 */
export function SessionModelFields({
  adapterId,
  provider = '',
  model,
  thinking,
  disabled = false,
  allowUnsetThinking = true,
  providerOptions: providedProviderOptions,
  providerClosed = false,
  thinkingOptions: providedThinkingOptions,
  disabledReasons = {},
  onProviderChange,
  onModelChange,
  onModelBlur,
  onThinkingChange,
}: Props): JSX.Element {
  const modelId = useId();
  const thinkingId = useId();
  const [discoveredProviderOptions, setDiscoveredProviderOptions] = useState<
    Array<{ id: string; name?: string }>
  >([]);
  const supportsProvider =
    adapterId === 'claude-code' || adapterId === 'codex-cli';
  const providerEnabled = supportsProvider && Boolean(onProviderChange);

  useEffect(() => {
    if (providedProviderOptions) return;
    if (!providerEnabled) {
      setDiscoveredProviderOptions([]);
      return;
    }
    let cancelled = false;
    const request =
      adapterId === 'claude-code'
        ? window.api.listClaudeGatewayProfiles()
        : window.api.listCodexModelProviders();
    void request
      .then((options) => {
        if (!cancelled) setDiscoveredProviderOptions(options);
      })
      .catch(() => {
        if (!cancelled) setDiscoveredProviderOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [adapterId, providedProviderOptions, providerEnabled]);

  const providerOptions = providedProviderOptions ?? discoveredProviderOptions;

  return (
    <div className="grid grid-cols-1 gap-3">
      {providerEnabled && onProviderChange && (
        <div className="flex min-w-0 flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-deck-muted/70">
            {adapterId === 'claude-code' ? '模型网关' : '模型来源'}
          </label>
          {disabledReasons.provider ? (
            <UnavailableField reason={disabledReasons.provider} />
          ) : (
            <ProviderCombobox
              value={provider}
              options={providerOptions}
              disabled={disabled}
              allowCustom={!providerClosed}
              ariaLabel={adapterId === 'claude-code' ? '模型网关' : '模型来源'}
              placeholder={
                adapterId === 'claude-code'
                  ? '留空使用 settings.json'
                  : '留空使用 config.toml'
              }
              emptyMessage={
                adapterId === 'claude-code'
                  ? '没有匹配的模型网关，可直接输入或留空'
                  : '没有匹配的模型来源，可直接输入或留空'
              }
              onChange={onProviderChange}
            />
          )}
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={modelId}
          className="text-[10px] uppercase tracking-wider text-deck-muted/70"
        >
          模型
        </label>
        {disabledReasons.model ? (
          <UnavailableField reason={disabledReasons.model} />
        ) : (
          <input
            id={modelId}
            type="text"
            value={model}
            maxLength={256}
            disabled={disabled}
            onChange={(event) => onModelChange(event.target.value)}
            onBlur={onModelBlur}
            placeholder="留空仍使用配置文件中的模型"
            className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
          />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={thinkingId}
          className="text-[10px] uppercase tracking-wider text-deck-muted/70"
        >
          思考程度
        </label>
        {disabledReasons.thinking ? (
          <UnavailableField reason={disabledReasons.thinking} />
        ) : (
          <DeckSelect
            id={thinkingId}
            value={thinking}
            onChange={onThinkingChange}
            disabled={disabled}
            options={providedThinkingOptions ?? thinkingOptionsForAdapter(
              adapterId,
              allowUnsetThinking,
            )}
            buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
            menuMinWidth={190}
          />
        )}
      </div>
    </div>
  );
}

function UnavailableField({ reason }: { reason: string }): JSX.Element {
  return (
    <div className="break-words rounded border border-white/[0.07] bg-white/[0.03] px-2 py-1.5 text-[10px] leading-relaxed text-deck-muted [overflow-wrap:anywhere]">
      不可用：{reason}
    </div>
  );
}
