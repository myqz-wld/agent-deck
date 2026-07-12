/** Session list/detail/archive/delete/history IPC handlers. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IpcInvoke } from '@shared/ipc-channels';
import type { TaskRecord } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { getSessionFileFinalDiff } from '@main/session/final-file-diff';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { eventRepo } from '@main/store/event-repo';
import { fileChangeRepo } from '@main/store/file-change-repo';
import { sessionRepo, SessionRowMissingError } from '@main/store/session-repo';
import { summaryRepo } from '@main/store/summary-repo';
import { taskRepo } from '@main/store/task-repo';
import log from '@main/utils/logger';
import { on, parseBoolean, parsePositiveInt, parseStringId, parseStringIdArray } from './_helpers';
import { registerSessionHandOffIpc } from './session-hand-off';
import { takePendingSessionFocusRequest } from '@main/session-focus-request';

const logger = log.scope('ipc-sessions');
const execFileAsync = promisify(execFile);

export function registerSessionsIpc(): void {
  on(IpcInvoke.SessionList, () => sessionManager.list());
  on(IpcInvoke.SessionGet, (_event, id) => sessionManager.get(String(id)));
  on(IpcInvoke.SessionTakePendingFocus, () => takePendingSessionFocusRequest());
  on(IpcInvoke.SessionListEvents, (_event, id, limit) => {
    const sessionId = parseStringId('sessionId', id);
    const safeLimit = parsePositiveInt('limit', limit, {
      fallback: 200,
      min: 1,
      max: 5_000,
    });
    return eventRepo.listForSession(sessionId, safeLimit);
  });
  on(IpcInvoke.SessionListFileChanges, (_event, id) =>
    fileChangeRepo.listForSession(parseStringId('sessionId', id)),
  );
  on(IpcInvoke.SessionGetFileFinalDiff, (_event, id, filePath) =>
    getSessionFileFinalDiff(
      parseStringId('sessionId', id),
      parseStringId('filePath', filePath, 4_096),
    ),
  );
  on(IpcInvoke.SessionGetGitBranch, async (_event, id) => {
    const session = sessionRepo.get(parseStringId('sessionId', id));
    return session ? getCurrentGitBranch(session.cwd) : null;
  });
  on(IpcInvoke.SessionListSummaries, (_event, id) =>
    summaryRepo.listForSession(parseStringId('sessionId', id)),
  );
  on(IpcInvoke.SessionLatestSummaries, (_event, ids) =>
    summaryRepo.latestForSessions(parseStringIdArray('ids', ids ?? [])),
  );
  on(IpcInvoke.SessionListTasks, (_event, id): { tasks: TaskRecord[] } => {
    const sessionId = parseStringId('sessionId', id);
    if (!sessionRepo.get(sessionId)) return { tasks: [] };
    const teamIds = agentDeckTeamRepo
      .findActiveTeamMembershipsBySession(sessionId)
      .map((membership) => membership.teamId);
    return {
      tasks: taskRepo.list({
        visibleScope: { teamIds, callerSid: sessionId },
        limit: 200,
      }),
    };
  });
  on(IpcInvoke.SessionArchive, async (_event, id) => {
    const sessionId = parseStringId('sessionId', id);
    try {
      await sessionManager.archive(sessionId);
      return true;
    } catch (error) {
      if (error instanceof SessionRowMissingError) {
        logger.warn(`[ipc SessionArchive] ${sessionId} row already missing:`, error);
        return true;
      }
      throw error;
    }
  });
  on(IpcInvoke.SessionUnarchive, async (_event, id) => {
    const sessionId = parseStringId('sessionId', id);
    try {
      await sessionManager.unarchive(sessionId);
      return true;
    } catch (error) {
      if (error instanceof SessionRowMissingError) {
        logger.warn(`[ipc SessionUnarchive] ${sessionId} row already missing:`, error);
        return true;
      }
      throw error;
    }
  });
  on(IpcInvoke.SessionReactivate, (_event, id) => {
    sessionManager.reactivate(parseStringId('sessionId', id));
    return true;
  });
  on(IpcInvoke.SessionSetPinned, (_event, id, pinned) =>
    sessionManager.setPinned(
      parseStringId('sessionId', id),
      parseBoolean('pinned', pinned),
    ),
  );
  on(IpcInvoke.SessionDelete, async (_event, id) => {
    await sessionManager.delete(parseStringId('sessionId', id));
    return true;
  });
  on(IpcInvoke.SessionListHistory, (_event, filters) =>
    sessionManager.enrichWithTeamsBatch(
      sessionRepo.listHistory(
        (filters ?? {}) as Parameters<typeof sessionRepo.listHistory>[0],
      ),
    ),
  );
  registerSessionHandOffIpc();
}

async function getCurrentGitBranch(cwd: string): Promise<string | null> {
  const gitCwd = cwd.trim();
  if (!gitCwd) return null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', gitCwd, 'branch', '--show-current'], {
      timeout: 3_000,
      maxBuffer: 64 * 1_024,
    });
    const branch = stdout.trim();
    if (branch) return branch;
  } catch {
    return null;
  }
  try {
    const { stdout } = await execFileAsync('git', ['-C', gitCwd, 'rev-parse', '--short', 'HEAD'], {
      timeout: 3_000,
      maxBuffer: 64 * 1_024,
    });
    const sha = stdout.trim();
    return sha ? `HEAD ${sha}` : null;
  } catch {
    return null;
  }
}
