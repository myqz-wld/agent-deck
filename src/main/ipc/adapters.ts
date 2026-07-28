/** Adapter creation, messaging, pending requests, and runtime-control IPC handlers. */
import { homedir } from 'node:os';
import { IpcInvoke } from '@shared/ipc-channels';
import { SDK_RESTART_RESUME_PROMPT } from '@shared/restart-prompts';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { adapterRegistry } from '@main/adapters/registry';
import { buildCreateSessionOptions, isAgentId } from '@main/adapters/options-builder';
import {
  getAdapterRuntimeProfile,
  isSessionAdapterId,
} from '@main/adapters/runtime-profiles';
import {
  resolveCreateSessionModelOptions,
  SessionModelOptionsError,
} from '@main/adapters/session-model-options';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { agentDeckTeamRepo, TeamInvariantError } from '@main/store/agent-deck-team-repo';
import { eventBus } from '@main/event-bus';
import { planReviewService } from '@main/plan-review/service';
import { diffReviewService } from '@main/diff-review/service';
import {
  on,
  IpcInputError,
  parseStringId,
  parseAdapterSessionMode,
  parsePermissionMode,
  parseTeamName,
} from './_helpers';
import { deleteUploadIfExists } from '@main/store/image-uploads';
import { persistAdapterAttachments } from './adapters-attachments';
import { registerSessionModelOptionsIpc } from './adapters-session-model-options';
import { registerAdapterSessionCreationDefaultsIpc } from './adapters-session-creation-defaults';
import { registerAdapterOutgoingIpc } from './adapters-outgoing';
import {
  parseAdapterCreateRuntimeControls,
  registerAdapterSandboxRestartIpc,
} from './adapters-runtime-controls';
import log from '@main/utils/logger';

const logger = log.scope('ipc-adapters');
type PendingRequestList = Array<{ requestId: string }>;
function mergePendingRequests<T extends { requestId: string }>(base: T[], extra: T[]): T[] {
  if (extra.length === 0) return base;
  const seen = new Set(base.map((req) => req.requestId));
  return [...base, ...extra.filter((req) => !seen.has(req.requestId))];
}

