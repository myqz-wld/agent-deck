import type { JSX } from 'react';
import type { SessionRecord } from '@shared/types';

interface Props {
  session: Pick<SessionRecord, 'agentId' | 'contextUsage'>;
}

export function SessionContextUsageChip({ session }: Props): JSX.Element {
  const display = contextUsageDisplay(session);
  return (
    <span
      aria-label="上下文窗口用量"
      className={`whitespace-nowrap rounded bg-white/[0.04] px-1.5 py-0.5 text-[9px] tabular-nums ${display.className}`}
      title={display.title}
    >
      {display.label}
    </span>
  );
}

export function SessionContextUnavailableChip({ reason }: { reason: string }): JSX.Element {
  return (
    <span
      aria-label="上下文窗口用量"
      className="whitespace-nowrap rounded bg-white/[0.04] px-1.5 py-0.5 text-[9px] text-deck-muted/65"
      title={reason}
    >
      上下文 暂无远端快照
    </span>
  );
}

function contextUsageDisplay(
  session: Pick<SessionRecord, 'agentId' | 'contextUsage'>,
): {
  label: string;
  title: string;
  className: string;
} {
  const usage = session.contextUsage;
  if (!usage) {
    return {
      label: '上下文 暂无数据',
      title: 'Provider 尚未报告当前上下文用量和窗口大小',
      className: 'text-deck-muted/65',
    };
  }
  // Persisted provider/model selections may be delegated defaults or aliases, so the renderer
  // must not second-guess the native concrete model. Main atomically clears this snapshot when
  // those selections change; this final boundary rejects unattributed or cross-adapter snapshots.
  if (!usage.runtimeIdentity || usage.runtimeIdentity.adapter !== session.agentId) {
    return {
      label: '上下文 旧快照',
      title: usage.runtimeIdentity
        ? '上下文快照属于其他 adapter，未显示可能过期的 token 用量'
        : 'Provider 快照缺少可验证的 runtime identity，未显示可能过期的 token 用量',
      className: 'text-amber-300/80',
    };
  }
  const { usedTokens, windowTokens } = usage;
  if (usedTokens === null) {
    return {
      label: `上下文 更新中 / ${windowTokens === null ? '未知' : compactTokens(windowTokens)}`,
      title:
        windowTokens === null
          ? '上下文已压缩，正在等待 Provider 返回新的用量和窗口快照'
          : `上下文已压缩，正在等待新的用量快照；窗口大小 ${exactTokens(windowTokens)} token`,
      className: 'text-amber-300/90',
    };
  }
  if (windowTokens === null) {
    return {
      label: `上下文 ${compactTokens(usedTokens)} / 未知`,
      title: `当前上下文已用 ${exactTokens(usedTokens)} token；Provider 尚未报告窗口大小`,
      className: 'text-deck-muted/80',
    };
  }
  const percent = (usedTokens / windowTokens) * 100;
  return {
    label: `上下文 ${compactTokens(usedTokens)} / ${compactTokens(windowTokens)} · ${formatPercent(percent)}`,
    title:
      `当前上下文已用 ${exactTokens(usedTokens)} token / ` +
      `${exactTokens(windowTokens)} token（${formatPercent(percent)}）`,
    className:
      percent >= 100
        ? 'text-red-300'
        : percent >= 80
          ? 'text-amber-300'
          : 'text-deck-muted/80',
  };
}

function compactTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${compactNumber(value / 1_000)}K`;
  return `${compactNumber(value / 1_000_000)}M`;
}

function compactNumber(value: number): string {
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
}

function exactTokens(value: number): string {
  return value.toLocaleString('zh-CN');
}

function formatPercent(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, '')}%`;
}
