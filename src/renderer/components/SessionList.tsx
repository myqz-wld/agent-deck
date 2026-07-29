import { useMemo, type JSX } from 'react';
import type { SessionRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { selectLiveSessions } from '@renderer/lib/session-selectors';
import { deriveTeamRole } from '@renderer/lib/derive-team-role';
import { computeChildrenByOwner, isPureSpawnChain } from './session-list-tree';
import { SessionCard } from './SessionCard';

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

export function SessionList(): JSX.Element {
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
      active: all.filter((s) => s.lifecycle === 'active'),
      dormant: all.filter((s) => s.lifecycle === 'dormant'),
    };
  }, [sessions]);

  if (grouped.active.length === 0 && grouped.dormant.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center text-deck-muted">
        <div className="text-[12px]">还没有会话</div>
        <div className="text-[10px] leading-relaxed">
          点击右上角的 + 即可创建 Claude Code、Codex CLI 或 Grok Build 会话；Claude Code 可选择 Gateway。
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
            {renderTreeGroup(grouped.active, selected, select)}
          </div>
        </section>
      )}
      {grouped.dormant.length > 0 && (
        <section>
          <div className="mb-1.5 px-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
            休眠 · {grouped.dormant.length}
          </div>
          <div className="flex flex-col gap-1.5">
            {renderTreeGroup(grouped.dormant, selected, select)}
          </div>
        </section>
      )}
    </div>
  );
}
