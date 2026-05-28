import type { JSX } from 'react';
import type { AgentDeckTeamMember } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { Section, EmptyState } from './Header';

/**
 * plan team-cohesion-fix-20260513 Phase C：team 内 pending 聚合 section（与 PendingTab 同源）。
 *
 * 数据**不**走 IPC（避免与 PendingTab 数据源不一致 + 重复 SQL），直接从 store 的
 * `pendingPermissionsBySession` / `pendingAskQuestionsBySession` / `pendingExitPlanModesBySession`
 * 三个 Map ∩ team 成员 sessionIds 聚合。
 *
 * 展示：每个有 pending 的成员一行，标 总数 + 三类数量分布；点击跳转 SessionDetail（也可
 * 跳 PendingTab，但跳 SessionDetail 更直接给用户上下文）。无 pending 时显空 state（隐藏
 * 整个 section 也合理，但保留 empty state 让用户感知「检查过了，无待办」）。
 *
 * Phase D 已在 PendingTab 加 team chip + role badge，本 section 是反向视角：从 team 视角
 * 看哪些成员有 pending。两边互补。
 */
interface Props {
  members: AgentDeckTeamMember[];
  onOpenSession: (sessionId: string) => void;
}

export function PendingSection({ members, onOpenSession }: Props): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const pendingPerms = useSessionStore((s) => s.pendingPermissionsBySession);
  const pendingAsks = useSessionStore((s) => s.pendingAskQuestionsBySession);
  const pendingExits = useSessionStore((s) => s.pendingExitPlanModesBySession);

  const memberSidSet = new Set(members.filter((m) => m.leftAt === null).map((m) => m.sessionId));

  // 聚合：每个成员的 pending counts
  const rows = Array.from(memberSidSet)
    .map((sid) => ({
      sid,
      perms: pendingPerms.get(sid)?.length ?? 0,
      asks: pendingAsks.get(sid)?.length ?? 0,
      exits: pendingExits.get(sid)?.length ?? 0,
    }))
    .filter((r) => r.perms + r.asks + r.exits > 0)
    .sort((a, b) => b.perms + b.asks + b.exits - (a.perms + a.asks + a.exits));

  const totalPending = rows.reduce((sum, r) => sum + r.perms + r.asks + r.exits, 0);

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
          const sess = sessions.get(r.sid);
          const label = sess?.title ?? r.sid.slice(0, 8);
          const total = r.perms + r.asks + r.exits;
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
                {r.perms > 0 && <span className="mr-1.5">🛡 {r.perms}</span>}
                {r.asks > 0 && <span className="mr-1.5">❓ {r.asks}</span>}
                {r.exits > 0 && <span>📋 {r.exits}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
