/** Issue Tracker UI IPC handlers, including deduplicated resolution-session creation. */

import { homedir } from 'node:os';
import { IpcInvoke } from '@shared/ipc-channels';
import { z } from 'zod';
import { adapterRegistry } from '@main/adapters/registry';
import { sessionManager } from '@main/session/manager';
import { issueRepo } from '@main/store/issue-repo';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import log from '@main/utils/logger';
import {
  on,
  IpcInputError,
  parseStringId,
  parsePermissionMode,
  parseAdapterSessionMode,
  parseCodexApprovalPolicy,
  parseSandboxMode,
  parseCodexSandboxMode,
  parseGrokSandboxProfile,
} from './_helpers';
import type { IssueRecord } from '@shared/types';
import { createIssueResolutionSession } from './issue-resolution-session';

export { createIssueResolutionSession } from './issue-resolution-session';

const logger = log.scope('ipc-issues');

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class IssueResolutionRollbackIncompleteError extends Error {
  readonly code = 'ISSUE_RESOLUTION_ROLLBACK_INCOMPLETE';
  readonly retryValid = false as const;

  constructor(readonly sessionId: string, cause: unknown, diagnostics: string[]) {
    super(
      `ISSUE_RESOLUTION_ROLLBACK_INCOMPLETE: retryValid=false; sid=${sessionId}; `
        + `restart Agent Deck or manually clean up this session before retrying; `
        + `rollback=${diagnostics.join('; ')}; original=${errorText(cause)}`,
      { cause },
    );
    this.name = 'IssueResolutionRollbackIncompleteError';
  }
}

const incompleteRollbackByIssue = new Map<string, {
  adapterId: string; sessionId: string; error: IssueResolutionRollbackIncompleteError;
}>();

async function rejectAfterCreatedSessionFailure(
  issueId: string,
  adapterId: string,
  sessionId: string,
  cause: unknown,
): Promise<never> {
  const diagnostics: string[] = [];
  let providerClosed = false;
  const adapter = adapterRegistry.get(adapterId);
  if (!adapter?.closeSessionForRollback) {
    diagnostics.push(`adapter ${adapterId} does not expose strict rollback close`);
  } else {
    try {
      await adapter.closeSessionForRollback(sessionId);
      providerClosed = true;
    } catch (error) {
      diagnostics.push(`strict adapter close failed: ${errorText(error)}`);
    }
  }
  try {
    await sessionManager.close(sessionId);
  } catch (error) {
    diagnostics.push(`session manager close failed: ${errorText(error)}`);
  }
  let durableClosed = false;
  try {
    const record = sessionRepo.get(sessionId);
    durableClosed = record?.lifecycle === 'closed';
    if (!durableClosed) diagnostics.push(`durable lifecycle is ${record?.lifecycle ?? 'missing'}`);
  } catch (error) {
    diagnostics.push(`durable lifecycle verification failed: ${errorText(error)}`);
  }
  if (!providerClosed || !durableClosed) {
    const error = new IssueResolutionRollbackIncompleteError(sessionId, cause, diagnostics);
    incompleteRollbackByIssue.set(issueId, { adapterId, sessionId, error });
    throw error;
  }
  throw cause;
}

// zod schemas (§D7 / §D15 — status strict enum 第 9 case 在此层 reject)

const ISSUE_STATUS_ENUM = z.enum(['open', 'in-progress', 'resolved']);
const ISSUE_SEVERITY_ENUM = z.enum(['low', 'medium', 'high']);

/** UI 端 IssuesList filter 入参（与 issueRepo.IssueListOptions 字段名 1:1 对应）。 */
export const LIST_FILTER_SCHEMA = z.object({
  statuses: z.array(ISSUE_STATUS_ENUM).optional(),
  kinds: z.array(z.string().min(1).max(64)).optional(),
  titleKeyword: z.string().max(200).optional(),
  includeDeleted: z.boolean().optional(),
  onlyDeleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
}).optional();

/** UI patch schema; resolutionSessionId remains exclusive to the resolution-session handler. */
export const UPDATE_PATCH_SCHEMA = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2000).optional(),
  repro: z.string().min(1).max(2000).nullable().optional(),
  kind: z.string().min(1).max(32).optional(),
  status: ISSUE_STATUS_ENUM.optional(),
  severity: ISSUE_SEVERITY_ENUM.optional(),
  labels: z.array(z.string().min(1).max(64)).max(16).optional(),
}).strict();

