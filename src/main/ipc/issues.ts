/**
 * Issue Tracker IPC handlers（plan issue-tracker-mcp-20260529 §Step 3.5）。
 *
 * 6 个 channel 给 UI Issues tab 用（agent 不消费 — mcp tool report_issue / append_issue_context
 * 走另一条通道,与本文件正交）。
 *
 * **§D14 选定路径 (b)**: IssuesResolveInNewSession 走 `adapter.createSession(buildCreateSessionOptions)`
 * adapter 层 API（绕 mcp tool 层 spawn-guards 三道防御 — UI 触发不是 agent spawn agent）。
 * `createIssueResolutionSession` helper 11 项边界硬化复用 IPC AdapterCreateSession (`adapters.ts:105-182`)
 * 已生产多年的同款 pattern（参考 spike1-spawn-from-ipc.md 静态实证 6/6 pass）。
 *
 * **§D14 UI throttle 兜底**: in-flight Promise dedupe Map 守门 — 同 issueId 并发 click 期间
 * return 同 Promise,spawn 完成后清条目。
 *
 * **§D15 状态机**: IssuesUpdate 的 status patch transition 副作用走 issueRepo.update 内置（不在
 * 本文件复写）— 7 transition + 1 partial patch undefined idempotent + 1 zod enum reject 共 9 case
 * 已在 Step 3.2.2 repo 层 test 覆盖 8 case + 本文件 Step 3.5.6 IPC test 覆盖第 9 case (zod reject)。
 *
 * **handler 函数全 named export 模式**: ipcMain.handle 注册时直接调 named handler,test 端 import
 * 同 handler 验业务（避免 mock electron ipcMain 复杂度;与 session-hand-off-finalize.ts 同款 pattern）。
 */

import { homedir } from 'node:os';
import { IpcInvoke } from '@shared/ipc-channels';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { z } from 'zod';
import { adapterRegistry } from '@main/adapters/registry';
import {
  buildCreateSessionOptions,
  type AgentId,
} from '@main/adapters/options-builder';
import {
  resolveCreateSessionModelOptions,
  SessionModelOptionsError,
} from '@main/adapters/session-model-options';
import { sessionManager } from '@main/session/manager';
import { issueRepo } from '@main/store/issue-repo';
import { eventBus } from '@main/event-bus';
import log from '@main/utils/logger';
import {
  on,
  IpcInputError,
  parseStringId,
  parsePermissionMode,
  parseAdapterSessionMode,
  parseSandboxMode,
  parseCodexSandboxMode,
} from './_helpers';
import type { IssueRecord } from '@shared/types';

const logger = log.scope('ipc-issues');

// ═══════════════════════════════════════════════════════════════════════════
// zod schemas (§D7 / §D15 — status strict enum 第 9 case 在此层 reject)
// ═══════════════════════════════════════════════════════════════════════════

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

/**
 * UI 端 IssuesUpdate patch 入参。**status zod 严格 enum**（§D7 + §D15 第 9 case — repo 层不再校验,
 * zod 是唯一守门）。`resolutionSessionId` 不开放 UI 改（由 IssuesResolveInNewSession handler 内部
 * 写,UI 走专用 channel 不能直接 patch — 防止 UI 端误改导致 GC 时钟错位）。
 */
export const UPDATE_PATCH_SCHEMA = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2000).optional(),
  repro: z.string().min(1).max(2000).nullable().optional(),
  kind: z.string().min(1).max(32).optional(),
  status: ISSUE_STATUS_ENUM.optional(),
  severity: ISSUE_SEVERITY_ENUM.optional(),
  labels: z.array(z.string().min(1).max(64)).max(16).optional(),
}).strict();

/**
 * UI 「Resolve in new session」args。adapter / cwd / prompt 三必填（dialog D8 模板预填）;
 * permissionMode / sandbox optional 让 dialog 用户可选,默认走 adapter / settings 全局值。
 */
export const RESOLVE_IN_NEW_SESSION_SCHEMA = z.object({
  issueId: z.string().min(1).max(128),
  adapter: z.string().min(1).max(64),
  cwd: z.string().max(4096).optional(), // optional: fallback issue.cwd > homedir
  prompt: z.string().min(1).max(102400),
  permissionMode: z.string().optional(), // parsePermissionMode 内部白名单
  sessionMode: z.string().optional(),
  codexSandbox: z.string().optional(),
  claudeCodeSandbox: z.string().optional(),
  provider: z.string().max(128).optional(),
  model: z.string().max(256).optional(),
  thinking: z.string().optional(), // resolveCreateSessionModelOptions 内按 adapter 白名单校验
}).strict();

// ═══════════════════════════════════════════════════════════════════════════
// createIssueResolutionSession helper —— §Step 3.5.1 抽出 (D14 UI throttle 兜底前置)
//
// 11 项边界硬化（与 ipc/adapters.ts:105-182 AdapterCreateSession 同款,复用经过生产验证的
// pattern — 详 spike1-spawn-from-ipc.md 静态实证 6/6 pass）。
// ═══════════════════════════════════════════════════════════════════════════

