import { useEffect, useRef, useState, type JSX } from 'react';
import type { AppSettings } from '@shared/types';
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
 * 文案，与通用 controls 抽离没好处（YAGNI）。如果未来其他 settings 字段也需要 free-form
 * string input，再迁到 controls.tsx 抽 TextInput / FreeFormStringInput helper。
 */
function ModelInput({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
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
    <div className="flex flex-col gap-1 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="flex-1">{label}</span>
        <input
          type="text"
          value={draft}
          placeholder="（沿用 env / alias）"
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
          className="no-drag w-44 rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-[11px] outline-none focus:border-white/20"
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
      <ModelInput
        label="claude 周期性总结模型"
        hint="留空 = 沿用 ANTHROPIC_DEFAULT_HAIKU_MODEL → ANTHROPIC_MODEL → 'haiku' alias 兜底。仅对 claude-code session 生效；codex session 走下方 codex 字段。"
        value={settings.summaryModel}
        onChange={(v) => void update({ summaryModel: v })}
      />
      <ModelInput
        label="claude hand-off 简报模型"
        hint="留空 = 沿用 ANTHROPIC_DEFAULT_SONNET_MODEL → ANTHROPIC_MODEL → 'sonnet' alias 兜底。仅对 claude-code session 生效；codex session 走下方 codex 字段。"
        value={settings.handOffModel}
        onChange={(v) => void update({ handOffModel: v })}
      />
      <ModelInput
        label="codex 周期性总结模型"
        hint="留空 = 沿用 CODEX_SUMMARY_MODEL env → ~/.codex/config.toml 顶层 model 兜底。仅对 codex-cli session 生效；典型对标 claude haiku 用轻量 model (codex CLI 支持的具体 model id 由 user 确认)。"
        value={settings.codexSummaryModel}
        onChange={(v) => void update({ codexSummaryModel: v })}
      />
      <ModelInput
        label="codex hand-off 简报模型"
        hint="留空 = 沿用 CODEX_HANDOFF_MODEL env → ~/.codex/config.toml 顶层 model 兜底。仅对 codex-cli session 生效；典型对标 claude sonnet 用 mid model。"
        value={settings.codexHandOffModel}
        onChange={(v) => void update({ codexHandOffModel: v })}
      />
      <SummarizerErrorsDiagnostic />
    </Section>
  );
}
