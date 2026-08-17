import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
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
  if (adapter === 'codex-cli') return thinking;
  if (adapter === 'grok-build') {
    if (isGrokThinkingLevel(thinking)) return thinking;
    return 'xhigh';
  }
  if (isClaudeThinkingLevel(thinking)) return thinking;
  return 'max';
}

function ModelInput({
  label,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
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
      aria-label={`${label} 模型`}
      value={draft}
      disabled={disabled}
      title={disabled ? value || placeholder : undefined}
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
      className="no-drag w-full min-w-0 rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] text-deck-text outline-none focus:border-white/20 disabled:cursor-not-allowed disabled:text-deck-muted disabled:opacity-50"
    />
  );
}

function GeneratorField({
  field,
  label,
  children,
}: {
  field: 'adapter' | 'provider' | 'model' | 'thinking';
  label: string;
  children: ReactNode;
}): JSX.Element {
  const widthClass = field === 'provider' || field === 'model'
    ? 'min-[420px]:col-span-2'
    : 'min-[420px]:col-span-1';

  return (
    <div
      data-generator-field={field}
      className={`flex min-w-0 flex-col gap-1 ${widthClass}`}
    >
      <span className="text-[10px] leading-none text-deck-muted/70">{label}</span>
      {children}
    </div>
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
  disabled = false,
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
  disabled?: boolean;
  onAdapterChange: (value: GeneratorAdapter) => void;
  onRuntimeProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onThinkingChange: (value: SessionThinkingLevel) => void;
}): JSX.Element {
  const [providerOptions, setProviderOptions] = useState<
    Array<{ id: string; name?: string }>
  >([]);

  useEffect(() => {
    if (disabled) {
      setProviderOptions([]);
      return;
    }
    if (adapter === 'grok-build') {
      setProviderOptions([]);
      return;
    }
    let cancelled = false;
    const request =
      adapter === 'claude-code'
        ? window.api.listClaudeGatewayProfiles()
        : window.api.listCodexGatewayProfiles();
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
  }, [adapter, disabled]);

  const adapterLabel =
    ADAPTER_OPTIONS.find((candidate) => candidate.value === adapter)?.label ??
    adapter;
  const providerLabel = '模型网关';
  const disabledControlClass =
    'disabled:cursor-not-allowed disabled:text-deck-muted disabled:opacity-50';

  return (
    <div
      role="group"
      aria-label={label}
      data-settings-field={label}
      className="flex flex-col gap-1.5 text-[11px]"
    >
      <div className="font-medium text-deck-text/90">{label}</div>
      <div
        data-generator-fields
        className="grid grid-cols-1 gap-x-3 gap-y-2 rounded-md border border-white/[0.06] bg-black/10 p-2 min-[420px]:grid-cols-3"
      >
        <GeneratorField field="adapter" label="助手">
          <DeckSelect
            value={adapter}
            onChange={onAdapterChange}
            options={ADAPTER_OPTIONS}
            ariaLabel={`${label} 助手`}
            disabled={disabled}
            className="w-full min-w-0"
            buttonClassName={`w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] text-deck-text outline-none focus:border-white/20 ${disabledControlClass}`}
            menuMinWidth={160}
          />
        </GeneratorField>
        <GeneratorField field="provider" label={providerLabel}>
          {adapter !== 'grok-build' ? (
            <ProviderCombobox
              value={runtimeProvider}
              options={providerOptions}
              ariaLabel={`${label} ${providerLabel}`}
              placeholder={
                adapter === 'claude-code'
                  ? '留空使用 Claude Code 设置'
                  : '留空使用 Codex 设置'
              }
              emptyMessage="未发现其他可用的模型网关"
              onChange={onRuntimeProviderChange}
              disabled={disabled}
            />
          ) : (
            <div
              title="模型网关跟随 Grok Build 设置"
              className="min-w-0 truncate rounded border border-deck-border bg-white/[0.025] px-2 py-1 text-[11px] text-deck-muted/65"
            >
              跟随 Grok Build 设置
            </div>
          )}
        </GeneratorField>
        <GeneratorField field="model" label="模型">
          <ModelInput
            label={label}
            value={model}
            placeholder={modelPlaceholder}
            disabled={disabled}
            onChange={onModelChange}
          />
        </GeneratorField>
        <GeneratorField field="thinking" label="思考程度">
          <DeckSelect
            value={thinking}
            onChange={onThinkingChange}
            title={`${adapterLabel} 思考程度`}
            ariaLabel={`${label} 思考程度`}
            options={thinkingOptionsForAdapter(adapter)}
            disabled={disabled}
            className="w-full min-w-0"
            buttonClassName={`w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] text-deck-text outline-none focus:border-white/20 ${disabledControlClass}`}
            menuMinWidth={140}
          />
        </GeneratorField>
        <div className="border-t border-white/[0.05] pt-1.5 text-[10px] leading-snug text-deck-muted/60 min-[420px]:col-span-3">
          {hint}
        </div>
      </div>
    </div>
  );
}
