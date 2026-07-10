import { realpath } from 'node:fs/promises';
import type {
  AgentAdapter,
  CreateSessionOptions,
  ForkSessionSource,
} from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import { err, type HandlerResult } from '../helpers';

interface ForkPreflightDeps {
  realpath(path: string): Promise<string>;
}

const DEFAULT_DEPS: ForkPreflightDeps = { realpath };

export type ForkPreflightResult =
  | { ok: true; source: ForkSessionSource }
  | { ok: false; result: HandlerResult };

function reject(error: string, hint: string): ForkPreflightResult {
  return { ok: false, result: err(error, hint) };
}

/** Validate all fork-only constraints before guards reserve capacity or teams are mutated. */
export async function validateSpawnForkPreflight(
  input: {
    callerSessionId: string;
    caller: SessionRecord | null;
    adapter: AgentAdapter;
    target: CreateSessionOptions;
  },
  deps: ForkPreflightDeps = DEFAULT_DEPS,
): Promise<ForkPreflightResult> {
  const caller = input.caller;
  if (!caller) {
    return reject(
      `Cannot fork missing caller session ${input.callerSessionId}.`,
      'Call spawn_session from an active in-app SDK session, or use contextMode "fresh".',
    );
  }
  if (caller.source !== 'sdk') {
    return reject(
      `contextMode "fork" requires an in-app SDK caller; caller source is "${caller.source}".`,
      'Start an in-app SDK session for this adapter, or use contextMode "fresh".',
    );
  }
  if (caller.archivedAt !== null) {
    return reject(
      'Cannot fork an archived caller session.',
      'Restore the caller session or use contextMode "fresh".',
    );
  }
  if (caller.lifecycle !== 'active') {
    return reject(
      `Cannot fork a ${caller.lifecycle} caller session.`,
      'Resume an active caller session or use contextMode "fresh".',
    );
  }
  const nativeSessionId = caller.cliSessionId;
  if (!nativeSessionId?.trim()) {
    return reject(
      'Caller session has no resumable provider session ID.',
      'Retry after SDK initialization completes or use contextMode "fresh".',
    );
  }
  if (caller.agentId !== input.target.agentId) {
    return reject(
      `contextMode "fork" requires caller adapter "${caller.agentId}", received "${input.target.agentId}".`,
      `Retry with adapter "${caller.agentId}" or use contextMode "fresh".`,
    );
  }
  if (
    input.adapter.capabilities.canForkSession !== true ||
    !input.adapter.validateForkSession ||
    !input.adapter.createForkedSession
  ) {
    return reject(
      `adapter "${input.target.agentId}" does not provide native session fork support.`,
      'Use contextMode "fresh" or enable an adapter version with native fork support.',
    );
  }

  let sourceCwd: string;
  let targetCwd: string;
  try {
    [sourceCwd, targetCwd] = await Promise.all([
      deps.realpath(caller.cwd),
      deps.realpath(input.target.cwd),
    ]);
  } catch (error) {
    return reject(
      `Cannot resolve fork cwd: ${error instanceof Error ? error.message : String(error)}`,
      'Use the active caller cwd for an existing directory, or use contextMode "fresh".',
    );
  }
  if (sourceCwd !== targetCwd) {
    return reject(
      'Fork source and target cwd must resolve to the same directory.',
      `Retry with cwd "${caller.cwd}" or use contextMode "fresh".`,
    );
  }

  const source: ForkSessionSource = {
    applicationSessionId: caller.id,
    nativeSessionId,
    cwd: caller.cwd,
  };
  try {
    await input.adapter.validateForkSession(source, input.target);
  } catch (error) {
    return reject(
      error instanceof Error ? error.message : String(error),
      `Fix the ${input.target.agentId} native-fork condition described above, or use contextMode "fresh".`,
    );
  }
  return { ok: true, source };
}
