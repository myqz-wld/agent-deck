import { useEffect, useRef, useState, type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import {
  CLAUDE_THINKING_LEVELS,
  CODEX_THINKING_LEVELS,
  isClaudeThinkingLevel,
  type SessionThinkingLevel,
} from '@shared/session-metadata';
import { DeckSelect, type DeckSelectOption } from '@renderer/components/DeckSelect';

export type GeneratorProvider = AppSettings['summaryProvider'];

const PROVIDER_OPTIONS: readonly DeckSelectOption<GeneratorProvider>[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'deepseek', label: 'Deepseek' },
  { value: 'codex', label: 'Codex' },
];

function buildThinkingOptions(
  levels: readonly SessionThinkingLevel[],
): readonly DeckSelectOption<SessionThinkingLevel>[] {
  return levels.map((value) => ({ value, label: value.toUpperCase() }));
}

const CLAUDE_THINKING_OPTIONS = buildThinkingOptions(CLAUDE_THINKING_LEVELS);
const CODEX_THINKING_OPTIONS = buildThinkingOptions(CODEX_THINKING_LEVELS);

function thinkingOptionsForProvider(
  provider: GeneratorProvider,
): readonly DeckSelectOption<SessionThinkingLevel>[] {
  return provider === 'codex' ? CODEX_THINKING_OPTIONS : CLAUDE_THINKING_OPTIONS;
}

export function coerceThinkingForProvider(
  provider: GeneratorProvider,
  thinking: SessionThinkingLevel,
): SessionThinkingLevel {
  if (provider === 'codex' || isClaudeThinkingLevel(thinking)) return thinking;
  return thinking === 'ultra' ? 'max' : 'low';
}

function providerLabel(provider: GeneratorProvider): string {
  const option = PROVIDER_OPTIONS.find((candidate) => candidate.value === provider);
  return typeof option?.label === 'string' ? option.label : provider;
}

function ModelInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  useEffect(() => {
    if (!editingRef.current) setDraft(value);
  }, [value]);

  const commit = (): void => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value) onChange(trimmed);
    setDraft(trimmed);
  };

  return (
    <input
      type="text"
      aria-label={`${label} model`}
      value={draft}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          setDraft(value);
          setEditing(false);
          event.currentTarget.blur();
        }
      }}
      className="no-drag min-w-0 flex-1 rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-[11px] outline-none focus:border-white/20"
    />
  );
}

/** provider × model × thinking 三联控件，供周期总结与会话续接生成器共用。 */
export function ProviderModelThinkingFields({
  label,
  hint,
  provider,
  model,
  thinking,
  modelPlaceholder,
  onProviderChange,
  onModelChange,
  onThinkingChange,
}: {
  label: string;
  hint: string;
  provider: GeneratorProvider;
  model: string;
  thinking: SessionThinkingLevel;
  modelPlaceholder: string;
  onProviderChange: (value: GeneratorProvider) => void;
  onModelChange: (value: string) => void;
  onThinkingChange: (value: SessionThinkingLevel) => void;
}): JSX.Element {
  const selectedProviderLabel = providerLabel(provider);

  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1 text-[11px]">
      <div>{label}</div>
      <div className="flex items-center gap-2">
        <DeckSelect
          value={provider}
          onChange={onProviderChange}
          options={PROVIDER_OPTIONS}
          ariaLabel={`${label} provider`}
          className="shrink-0"
          buttonClassName="rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
          menuMinWidth={140}
        />
        <ModelInput
          label={label}
          value={model}
          placeholder={modelPlaceholder}
          onChange={onModelChange}
        />
        <DeckSelect
          value={thinking}
          onChange={onThinkingChange}
          title={`${selectedProviderLabel} 思考程度`}
          ariaLabel={`${label} 思考程度`}
          options={thinkingOptionsForProvider(provider)}
          className="w-20 shrink-0"
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
          menuMinWidth={120}
        />
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/60">{hint}</div>
    </div>
  );
}
