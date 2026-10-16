import { NATIVE_WORK_TEXT_BYTES, type NativeWorkDetail, type NativeWorkRef, type NativeWorkSnapshot } from '../contracts/native-work';
export * from '../contracts/native-work';

export const nativeWorkEntityKey = (ref: NativeWorkRef): string => JSON.stringify([ref.provider, ref.nativeId]);
/** Presentation identity survives reconnects, while controls also require the runtime ID. */
export const nativeWorkAttemptKey = (ref: NativeWorkRef): string => JSON.stringify([ref.provider, ref.nativeId, ref.runId]);
export const sameNativeWorkRef = (a: NativeWorkRef, b: NativeWorkRef): boolean =>
  a.sessionId === b.sessionId && a.runtimeId === b.runtimeId && nativeWorkAttemptKey(a) === nativeWorkAttemptKey(b);
export const isTerminalNativeWork = (status: NativeWorkSnapshot['status']): boolean =>
  status === 'completed' || status === 'failed' || status === 'stopped';

export function reduceNativeWork(previous: NativeWorkSnapshot | undefined, next: NativeWorkSnapshot): NativeWorkSnapshot {
  if (!previous) return next;
  if (previous.native.sessionId !== next.native.sessionId || nativeWorkEntityKey(previous.native) !== nativeWorkEntityKey(next.native)) return previous;
  const sameRuntime = previous.native.runtimeId === next.native.runtimeId;
  if (!sameRuntime && (next.runtimeStartedAt ?? next.startedAt) <= (previous.runtimeStartedAt ?? previous.startedAt)) return previous;
  if (previous.native.runId !== next.native.runId) return next.startedAt > previous.startedAt ? next : previous;
  if (next.updatedAt < previous.updatedAt || sameRuntime && next.revision < previous.revision) return previous;
  if (isTerminalNativeWork(previous.status) && !isTerminalNativeWork(next.status)) return previous;
  return next;
}

/** Split by Unicode code point and encoded bytes, never by UTF-16 offsets. */
export function chunkNativeWorkDetail(input: Omit<NativeWorkDetail, 'part' | 'parts'>): NativeWorkDetail[] {
  const chunks: string[] = [];
  let text = '', size = 0;
  const encoder = new TextEncoder();
  for (const point of input.text) {
    const length = encoder.encode(point).byteLength;
    if (size + length > NATIVE_WORK_TEXT_BYTES) { chunks.push(text); text = ''; size = 0; }
    text += point; size += length;
  }
  chunks.push(text);
  return chunks.map((text, part) => ({ ...input, text, part, parts: chunks.length }));
}

/** Provider implementations own observation lifetimes and exact control validation. */
export interface NativeWorkProviderPort {
  list(sessionId: string): Promise<NativeWorkSnapshot[]>;
  stop(ref: NativeWorkRef): Promise<import('../contracts/native-work').NativeWorkStopResult>;
}
