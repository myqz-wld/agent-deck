import type { JSX } from 'react';

import type { RemoteSessionSourceView } from './source-types';

export type RemotePageSurface =
  | 'data'
  | 'history'
  | 'issues'
  | 'live'
  | 'pending'
  | 'teams';
export type RemotePageAvailabilityKind =
  | 'available'
  | 'connecting'
  | 'offline'
  | 'unknown'
  | 'unsupported';

export interface RemotePageAvailability {
  kind: RemotePageAvailabilityKind;
  title: string;
  detail: string;
  error: string | null;
}

const PAGE_REQUIREMENTS: Record<
  RemotePageSurface,
  { label: string; capabilities: readonly string[] }
> = {
  data: { label: '数据与用量', capabilities: ['usage'] },
  history: {
    label: '历史会话',
    capabilities: ['session-console.read', 'sessions.history'],
  },
  issues: { label: '问题', capabilities: ['issues'] },
  live: { label: '会话列表', capabilities: ['session-console.read'] },
  pending: {
    label: '待处理',
    capabilities: ['pending.index.read'],
  },
  teams: { label: '团队', capabilities: ['teams'] },
};

export function remotePageAvailability(
  source: Pick<
    RemoteSessionSourceView,
    'capabilities' | 'profile' | 'state' | 'usable'
  >,
  surface: RemotePageSurface,
): RemotePageAvailability {
  const requirement = PAGE_REQUIREMENTS[surface];
  const { label } = requirement;
  const status = source.state?.status ?? null;
  if (status === 'connecting' || status === 'reconnecting') {
    return {
      kind: 'connecting',
      title: status === 'connecting' ? '正在连接 Remote Core' : '正在重新连接 Remote Core',
      detail: `${label}将在连接完成后可用；连接期间不会发起远程业务请求，也不会回退读取 Local 数据。`,
      error: null,
    };
  }
  if (
    !source.usable ||
    source.profile?.scope !== 'remote' ||
    status !== 'connected'
  ) {
    return {
      kind: 'offline',
      title: status === 'incompatible'
        ? 'Remote 协议不兼容'
        : source.profile
          ? 'Remote Core 当前不可用'
          : '尚未选择 Remote 连接',
      detail: `${label}当前不可用；不会回退读取 Local 数据。`,
      error: source.state?.error?.message ?? null,
    };
  }
  if (requirement.capabilities.some((capability) => !source.capabilities.has(capability))) {
    return {
      kind: 'unsupported',
      title: `当前 Remote Core 未提供${label}能力`,
      detail: '不会回退读取 Local 数据；请升级远端部署或切换至支持该能力的连接。',
      error: null,
    };
  }
  return {
    kind: 'available',
    title: '',
    detail: '',
    error: null,
  };
}

export function unknownSourceAvailability(error: string | null): RemotePageAvailability {
  return {
    kind: 'unknown',
    title: error ? '无法确认数据源' : '正在确认数据源',
    detail: error
      ? '数据源状态读取失败；已停止 Local 与 Remote 业务读取，请稍后重试。'
      : '确认完成前不会读取 Local 或 Remote 业务数据。',
    error,
  };
}

export function RemotePageUnavailable({
  availability,
  onRetry,
}: {
  availability: Exclude<RemotePageAvailability, { kind: 'available' }>;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div
      data-testid="remote-page-unavailable"
      className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center"
    >
      <div className="text-[12px] text-deck-text">{availability.title}</div>
      <div className="max-w-md text-[10px] leading-relaxed text-deck-muted">
        {availability.detail}
      </div>
      {availability.error && (
        <div className="max-w-md break-words text-[10px] leading-relaxed text-status-waiting/90">
          {availability.error}
        </div>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="no-drag mt-1 rounded border border-white/10 px-2 py-1 text-[10px] text-deck-muted hover:bg-white/[0.05] hover:text-deck-text"
        >
          重新读取数据源
        </button>
      )}
    </div>
  );
}
