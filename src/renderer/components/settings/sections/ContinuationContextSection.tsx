import { type JSX } from 'react';
import {
  MAX_CONTINUATION_RAW_RETENTION_TOKENS,
  MIN_CONTINUATION_RAW_RETENTION_TOKENS,
  type AppSettings,
  type ContinuationCheckpointProvider,
} from '@shared/types';
import {
  MAX_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES,
  MIN_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES,
} from '@shared/types/settings/defaults';
import { NumberInput, Section, Toggle } from '../controls';
import {
  coerceThinkingForProvider,
  ProviderModelThinkingFields,
} from '../ProviderModelThinkingFields';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

function modelHint(provider: ContinuationCheckpointProvider): string {
  if (provider === 'claude') return '留空时使用 Claude Sonnet';
  if (provider === 'deepseek') return '留空时使用 Deepseek Sonnet';
  return '留空时使用 Codex 配置默认模型';
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
        用于接力到新会话，以及原生会话历史缺失时的恢复。
      </p>
      <Toggle
        label="自动维护续接检查点"
        value={settings.continuationCheckpointAutoRefreshEnabled}
        onChange={(enabled) =>
          void update({ continuationCheckpointAutoRefreshEnabled: enabled })
        }
      />
      <NumberInput
        label="常规检查间隔（分钟）"
        value={settings.continuationCheckpointAutoRefreshIntervalMinutes}
        min={MIN_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES}
        max={MAX_CONTINUATION_CHECKPOINT_AUTO_REFRESH_INTERVAL_MINUTES}
        onChange={(minutes) =>
          void update({ continuationCheckpointAutoRefreshIntervalMinutes: minutes })
        }
      />
      <p className="text-[10px] leading-snug text-deck-muted/70">
        达到检查间隔、新增 32,000 token 且会话空闲时刷新；积压到 48,000 token
        时直接排队，仍不会中断当前回复。
      </p>
      <ProviderModelThinkingFields
        label="上下文整理模型"
        hint={modelHint(provider) + '。'}
        provider={provider}
        model={settings.continuationCheckpointModel}
        thinking={settings.continuationCheckpointThinking}
        modelPlaceholder="模型（可留空）"
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
        仅限制续接上下文中的最近用户输入，不包含检查点、当前指令和回复预留。
      </p>
    </Section>
  );
}
