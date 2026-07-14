import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, NumberInput, Toggle } from '../controls';
import {
  coerceThinkingForProvider,
  ProviderModelThinkingFields,
  type GeneratorProvider,
} from '../ProviderModelThinkingFields';
import { SummarizerErrorsDiagnostic } from '../SummarizerErrorsDiagnostic';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

function buildModelPlaceholder(provider: GeneratorProvider): string {
  if (provider === 'codex') return '留空使用 Codex 配置默认模型';
  if (provider === 'deepseek') return '留空使用 Deepseek Sonnet';
  return '留空使用 Claude Haiku';
}

function buildModelHint(provider: GeneratorProvider): string {
  if (provider === 'codex') {
    return '留空时使用 Codex 配置默认模型，思考程度默认 low。总结在只读、无网络、无 MCP 的临时环境中运行；Codex app-server 暂时无法验证模型内置工具是否为空。';
  }
  if (provider === 'deepseek') {
    return '模型留空时使用 Deepseek Sonnet，默认思考程度为 low。';
  }
  return '模型留空时使用 Claude Haiku，默认思考程度为 low。';
}

export function SummarySection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="间歇总结" storageKey="summary" defaultOpen={false}>
      <Toggle
        label="启用周期总结"
        value={settings.summaryEnabled}
        onChange={(enabled) => void update({ summaryEnabled: enabled })}
      />
      <p className="text-[10px] leading-snug text-deck-muted/70">
        关闭后不会启动新的总结模型调用。
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
      <ProviderModelThinkingFields
        label="总结模型"
        hint={buildModelHint(settings.summaryProvider)}
        provider={settings.summaryProvider}
        model={settings.summaryModel}
        thinking={settings.summaryReasoning}
        modelPlaceholder={buildModelPlaceholder(settings.summaryProvider)}
        onProviderChange={(v) =>
          void update({
            summaryProvider: v,
            summaryReasoning: coerceThinkingForProvider(v, settings.summaryReasoning),
          })
        }
        onModelChange={(v) => void update({ summaryModel: v })}
        onThinkingChange={(v) => void update({ summaryReasoning: v })}
      />
      <SummarizerErrorsDiagnostic />
    </Section>
  );
}
