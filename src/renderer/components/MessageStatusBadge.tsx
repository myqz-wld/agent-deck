import type { JSX } from 'react';
import type { AgentDeckMessage } from '@shared/types';
import {
  BanIcon,
  CircleCheckIcon,
  CircleCloseIcon,
  ClockIcon,
  SendIcon,
} from './icons';

export function MessageStatusBadge({ status }: { status: AgentDeckMessage['status'] }): JSX.Element {
  const iconClass = 'h-3 w-3';
  const toneClass = status === 'failed'
    ? 'text-status-error'
    : status === 'delivered' || status === 'delivering'
      ? 'text-status-working'
      : status === 'pending'
        ? 'text-status-waiting'
        : 'text-deck-muted';
  const content = status === 'pending'
    ? { icon: <ClockIcon className={iconClass} />, label: '待发送' }
    : status === 'delivering'
      ? { icon: <SendIcon className={iconClass} />, label: '发送中' }
      : status === 'delivered'
        ? { icon: <CircleCheckIcon className={iconClass} />, label: '已送达' }
        : status === 'failed'
          ? { icon: <CircleCloseIcon className={iconClass} />, label: '失败' }
          : status === 'cancelled'
            ? { icon: <BanIcon className={iconClass} />, label: '已取消' }
            : { icon: null, label: status };
  return <span className={`inline-flex items-center gap-0.5 ${toneClass}`}>{content.icon}{content.label}</span>;
}
