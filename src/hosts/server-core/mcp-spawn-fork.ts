import { realpath } from 'node:fs/promises';

import type {
  AgentAdapter,
  CreateSessionOptions,
  ForkSessionSource,
} from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';

function runtimeSelector(target: CreateSessionOptions): string | null {
  if (target.agentId === 'codex-cli') return target.provider?.trim() || null;
  if (target.agentId === 'claude-code') return target.gateway?.trim() || null;
  return null;
}

/** Reject any caller-record drift after an asynchronous native-fork preflight. */
export function assertServerCoreSpawnForkSourceUnchanged(input: {
  readonly caller: SessionRecord;
  readonly source: ForkSessionSource;
  readonly target: CreateSessionOptions;
}): void {
  const { caller, source, target } = input;
  if (
    caller.id !== source.applicationSessionId ||
    caller.source !== 'sdk' ||
    caller.agentId !== target.agentId ||
    caller.cliSessionId?.trim() !== source.nativeSessionId ||
    (caller.runtimeProvider?.trim() || null) !== runtimeSelector(target) ||
    caller.cwd !== source.cwd
  ) throw new Error('Fork caller identity changed during validation');
}

/** Re-prove the normalized cwd while retaining the exact validated caller identity. */
export async function revalidateServerCoreSpawnFork(input: {
  readonly caller: SessionRecord;
  readonly source: ForkSessionSource;
  readonly target: CreateSessionOptions;
}): Promise<void> {
  assertServerCoreSpawnForkSourceUnchanged(input);
  const [sourceCwd, targetCwd] = await Promise.all([
    realpath(input.caller.cwd),
    realpath(input.target.cwd),
  ]);
  if (sourceCwd !== targetCwd) {
    throw new Error('Fork source and target cwd identity changed during validation');
  }
}

/** Validate provider-native fork constraints before teams or spawn capacity are mutated. */
export async function validateServerCoreSpawnFork(input: {
  readonly adapter: AgentAdapter;
  readonly caller: SessionRecord;
  readonly target: CreateSessionOptions;
}): Promise<ForkSessionSource> {
  const { adapter, caller, target } = input;
  if (caller.source !== 'sdk') {
    throw new Error('contextMode "fork" requires an in-app SDK caller');
  }
  const nativeSessionId = caller.cliSessionId?.trim();
  if (!nativeSessionId) throw new Error('Fork caller has no resumable provider session ID');
  if (caller.agentId !== target.agentId) {
    throw new Error(`contextMode "fork" requires caller adapter "${caller.agentId}"`);
  }
  if ((caller.runtimeProvider?.trim() || null) !== runtimeSelector(target)) {
    throw new Error('contextMode "fork" requires the caller runtime selector');
  }
  if (
    adapter.capabilities.canForkSession !== true ||
    !adapter.validateForkSession ||
    !adapter.createForkedSession
  ) throw new Error(`adapter "${target.agentId}" does not provide native session fork support`);

  const [sourceCwd, targetCwd] = await Promise.all([
    realpath(caller.cwd),
    realpath(target.cwd),
  ]);
  if (sourceCwd !== targetCwd) {
    throw new Error('Fork source and target cwd must resolve to the same directory');
  }
  const source: ForkSessionSource = {
    applicationSessionId: caller.id,
    nativeSessionId,
    cwd: caller.cwd,
  };
  await adapter.validateForkSession(source, target);
  return source;
}
