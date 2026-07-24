import { useEffect, useRef, useState, type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import {
  CLAUDE_THINKING_LEVELS,
  CODEX_THINKING_LEVELS,
  GROK_THINKING_LEVELS,
  isClaudeThinkingLevel,
  isGrokThinkingLevel,
  type SessionThinkingLevel,
} from '@shared/session-metadata';
import { DeckSelect, type DeckSelectOption } from '@renderer/components/DeckSelect';
import { ProviderCombobox } from '@renderer/components/assets/ProviderCombobox';

export type GeneratorAdapter = AppSettings['summaryAdapter'];

const ADAPTER_OPTIONS: readonly DeckSelectOption<GeneratorAdapter>[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex-cli', label: 'Codex CLI' },
  { value: 'grok-build', label: 'Grok Build' },
];

function buildThinkingOptions(
  levels: readonly SessionThinkingLevel[],
): readonly DeckSelectOption<SessionThinkingLevel>[] {
  return levels.map((value) => ({ value, label: value.toUpperCase() }));
}

const CLAUDE_THINKING_OPTIONS = buildThinkingOptions(CLAUDE_THINKING_LEVELS);
const CODEX_THINKING_OPTIONS = buildThinkingOptions(CODEX_THINKING_LEVELS);
const GROK_THINKING_OPTIONS = buildThinkingOptions(GROK_THINKING_LEVELS);

function thinkingOptionsForAdapter(
  adapter: GeneratorAdapter,
): readonly DeckSelectOption<SessionThinkingLevel>[] {
  if (adapter === 'codex-cli') return CODEX_THINKING_OPTIONS;
  if (adapter === 'grok-build') return GROK_THINKING_OPTIONS;
  return CLAUDE_THINKING_OPTIONS;
}

export function coerceThinkingForAdapter(
  adapter: GeneratorAdapter,
  thinking: SessionThinkingLevel,
): SessionThinkingLevel {
  if (adapter === 'codex-cli') {
    return thinking === 'minimal' ? 'low' : thinking;
  }
  if (adapter === 'grok-build') {
    if (isGrokThinkingLevel(thinking)) return thinking;
    return thinking === 'minimal' ? 'low' : 'xhigh';
  }
  if (isClaudeThinkingLevel(thinking)) return thinking;
  return thinking === 'minimal' ? 'low' : 'max';
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

/** Adapter × provider × model × thinking controls shared by both generator settings. */
export function ProviderModelThinkingFields({
  label,
  hint,
  adapter,
  runtimeProvider,
  model,
  thinking,
  modelPlaceholder,
  onAdapterChange,
  onRuntimeProviderChange,
  onModelChange,
  onThinkingChange,
}: {
  label: string;
  hint: string;
  adapter: GeneratorAdapter;
  runtimeProvider: string;
  model: string;
  thinking: SessionThinkingLevel;
  modelPlaceholder: string;
  onAdapterChange: (value: GeneratorAdapter) => void;
  onRuntimeProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onThinkingChange: (value: SessionThinkingLevel) => void;
}): JSX.Element {
  const [providerOptions, setProviderOptions] = useState<
    Array<{ id: string; name?: string }>
  >([]);

  useEffect(() => {
    if (adapter === 'grok-build') {
      setProviderOptions([]);
      return;
    }
    let cancelled = false;
    const request =
      adapter === 'claude-code'
        ? window.api.listClaudeGatewayProfiles()
        : window.api.listCodexModelProviders();
    void request
      .then((options) => {
        if (!cancelled) setProviderOptions(options);
      })
      .catch(() => {
        if (!cancelled) setProviderOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  const adapterLabel =
    ADAPTER_OPTIONS.find((candidate) => candidate.value === adapter)?.label ??
    adapter;

  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1 text-[11px]">
      <div>{label}</div>
      <div className="flex items-center gap-2">
        <DeckSelect
          value={adapter}
          onChange={onAdapterChange}
          options={ADAPTER_OPTIONS}
          ariaLabel={`${label} adapter`}
          className="shrink-0"
          buttonClassName="rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
          menuMinWidth={140}
        />
        {adapter !== 'grok-build' && (
          <div className="min-w-0 flex-1">
            <ProviderCombobox
              value={runtimeProvider}
              options={providerOptions}
              ariaLabel={`${label} ${adapter === 'claude-code' ? 'Gateway' : 'provider'}`}
              placeholder={
                adapter === 'claude-code'
                  ? 'Gateway（留空使用原生配置）'
                  : 'Provider（留空跟随 config.toml）'
              }
              emptyMessage={
                adapter === 'claude-code'
                  ? '没有发现 Gateway profile'
                  : '没有匹配项，可直接输入 provider'
              }
              onChange={onRuntimeProviderChange}
            />
          </div>
        )}
        <ModelInput
          label={label}
          value={model}
          placeholder={modelPlaceholder}
          onChange={onModelChange}
        />
        <DeckSelect
          value={thinking}
          onChange={onThinkingChange}
          title={`${adapterLabel} 思考程度`}
          ariaLabel={`${label} 思考程度`}
          options={thinkingOptionsForAdapter(adapter)}
          className="w-20 shrink-0"
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
          menuMinWidth={120}
        />
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/60">{hint}</div>
    </div>
  );
}
