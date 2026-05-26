import { useMemo, type JSX } from 'react';
import type { SessionRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { selectLiveSessions } from '@renderer/lib/session-selectors';
import { SessionCard } from './SessionCard';

/**
 * Phase C (CHANGELOG_77 / plan deep-review-flow-fix): 按 spawnedBy 树形分组。
 * - lead = root + has visible children
 * - teammate = spawnedBy 命中 visible owner（缩进显示在 owner 下）
 * - 孤儿 teammate（owner 不可见 / 已归档 / 已 closed 不在本 group）→ 平铺为 root，无 badge（D8 决策不绑死 owner）
 *
 * 单飞同 group 内分组（active / dormant 各自分组），不跨 group 关联（避免「lead active 但 teammate dormant」
 * 的 cross-group 视觉跳跃 + 简化数据结构）。
 *
 * **视觉缩进上限 3 层**：spawn-guards.ts default `mcpMaxSpawnDepth=3` 允许 4 层 spawn 链
 * (L1→L2→L3→L4)，但 SessionList 视觉缩进 cap 在 `MAX_VISUAL_DEPTH=2`（L1/L2/L3 三层 ml-3）
 * 防深嵌套塞爆侧栏。L4+ 仍渲染但平铺在 L3 同级（无额外缩进 div），保留 `teammate` badge 让 owner
 * 关系仍可见。修前 `renderTreeGroup` 是非递归只画 L1+L2，L3 既不进 roots（spawnedBy 命中
 * visible owner）又拿不到 root.children（root 仅含 L2）→ 整层消失。
 */
const MAX_VISUAL_DEPTH = 2; // L1=0, L2=1, L3=2 → 视觉 3 层缩进上限

function renderTreeGroup(
  sessions: SessionRecord[],
  selectedId: string | null,
  onSelect: (sid: string) => void,
): JSX.Element[] {
  const visibleIds = new Set(sessions.map((s) => s.id));
  const childrenByOwner = new Map<string, SessionRecord[]>();
  const roots: SessionRecord[] = [];
  for (const s of sessions) {
    if (s.spawnedBy && visibleIds.has(s.spawnedBy)) {
      const arr = childrenByOwner.get(s.spawnedBy) ?? [];
      arr.push(s);
      childrenByOwner.set(s.spawnedBy, arr);
    } else {
      roots.push(s);
    }
  }

  function renderNode(
    session: SessionRecord,
    visualDepth: number,
    hasOwner: boolean,
  ): JSX.Element[] {
    const children = childrenByOwner.get(session.id) ?? [];
    // hasOwner 优先 teammate（即使本节点也有 children — 一个 mid-tier 节点对 owner 是 teammate，
    // 对自己 children 是 lead；SessionCard 单 role prop 只能选一个，按"对 owner 是 teammate"显示
    // 与原 2 层实现 L2 始终 teammate 行为一致）。
    const teamRole: 'lead' | 'teammate' | undefined = hasOwner
      ? 'teammate'
      : children.length > 0
        ? 'lead'
        : undefined;
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
        // 触视觉缩进上限 → 平铺在当前节点同级（仍保留 teammate badge）
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
        <div className="text-[12px]">暂无活跃会话</div>
        <div className="text-[10px] leading-relaxed">
          点 ＋ 新建会话（可选 Claude / Codex），或：
          <br />
          在「设置」装 Claude Hook 后终端跑 <code className="rounded bg-white/5 px-1">claude</code>
          <br />
          也可终端跑 <code className="rounded bg-white/5 px-1">agent-deck new --agent codex-cli</code>
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