interface CreateIssueResolutionSessionInput {
  adapter: string;
  cwd: string; // 已 fallback + 长度校验完
  prompt: string;
  permissionMode: ReturnType<typeof parsePermissionMode>;
  sessionMode?: ReturnType<typeof parseAdapterSessionMode>;
  codexSandbox: ReturnType<typeof parseCodexSandboxMode>;
  claudeCodeSandbox: ReturnType<typeof parseSandboxMode>;
  provider?: unknown;
  model?: unknown;
  thinking?: unknown;
}

export async function createIssueResolutionSession(input: CreateIssueResolutionSessionInput): Promise<string> {
  // §1+§2 adapter id 校验 + 反查（不可 `?.createSession` optional chain 吞错 — 与 §D14 一致）
  const validAdapterId = parseStringId('adapter', input.adapter, 64);
  const a = adapterRegistry.get(validAdapterId);
  if (!a) {
    throw new IpcInputError('adapter', `adapter "${validAdapterId}" not found in registry`);
  }
  if (!a.createSession) {
    throw new IpcInputError('adapter', `adapter "${validAdapterId}" does not implement createSession`);
  }
  // §3 canCreateSession capability 校验
  if (a.capabilities.canCreateSession !== true) {
    throw new IpcInputError('adapter', `adapter "${validAdapterId}" capabilities.canCreateSession=false`);
  }
  if (input.sessionMode != null) {
    if (!a.capabilities.canSetSessionMode) {
      throw new IpcInputError(
        'sessionMode',
        `adapter "${validAdapterId}" does not support session mode "${input.sessionMode}"`,
      );
    }
  }
  // §6 prompt 长度（zod 已 max 102400 守门）
  if (input.prompt.length > MAX_USER_MESSAGE_LENGTH) {
    throw new IpcInputError('prompt', `> 102400 chars (got ${input.prompt.length.toLocaleString()} chars)`);
  }
  // §5 cwd 长度（fallback 由调用方做完,这里只兜底 ≤4096）
  if (input.cwd.length > 4096) {
    throw new IpcInputError('cwd', `length > 4096 (got ${input.cwd.length})`);
  }
  let sessionModelOptions;
  try {
    sessionModelOptions = resolveCreateSessionModelOptions(validAdapterId as AgentId, {
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
    });
  } catch (error) {
    if (error instanceof SessionModelOptionsError) {
      throw new IpcInputError(error.field, error.message);
    }
    throw error;
  }
  // §9 调 adapter.createSession（§8 不支持 attachments — buildCreateSessionOptions 不传 attachments
  // 字段 → builder 走 attachments=[] 默认；helper signature 无 attachments 字段保接口最小）
  const sid = await a.createSession(
    buildCreateSessionOptions(validAdapterId, {
      cwd: input.cwd,
      prompt: input.prompt,
      ...(input.permissionMode !== null ? { permissionMode: input.permissionMode } : {}),
      ...(input.sessionMode != null ? { sessionMode: input.sessionMode } : {}),
      ...(input.codexSandbox !== null ? { codexSandbox: input.codexSandbox } : {}),
      ...(input.claudeCodeSandbox !== null ? { claudeCodeSandbox: input.claudeCodeSandbox } : {}),
      ...sessionModelOptions,
    }),
  );
  // §10 关键:recordCreatedPermissionMode 持久化（与 ipc/adapters.ts:182 同款 — 保证后续 SDK session
  // resume / recoverAndSend 从 sessionRepo 拿回用户主动选的 permissionMode 复原；漏调 = 项目
  // CLAUDE.md §会话恢复 / 断连 UX 硬约束破坏「用户上次主动选过的 acceptEdits / plan / bypassPermissions
  // 必须复原,恢复路径不能默认 default」）
  sessionManager.recordCreatedPermissionMode(sid, input.permissionMode ?? undefined);
  return sid;
}

// ═══════════════════════════════════════════════════════════════════════════
// §D14 UI throttle 兜底: in-flight Promise dedupe Map
// 同 issueId 并发 click 期间二次调用 return 同 Promise（避免 React 双 click / race 起 N 个并发
// SDK session）。spawn 完成 / 失败 finally 清条目让下次调用重新走 createSession。
// ═══════════════════════════════════════════════════════════════════════════
const inFlightResolve = new Map<string, Promise<{ sessionId: string; issue: IssueRecord }>>();

