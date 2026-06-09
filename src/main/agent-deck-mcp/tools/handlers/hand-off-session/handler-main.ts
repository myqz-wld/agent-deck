import { existsSync } from 'node:fs';

import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { omitUndefined } from '@main/utils/optional-fields';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../../helpers';
import type {
  HandOffSessionArgs,
  HandOffSessionResult,
  SpawnSessionArgs,
  SpawnSessionResult,
} from '../../schemas';
import { spawnSessionHandler } from '../spawn';
import type { HandOffSessionHandlerDeps } from './_deps';
import { transferHandOffResources } from './resource-transfer-coordinator';

export function resolveBatonRoleForSpawn(): { handOffMode: true; batonRole: 'lead' } {
  return { handOffMode: true, batonRole: 'lead' };
}

function resourceTransferFailed(result: HandOffSessionResult['resourceTransfer']): boolean {
  return (
    result.tasks.status === 'failed' ||
    result.teams.status === 'failed' ||
    result.worktreeMarker.status === 'failed'
  );
}

export const handOffSessionHandler = withMcpGuard(
  'hand_off_session',
  async (
    args: HandOffSessionArgs,
    ctx: HandlerContext,
    handlerDeps?: HandOffSessionHandlerDeps,
  ) => {
    const { caller } = ctx;
    const callerSessionId = caller.callerSessionId;
    const callerRow = sessionRepo.get(callerSessionId);
    if (!callerRow) {
      return err(
        `caller session not found: ${callerSessionId}`,
        'hand_off_session needs a real caller session so its teams, tasks, and worktree marker can be transferred to the successor.',
      );
    }

    const finalCwd = args.cwd ?? callerRow.cwd;
    const cwdExists = handlerDeps?.cwdExists ?? existsSync;
    if (!cwdExists(finalCwd)) {
      return err(
        `handoff cwd does not exist on disk: ${finalCwd}`,
        'Pass args.cwd with an existing absolute directory, or repair the caller session cwd before handing off.',
      );
    }

    const spawnArgs: SpawnSessionArgs = {
      adapter: args.adapter ?? 'claude-code',
      cwd: finalCwd,
      prompt: args.prompt,
      handOff: {
        mode: 'session',
        fromCallerSid: callerSessionId,
      },
      ...omitUndefined({
        permissionMode: args.permissionMode,
        codexSandbox: args.codexSandbox,
        claudeCodeSandbox: args.claudeCodeSandbox,
      }),
      ...(args.extraAllowWrite !== undefined && args.extraAllowWrite.length > 0
        ? { extraAllowWrite: [...args.extraAllowWrite] }
        : {}),
    };

    const spawnFn = handlerDeps?.spawnSession ?? spawnSessionHandler;
    const { handOffMode, batonRole } = resolveBatonRoleForSpawn();
    const spawnResult = await spawnFn(spawnArgs, ctx, { handOffMode, batonRole });
    if (spawnResult.isError) return spawnResult;

    let spawnData: SpawnSessionResult;
    try {
      spawnData = JSON.parse(spawnResult.content[0]?.text ?? '{}') as SpawnSessionResult;
    } catch (e) {
      return err(
        `failed to parse spawn_session result: ${(e as Error).message}`,
        'spawn_session returned non-JSON content; this is an internal error.',
      );
    }

    const newSessionId =
      typeof spawnData.sessionId === 'string' && spawnData.sessionId.length > 0
        ? spawnData.sessionId
        : null;
    if (!newSessionId) {
      return err(
        'spawn_session result did not include sessionId',
        'The successor session was not addressable, so hand_off_session cannot transfer resources.',
      );
    }

    const transferFn = handlerDeps?.transferResources ?? transferHandOffResources;
    const resourceTransfer = transferFn({
      callerSessionId,
      callerRow,
      newSessionId,
    });
    if (resourceTransferFailed(resourceTransfer)) {
      return err(
        'handoff resource transfer failed; caller was not closed',
        `Successor session ${newSessionId} was spawned, but mandatory caller resource transfer failed. Caller ${callerSessionId} remains active. Details: ${JSON.stringify(resourceTransfer)}`,
      );
    }

    let callerClosed: HandOffSessionResult['callerClosed'] = 'ok';
    try {
      const closeFn = handlerDeps?.closeSession ?? ((sid: string) => sessionManager.close(sid));
      await closeFn(callerSessionId);
    } catch {
      callerClosed = 'failed';
    }

    return ok({
      initialPrompt: args.prompt,
      callerClosed,
      resourceTransfer,
      ...spawnData,
    } satisfies HandOffSessionResult);
  },
);
