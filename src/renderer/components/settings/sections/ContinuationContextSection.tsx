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

function modelPlaceholder(provider: ContinuationCheckpointProvider): string {
  if (provider === 'claude') return '留空使用 Claude Sonnet';
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
        常规刷新需达到上方间隔、新增至少 32,000 token，并等待 provider 空闲且会话安静 60
        秒；新增达到 48,000 token 时会后台安全刷新，不等待空闲，也不会中断当前回复。达到阈值只负责排队，
        真正开始时会原子捕获最新持久化 revision，排队期间完成的工具结果会合并进本次检查点。
      </p>
      <ProviderModelThinkingFields
        label="上下文整理模型"
        hint={
          provider === 'codex'
            ? '思考程度默认 medium。在只读、无网络、无 MCP 的临时环境中运行；Codex app-server 暂时无法验证模型内置工具是否为空。可选 low、medium、high、xhigh、max、ultra。'
            : '模型留空时使用 Sonnet，默认思考程度为 medium。Claude 与 Deepseek 支持 low 至 max。'
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
        generator 输入默认 96,000 token；已知模型窗口时取 min(128,000, 窗口 − 32,000)，完整
        prompt 另有 512 KiB 上限。canonical checkpoint 约 20,000 token 开始精简，硬上限
        24,000。
      </p>
      <p className="text-[10px] leading-snug text-deck-muted/60">
        目标窗口未知时按 128,000 token；先预留系统/项目指令 16,000 和回复 8,000，再扣固定包装与当前指令。
        checkpoint 获得剩余历史的 20%（2,000–12,000），最近 user input 使用余量且受上方上限约束。
      </p>
    </Section>
  );
}