/** UI "Resolve in new session" arguments. */
export const RESOLVE_IN_NEW_SESSION_SCHEMA = z.object({
  issueId: z.string().min(1).max(128),
  adapter: z.string().min(1).max(64),
  cwd: z.string().max(4096).optional(), // optional: fallback issue.cwd > homedir
  prompt: z.string().min(1).max(102400),
  attachments: z.array(z.unknown()).max(20).optional(),
  permissionMode: z.string().optional(), // parsePermissionMode 内部白名单
  sessionMode: z.string().optional(),
  approvalPolicy: z.string().optional(),
  codexSandbox: z.string().optional(),
  claudeCodeSandbox: z.string().optional(),
  grokSandbox: z.string().optional(),
  provider: z.string().max(128).optional(),
  model: z.string().max(256).optional(),
  thinking: z.string().optional(), // resolveCreateSessionModelOptions 内按 adapter 白名单校验
}).strict();

// Concurrent clicks for one issue share the same in-flight creation.
const inFlightResolve = new Map<string, Promise<{ sessionId: string; issue: IssueRecord }>>();

/** Test seam — vitest 端清 dedupe Map 让 beforeEach 干净（不暴露给生产 caller）。 */
export function _resetInFlightResolveForTesting(): void {
  inFlightResolve.clear();
  incompleteRollbackByIssue.clear();
}

export function issuesListHandler(filters: unknown): IssueRecord[] {
  const parseRes = LIST_FILTER_SCHEMA.safeParse(filters);
  if (!parseRes.success) {
    throw new IpcInputError('filters', parseRes.error.issues[0]?.message ?? 'invalid');
  }
  return issueRepo.list(parseRes.data);
}

export function issuesGetHandler(id: unknown): IssueRecord | null {
  const validId = parseStringId('id', id, 128);
  const rec = issueRepo.get(validId);
  if (!rec) return null;
  rec.appendices = issueRepo.listAppendices(validId);
  return rec;
}

export function issuesUpdateHandler(id: unknown, patch: unknown): IssueRecord {
  const validId = parseStringId('id', id, 128);
  const parseRes = UPDATE_PATCH_SCHEMA.safeParse(patch);
  if (!parseRes.success) {
    throw new IpcInputError('patch', parseRes.error.issues[0]?.message ?? 'invalid');
  }
  const updated = issueRepo.update(validId, parseRes.data);
  if (!updated) throw new IpcInputError('id', `issue ${validId} not found`);
  // Keep the returned detail snapshot complete after a patch.
  updated.appendices = issueRepo.listAppendices(validId);
  eventBus.emit('issue-changed', {
    kind: 'updated',
    issueId: updated.id,
    issue: updated,
    sourceSessionId: updated.sourceSessionId,
    ts: Date.now(),
  });
  return updated;
}

export function issuesSoftDeleteHandler(id: unknown): boolean {
  const validId = parseStringId('id', id, 128);
  const ok = issueRepo.softDelete(validId);
  if (!ok) {
    // 不存在 / 已 soft-deleted — silent return false（idempotent；与 Undelete 对称）
    return false;
  }
  const issue = issueRepo.get(validId);
  if (issue) issue.appendices = issueRepo.listAppendices(validId);
  eventBus.emit('issue-changed', {
    kind: 'softDeleted',
    issueId: validId,
    issue,
    sourceSessionId: issue?.sourceSessionId ?? null,
    ts: Date.now(),
  });
  return true;
}

export function issuesUndeleteHandler(id: unknown): boolean {
  const validId = parseStringId('id', id, 128);
  const ok = issueRepo.undelete(validId);
  if (!ok) {
    // 不存在 / 未 soft-deleted — silent return false
    return false;
  }
  const issue = issueRepo.get(validId);
  if (issue) issue.appendices = issueRepo.listAppendices(validId);
  eventBus.emit('issue-changed', {
    kind: 'undeleted',
    issueId: validId,
    issue,
    sourceSessionId: issue?.sourceSessionId ?? null,
    ts: Date.now(),
  });
  return true;
}

