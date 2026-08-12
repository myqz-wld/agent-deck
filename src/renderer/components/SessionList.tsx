import { useMemo, type JSX } from 'react';
import { useSessionStore } from '@renderer/stores/session-store';
import { selectLiveSessions } from '@renderer/lib/session-selectors';
import { deriveTeamRole } from '@renderer/lib/derive-team-role';
import {
  computeChildrenByOwner,
  isPureSpawnChain,
  type SessionTreeNode,
} from './session-list-tree';
import { SessionCard } from './SessionCard';
import { useSessionGitBranches } from '@renderer/hooks/use-session-git-branches';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { groupRemoteSessionSummaries } from '@renderer/remote-host/session-summary-presentation';
import { RemoteSessionSummaryCard } from './RemoteSessionSummaryCard';
import { SessionListSection, SessionListState } from './SessionListPrimitives';

/**
 * 会话树先按 spawn link 收编，再用 universal team backend 为未收编协作者寻找同团队的首个
 * 可见负责人。spawn owner 只有在仍是共同团队的 active visible lead 时才优先，避免过期
 * spawnedBy 将成员锁到已离队的 caller。
 *
 * deriveTeamRole 是角色标签的唯一来源：universal team membership 优先，纯 spawn 链才回退到
 * owner/child 位置。视觉缩进最多三层，更深节点在上限层平铺；active 与 dormant 分组独立，
 * 不建立跨 lifecycle 的视觉父子关系。
 */
const MAX_VISUAL_DEPTH = 2; // L1=0, L2=1, L3=2 → 视觉 3 层缩进上限

function renderTreeGroup<T extends SessionTreeNode>(
  sessions: T[],
  renderCard: (session: T, teamRole: 'lead' | 'teammate' | undefined) => JSX.Element,
): JSX.Element[] {
  const { childrenByOwner, roots } = computeChildrenByOwner(sessions);

  function renderNode(
    session: T,
    visualDepth: number,
    hasOwner: boolean,
  ): JSX.Element[] {
    const children = childrenByOwner.get(session.id) ?? [];
    const pureSpawnChain = isPureSpawnChain(session, children, sessions);
    const teamRole = deriveTeamRole(session, hasOwner, children.length, pureSpawnChain);
    const out: JSX.Element[] = [
      renderCard(session, teamRole),
    ];
    if (children.length > 0) {
      const nextVisualDepth = Math.min(visualDepth + 1, MAX_VISUAL_DEPTH);
      const childNodes = children.flatMap((c) => renderNode(c, nextVisualDepth, true));
      if (nextVisualDepth > visualDepth) {
        // 还能再缩进一层 → wrap 在 ml-3 + border-l 缩进容器内
        out.push(
          <div
            key={`${session.id}-children`}
            className="ml-3 flex flex-col gap-1.5 border-l border-blue-400/20 pl-2.5"
          >
            {childNodes}
          </div>,
        );
      } else {
        // 触视觉缩进上限 → 平铺在当前节点同级(仍保留 teammate badge)
        out.push(...childNodes);
      }
    }
    return out;
  }

  return roots.flatMap((root) => renderNode(root, 0, false));
}

export function SessionList({ remoteSource }: { remoteSource?: RemoteSessionSourceView }): JSX.Element {
  return remoteSource ? <RemoteSessionList source={remoteSource} /> : <LocalSessionList />;
}