/** Test seam — vitest 端清 dedupe Map 让 beforeEach 干净（不暴露给生产 caller）。 */
export function _resetInFlightResolveForTesting(): void {
  inFlightResolve.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// Named handler exports (test 直接 import — 与 session-hand-off-finalize pattern 一致)
// ═══════════════════════════════════════════════════════════════════════════

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
  // detail 视图带 appendices；update 返回/emit 必须补齐（与 get/softDelete/undelete/resolve
  // handler 对称），否则 save 后 store/detail 的现场补充记录被裸记录覆盖消失直到重新 fetch
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

  // §D14 UI throttle 兜底: 同 issueId 并发 click 期间 return 同 Promise
  const cached = inFlightResolve.get(args.issueId);
  if (cached) {
    logger.info('[IssuesResolveInNewSession] reuse in-flight resolve', {
      issueId: args.issueId,
      adapter: args.adapter,
    });
    return cached;
  }

  const promise = (async () => {
    // §1 拿 issue（cwd fallback 链需要 issue.cwd）
    const issue = issueRepo.get(args.issueId);
    if (!issue) {
      throw new IpcInputError('issueId', `issue ${args.issueId} not found`);
    }
    // 入口守门: resolved / 已软删的 issue 不允许再起解决会话（UI 已隐藏按钮，但直接 IPC
    // 调用绕不过；同时是 spawn race 的第一道防线）
    if (issue.status === 'resolved') {
      throw new IpcInputError('issueId', `issue ${args.issueId} 已是 resolved，无需再起会话`);
    }
    if (issue.deletedAt !== null) {
      throw new IpcInputError('issueId', `issue ${args.issueId} 已删除，无法起会话`);
    }
    // §4 cwd fallback: non-empty args.cwd > non-empty issue.cwd > homedir
    const cwd =
      (args.cwd && args.cwd.trim().length > 0 && args.cwd.trim())
      || (issue.cwd && issue.cwd.trim().length > 0 && issue.cwd.trim())
      || homedir();
    // §7 默认 sandbox / permissionMode 走 adapter 默认 + 应用 settings 白名单 — parseXxx 接 unknown
    const permissionMode = parsePermissionMode(args.permissionMode);
    const sessionMode = parseAdapterSessionMode(args.sessionMode);
    const codexSandbox = parseCodexSandboxMode(args.codexSandbox);
    const claudeCodeSandbox = parseSandboxMode(args.claudeCodeSandbox);
    logger.info('[IssuesResolveInNewSession] spawning resolution session', {
      issueId: args.issueId,
      adapter: args.adapter,
      cwd,
      permissionMode,
      sessionMode,
      codexSandbox,
      claudeCodeSandbox,
      provider: args.provider?.trim() || null,
      model: args.model?.trim() || null,
      thinking: args.thinking ?? null,
      promptLength: args.prompt.length,
    });
    // §9-§10 起 SDK session + recordCreatedPermissionMode
    const sid = await createIssueResolutionSession({
      adapter: args.adapter,
      cwd,
      prompt: args.prompt,
      permissionMode,
      sessionMode,
      codexSandbox,
      claudeCodeSandbox,
      provider: args.provider,
      model: args.model,
      thinking: args.thinking,
    });
    logger.info('[IssuesResolveInNewSession] spawned resolution session', {
      issueId: args.issueId,
      adapter: args.adapter,
      sid,
    });
    // §11 写回 resolutionSessionId + status='in-progress'（不是 resolved — 让 user 后续手工 resolve）。
    // spawn 是异步窗口：用户可能在此期间 resolve / soft-delete 该 issue。re-read 后只在 issue
    // 仍 actionable（未 resolved + 未删）时才覆盖 status，否则只回写 resolutionSessionId 保住
    // 已起 session 的 link，不踩用户并发操作。
    const fresh = issueRepo.get(args.issueId);
    if (!fresh) {
      // 罕见 race: spawn 完成期间 issue 被另一处 hardDelete — sid 已起,记日志
      logger.warn('[IssuesResolveInNewSession] issue disappeared after spawn', {
        issueId: args.issueId,
        sid,
      });
      throw new IpcInputError('issueId', `issue ${args.issueId} disappeared during spawn`);
    }
    const stillActionable = fresh.status !== 'resolved' && fresh.deletedAt === null;
    const updated = issueRepo.update(args.issueId, {
      resolutionSessionId: sid,
      ...(stillActionable ? { status: 'in-progress' as const } : {}),
    });
    if (!updated) {
      logger.warn('[IssuesResolveInNewSession] issue disappeared before link update', {
        issueId: args.issueId,
        sid,
        freshStatus: fresh.status,
        freshDeletedAt: fresh.deletedAt,
      });
      throw new IpcInputError('issueId', `issue ${args.issueId} disappeared during spawn`);
    }
    updated.appendices = issueRepo.listAppendices(args.issueId);
    eventBus.emit('issue-changed', {
      kind: 'updated',
      issueId: updated.id,
      issue: updated,
      sourceSessionId: updated.sourceSessionId,
      ts: Date.now(),
    });
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
    // spawn 完成 / 失败 都清条目让下次调用重新走 createSession（不缓存失败 sid）
    inFlightResolve.delete(args.issueId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 主 registerIssuesIpc — ipcMain.handle 注册 6 个 channel 直调 named handler
// ═══════════════════════════════════════════════════════════════════════════

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
