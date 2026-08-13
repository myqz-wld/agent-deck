import type {
  RemoteHostMutationAuthorityDto,
  RemoteHostStateDto,
} from '@shared/remote-host';

export function remoteSourceIdentity(
  profileId: string,
  coreId: string | null,
  generation: number | null,
): string {
  const parts = [profileId, coreId ?? '', String(generation ?? 0)];
  return parts.map((part) => `${new TextEncoder().encode(part).byteLength}:${part}`).join('|');
}

export function remoteMutationAuthority(
  state: RemoteHostStateDto | null,
): RemoteHostMutationAuthorityDto {
  return {
    authoritativeCoreId: state?.authoritativeCoreId ?? null,
    workerGeneration: state?.workerGeneration ?? null,
  };
}

export function appendUnique<T>(
  current: readonly T[],
  incoming: readonly T[],
  identityOf: (value: T) => string,
): T[] {
  const merged = new Map(current.map((value) => [identityOf(value), value]));
  for (const value of incoming) merged.set(identityOf(value), value);
  return [...merged.values()];
}

export type RemoteSessionRenameAliases = ReadonlyMap<string, string>;

export function resolveRemoteSessionId(
  aliases: RemoteSessionRenameAliases | undefined,
  sessionId: string,
): string {
  if (!aliases) return sessionId;
  let current = sessionId;
  const visited = new Set<string>();
  while (!visited.has(current) && visited.size < 32) {
    visited.add(current);
    const next = aliases.get(current);
    if (!next) break;
    current = next;
  }
  return current;
}

export function appendRemoteSessionRename(
  aliases: RemoteSessionRenameAliases | undefined,
  fromId: string,
  toId: string,
  limit = 256,
): RemoteSessionRenameAliases {
  const next = new Map(aliases ?? []);
  const target = resolveRemoteSessionId(next, toId);
  if (fromId !== target) {
    next.delete(fromId);
    next.set(fromId, target);
  }
  while (next.size > limit) next.delete(next.keys().next().value as string);
  return next;
}
