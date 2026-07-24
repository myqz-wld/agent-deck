import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, NumberInput, Toggle } from '../controls';
import {
  coerceThinkingForAdapter,
  ProviderModelThinkingFields,
  type GeneratorAdapter,
} from '../ProviderModelThinkingFields';
import { SummarizerErrorsDiagnostic } from '../SummarizerErrorsDiagnostic';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

function buildModelHint(adapter: GeneratorAdapter, runtimeProvider: string): string {
  if (adapter === 'codex-cli') return '留空时使用所选 Codex provider 的默认模型';
  if (adapter === 'grok-build') return '留空时使用 Grok 配置默认模型';
  return runtimeProvider
    ? `留空时使用 ${runtimeProvider} Gateway 的 Haiku 路由`
    : '留空时使用 Claude Haiku';
}

export function SummarySection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="间歇总结" storageKey="summary" defaultOpen={false}>
      <p className="text-[10px] leading-snug text-deck-muted/70">
        用于会话卡片和「总结」视图，不用于会话接力或历史恢复。
      </p>
      <Toggle
        label="启用周期总结"
        value={settings.summaryEnabled}
        onChange={(enabled) => void update({ summaryEnabled: enabled })}
      />
      <p className="text-[10px] leading-snug text-deck-muted/70">
        关闭后不再生成新总结。
      </p>
      <NumberInput
        label="每隔多少分钟总结"
        value={Math.round(settings.summaryIntervalMs / 60000)}
        min={1}
        onChange={(v) => void update({ summaryIntervalMs: v * 60_000 })}
      />
      <NumberInput
        label="每多少个事件总结"
        value={settings.summaryEventCount}
        min={1}
        onChange={(v) => void update({ summaryEventCount: v })}
      />
      <NumberInput
        label="最多同时总结的会话数"
        value={settings.summaryMaxConcurrent}
        min={1}
        max={10}
        onChange={(v) => void update({ summaryMaxConcurrent: v })}
      />
      <p className="text-[10px] leading-snug text-deck-muted/60">
        限制后台总结模型的并发调用数。
      </p>
      <ProviderModelThinkingFields
        label="总结模型"
        hint={
          buildModelHint(
            settings.summaryAdapter,
            settings.summaryRuntimeProvider,
          ) + '。'
        }
        adapter={settings.summaryAdapter}
        runtimeProvider={settings.summaryRuntimeProvider}
        model={settings.summaryModel}
        thinking={settings.summaryThinking}
        modelPlaceholder="模型（可留空）"
        onAdapterChange={(v) =>
          void update({
            summaryAdapter: v,
            summaryRuntimeProvider: '',
            summaryModel: '',
            summaryThinking: coerceThinkingForAdapter(v, settings.summaryThinking),
          })
        }
        onRuntimeProviderChange={(v) =>
          void update({ summaryRuntimeProvider: v, summaryModel: '' })
        }
        onModelChange={(v) => void update({ summaryModel: v })}
        onThinkingChange={(v) => void update({ summaryThinking: v })}
      />
      <SummarizerErrorsDiagnostic />
    </Section>
  );
}
