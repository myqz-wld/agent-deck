import type { JSX } from 'react';
import type { SessionRecord } from '@shared/types';
import {
  CLAUDE_DEFAULT_BUCKET,
  CODEX_DEFAULT_BUCKET,
  normalizeModel,
} from '@shared/model-normalize';

interface Props {
  session: SessionRecord;
  branch?: string | null;
  compact?: boolean;
}

export function SessionMetadataChips({ session, branch, compact = false }: Props): JSX.Element {
  return (
    <RuntimeMetadataChips
      adapterId={session.agentId}
      runtimeProvider={session.runtimeProvider}
      model={session.model}
      thinking={session.thinking}
      branch={branch}
      compact={compact}
    />
  );
}

export function RuntimeMetadataChips({
  adapterId,
  runtimeProvider,
  model,
  thinking,
  branch,
  compact = false,
}: {
  adapterId?: string;
  runtimeProvider?: string | null;
  model: string | null | undefined;
  thinking: string | null | undefined;
  branch?: string | null;
  compact?: boolean;
}): JSX.Element {
  const modelLabel = formatModelLabel(model);
  const thinkingLabel = thinking ?? '默认';
  const chipClass = compact
    ? 'rounded bg-white/[0.04] px-1.5 py-0.5 text-[9px] text-deck-muted/80'
    : 'rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-deck-muted/85';

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {runtimeProvider && (
        <span className={chipClass} title={runtimeProvider}>
          {adapterId === 'claude-code' ? 'Gateway' : 'Provider'} {runtimeProvider}
        </span>
      )}
      <span className={chipClass} title={model ?? '使用适配器 / 用户配置默认模型'}>
        模型 {modelLabel}
      </span>
      <span className={chipClass} title={thinking ?? '使用适配器 / 用户配置默认思考程度'}>
        思考 {thinkingLabel}
      </span>
      {branch && (
        <span className={`${chipClass} max-w-[14rem] truncate font-mono`} title={branch}>
          分支 {branch}
        </span>
      )}
    </div>
  );
}

function formatModelLabel(model: string | null | undefined): string {
  const raw = model?.trim();
  if (!raw) return '默认';
  const normalized = normalizeModel(raw);
  if (
    normalized.bucketKey === CODEX_DEFAULT_BUCKET ||
    normalized.bucketKey === CLAUDE_DEFAULT_BUCKET
  ) {
    return '默认';
  }
  return normalized.displayName;
}
