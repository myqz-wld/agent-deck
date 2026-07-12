import { type JSX } from 'react';
import {
  MAX_CONTINUATION_RAW_RETENTION_TOKENS,
  MIN_CONTINUATION_RAW_RETENTION_TOKENS,
  type AppSettings,
  type ContinuationCheckpointProvider,
} from '@shared/types';
import { NumberInput, Section } from '../controls';
import {
  coerceThinkingForProvider,
  ProviderModelThinkingFields,
} from '../ProviderModelThinkingFields';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

function modelPlaceholder(provider: ContinuationCheckpointProvider): string {
  if (provider === 'claude') return '留空使用 Claude Opus';
  if (provider === 'deepseek') return '留空使用 Deepseek Sonnet';
  return '留空使用 Codex 配置默认模型';
}

export function ContinuationContextSection({ settings, update }: Props): JSX.Element {
  const provider = settings.continuationCheckpointProvider;

  return (
    <Section
      title="会话续接上下文"
      storageKey="continuation-context"
      defaultOpen={false}
    >
      <p className="text-[10px] leading-snug text-deck-muted/70">
        选择用于整理接力上下文的 provider 和模型；它可以不同于目标会话。模型留空时使用各 provider 的默认值。
      </p>
      <ProviderModelThinkingFields
        label="上下文整理模型"
        hint={
          provider === 'codex'
            ? '思考程度默认 high。在只读、无网络、无 MCP 的临时环境中运行；Codex app-server 暂时无法验证模型内置工具是否为空。可选 low、medium、high、xhigh、max、ultra。'
            : '默认思考程度为 high。Claude 与 Deepseek 支持 low 至 max。'
        }
        provider={provider}
        model={settings.continuationCheckpointModel}
        thinking={settings.continuationCheckpointThinking}
        modelPlaceholder={modelPlaceholder(provider)}
        onProviderChange={(nextProvider) =>
          void update({
            continuationCheckpointProvider: nextProvider,
            continuationCheckpointThinking: coerceThinkingForProvider(
              nextProvider,
              settings.continuationCheckpointThinking,
            ),
          })
        }
        onModelChange={(model) => void update({ continuationCheckpointModel: model })}
        onThinkingChange={(thinking) =>
          void update({ continuationCheckpointThinking: thinking })
        }
      />
      <NumberInput
        label="保留最近对话的 token 上限"
        value={settings.continuationRawRetentionTokens}
        min={MIN_CONTINUATION_RAW_RETENTION_TOKENS}
        max={MAX_CONTINUATION_RAW_RETENTION_TOKENS}
        onChange={(tokens) => void update({ continuationRawRetentionTokens: tokens })}
      />
      <p className="text-[10px] leading-snug text-deck-muted/60">
        按 token 计算，可设置 8,000–128,000；默认 64,000。
      </p>
    </Section>
  );
}
