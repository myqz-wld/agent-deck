import { useMemo, type JSX } from 'react';
import type { SessionRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { selectLiveSessions } from '@renderer/lib/session-selectors';
import { deriveTeamRole } from '@renderer/lib/derive-team-role';
import { computeChildrenByOwner, isPureSpawnChain } from './session-list-tree';
import { SessionCard } from './SessionCard';

/**
 * Phase C (CHANGELOG_77 / plan deep-review-flow-fix) + plan session-list-handoff-role-badge-20260526
 * (v4 D1/D2): 按 spawn-link + universal team backend 双源分组,SSOT 走 deriveTeamRole shared util。
 *
 * **Phase 1: spawn-link primary (有条件收编)** — 老 spawn 子任务 (SDK 派遣链) 行为不变;对有
 * universal team teammate membership 的 child, 必须验证 spawn owner 仍是 child 某 team 的 active
 * visible lead, 否则不锁 claimedBySpawn, 让 Phase 2 走 universal team SSOT 收编 (HIGH-A 修法:
 * 避免 archive_caller:false adopt 后 caller 已 left_at 但 child spawnedBy 仍指向 stale caller,
 * Phase 1 把 child 错锁在 stale caller 下)。
 *
 * **Phase 2: universal team 收编 fallback** — 仅 Phase 1 未收编的 teammate 走此分支, teammate
 * 找同 team 的 visible lead 缩进进去 (first-match-wins 单 parent — plan §不变量 5)。让 hand_off
 * adopt_teammates=true 后 newSid + 原 teammate 视觉缩进层级回归 (D4 反转)。
 *
 * **mid-tier dual-role 注**: mid-tier 节点 (既有 owner 又有 children) badge 走 deriveTeamRole,
 * 优先看 universal team membership (任一 lead → lead), 退化才用「对 owner 是 teammate」(纯 spawn
 * 链场景)。与原 v1「始终 teammate」承诺改写, mixed lead+teammate 节点显 lead badge (任一 lead
 * 优先) — D7 mixed role nested spawn 当前可达。
 *
 * **视觉缩进上限 3 层**: spawn-guards.ts default `mcpMaxSpawnDepth=3` 允许 4 层 spawn 链
 * (L1→L2→L3→L4),但 SessionList 视觉缩进 cap 在 `MAX_VISUAL_DEPTH=2`(L1/L2/L3 三层 ml-3)防
 * 深嵌套塞爆侧栏。L4+ 仍渲染但平铺在 L3 同级(无额外缩进 div),保留 `teammate` badge 让 owner
 * 关系仍可见。
 *
 * **跨 group 不关联**: SessionList 按 grouped.active / grouped.dormant 双 section 分别调
 * renderTreeGroup, Phase 1 / Phase 2 收编都只在单 section 内, 跨 lifecycle group 不缩进
 * (caller dormant + teammate active 视觉脱节是设计预期, 详 plan §已知踩坑)。
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
          点击右上角的 + 即可创建 Claude、Codex 或 Grok 会话；Claude 可选择 Gateway。
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
