import type { SessionRecord } from '@shared/types';

/**
 * 从 session 推断 team 角色 badge。SSOT for 所有 renderer 渲染 lead/teammate badge 的位置
 * (SessionList / PendingTab / 未来新增组件) — 抽 shared util DRY 防漂移。
 *
 * 优先级 (plan session-list-handoff-role-badge-20260526 §不变量 1-2):
 *   1. universal team backend membership (DB 权威)
 *      - 任一 team role==='lead' → 'lead' (§不变量 3 任一 lead 优先,避免 lead 被误认 teammate)
 *      - 否则 → 'teammate'
 *   2. spawn-link 退化 (仅纯 spawn 链场景,即 session 自身 + 所有 visible spawn 相关 session
 *      均无 universal team membership;否则 universal team backend 才是权威,spawn-link 不能越权
 *      代理 lead/teammate 标识 — 详 §不变量 2 + HIGH-2 archive_caller:false adopt 后 caller
 *      仍 active 但已 left team → 撞 spawn 子节点错标 lead 的反例)
 *      - hasOwner=true && self 无 universal team → 'teammate'
 *      - childrenCount > 0 && self 无 universal team && pureSpawnChain=true → 'lead'
 *      - 其余 → undefined
 *
 * @param session         目标 session
 * @param hasOwner        本 session 有 visible spawn owner (SessionList 树形分组计算)
 * @param childrenCount   本 session visible spawn children 数量
 * @param pureSpawnChain  visible owner / children 是否均无 universal team membership
 *                        (避免 spawn-link 误判为 universal team 角色;详 plan §D6 + isPureSpawnChain)
 */
export function deriveTeamRole(
  session: SessionRecord,
  hasOwner: boolean,
  childrenCount: number,
  pureSpawnChain: boolean,
): 'lead' | 'teammate' | undefined {
  const teams = session.teams ?? [];
  if (teams.length > 0) {
    if (teams.some((t) => t.role === 'lead')) return 'lead';
    return 'teammate';
  }
  if (!pureSpawnChain) return undefined;
  if (hasOwner) return 'teammate';
  if (childrenCount > 0) return 'lead';
  return undefined;
}
