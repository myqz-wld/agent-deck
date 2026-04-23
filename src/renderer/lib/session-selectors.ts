import type {
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  PermissionRequest,
  SessionRecord,
} from '@shared/types';

/**
 * 「实时面板」口径：lifecycle ∈ {active, dormant} 且未归档。
 *
 * 为什么 renderer 端要再过滤一次：
 * - main 端 sessionRepo.listActiveAndDormant 的 SQL 已经把 closed / archived 过滤掉了，
 *   首次 listSessions 拿到的就是干净集合
 * - 但 store 是「增量维护」的：当一条会话在运行时被归档（仅打 archived_at 标记，lifecycle 不变，
 *   见 CLAUDE.md「生命周期与归档正交」），或被 LifecycleScheduler 推到 lifecycle='closed'，
 *   main 都会 emit 'session-upserted'，store 的 upsertSession 不过滤照单收下
 * - 因此 header stats / SessionList 必须在使用前再过滤一次，与 SQL 口径对齐，
 *   否则会出现「N 会话」与下方实时列表实际可见数对不上的问题
 *
 * 同时按 lastEventAt 倒序，与 SQL 的 ORDER BY 一致。
 */
export function selectLiveSessions(
  sessions: Map<string, SessionRecord>,
): SessionRecord[] {
  return [...sessions.values()]
    .filter(
      (s) =>
        s.archivedAt === null &&
        (s.lifecycle === 'active' || s.lifecycle === 'dormant'),
    )
    .sort((a, b) => b.lastEventAt - a.lastEventAt);
}

/**
 * 集中「待处理」面板的聚合视图：把每个会话挂着的 permission / ask / exit-plan
 * 收成一个 bucket。过滤口径与 selectLiveSessions 完全一致（archivedAt === null
 * && lifecycle ∈ {active, dormant}），避免「实时面板看不到这条会话但待处理还显示」
 * 的口径分裂；归档会话即便仍有 pending（理论上 sdk-bridge 还在等）也不在面板里
 * 骚扰用户（CHANGELOG_31 的「不主动弹通知」语义延伸）。
 *
 * 排序：activity === 'waiting' 的会话排顶部（这些是「现在卡在等用户」的），
 * 然后按 lastEventAt 倒序（最近活跃的优先）。
 */
export interface PendingBucket {
  session: SessionRecord;
  permissions: PermissionRequest[];
  askQuestions: AskUserQuestionRequest[];
  exitPlanModes: ExitPlanModeRequest[];
  total: number;
}

export function selectPendingBuckets(
  sessions: Map<string, SessionRecord>,
  pendingPerms: Map<string, PermissionRequest[]>,
  pendingAsks: Map<string, AskUserQuestionRequest[]>,
  pendingExits: Map<string, ExitPlanModeRequest[]>,
): PendingBucket[] {
  const ids = new Set<string>();
  for (const k of pendingPerms.keys()) ids.add(k);
  for (const k of pendingAsks.keys()) ids.add(k);
  for (const k of pendingExits.keys()) ids.add(k);

  const out: PendingBucket[] = [];
  for (const sid of ids) {
    const s = sessions.get(sid);
    if (!s || s.archivedAt !== null) continue;
    if (s.lifecycle !== 'active' && s.lifecycle !== 'dormant') continue;

    const permissions = pendingPerms.get(sid) ?? [];
    const askQuestions = pendingAsks.get(sid) ?? [];
    const exitPlanModes = pendingExits.get(sid) ?? [];
    const total = permissions.length + askQuestions.length + exitPlanModes.length;
    if (total === 0) continue; // store 用 setPendingRequests 时空列表会 delete key，
    // 这里仍兜底一下：renderer 短暂的中间态可能让 key 残留空数组

    out.push({ session: s, permissions, askQuestions, exitPlanModes, total });
  }

  return out.sort((a, b) => {
    const aw = a.session.activity === 'waiting' ? 1 : 0;
    const bw = b.session.activity === 'waiting' ? 1 : 0;
    if (aw !== bw) return bw - aw;
    return b.session.lastEventAt - a.session.lastEventAt;
  });
}

/** PendingBucket 数组求总 pending 条数。给 header chip / tab badge 共享口径。 */
export function sumPendingBuckets(buckets: PendingBucket[]): number {
  let n = 0;
  for (const b of buckets) n += b.total;
  return n;
}
