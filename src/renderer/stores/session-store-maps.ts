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

export function mergeRequestBuckets<R extends { requestId: string }>(
  existing: Map<string, R[]>,
  incoming: Map<string, R[]>,
): Map<string, R[]> {
  const next = new Map(existing);
  for (const [sid, snap] of incoming) {
    const cur = next.get(sid);
    if (!cur || cur.length === 0) {
      if (snap.length > 0) next.set(sid, snap);
      continue;
    }
    const seen = new Set(cur.map((r) => r.requestId));
    const merged = [...cur, ...snap.filter((r) => !seen.has(r.requestId))];
    next.set(sid, merged);
  }
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
