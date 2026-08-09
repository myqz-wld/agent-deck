import { createHash } from 'node:crypto';

export function remoteHostMutationId(
  scope: string,
  profileId: string,
  authoritativeCoreId: string | null,
  workerGeneration: number | null,
  intentId: string,
): string {
  const hash = createHash('sha256');
  for (const part of [
    profileId,
    authoritativeCoreId ?? '',
    String(workerGeneration ?? 0),
    intentId,
  ]) {
    hash.update(`${Buffer.byteLength(part, 'utf8')}:`);
    hash.update(part);
  }
  return `electron-${scope}-${hash.digest('base64url')}`;
}
