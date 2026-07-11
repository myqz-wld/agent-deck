import type {
  AskUserQuestionRequest,
  DiffReviewRequest,
  ExitPlanModeRequest,
  PermissionRequest,
  SessionRecord,
} from '@shared/types';

/**
 * 「实时面板」口径：lifecycle ∈ {active, dormant} 且未归档。
 *
 * R3.E7：删 teamPermissions 字段（老 inbox 协议下线）。
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
    .sort(comparePinnedSessions);
}

/** 置顶优先；同组依次按最近活动与稳定 id 排序。 */
function comparePinnedSessions(a: SessionRecord, b: SessionRecord): number {
  const aPinnedAt = a.pinnedAt ?? null;
  const bPinnedAt = b.pinnedAt ?? null;

  if (aPinnedAt !== null || bPinnedAt !== null) {
    if (aPinnedAt === null) return 1;
    if (bPinnedAt === null) return -1;
    if (aPinnedAt !== bPinnedAt) return bPinnedAt - aPinnedAt;
  }
  if (a.lastEventAt !== b.lastEventAt) return b.lastEventAt - a.lastEventAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface PendingBucket {
  session: SessionRecord;
  permissions: PermissionRequest[];
  askQuestions: AskUserQuestionRequest[];
  exitPlanModes: ExitPlanModeRequest[];
  diffReviews: DiffReviewRequest[];
  total: number;
}

const EMPTY_DIFFS = new Map<string, DiffReviewRequest[]>();

export function selectPendingBuckets(
  sessions: Map<string, SessionRecord>,
  pendingPerms: Map<string, PermissionRequest[]>,
  pendingAsks: Map<string, AskUserQuestionRequest[]>,
  pendingExits: Map<string, ExitPlanModeRequest[]>,
  pendingDiffs: Map<string, DiffReviewRequest[]> = EMPTY_DIFFS,
): PendingBucket[] {
  const ids = new Set<string>();
  for (const k of pendingPerms.keys()) ids.add(k);
  for (const k of pendingAsks.keys()) ids.add(k);
  for (const k of pendingExits.keys()) ids.add(k);
  for (const k of pendingDiffs.keys()) ids.add(k);

  const out: PendingBucket[] = [];
  for (const sid of ids) {
    const s = sessions.get(sid);
    if (!s || s.archivedAt !== null) continue;
    if (s.lifecycle !== 'active' && s.lifecycle !== 'dormant') continue;

    const permissions = pendingPerms.get(sid) ?? [];
    const askQuestions = pendingAsks.get(sid) ?? [];
    const exitPlanModes = pendingExits.get(sid) ?? [];
    const diffReviews = pendingDiffs.get(sid) ?? [];
    const total = permissions.length + askQuestions.length + exitPlanModes.length + diffReviews.length;
    if (total === 0) continue;

    out.push({
      session: s,
      permissions,
      askQuestions,
      exitPlanModes,
      diffReviews,
      total,
    });
  }

  return out.sort((a, b) => {
    const aw = a.session.activity === 'waiting' ? 1 : 0;
    const bw = b.session.activity === 'waiting' ? 1 : 0;
    if (aw !== bw) return bw - aw;
    return b.session.lastEventAt - a.session.lastEventAt;
  });
}

/** PendingBucket 数组求总 pending 条数。 */
export function sumPendingBuckets(buckets: PendingBucket[]): number {
  let n = 0;
  for (const b of buckets) n += b.total;
  return n;
}