export async function issuesResolveInNewSessionHandler(
  rawArgs: unknown,
): Promise<{ sessionId: string; issue: IssueRecord }> {
  const parseRes = RESOLVE_IN_NEW_SESSION_SCHEMA.safeParse(rawArgs);
  if (!parseRes.success) {
    throw new IpcInputError('args', parseRes.error.issues[0]?.message ?? 'invalid');
  }
  const args = parseRes.data;

  const blocked = incompleteRollbackByIssue.get(args.issueId);
  if (blocked) {
    logger.warn('[IssuesResolveInNewSession] blocked by incomplete rollback', {
      issueId: args.issueId, adapter: blocked.adapterId, sid: blocked.sessionId,
    });
    throw blocked.error;
  }
  const cached = inFlightResolve.get(args.issueId);
  if (cached) {
    logger.info('[IssuesResolveInNewSession] reuse in-flight resolve', {
      issueId: args.issueId,
      adapter: args.adapter,
    });
    return cached;
  }

  const promise = (async () => {
    const issue = issueRepo.get(args.issueId);
    if (!issue) {
      throw new IpcInputError('issueId', `issue ${args.issueId} not found`);
    }
    // Direct IPC callers cannot bypass the resolved/deleted gate.
    if (issue.status === 'resolved') {
      throw new IpcInputError('issueId', `issue ${args.issueId} 已是 resolved，无需再起会话`);
    }
    if (issue.deletedAt !== null) {
      throw new IpcInputError('issueId', `issue ${args.issueId} 已删除，无法起会话`);
    }
    const cwd =
      (args.cwd && args.cwd.trim().length > 0 && args.cwd.trim())
      || (issue.cwd && issue.cwd.trim().length > 0 && issue.cwd.trim())
      || homedir();
    const permissionMode = parsePermissionMode(args.permissionMode);
    const sessionMode = parseAdapterSessionMode(args.sessionMode);
    const approvalPolicy = parseCodexApprovalPolicy(args.approvalPolicy);
    const codexSandbox = parseCodexSandboxMode(args.codexSandbox);
    const claudeCodeSandbox = parseSandboxMode(args.claudeCodeSandbox);
    const grokSandbox = parseGrokSandboxProfile(args.grokSandbox);
    logger.info('[IssuesResolveInNewSession] spawning resolution session', {
      issueId: args.issueId,
      adapter: args.adapter,
      cwd,
      permissionMode,
      sessionMode,
      approvalPolicy,
      codexSandbox,
      claudeCodeSandbox,
      grokSandbox,
      provider: args.provider?.trim() || null,
      model: args.model?.trim() || null,
      thinking: args.thinking ?? null,
      promptLength: args.prompt.length,
    });
    const sid = await createIssueResolutionSession({
      adapter: args.adapter,
      cwd,
      prompt: args.prompt,
      attachments: args.attachments,
      permissionMode,
      sessionMode,
      approvalPolicy,
      codexSandbox,
      claudeCodeSandbox,
      grokSandbox,
      provider: args.provider,
      model: args.model,
      thinking: args.thinking,
    });
    logger.info('[IssuesResolveInNewSession] spawned resolution session', {
      issueId: args.issueId,
      adapter: args.adapter,
      sid,
    });
    // Re-read after creation; preserve concurrent resolve/delete state while replacing the link.
    let updated: IssueRecord;
    let stillActionable: boolean;
    try {
      const fresh = issueRepo.get(args.issueId);
      if (!fresh) {
        throw new IpcInputError('issueId', `issue ${args.issueId} disappeared during spawn`);
      }
      stillActionable = fresh.status !== 'resolved' && fresh.deletedAt === null;
      const linked = issueRepo.update(args.issueId, {
        resolutionSessionId: sid,
        ...(stillActionable ? { status: 'in-progress' as const } : {}),
      });
      if (!linked) {
        throw new IpcInputError('issueId', `issue ${args.issueId} disappeared during spawn`);
      }
      linked.appendices = issueRepo.listAppendices(args.issueId);
      updated = linked;
    } catch (error) {
      logger.warn('[IssuesResolveInNewSession] required post-create linkage failed', {
        issueId: args.issueId,
        sid,
        error: errorText(error),
      });
      return rejectAfterCreatedSessionFailure(args.issueId, args.adapter, sid, error);
    }
    try {
      eventBus.emit('issue-changed', {
        kind: 'updated',
        issueId: updated.id,
        issue: updated,
        sourceSessionId: updated.sourceSessionId,
        ts: Date.now(),
      });
    } catch (error) {
      logger.warn('[IssuesResolveInNewSession] issue-changed notification failed', {
        issueId: updated.id,
        sid,
        error: errorText(error),
      });
    }
    logger.info('[IssuesResolveInNewSession] linked resolution session', {
      issueId: updated.id,
      sid,
      status: updated.status,
      stillActionable,
    });
    return { sessionId: sid, issue: updated };
  })();

  inFlightResolve.set(args.issueId, promise);
  try {
    return await promise;
  } finally {
    inFlightResolve.delete(args.issueId);
  }
}

export function registerIssuesIpc(): void {
  on(IpcInvoke.IssuesList, (_e, filters) => issuesListHandler(filters));
  on(IpcInvoke.IssuesGet, (_e, id) => issuesGetHandler(id));
  on(IpcInvoke.IssuesUpdate, (_e, id, patch) => issuesUpdateHandler(id, patch));
  on(IpcInvoke.IssuesSoftDelete, (_e, id) => issuesSoftDeleteHandler(id));
  on(IpcInvoke.IssuesUndelete, (_e, id) => issuesUndeleteHandler(id));
  on(IpcInvoke.IssuesResolveInNewSession, async (_e, rawArgs) =>
    issuesResolveInNewSessionHandler(rawArgs),
  );
}
