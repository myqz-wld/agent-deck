import type { JSX } from 'react';
import type { SessionContextUsage } from '@shared/types';

interface Props {
  usage: SessionContextUsage | null | undefined;
}

export function SessionContextUsageChip({ usage }: Props): JSX.Element {
  const display = contextUsageDisplay(usage);
  return (
    <span
      aria-label="上下文窗口用量"
      className={`rounded bg-white/[0.04] px-1.5 py-0.5 text-[9px] tabular-nums ${display.className}`}
      title={display.title}
    >
      {display.label}
    </span>
  );
}

function contextUsageDisplay(usage: SessionContextUsage | null | undefined): {
  label: string;
  title: string;
  className: string;
} {
  if (!usage) {
    return {
      label: '上下文 暂无数据',
      title: 'Provider 尚未报告当前上下文用量和窗口大小',
      className: 'text-deck-muted/65',
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
