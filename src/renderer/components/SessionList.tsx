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
 */
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
  return roots.flatMap((root) => {
    const children = childrenByOwner.get(root.id) ?? [];
    const elements: JSX.Element[] = [
      <SessionCard
        key={root.id}
        session={root}
        selected={selectedId === root.id}
        onSelect={() => onSelect(root.id)}
        teamRole={children.length > 0 ? 'lead' : undefined}
      />,
    ];
    if (children.length > 0) {
      elements.push(
        <div key={`${root.id}-children`} className="ml-3 flex flex-col gap-1.5 border-l border-blue-400/20 pl-2.5">
          {children.map((child) => (
            <SessionCard
              key={child.id}
              session={child}
              selected={selectedId === child.id}
              onSelect={() => onSelect(child.id)}
              teamRole="teammate"
            />
          ))}
        </div>,
      );
    }
    return elements;
  });
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
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center text-deck-muted">
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
