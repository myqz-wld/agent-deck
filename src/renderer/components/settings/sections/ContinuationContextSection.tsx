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
        检查点生成器独立于续接目标 adapter；空模型分别使用 Claude Opus、Deepseek Sonnet 或 Codex 配置默认模型。
      </p>
      <ProviderModelThinkingFields
        label="续接检查点生成器"
        hint={
          provider === 'codex'
            ? '默认思考程度为 high。Codex compact 在空临时目录、只读沙盒、禁网、空 MCP 与禁用可执行功能的边界内运行；app-server 仍不能证明模型侧内建工具列表为空。Codex 支持 low、medium、high、xhigh、max、ultra。'
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
        label="原始历史保留上限（token）"
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
