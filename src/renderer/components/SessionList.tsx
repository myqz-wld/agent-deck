import { useMemo, type JSX } from 'react';
import type { SessionRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { selectLiveSessions } from '@renderer/lib/session-selectors';
import { deriveTeamRole } from '@renderer/lib/derive-team-role';
import { computeChildrenByOwner, isPureSpawnChain } from './session-list-tree';
import { SessionCard } from './SessionCard';
import { useSessionGitBranches } from '@renderer/hooks/use-session-git-branches';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';

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

function renderTreeGroup(
  sessions: SessionRecord[],
  selectedId: string | null,
  onSelect: (sid: string) => void,
  branchesBySession: ReadonlyMap<string, string | null>,
): JSX.Element[] {
  const { childrenByOwner, roots } = computeChildrenByOwner(sessions);

  function renderNode(
    session: SessionRecord,
    visualDepth: number,
    hasOwner: boolean,
  ): JSX.Element[] {
    const children = childrenByOwner.get(session.id) ?? [];
    const pureSpawnChain = isPureSpawnChain(session, children, sessions);
    const teamRole = deriveTeamRole(session, hasOwner, children.length, pureSpawnChain);
    const out: JSX.Element[] = [
      <SessionCard
        key={session.id}
        session={session}
        selected={selectedId === session.id}
        onSelect={() => onSelect(session.id)}
        branch={branchesBySession.get(session.id)}
        teamRole={teamRole}
      />,
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
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center text-deck-muted">
        <div className="text-[12px]">还没有会话</div>
        <div className="text-[10px] leading-relaxed">
          点击右上角的 + 即可创建 Claude Code、Codex CLI 或 Grok Build 会话。
          <br />
          <details className="mt-1 inline-block text-left">
            <summary className="cursor-pointer text-deck-muted/70 hover:text-deck-text/85">也可接入终端会话</summary>
            <div className="mt-1 pl-2 text-deck-muted/70">
              在设置中安装 Hook 后，终端里的 <code className="rounded bg-white/5 px-1">claude</code>、<code className="rounded bg-white/5 px-1">codex</code> 或 <code className="rounded bg-white/5 px-1">grok</code> 会话也会显示在这里。
            </div>
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {grouped.active.length > 0 && (
        <section>
          <div className="mb-1.5 px-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
            活跃 · {grouped.active.length}
          </div>
          <div className="flex flex-col gap-1.5">
            {renderTreeGroup(grouped.active, selected, select, branchesBySession)}
          </div>
        </section>
      )}
      {grouped.dormant.length > 0 && (
        <section>
          <div className="mb-1.5 px-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
            休眠 · {grouped.dormant.length}
          </div>
          <div className="flex flex-col gap-1.5">
            {renderTreeGroup(grouped.dormant, selected, select, branchesBySession)}
          </div>
        </section>
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
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-deck-muted">
        <div className="text-[12px]">{title}</div>
        <div className="text-[10px]">请在数据源设置中连接远程服务；切换数据源不会停止远程 session。</div>
      </div>
    );
  }
  if (source.loading && source.sessions.length === 0) {
    return <div className="flex h-full items-center justify-center text-[11px] text-deck-muted">加载远程会话…</div>;
  }
  if (source.sessions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-deck-muted">
        <div className="text-[12px]">还没有远程会话</div>
        <div className="text-[10px]">点击右上角的 +，从远程 Core 提供的项目中创建 session。</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
        {source.profile?.label} · {source.sessionTotal === null ? `已载入 ${source.sessions.length}` : `${source.sessions.length}/${source.sessionTotal}`}
      </div>
      {source.sessions.map((session) => (
        <button
          key={`${source.identity}:${session.id}`}
          type="button"
          onClick={() => source.selectSession(session.id)}
          className={`rounded-lg border px-3 py-2 text-left transition ${source.selectedSessionId === session.id ? 'border-white/30 bg-white/10' : 'border-deck-border bg-white/[0.02] hover:bg-white/[0.06]'}`}
        >
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${session.status === 'active' ? 'bg-status-working' : 'bg-deck-muted/50'}`} />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{session.title ?? '未命名 session'}</span>
            <span className="rounded bg-blue-500/15 px-1 py-0.5 text-[8px] uppercase text-blue-200">Remote</span>
            <span className="text-[9px] text-deck-muted">{session.adapterId}</span>
          </div>
          <div className="mt-1 flex justify-between gap-2 text-[10px] text-deck-muted/70">
            <span>{session.status}</span>
            <span>{new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
          </div>
        </button>
      ))}
      {source.hasMoreSessions && (
        <button
          type="button"
          disabled={source.busy}
          onClick={() => void source.loadMoreSessions()}
          className="rounded border border-dashed border-white/10 px-3 py-2 text-[10px] text-deck-muted hover:bg-white/[0.04] disabled:opacity-40"
        >
          加载更多远程会话
        </button>
      )}
      {source.error && <div role="alert" className="rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-200">{source.error}</div>}
    </div>
  );
}
