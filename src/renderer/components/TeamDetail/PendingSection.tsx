import type { JSX } from 'react';
import { useMemo } from 'react';
import type { AgentDeckTeamMember } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { selectPendingBuckets } from '@renderer/lib/session-selectors';
import { Section, EmptyState } from './Header';

/**
 * plan team-cohesion-fix-20260513 Phase C：team 内 pending 聚合 section（与 PendingTab 同源）。
 *
 * 数据**不**走 IPC（避免与 PendingTab 数据源不一致 + 重复 SQL），复用 PendingTab 同款
 * `selectPendingBuckets`（session-selectors）算出 buckets 后按 team 成员 sessionIds 过滤。
 *
 * REVIEW_107 MED：必须复用 `selectPendingBuckets` 而非自行按 raw pending Map 聚合——后者
 * 只看 member `leftAt === null`，漏掉 PendingTab 走的 `archivedAt !== null` + lifecycle
 * ∉ {active,dormant} 过滤（pending Map 仅 removeSession 清，session archive/非活跃但仍是
 * active member 时残留 pending）。口径漂移会让 TeamDetail 显示 PendingTab 已隐藏的、用户
 * 点进去也无法处理的会话。复用 selector = 两个视图 0 漂移 + 继承其 waiting/lastEventAt 排序。
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
  const pendingDiffs = useSessionStore((s) => s.pendingDiffReviewsBySession);

  // 复用 PendingTab 同款 selector（含 archivedAt + lifecycle 过滤 + waiting/lastEventAt 排序），
  // 再按 team active 成员 sessionIds 过滤。memberSidSet 依赖 members → useMemo 锁住重算时机。
  const rows = useMemo(() => {
    const memberSidSet = new Set(
      members.filter((m) => m.leftAt === null).map((m) => m.sessionId),
    );
    return selectPendingBuckets(sessions, pendingPerms, pendingAsks, pendingExits, pendingDiffs)
      .filter((b) => memberSidSet.has(b.session.id))
      .map((b) => ({
        sid: b.session.id,
        label: b.session.title ?? b.session.id.slice(0, 8),
        perms: b.permissions.length,
        asks: b.askQuestions.length,
        exits: b.exitPlanModes.length,
        diffs: b.diffReviews.length,
        total: b.total,
      }));
  }, [members, sessions, pendingPerms, pendingAsks, pendingExits, pendingDiffs]);

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
                {r.perms > 0 && <span className="mr-1.5">🛡 {r.perms}</span>}
                {r.asks > 0 && <span className="mr-1.5">❓ {r.asks}</span>}
                {r.exits > 0 && <span className="mr-1.5">📋 {r.exits}</span>}
                {r.diffs > 0 && <span>🧩 {r.diffs}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
