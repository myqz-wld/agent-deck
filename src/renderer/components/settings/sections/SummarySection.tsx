import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, NumberInput } from '../controls';
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
  if (provider === 'deepseek') return '留空使用 Deepseek Haiku';
  return '留空使用 Claude Haiku';
}

function buildModelHint(provider: GeneratorProvider): string {
  if (provider === 'codex') {
    return 'Codex 空模型使用 Codex 配置默认模型，默认思考程度为 medium。总结在空临时目录、只读沙盒、禁网、空 MCP 与禁用可执行功能的边界内运行；当前 app-server 仍不能证明模型侧内建工具列表为空。';
  }
  if (provider === 'deepseek') {
    return '模型留空时使用 Deepseek Haiku，默认思考程度为 medium。';
  }
  return '模型留空时使用 Claude Haiku，默认思考程度为 medium。';
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
      <ProviderModelThinkingFields
        label="周期性总结"
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
