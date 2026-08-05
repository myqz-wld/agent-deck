import type {
  RemoteHostPendingListDto,
  RemoteHostSessionSummaryDto,
} from '@shared/remote-host';

export function remoteSourceIdentity(
  profileId: string,
  coreId: string | null,
  generation: number | null,
): string {
  const parts = [profileId, coreId ?? '', String(generation ?? 0)];
  return parts.map((part) => `${new TextEncoder().encode(part).byteLength}:${part}`).join('|');
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await run(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return output;
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

export async function loadPendingRows(
  profileId: string,
  sessions: readonly RemoteHostSessionSummaryDto[],
  concurrency: number,
  load: (target: { profileId: string; sessionId: string }) => Promise<RemoteHostPendingListDto>,
): Promise<Array<
  | { id: string; value: RemoteHostPendingListDto }
  | { id: string; reason: unknown }
>> {
  return mapConcurrent(sessions, concurrency, async (session) => {
    try {
      return { id: session.id, value: await load({ profileId, sessionId: session.id }) };
    } catch (reason) {
      return { id: session.id, reason };
    }
  });
}
