import { existsSync } from 'node:fs';

import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import log from '@main/utils/logger';
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

const logger = log.scope('mcp-handoff-main');

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

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function truncateLogText(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}...<truncated>`;
}

function summarizeHandlerResult(result: { content: Array<{ text: string }> }): string {
  const text = result.content[0]?.text ?? '<empty>';
  try {
    const parsed = JSON.parse(text) as { error?: unknown; hint?: unknown };
    const error = typeof parsed.error === 'string' ? parsed.error : text;
    const hint = typeof parsed.hint === 'string' ? ` hint=${parsed.hint}` : '';
    return truncateLogText(`${error}${hint}`);
  } catch {
    return truncateLogText(text);
  }
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
      logger.warn(`[mcp hand_off_session] caller session not found: ${callerSessionId}`);
      return err(
        `caller session not found: ${callerSessionId}`,
        'hand_off_session needs a real caller session so its teams, tasks, and worktree marker can be transferred to the successor.',
      );
    }

    const finalCwd = args.cwd ?? callerRow.cwd;
    const cwdExists = handlerDeps?.cwdExists ?? existsSync;
    if (!cwdExists(finalCwd)) {
      logger.warn(
        `[mcp hand_off_session] cwd missing before spawn: caller=${callerSessionId} cwd=${finalCwd}`,
      );
      return err(
        `handoff cwd does not exist on disk: ${finalCwd}`,
        'Pass args.cwd with an existing absolute directory, or repair the caller session cwd before handing off.',
      );
    }

    logger.info(
      `[mcp hand_off_session] start caller=${callerSessionId} adapter=${args.adapter ?? 'claude-code'} cwd=${finalCwd} promptChars=${args.prompt.length} extraAllowWrite=${args.extraAllowWrite?.length ?? 0}`,
    );

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
    if (spawnResult.isError) {
      logger.warn(
        `[mcp hand_off_session] spawn_session failed caller=${callerSessionId} adapter=${spawnArgs.adapter} cwd=${finalCwd}: ${summarizeHandlerResult(spawnResult)}`,
      );
      return spawnResult;
    }

    let spawnData: SpawnSessionResult;
    try {
      spawnData = JSON.parse(spawnResult.content[0]?.text ?? '{}') as SpawnSessionResult;
    } catch (e) {
      logger.warn(
        `[mcp hand_off_session] failed to parse spawn_session result caller=${callerSessionId}:`,
        e,
      );
      return err(
        `failed to parse spawn_session result: ${errorMessage(e)}`,
        'spawn_session returned non-JSON content; this is an internal error.',
      );
    }

    const newSessionId =
      typeof spawnData.sessionId === 'string' && spawnData.sessionId.length > 0
        ? spawnData.sessionId
        : null;
    if (!newSessionId) {
      logger.warn(
        `[mcp hand_off_session] spawn_session result missing sessionId caller=${callerSessionId}`,
      );
      return err(
        'spawn_session result did not include sessionId',
        'The successor session was not addressable, so hand_off_session cannot transfer resources.',
      );
    }
    logger.info(
      `[mcp hand_off_session] spawned successor caller=${callerSessionId} successor=${newSessionId} adapter=${spawnData.adapter} cwd=${spawnData.cwd}`,
    );

    const transferFn = handlerDeps?.transferResources ?? transferHandOffResources;
    const resourceTransfer = transferFn({
      callerSessionId,
      callerRow,
      newSessionId,
    });
    if (resourceTransferFailed(resourceTransfer)) {
      logger.warn(
        `[mcp hand_off_session] resource transfer failed caller=${callerSessionId} successor=${newSessionId}: ${JSON.stringify(resourceTransfer)}`,
      );
      let successorClosed: 'ok' | 'failed' = 'ok';
      try {
        const closeFn = handlerDeps?.closeSession ?? ((sid: string) => sessionManager.close(sid));
        await closeFn(newSessionId);
        logger.info(
          `[mcp hand_off_session] closed successor after transfer failure successor=${newSessionId}`,
        );
      } catch (e) {
        successorClosed = 'failed';
        logger.warn(
          `[mcp hand_off_session] failed to close successor after transfer failure successor=${newSessionId}:`,
          e,
        );
      }
      return err(
        'handoff resource transfer failed; caller was not closed',
        `Successor session ${newSessionId} was spawned, but mandatory caller resource transfer failed. Caller ${callerSessionId} remains active. Successor cleanup: ${successorClosed}. Details: ${JSON.stringify(resourceTransfer)}`,
        {
          successorSessionId: newSessionId,
          successorClosed,
          resourceTransfer,
        },
      );
    }
    logger.info(
      `[mcp hand_off_session] resources transferred caller=${callerSessionId} successor=${newSessionId} tasks=${resourceTransfer.tasks.count} teams=${resourceTransfer.teams.transferred.length} skippedTeams=${resourceTransfer.teams.skipped.length} worktreeMarker=${resourceTransfer.worktreeMarker.status}`,
    );

    let callerClosed: HandOffSessionResult['callerClosed'] = 'ok';
    try {
      const closeFn =
        handlerDeps?.closeSession ??
        ((sid: string) => {
          // Mark the session closed WITHOUT aborting the active SDK turn.
          // sessionManager.close() calls adapter.closeSession() → query.interrupt(), which kills
          // the current turn before the MCP tool result is delivered back to Claude. Instead:
          // - markClosed: sets lifecycle=closed + applies side effects (leave teams, clear marker)
          // - do not markRecentlyDeleted: the caller's post-handoff assistant/session-end tail should
          //   remain visible in SessionDetail. SessionManager persists closed-session events but
          //   advanceState keeps lifecycle closed, so the old turn cannot revive the caller.
          // - mcpSessionTokenMap.release: cleans up the token map entry (no-op for Claude sessions)
          sessionManager.markClosed(sid);
          mcpSessionTokenMap.release(sid);
          return Promise.resolve();
        });
      await closeFn(callerSessionId);
      logger.info(
        `[mcp hand_off_session] caller closed caller=${callerSessionId} successor=${newSessionId}`,
      );
    } catch (e) {
      callerClosed = 'failed';
      logger.warn(
        `[mcp hand_off_session] caller close failed after successful transfer caller=${callerSessionId} successor=${newSessionId}:`,
        e,
      );
    }

    return ok({
      initialPrompt: args.prompt,
      callerClosed,
      resourceTransfer,
      ...spawnData,
    } satisfies HandOffSessionResult);
  },
);
