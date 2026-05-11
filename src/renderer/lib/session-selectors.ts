import type {
  AskUserQuestionRequest,
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
    .sort((a, b) => b.lastEventAt - a.lastEventAt);
}

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
    if (total === 0) continue;

    out.push({
      session: s,
      permissions,
      askQuestions,
      exitPlanModes,
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
