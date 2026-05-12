/**
 * plan team-cohesion-fix-20260513 Phase C：TeamDetail 子组件共用纯函数。
 * 全部 module-level，无 React state，便于子组件 import。
 */
import type { AgentDeckMessage } from '@shared/types';

/** message status → emoji + 文字标签（与原 inline 实现一致）。 */
export function statusBadge(status: AgentDeckMessage['status']): string {
  switch (status) {
    case 'pending':
      return '⏳ pending';
    case 'delivering':
      return '📤 delivering';
    case 'delivered':
      return '✅ delivered';
    case 'failed':
      return '❌ failed';
    case 'cancelled':
      return '⊘ cancelled';
    default:
      return status;
  }
}

/** 折叠过长 cwd / 路径：>4 段时只保留最后 3 段。 */
export function shortenPath(p: string | null | undefined): string {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 4) return p;
  return '…/' + parts.slice(-3).join('/');
}

/** 时间戳 → 相对时间（如「3min ago」/ 「just now」），用于 events / messages 列表显示。 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const dt = Math.max(0, now - ts);
  if (dt < 5_000) return 'just now';
  if (dt < 60_000) return `${Math.floor(dt / 1_000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}min ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}