function LocalSessionList(): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const selected = useSessionStore((s) => s.selectedSessionId);
  const select = useSessionStore((s) => s.selectSession);

  const grouped = useMemo(() => {
    // 实时面板只显示未归档的 active/dormant；归档与 lifecycle 正交（详见 CLAUDE.md），
    // 必须显式过滤 archivedAt，否则在当前会话内归档后，session-upserted 推送的
    // record 仍带原 lifecycle，会一直留在实时列表里直到下次重启 setSessions 重灌。
    // 与 App.tsx header stats 共用 selectLiveSessions，确保两处计数完全一致。
    const all = selectLiveSessions(sessions);
    return {
      all,
      active: all.filter((s) => s.lifecycle === 'active'),
      dormant: all.filter((s) => s.lifecycle === 'dormant'),
    };
  }, [sessions]);
  const branchesBySession = useSessionGitBranches(grouped.all);

  if (grouped.active.length === 0 && grouped.dormant.length === 0) {
    return (
      <SessionListState
        kind="empty"
        title="还没有会话"
        detail={<>
          点击右上角的 + 即可创建 Claude Code、Codex CLI 或 Grok Build 会话。
          <br />
          <details className="mt-1 inline-block text-left">
            <summary className="cursor-pointer text-deck-muted/70 hover:text-deck-text/85">也可接入终端会话</summary>
            <div className="mt-1 pl-2 text-deck-muted/70">
              在设置中安装 Hook 后，终端里的 <code className="rounded bg-white/5 px-1">claude</code>、<code className="rounded bg-white/5 px-1">codex</code> 或 <code className="rounded bg-white/5 px-1">grok</code> 会话也会显示在这里。
            </div>
          </details>
        </>}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {grouped.active.length > 0 && (
        <SessionListSection kind="active" label="活跃" count={grouped.active.length}>
          {renderTreeGroup(grouped.active, (session, teamRole) => (
            <SessionCard
              key={session.id}
              session={session}
              selected={selected === session.id}
              onSelect={() => select(session.id)}
              branch={branchesBySession.get(session.id)}
              teamRole={teamRole}
            />
          ))}
        </SessionListSection>
      )}
      {grouped.dormant.length > 0 && (
        <SessionListSection kind="dormant" label="休眠" count={grouped.dormant.length}>
          {renderTreeGroup(grouped.dormant, (session, teamRole) => (
            <SessionCard
              key={session.id}
              session={session}
              selected={selected === session.id}
              onSelect={() => select(session.id)}
              branch={branchesBySession.get(session.id)}
              teamRole={teamRole}
            />
          ))}
        </SessionListSection>
      )}
    </div>
  );
}

function RemoteSessionList({ source }: { source: RemoteSessionSourceView }): JSX.Element {
  if (!source.usable) {
    const title = source.state?.status === 'connecting' || source.state?.status === 'reconnecting'
      ? '正在建立受限 SSH 连接…'
      : '远程数据源尚未连接';
    return (
      <SessionListState
        kind="offline"
        title={title}
        detail="请在数据源设置中连接远程服务；切换数据源不会停止远程 session。"
      />
    );
  }
  const grouped = groupRemoteSessionSummaries(source.sessions);
  const visibleSessionCount = grouped.active.length + grouped.dormant.length;
  const authoritativeVisibleCount = source.presentationCounts
    ? source.presentationCounts.active + source.presentationCounts.dormant
    : visibleSessionCount;
  if (source.loading && visibleSessionCount === 0) {
    return <SessionListState kind="loading" title="加载远程会话…" />;
  }
  if (source.error && visibleSessionCount === 0) {
    return <SessionListState kind="error" title={source.error} />;
  }
  if (authoritativeVisibleCount === 0) {
    return (
      <SessionListState
        kind="empty"
        title="还没有远程会话"
        detail="点击右上角的 +，从远程 Core 提供的项目中创建 session。"
      />
    );
  }
  const sections = [
    {
      key: 'active', label: '活跃', rows: grouped.active,
      count: source.presentationCounts?.active ?? grouped.active.length,
    },
    {
      key: 'dormant', label: '休眠', rows: grouped.dormant,
      count: source.presentationCounts?.dormant ?? grouped.dormant.length,
    },
  ] as const;
  return (
    <div className="flex flex-col gap-3">
      {sections.map((section) => section.count > 0 && (
        <SessionListSection
          key={section.key}
          kind={section.key}
          label={section.label}
          count={section.count}
        >
          {section.rows.length === 0 ? (
            <div className="rounded border border-dashed border-white/10 px-3 py-2 text-[10px] text-deck-muted/70">
              此分区还有 {section.count} 个会话；继续加载即可查看。
            </div>
          ) : renderTreeGroup([...section.rows], (session, teamRole) => (
            <RemoteSessionSummaryCard
              key={`${source.identity}:${session.id}`}
              session={session}
              selected={source.selectedSessionId === session.id}
              onSelect={() => source.selectSession(session.id)}
              teamRole={teamRole}
            />
          ))}
        </SessionListSection>
      ))}
      {source.hasMoreSessions && (
        <button
          type="button"
          disabled={source.livePaginationBusy ?? source.busy}
          onClick={() => void source.loadMoreSessions()}
          className="rounded border border-dashed border-white/10 px-3 py-2 text-[10px] text-deck-muted hover:bg-white/[0.04] disabled:opacity-40"
        >
          加载更多会话
        </button>
      )}
      {source.error && <div role="alert" className="rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-200">{source.error}</div>}
    </div>
  );
}