export function registerAdaptersIpc(): void {
  registerSessionModelOptionsIpc();
  registerAdapterSessionCreationDefaultsIpc();
  registerAdapterOutgoingIpc();
  registerAdapterSandboxRestartIpc();
  // Adapter actions (createSession 在 M9 实现 SDK 通道后才会真正可用)
  on(IpcInvoke.AdapterList, () => {
    return adapterRegistry.list().map((a) => ({
      id: a.id,
      displayName: a.displayName,
      capabilities: a.capabilities,
      sessionModes: isSessionAdapterId(a.id)
        ? [...getAdapterRuntimeProfile(a.id).runtimeControls.sessionModes]
        : [],
    }));
  });
  on(IpcInvoke.AdapterCreateSession, async (_e, agentId, opts) => {
    const validAgentId = parseStringId('agentId', agentId, 64);
    if (!isAgentId(validAgentId)) {
      throw new IpcInputError('agentId', 'unknown adapter');
    }
    const adapter = adapterRegistry.get(validAgentId);
    if (!adapter?.createSession) throw new Error('adapter cannot create session');
    if (opts === undefined || opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new IpcInputError('opts', 'must be object');
    }
    const raw = opts as Record<string, unknown>;
    // cwd：留空 / 非字符串 → 兜底 homedir。renderer 对话框允许「不填」，CLI 也共用这条兜底。
    const cwdInput = raw.cwd;
    const cwd =
      typeof cwdInput === 'string' && cwdInput.trim().length > 0 ? cwdInput.trim() : homedir();
    if (cwd.length > 4096) {
      throw new IpcInputError('opts.cwd', 'length > 4096');
    }
    const {
      permissionMode,
      sessionMode,
      approvalPolicy,
      codexSandbox,
      claudeCodeSandbox,
      grokSandbox,
      extraAllowWrite,
    } = parseAdapterCreateRuntimeControls(validAgentId, raw);
    const prompt = typeof raw.prompt === 'string' ? raw.prompt : undefined;
    // REVIEW_4 M4 + REVIEW_24 HIGH-2 follow-up：首条 prompt 走 102_400 字符上限（与
    // sdk-bridge MAX_MESSAGE_LENGTH + agent-deck-message-repo MAX_BODY_LENGTH 全局对齐）
    if (prompt !== undefined && prompt.length > MAX_USER_MESSAGE_LENGTH) {
      throw new IpcInputError(
        'opts.prompt',
        `> 102400 chars (got ${prompt.length.toLocaleString()} chars)`,
      );
    }
    const resume = typeof raw.resume === 'string' ? raw.resume : undefined;
    // CHANGELOG_46：NewSessionDialog 已删 teamName 输入框；team 名由 lead 在会话内自由决定，
    // 应用通过 PreToolUse hook / fs watcher / hook 三层反向同步到 sessions.team_name DB 列。
    // 但 IPC 入口仍接 raw.teamName 兼容 CLI `agent-deck new --team-name` 命令（如有）。
    const teamName = parseTeamName(raw.teamName);
    let sessionModelOptions;
    try {
      sessionModelOptions = resolveCreateSessionModelOptions(validAgentId, {
        provider: raw.provider,
        model: raw.model,
        thinking: raw.thinking,
      });
    } catch (error) {
      if (error instanceof SessionModelOptionsError) {
        throw new IpcInputError(`opts.${error.field}`, error.message);
      }
      throw error;
    }

    // REVIEW_35 R2 HIGH-D codex H1：last-line defense — adapter 不支持 attachments 时拒绝。
    // createSession 同 sendMessage 路径同样 enforce，防 NewSessionDialog / 测试 / 直接 IPC 绕过 ComposerSdk gate。
    if (raw.attachments && Array.isArray(raw.attachments) && raw.attachments.length > 0
        && !adapter.capabilities.canAcceptAttachments) {
      throw new IpcInputError(
        'opts.attachments',
        `adapter "${agentId}" does not support attachments`,
      );
    }
    // attachments 写盘：失败 throw 已回滚兄弟附件。createSession throw 时本 handler 同款回滚。
    const attachments = await persistAdapterAttachments(raw.attachments, 'opts.attachments');
    let sid: string;
    try {
      // p4-d2-impl Step 2.1：用 buildCreateSessionOptions builder helper 按 agentId narrow
      // 到对应 union arm。agentId 是 parseStringId 后的 string,走 string overload 内部
      // isAgentId guard,invalid throw（caller 已 line 107 验过 adapter 存在 +
      // line 161-169 验 attachments capability,到此 agentId 应都是合法 union 成员）。
      const createOptions = buildCreateSessionOptions(validAgentId, {
        cwd,
        prompt,
        ...(permissionMode !== null ? { permissionMode } : {}),
        ...(sessionMode !== null ? { sessionMode } : {}),
        ...(resume !== undefined ? { resume } : {}),
        ...(teamName !== null ? { teamName } : {}),
        ...(codexSandbox !== null ? { codexSandbox } : {}),
        ...(claudeCodeSandbox !== null ? { claudeCodeSandbox } : {}),
        ...(grokSandbox !== null ? { grokSandbox } : {}),
        ...(extraAllowWrite !== null ? { extraAllowWrite } : {}),
        ...sessionModelOptions,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      // Human UI creation may override Codex's thread-wide approval policy. Keep this out of the
      // public MCP builder contract; the bridge persists the explicit value for resume/recovery.
      if (createOptions.agentId === 'codex-cli' && approvalPolicy !== null) {
        createOptions.approvalPolicy = approvalPolicy;
      }
      sid = await adapter.createSession(createOptions);
    } catch (err) {
      // createSession 失败：path 还没塞进 SDK 队列，安全清干净
      await Promise.all(attachments.map((r) => deleteUploadIfExists(r.path)));
      throw err;
    }
    // 持久化 permissionMode：抽到 sessionManager.recordCreatedPermissionMode，
    // CLI 路径（cli.ts applyCliInvocation）也走同一个 helper，确保两条入口语义一致。
    // REVIEW_108 MED-3：与 mcp spawn_session handler（spawn.ts:364-380）对称，把
    // recordCreatedPermissionMode 包成 capability gate + try/catch warn-only。helper
    // 内部 setPermissionMode(DB 写) + sessionRepo.get(DB 读) + eventBus.emit（同步派发
    // 监听器，任一监听器抛会冒泡）三处可抛。修前裸调抛错会越过 handler → caller 收 IPC
    // error 拿不到 sid，而 SDK 子进程已起 → 孤儿活 session + caller 可能重试重复 create。
    // permissionMode 持久化失败最坏 fallback 默认 mode，远比孤儿活 session 轻 → 失败
    // 仅 warn 不阻塞 createSession 成功返回。capability gate 与 cli.ts:285 对齐（codex
    // arm canSetPermissionMode=false，跳过避免 codex session 落无意义 permission_mode 列）。
    if (permissionMode !== null && adapter.capabilities.canSetPermissionMode) {
      try {
        sessionManager.recordCreatedPermissionMode(sid, permissionMode);
      } catch (e) {
        logger.warn(
          `[ipc createSession] recordCreatedPermissionMode(${sid}, ${permissionMode}) failed:`,
          e,
        );
      }
    }
    // plan team-cohesion-fix-20260513 Phase A Step A8：删 sessionManager.recordCreatedTeamName，
    // 改走 universal team backend ensureByName + addMember(role:'teammate')。IPC 入口
    // (agent-deck new --team-name X) 不知道 session 是 lead 还是 teammate，按 teammate 安全加入；
    // 如要明确 lead 角色走 spawn_session MCP tool。
    if (teamName) {
      try {
        const team = agentDeckTeamRepo.ensureByName(teamName, { source: 'cli' });
        try {
          agentDeckTeamRepo.addMember({
            teamId: team.id,
            sessionId: sid,
            role: 'teammate',
            displayName: null,
          });
          sessionManager.notifyTeamMembershipChanged(sid);
          // REVIEW_35 MED-A7：emit `agent-deck-team-member-changed` 让 universal-message-watcher
          // dispatcher 收到 → fan-out member-joined adapter event 给同 team active member。
          // 修前 spawn / cli / ipc.adapters 三条路径只刷 UI 不通知 adapter chain。
          eventBus.emit('agent-deck-team-member-changed', {
            teamId: team.id,
            sessionId: sid,
            kind: 'joined',
          });
        } catch (e) {
          // 已 active 时 invariant 抛错；幂等成功
          if (!(e instanceof TeamInvariantError)) throw e;
        }
      } catch (e) {
        logger.warn(`[ipc adapters createSession] team ensure / addMember failed for "${teamName}":`, e);
      }
    }
    return sid;
  });
  on(IpcInvoke.AdapterInterrupt, async (_e, agentId, sessionId) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
    if (!adapter?.interruptSession) throw new Error('adapter cannot interrupt');
    await adapter.interruptSession(parseStringId('sessionId', sessionId));
    return true;
  });
  on(IpcInvoke.AdapterSteerTurn, async (_e, agentId, sessionId, text) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
    if (!adapter?.steerTurn || adapter.capabilities.canSteerTurn !== true) {
      throw new Error('adapter cannot steer active turn');
    }
    if (typeof text !== 'string') {
      throw new IpcInputError('text', 'must be string');
    }
    if (text.length > MAX_USER_MESSAGE_LENGTH) {
      throw new IpcInputError('text', `> 102400 chars (got ${text.length.toLocaleString()} chars)`);
    }
    await adapter.steerTurn(parseStringId('sessionId', sessionId), text);
    return true;
  });
  on(IpcInvoke.AdapterRespondPermission, async (_e, agentId, sessionId, requestId, response) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
    if (!adapter?.respondPermission) throw new Error('adapter cannot respond to permission');
    await adapter.respondPermission(
      parseStringId('sessionId', sessionId),
      parseStringId('requestId', requestId),
      response as Parameters<NonNullable<typeof adapter.respondPermission>>[2],
    );
    return true;
  });
  on(IpcInvoke.AdapterRespondAskUserQuestion, async (_e, agentId, sessionId, requestId, answer) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
    if (!adapter?.respondAskUserQuestion) {
      throw new Error('adapter cannot respond to AskUserQuestion');
    }
    await adapter.respondAskUserQuestion(
      parseStringId('sessionId', sessionId),
      parseStringId('requestId', requestId),
      answer as Parameters<NonNullable<typeof adapter.respondAskUserQuestion>>[2],
    );
    return true;
  });
  on(IpcInvoke.AdapterRespondExitPlanMode, async (_e, agentId, sessionId, requestId, response) => {
    const sid = parseStringId('sessionId', sessionId);
    const rid = parseStringId('requestId', requestId);
    const resolvedSessionId = await planReviewService.respond(
      sid,
      rid,
      response as Parameters<typeof planReviewService.respond>[2],
    );
    if (resolvedSessionId) return { resolvedSessionId };
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
    if (!adapter?.respondExitPlanMode) {
      throw new Error('adapter cannot respond to ExitPlanMode');
    }
    await adapter.respondExitPlanMode(
      sid,
      rid,
      response as Parameters<NonNullable<typeof adapter.respondExitPlanMode>>[2],
    );
    return { resolvedSessionId: sid };
  });
  on(IpcInvoke.AdapterRespondDiffReview, async (_e, _agentId, sessionId, requestId, response) => {
    const sid = parseStringId('sessionId', sessionId);
    const rid = parseStringId('requestId', requestId);
    if (
      diffReviewService.respond(
        sid,
        rid,
        response as Parameters<typeof diffReviewService.respond>[2],
      )
    ) {
      return true;
    }
    throw new Error('diff review request not found');
  });
  on(IpcInvoke.AdapterSetPermissionMode, async (_e, agentId, sessionId, mode) => {
    const validAgentId = parseStringId('agentId', agentId, 64);
    const adapter = adapterRegistry.get(validAgentId);
    if (!adapter?.setPermissionMode) throw new Error('adapter cannot set permission mode');
    const sid = parseStringId('sessionId', sessionId);
    // mode 必须是非空白名单值（与同文件 AdapterCreateSession 走 parsePermissionMode
    // 范式对称，REVIEW_108 MED-2）。undefined / null / 非白名单 → IpcInputError 拒绝，
    // 防止 raw cast 漏掉 bypass 冷切分支 + 把非法值直写 DB。
    if (mode === undefined || mode === null) {
      throw new IpcInputError(
        'mode',
        'required (one of default|acceptEdits|plan|auto|bypassPermissions)',
      );
    }
    const m = parsePermissionMode(mode) as Parameters<NonNullable<typeof adapter.setPermissionMode>>[1];
    // bypassPermissions 必须冷切：SDK 的 allowDangerouslySkipPermissions flag 在子进程
    // 启动时锁死，运行时热切会被 SDK 静默吞（用户体感「切了但还在询问」）。
    // 冷切走 restartWithPermissionMode 销毁旧子进程 + 用新 flag 重建（复用 recoverAndSend
    // 的 H4/H1 全套护栏）。renderer 端两个入口（SessionDetail 下拉、PendingTab 批准 bypass）
    // 收口到此方法，行为一致。restartWithPermissionMode 内部已写 DB + emit upsert，
    // 失败时回滚 DB + emit error message，本 handler 不重复处理。
    if (m === 'bypassPermissions' && adapter.restartWithPermissionMode) {
      await adapter.restartWithPermissionMode(sid, m, SDK_RESTART_RESUME_PROMPT);
      return true;
    }
    // REVIEW_11 Bug 2 次因：DB 写 + emit upsert 必须先于 SDK 调用，且 SDK 失败要回滚。
    // 旧顺序（先 SDK → 再 DB）的 hazard：adapter.setPermissionMode 抛错时（典型：SDK Query
    // 已 close 命中 sdk-bridge.ts:1148 throw 'session not found'），跳过 DB 写 + emit upsert，
    // 导致 catch 在 renderer 的 setPmError 弹错但 store 仍是旧 mode；用户看到红字、再次切档时
    // 又是旧值起点 → UI / DB / SDK 三方不一致。修法范式与 restartWithPermissionMode 内部一致：
    // 先写 DB + emit upsert（让 UI 立即响应），SDK 失败 catch 回滚 DB 到 oldMode + emit upsert + 重抛。
    const oldMode = sessionRepo.get(sid)?.permissionMode ?? null;
    sessionRepo.setPermissionMode(sid, m);
    {
      const updated = sessionRepo.get(sid);
      if (updated) eventBus.emit('session-upserted', updated);
    }
    try {
      await adapter.setPermissionMode(sid, m);
    } catch (err) {
      sessionRepo.setPermissionMode(sid, oldMode);
      const reverted = sessionRepo.get(sid);
      if (reverted) eventBus.emit('session-upserted', reverted);
      throw err;
    }
    return true;
  });

  on(IpcInvoke.AdapterSetSessionMode, async (_e, agentId, sessionId, mode) => {
    const validAgentId = parseStringId('agentId', agentId, 64);
    if (!isAgentId(validAgentId)) {
      throw new IpcInputError('agentId', 'unknown adapter');
    }
    const adapter = adapterRegistry.get(validAgentId);
    if (!adapter?.capabilities.canSetSessionMode || !adapter.setSessionMode) {
      throw new Error('adapter cannot set session mode');
    }
    const sid = parseStringId('sessionId', sessionId);
    const record = sessionRepo.get(sid);
    if (!record) throw new Error(`session ${sid} not found`);
    if (record.agentId !== validAgentId) {
      throw new IpcInputError('agentId', `does not own session ${sid}`);
    }
    if (record.source !== 'sdk') {
      throw new Error('external CLI sessions cannot be reconfigured by Agent Deck');
    }
    const next = parseAdapterSessionMode(mode);
    if (next === null) {
      throw new IpcInputError('mode', 'required');
    }
    const allowed = getAdapterRuntimeProfile(validAgentId).runtimeControls.sessionModes;
    if (!allowed.includes(next)) {
      throw new IpcInputError(
        'mode',
        `adapter "${validAgentId}" does not support session mode "${next}"`,
      );
    }

    const previous = record.sessionMode ?? null;
    sessionRepo.setSessionMode(sid, next);
    const updated = sessionRepo.get(sid);
    if (updated) eventBus.emit('session-upserted', updated);
    try {
      await adapter.setSessionMode(sid, next);
    } catch (error) {
      sessionRepo.setSessionMode(sid, previous);
      const reverted = sessionRepo.get(sid);
      if (reverted) eventBus.emit('session-upserted', reverted);
      throw error;
    }
    return true;
  });

  on(IpcInvoke.AdapterListPending, (_e, agentId, sessionId) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
    const sid = parseStringId('sessionId', sessionId);
    const base = adapter?.listPending
      ? adapter.listPending(sid)
      : { permissions: [], askQuestions: [], exitPlanModes: [] };
    return {
      ...base,
      exitPlanModes: mergePendingRequests(base.exitPlanModes, planReviewService.listPending(sid)),
      diffReviews: diffReviewService.listPending(sid),
    };
  });
  on(IpcInvoke.AdapterListPendingAll, (_e, agentId) => {
    const validAgentId = parseStringId('agentId', agentId, 64);
    const adapter = adapterRegistry.get(validAgentId);
    const out: Record<
      string,
      {
        permissions: PendingRequestList;
        askQuestions: PendingRequestList;
        exitPlanModes: PendingRequestList;
        diffReviews?: PendingRequestList;
      }
    > = adapter?.listAllPending ? adapter.listAllPending() : {};
    const mcpPlanReviews = planReviewService.listAllPending(validAgentId);
    for (const [sid, exitPlanModes] of Object.entries(mcpPlanReviews)) {
      const cur = out[sid] ?? { permissions: [], askQuestions: [], exitPlanModes: [] };
      out[sid] = {
        ...cur,
        exitPlanModes: mergePendingRequests(cur.exitPlanModes, exitPlanModes),
      };
    }
    const mcpDiffReviews = diffReviewService.listAllPending(validAgentId);
    for (const [sid, diffReviews] of Object.entries(mcpDiffReviews)) {
      const cur = out[sid] ?? { permissions: [], askQuestions: [], exitPlanModes: [] };
      out[sid] = {
        ...cur,
        diffReviews: mergePendingRequests(cur.diffReviews ?? [], diffReviews),
      };
    }
    return out;
  });

}
