import type {
  AskUserQuestionRequest,
  DiffReviewRequest,
  ExitPlanModeRequest,
  PermissionRequest,
} from '@shared/types';

export function pruneMapByValidIds<V>(
  src: Map<string, V>,
  validIds: Set<string>,
): Map<string, V> {
  let changed = false;
  for (const k of src.keys()) {
    if (!validIds.has(k)) {
      changed = true;
      break;
    }
  }
  if (!changed) return src;
  const next = new Map<string, V>();
  for (const [k, v] of src) if (validIds.has(k)) next.set(k, v);
  return next;
}

export function moveRequestBucket<R extends { requestId: string }>(
  src: Map<string, R[]>,
  fromId: string,
  toId: string,
): Map<string, R[]> {
  if (!src.has(fromId)) return src;
  const next = new Map(src);
  const v = next.get(fromId)!;
  next.delete(fromId);
  const existing = next.get(toId);
  if (!existing) {
    next.set(toId, v);
  } else {
    const seen = new Set(existing.map((r) => r.requestId));
    next.set(toId, [...existing, ...v.filter((r) => !seen.has(r.requestId))]);
  }
  return next;
}

type PendingSnapshot = Record<
  string,
  {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
    diffReviews?: DiffReviewRequest[];
  }
>;

export function pendingRequestMapsFromSnapshot(map: PendingSnapshot) {
  const pendingPermissionsBySession = new Map<string, PermissionRequest[]>();
  const pendingAskQuestionsBySession = new Map<string, AskUserQuestionRequest[]>();
  const pendingExitPlanModesBySession = new Map<string, ExitPlanModeRequest[]>();
  const pendingDiffReviewsBySession = new Map<string, DiffReviewRequest[]>();
  for (const [sid, bucket] of Object.entries(map)) {
    if (bucket.permissions.length > 0) pendingPermissionsBySession.set(sid, bucket.permissions);
    if (bucket.askQuestions.length > 0) pendingAskQuestionsBySession.set(sid, bucket.askQuestions);
    if (bucket.exitPlanModes.length > 0) pendingExitPlanModesBySession.set(sid, bucket.exitPlanModes);
    if ((bucket.diffReviews?.length ?? 0) > 0) {
      pendingDiffReviewsBySession.set(sid, bucket.diffReviews!);
    }
  }
  return {
    pendingPermissionsBySession,
    pendingAskQuestionsBySession,
    pendingExitPlanModesBySession,
    pendingDiffReviewsBySession,
  };
}
