import {
  spawn as spawnChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';

import type { SpawnSshProcess } from './types';

export const spawnOpenSsh: SpawnSshProcess = (binary, argv, options) =>
  spawnChildProcess(binary, [...argv], options) as ChildProcessWithoutNullStreams;

export function toSshStreamBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  throw new Error('SSH stream emitted a non-byte chunk');
}
