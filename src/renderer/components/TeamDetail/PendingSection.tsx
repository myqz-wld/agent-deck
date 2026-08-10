import type { JSX } from 'react';
import type {
  TeamMemberDto,
  TeamPendingCountsDto,
  TeamSessionDto,
} from '@contracts/index';
import { Section, EmptyState } from './Header';
import { ShieldIcon } from '../icons';

/**
 * plan team-cohesion-fix-20260513 Phase C：team 内 pending 聚合 section（与 PendingTab 同源）。
 *
 * Local 由共享 adapter 从 PendingTab 同款 selector 产生计数；Remote 由 Core 对每个 active
 * member 读取 `pending.list` 后投影。组件只保留 active member、非零计数，并按 session 最近
 * 活动排序，因此两个来源共享同一展示语义且不会读取另一来源的 store。
 *
 * 展示：每个有 pending 的成员一行，标 总数 + 三类数量分布；点击跳转 SessionDetail（也可
 * 跳 PendingTab，但跳 SessionDetail 更直接给用户上下文）。无 pending 时显空 state（隐藏
 * 整个 section 也合理，但保留 empty state 让用户感知「检查过了，无待办」）。
 *
 * Phase D 已在 PendingTab 加 team chip + role badge，本 section 是反向视角：从 team 视角
 * 看哪些成员有 pending。两边互补。
 */
interface Props {
  members: TeamMemberDto[];
  pending: TeamPendingCountsDto[];
  sessions: ReadonlyMap<string, TeamSessionDto>;
  onOpenSession: (sessionId: string) => void;
}

export function PendingSection({ members, pending, sessions, onOpenSession }: Props): JSX.Element {
  const active = new Set(
    members.filter((member) => member.leftAt === null).map((member) => member.sessionId),
  );
  const rows = pending
    .filter((counts) => active.has(counts.sessionId) && counts.total > 0)
    .map((counts) => ({
      sid: counts.sessionId,
      label: sessions.get(counts.sessionId)?.title || counts.sessionId.slice(0, 8),
      perms: counts.permissions,
      asks: counts.questions,
      exits: counts.plans,
      diffs: counts.diffs,
      total: counts.total,
    }))
    .sort((left, right) => {
      const recency = (sessions.get(right.sid)?.lastEventAt ?? 0) -
        (sessions.get(left.sid)?.lastEventAt ?? 0);
      return recency || left.sid.localeCompare(right.sid);
    });

  const totalPending = rows.reduce((sum, r) => sum + r.total, 0);

  if (rows.length === 0) {
    return (
      <Section title="待处理" count={0}>
        <EmptyState>团队内所有成员都没有等待响应的请求</EmptyState>
      </Section>
    );
  }

  return (
    <Section title="待处理" count={totalPending}>
      <ul className="flex flex-col gap-1">
        {rows.map((r) => {
          const label = r.label;
          const total = r.total;
          return (
            <li
              key={r.sid}
              className="flex items-center justify-between rounded border border-status-waiting/30 bg-status-waiting/5 px-2 py-1 text-[11px] hover:bg-status-waiting/10 cursor-pointer"
              onClick={() => onOpenSession(r.sid)}
              title={`打开 ${label} 处理 ${total} 项待办`}
            >
              <span className="truncate">
                <strong className="text-deck-text">{label}</strong>{' '}
                <span className="ml-1 rounded bg-status-waiting/30 px-1.5 py-0.5 text-[9px] font-medium text-status-waiting">
                  {total}
                </span>
              </span>
              <span className="ml-2 shrink-0 text-[9px] text-deck-muted">
                {r.perms > 0 && (
                  <span className="mr-1.5">
                    <span className="sr-only">权限请求 </span>
                    <ShieldIcon className="mr-0.5 inline h-3 w-3" />{r.perms}
                  </span>
                )}
                {r.asks > 0 && (
                  <span className="mr-1.5">
                    <span className="sr-only">提问 </span>
                    <span aria-hidden="true">❓ </span>{r.asks}
                  </span>
                )}
                {r.exits > 0 && (
                  <span className="mr-1.5">
                    <span className="sr-only">计划确认 </span>
                    <span aria-hidden="true">📋 </span>{r.exits}
                  </span>
                )}
                {r.diffs > 0 && (
                  <span>
                    <span className="sr-only">差异确认 </span>
                    <span aria-hidden="true">🧩 </span>{r.diffs}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
