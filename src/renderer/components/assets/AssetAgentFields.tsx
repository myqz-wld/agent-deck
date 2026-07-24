import type { JSX } from 'react';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { ProviderCombobox } from './ProviderCombobox';

const CLAUDE_MODEL_OPTIONS = ['fable', 'opus', 'sonnet', 'haiku'];
const CODEX_MODEL_OPTIONS = ['', 'gpt-5.5', 'gpt-5.4'];
const GROK_MODEL_OPTIONS = ['', 'grok-4.5'];
const GROK_EFFORT_OPTIONS = ['', 'low', 'medium', 'high', 'xhigh'];

export function AssetAgentFields({
  adapter,
  model,
  provider,
  providerOptions,
  thinking,
  tools,
  busy,
  modelError,
  providerError,
  thinkingError,
  toolsError,
  onModelChange,
  onProviderChange,
  onThinkingChange,
  onToolsChange,
}: {
  adapter: 'claude-code' | 'codex-cli' | 'grok-build';
  model: string;
  provider: string;
  providerOptions: Array<{ id: string; name?: string }>;
  thinking: string;
  tools: string;
  busy: boolean;
  modelError: string | null;
  providerError: string | null;
  thinkingError: string | null;
  toolsError: string | null;
  onModelChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onThinkingChange: (value: string) => void;
  onToolsChange: (value: string) => void;
}): JSX.Element {
  const isCodex = adapter === 'codex-cli';
  const isGrok = adapter === 'grok-build';
  const modelOptions = isCodex
    ? CODEX_MODEL_OPTIONS
    : isGrok
      ? GROK_MODEL_OPTIONS
      : CLAUDE_MODEL_OPTIONS;
  return (
    <>
      <Field label={isCodex || isGrok ? '模型（可留空）' : '模型'} error={modelError}>
        <DeckSelect
          value={model}
          onChange={onModelChange}
          disabled={busy}
          options={modelOptions.map((value) => ({ value, label: value || 'inherit' }))}
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
        />
      </Field>
      {!isGrok && (
        <Field
          label={adapter === 'claude-code' ? 'Gateway（可留空）' : 'Provider（可留空）'}
          error={providerError}
        >
          <ProviderCombobox
            value={provider}
            options={providerOptions}
            disabled={busy}
            ariaLabel={adapter === 'claude-code' ? 'Gateway' : 'Provider'}
            placeholder={adapter === 'claude-code' ? '留空使用 Claude 原生配置' : '留空跟随 config.toml'}
            emptyMessage={adapter === 'claude-code' ? '没有发现 Gateway profile' : '没有匹配项，可直接输入 provider'}
            onChange={onProviderChange}
          />
        </Field>
      )}
      {isGrok && (
        <Field label="思考程度（可留空）" error={thinkingError}>
          <DeckSelect
            value={thinking}
            onChange={onThinkingChange}
            disabled={busy}
            options={GROK_EFFORT_OPTIONS.map((value) => ({ value, label: value || 'inherit' }))}
            buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
          />
        </Field>
      )}
      {!isCodex && (
        <Field label="工具（逗号分隔，可留空）" error={toolsError}>
          <input
            type="text"
            value={tools}
            onChange={(event) => onToolsChange(event.target.value)}
            disabled={busy}
            placeholder="Read, Grep, Glob, Bash"
            className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
          />
        </Field>
      )}
    </>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-0.5 text-[11px]">
      <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">{label}</span>
      {children}
      {error && <span className="text-[10px] text-status-waiting/90">{error}</span>}
    </label>
  );
}
