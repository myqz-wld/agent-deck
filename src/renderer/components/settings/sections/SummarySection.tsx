import { useEffect, useRef, useState, type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import {
  CLAUDE_THINKING_LEVELS,
  CODEX_THINKING_LEVELS,
  isClaudeThinkingLevel,
  type SessionThinkingLevel,
} from '@shared/session-metadata';
import { DeckSelect, type DeckSelectOption } from '@renderer/components/DeckSelect';
import { Section, NumberInput } from '../controls';
import { SummarizerErrorsDiagnostic } from '../SummarizerErrorsDiagnostic';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

/**
 * plan model-wiring-and-handoff-20260514 Step 4.5：本地 ModelInput 控件（与 NumberInput
 * 同套 draft / focus / blur 提交模式，避免输入时每字符触发 IPC）。
 *
 * 抽到本文件 local 而非 controls.tsx：本控件目前仅 SummarySection 用 + 字段语义带强 hint
 * 文案，与通用 controls 抽离没好处（YAGNI）。其他 settings 字段需要 free-form string input
 * 时，再迁到 controls.tsx 抽 TextInput / FreeFormStringInput helper。
 */
function ModelInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<string>(value);
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    if (editingRef.current) return;
    setDraft(value);
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
      value={draft}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
          e.currentTarget.blur();
        }
      }}
      className="no-drag min-w-0 flex-1 rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-[11px] outline-none focus:border-white/20"
    />
  );
}

type Provider = AppSettings['summaryProvider'];
type Reasoning = SessionThinkingLevel;
type ModelPurpose = 'summary' | 'handoff';

const PROVIDER_OPTIONS: { value: Provider; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'deepseek', label: 'Deepseek' },
  { value: 'codex', label: 'Codex' },
];

function buildReasoningOptions(
  levels: readonly Reasoning[],
): readonly DeckSelectOption<Reasoning>[] {
  return levels.map((value) => ({ value, label: value.toUpperCase() }));
}

const CLAUDE_REASONING_OPTIONS = buildReasoningOptions(CLAUDE_THINKING_LEVELS);
const CODEX_REASONING_OPTIONS = buildReasoningOptions(CODEX_THINKING_LEVELS);

function reasoningOptionsForProvider(
  provider: Provider,
): readonly DeckSelectOption<Reasoning>[] {
  return provider === 'codex' ? CODEX_REASONING_OPTIONS : CLAUDE_REASONING_OPTIONS;
}

function coerceReasoningForProvider(provider: Provider, reasoning: Reasoning): Reasoning {
  if (provider === 'codex' || isClaudeThinkingLevel(reasoning)) return reasoning;
  return reasoning === 'ultra' ? 'max' : 'low';
}

function providerLabel(provider: Provider): string {
  return PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider;
}

function buildModelPlaceholder(purpose: ModelPurpose, provider: Provider): string {
  if (provider === 'codex') return '留空使用 Codex 配置默认模型';
  if (provider === 'deepseek') {
    return purpose === 'summary' ? '留空使用 Deepseek Haiku' : '留空使用 Deepseek Sonnet';
  }
  return purpose === 'summary' ? '留空使用 Claude Haiku' : '留空使用 Claude Sonnet';
}

function buildModelHint(purpose: ModelPurpose, provider: Provider): string {
  if (provider === 'codex') return '模型留空时使用 Codex 配置里的默认模型。';
  if (provider === 'deepseek') {
    return purpose === 'summary'
      ? '模型留空时使用 Deepseek Haiku 默认模型。'
      : '模型留空时使用 Deepseek Sonnet 默认模型。';
  }
  return purpose === 'summary'
    ? '模型留空时使用 Claude Haiku。'
    : '模型留空时使用 Claude Sonnet。';
}

