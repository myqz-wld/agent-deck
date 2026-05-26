/**
 * SessionList 树形分组 pure helper (plan session-list-handoff-role-badge-20260526 §D2).
 *
 * 抽离原因:
 * 1. SessionList.tsx 含 JSX, vitest node env 不能直接 import (会撞 React 依赖)
 * 2. 这些纯函数无 React 依赖, 抽到 .ts 让单测直接 import (plan §Step 4.1.5)
 * 3. SessionList.tsx renderTreeGroup 主体变薄, 只负责 React 渲染部分
 *
 * 算法见 SessionList.tsx 头部 jsdoc (Phase 1 spawn-link primary + Phase 2 universal team 收编
 * fallback + Phase 3 roots = 未被任何方式收编)。
 */

import type { SessionRecord } from '@shared/types';

/**
 * 判断 session 是否处在「纯 spawn 链」上下文 (plan §D6 HIGH-2):
 * - self 无 universal team membership
 * - 所有 visible children 无 universal team membership
 * - visible owner (if any) 无 universal team membership
 *
 * Why: 避免 spawn-link 越权代理 lead/teammate 标识 (如 archive_caller:false adopt 后 caller 仍
 * active 但已 left team → 撞 spawn 子节点错标 lead 的反例)。
 *
 * Note: 「跨 section owner 不在 allSessions」时直接 return true (silent 防御行为, 跨 lifecycle
 * group 不关联是 SessionList 设计预期, 详 plan §已知踩坑)。
 */
export function isPureSpawnChain(
  self: SessionRecord,
  children: SessionRecord[],
  allSessions: SessionRecord[],
): boolean {
  if ((self.teams?.length ?? 0) > 0) return false;
  for (const c of children) {
    if ((c.teams?.length ?? 0) > 0) return false;
  }
  if (self.spawnedBy) {
    const owner = allSessions.find((s) => s.id === self.spawnedBy);
    if (owner && (owner.teams?.length ?? 0) > 0) return false;
  }
  return true;
}

/**
 * 双源 fallback 构造 SessionList 树形分组 (plan §D2):
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
 * **Phase 3: roots = 未被任何方式收编的 session** (renderTreeGroup 顶层迭代基础)。
 *
 * **visibleLeadByTeamId 顺序防御注** (plan §D2 R2 claude LOW-4): 取**第一个**遍历到的 visible
 * lead per team_id (按 sessions 数组顺序 = selectLiveSessions 返回顺序);swap 保证唯一 lead 时
 * 不冲突, 如数据不一致 (理论 corner — swap 中间态 / DB race) 走 selectLiveSessions 顺序的第一
 * 个, 这是防御性行为不是 guarantee。
 */
export function computeChildrenByOwner(sessions: SessionRecord[]): {
  childrenByOwner: Map<string, SessionRecord[]>;
  claimedBySpawn: Set<string>;
  claimedByTeam: Set<string>;
  roots: SessionRecord[];
} {
  const visibleIds = new Set(sessions.map((s) => s.id));
  const childrenByOwner = new Map<string, SessionRecord[]>();
  const claimedBySpawn = new Set<string>();

  // Phase 1: spawn-link primary (有条件收编)
  for (const s of sessions) {
    if (!s.spawnedBy || !visibleIds.has(s.spawnedBy)) continue;

    const sTeams = s.teams ?? [];
    if (sTeams.length > 0) {
      const owner = sessions.find((o) => o.id === s.spawnedBy);
      const ownerLeadsSomeTeamOfS =
        owner?.teams?.some(
          (ot) => ot.role === 'lead' && sTeams.some((st) => st.teamId === ot.teamId),
        ) ?? false;
      if (!ownerLeadsSomeTeamOfS) continue;
    }

    const arr = childrenByOwner.get(s.spawnedBy) ?? [];
    arr.push(s);
    childrenByOwner.set(s.spawnedBy, arr);
    claimedBySpawn.add(s.id);
  }

  // Phase 2: universal team 收编 fallback
  const visibleLeadByTeamId = new Map<string, SessionRecord>();
  for (const s of sessions) {
    for (const t of s.teams ?? []) {
      if (t.role === 'lead' && !visibleLeadByTeamId.has(t.teamId)) {
        visibleLeadByTeamId.set(t.teamId, s);
      }
    }
  }
  const claimedByTeam = new Set<string>();
  for (const s of sessions) {
    if (claimedBySpawn.has(s.id)) continue;
    for (const t of s.teams ?? []) {
      if (t.role !== 'teammate') continue;
      const lead = visibleLeadByTeamId.get(t.teamId);
      if (!lead || lead.id === s.id) continue;
      const arr = childrenByOwner.get(lead.id) ?? [];
      arr.push(s);
      childrenByOwner.set(lead.id, arr);
      claimedByTeam.add(s.id);
      break; // first-match-wins 单 parent (plan §不变量 5)
    }
  }

  // Phase 3: roots
  const roots: SessionRecord[] = sessions.filter(
    (s) => !claimedBySpawn.has(s.id) && !claimedByTeam.has(s.id),
  );

  return { childrenByOwner, claimedBySpawn, claimedByTeam, roots };
}
