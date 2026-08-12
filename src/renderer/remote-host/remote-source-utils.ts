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