/**
 * plan prancy-forging-penguin: provider × model × reasoning 三联控件。
 *
 * 布局(3 行,follow-up CHANGELOG_162 重排):SettingsDialog 容器 340px - p-4 = 308px,
 * 单行塞 label + 3 控件 + 3 gap 会把 input 压成 0 宽(CHANGELOG_161 follow-up 已经修过一次
 * 让 reasoning select 不被推出容器,代价是 input 完全没空间)。重排成:
 *   1. label 单独一行
 *   2. provider select + model input(flex-1) + reasoning select 全宽一行(input 拿 ~140px 够显示 "claude-sonnet-4-6")
 *   3. hint 单独一行
 *
 * - Provider select: claude / deepseek / codex,决定走哪个 LLM provider
 * - Model input: free-form model id,空 = 沿用 provider 各自 env / alias / config.toml 兜底
 * - Reasoning select: 按 provider 展示对应 SDK 支持的思考程度。Codex 支持
 *   minimal..ultra；Claude-family providers 支持 low..max。
 */
function ModelRow({
  label,
  hint,
  provider,
  model,
  reasoning,
  modelPlaceholder,
  onProviderChange,
  onModelChange,
  onReasoningChange,
}: {
  label: string;
  hint: string;
  provider: Provider;
  model: string;
  reasoning: Reasoning;
  modelPlaceholder: string;
  onProviderChange: (v: Provider) => void;
  onModelChange: (v: string) => void;
  onReasoningChange: (v: Reasoning) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <div>{label}</div>
      <div className="flex items-center gap-2">
        <DeckSelect
          value={provider}
          onChange={onProviderChange}
          options={PROVIDER_OPTIONS}
          className="shrink-0"
          buttonClassName="rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
          menuMinWidth={140}
        />
        <ModelInput value={model} placeholder={modelPlaceholder} onChange={onModelChange} />
        <DeckSelect
          value={reasoning}
          onChange={onReasoningChange}
          title={`${providerLabel(provider)} 思考程度`}
          options={reasoningOptionsForProvider(provider)}
          className="w-20 shrink-0"
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
          menuMinWidth={120}
        />
      </div>
      <div className="text-[10px] text-deck-muted/60 leading-snug">{hint}</div>
    </div>
  );
}

export function SummarySection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="间歇总结" storageKey="summary" defaultOpen={false}>
      <NumberInput
        label="时间触发（分钟）"
        value={Math.round(settings.summaryIntervalMs / 60000)}
        min={1}
        onChange={(v) => void update({ summaryIntervalMs: v * 60_000 })}
      />
      <NumberInput
        label="事件数触发"
        value={settings.summaryEventCount}
        min={1}
        onChange={(v) => void update({ summaryEventCount: v })}
      />
      <NumberInput
        label="同时跑总结上限"
        value={settings.summaryMaxConcurrent}
        min={1}
        max={10}
        onChange={(v) => void update({ summaryMaxConcurrent: v })}
      />
      <ModelRow
        label="周期性总结"
        hint={buildModelHint('summary', settings.summaryProvider)}
        provider={settings.summaryProvider}
        model={settings.summaryModel}
        reasoning={settings.summaryReasoning}
        modelPlaceholder={buildModelPlaceholder('summary', settings.summaryProvider)}
        onProviderChange={(v) =>
          void update({
            summaryProvider: v,
            summaryReasoning: coerceReasoningForProvider(v, settings.summaryReasoning),
          })
        }
        onModelChange={(v) => void update({ summaryModel: v })}
        onReasoningChange={(v) => void update({ summaryReasoning: v })}
      />
      <ModelRow
        label="Hand-off 简报"
        hint={buildModelHint('handoff', settings.handOffProvider)}
        provider={settings.handOffProvider}
        model={settings.handOffModel}
        reasoning={settings.handOffReasoning}
        modelPlaceholder={buildModelPlaceholder('handoff', settings.handOffProvider)}
        onProviderChange={(v) =>
          void update({
            handOffProvider: v,
            handOffReasoning: coerceReasoningForProvider(v, settings.handOffReasoning),
          })
        }
        onModelChange={(v) => void update({ handOffModel: v })}
        onReasoningChange={(v) => void update({ handOffReasoning: v })}
      />
      <SummarizerErrorsDiagnostic />
    </Section>
  );
}
