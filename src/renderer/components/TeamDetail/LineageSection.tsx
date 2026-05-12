import type { JSX } from 'react';
import type { AgentDeckTeamMember } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { Section, EmptyState } from './Header';

/**
 * plan team-cohesion-fix-20260513 Phase C：spawn 血缘 section。
 *
 * 从 members + sessions Map.spawnedBy 在 renderer 端自拼树形（不走 IPC，与 SessionList 的
 * spawnedBy tree 算法对齐）。算法：
 * 1. 把 active members 的 sessionIds 集合作为 visible scope
 * 2. 每个成员若 session.spawnedBy 命中其他成员 sessionId → 是 child
 * 3. 否则视为 root（无 spawnedBy / spawnedBy 不在 team / spawnedBy 已退出）
 * 4. 渲染：root 不缩进；children 走树缩进 + 左侧蓝色虚线
 *
 * 与 MembersSection 的关系：MembersSection 是平铺成员清单，LineageSection 是树形组织视角，
 * 两者互补（一些 team 没有 spawn 链路 = 全部成员都是 root，此时 LineageSection 视觉上像
 * MembersSection 但少 hover badge）。
 *
 * 多 lead / 多 root 场景：每个独立 root 各自一棵树，平铺多棵。
 */
interface Props {
  members: AgentDeckTeamMember[];
  onOpenSession: (sessionId: string) => void;
}

interface TreeNode {
  member: AgentDeckTeamMember;
  children: TreeNode[];
}

export function LineageSection({ members, onOpenSession }: Props): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const activeMembers = members.filter((m) => m.leftAt === null);

  if (activeMembers.length === 0) {
    return (
      <Section title="血缘 (Spawn Lineage)" count={0}>
        <EmptyState>尚无 active 成员，无血缘可绘制</EmptyState>
      </Section>
    );
  }

  // 构建树
  const memberSidSet = new Set(activeMembers.map((m) => m.sessionId));
  const childrenByOwner = new Map<string, AgentDeckTeamMember[]>();
  const roots: AgentDeckTeamMember[] = [];
  for (const m of activeMembers) {
    const sess = sessions.get(m.sessionId);
    const ownerSid = sess?.spawnedBy ?? null;
    if (ownerSid && memberSidSet.has(ownerSid)) {
      const arr = childrenByOwner.get(ownerSid) ?? [];
      arr.push(m);
      childrenByOwner.set(ownerSid, arr);
    } else {
      roots.push(m);
    }
  }
  const buildNode = (m: AgentDeckTeamMember): TreeNode => ({
    member: m,
    children: (childrenByOwner.get(m.sessionId) ?? []).map(buildNode),
  });
  const tree = roots.map(buildNode);

  return (
    <Section title="血缘 (Spawn Lineage)" count={activeMembers.length}>
      <ul className="flex flex-col gap-1">
        {tree.map((node) => (
          <TreeNodeRow
            key={node.member.sessionId}
            node={node}
            depth={0}
            onOpenSession={onOpenSession}
          />
        ))}
      </ul>
    </Section>
  );
}

function TreeNodeRow({
  node,
  depth,
  onOpenSession,
}: {
  node: TreeNode;
  depth: number;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const m = node.member;
  const sess = sessions.get(m.sessionId);
  const label = m.displayName ?? sess?.title ?? m.sessionId.slice(0, 8);
  return (
    <>
      <li
        className="flex items-center justify-between rounded border border-deck-border/40 px-2 py-1 text-[11px] hover:bg-white/[0.04] cursor-pointer"
        style={{ marginLeft: depth * 12 }}
        onClick={() => onOpenSession(m.sessionId)}
        title={`点击打开 ${label} 详情（${m.role}）`}
      >
        <span className="truncate">
          {depth > 0 && <span className="mr-1 text-blue-400/40">└─</span>}
          <strong className="text-deck-text">{label}</strong>{' '}
          <span className="text-[9px] text-deck-muted">[{m.role}]</span>
          {node.children.length > 0 && (
            <span className="ml-1 text-[9px] text-deck-muted/60">
              ↳ {node.children.length}
            </span>
          )}
        </span>
        <span className="ml-2 shrink-0 text-[9px] text-deck-muted/60">
          {sess?.agentId ?? 'unknown'}
        </span>
      </li>
      {node.children.map((child) => (
        <TreeNodeRow
          key={child.member.sessionId}
          node={child}
          depth={depth + 1}
          onOpenSession={onOpenSession}
        />
      ))}
    </>
  );
}
