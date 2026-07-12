export function bumpSessionRevision(
  revisions: Map<string, number>,
  sessionId: string,
): Map<string, number> {
  const next = new Map(revisions);
  next.set(sessionId, (next.get(sessionId) ?? 0) + 1);
  return next;
}

export function bumpRenamedSessionRevisions(
  revisions: Map<string, number>,
  fromId: string,
  toId: string,
): Map<string, number> {
  const next = new Map(revisions);
  const revision = Math.max(next.get(fromId) ?? 0, next.get(toId) ?? 0) + 1;
  next.set(fromId, revision);
  next.set(toId, revision);
  return next;
}
