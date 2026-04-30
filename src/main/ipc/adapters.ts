/**
 * Adapter*：createSession / interrupt / sendMessage / RespondPermission /
 * RespondAskUserQuestion / RespondExitPlanMode / SetPermissionMode / ListPending(All)。
 *
 * 重点护栏（保持不变）：
 * - SetPermissionMode 的 bypassPermissions 走冷切（restartWithPermissionMode），见 REVIEW_11 Bug 2 次因
 * - SetPermissionMode 「先 DB 后 SDK」+ 失败回滚 DB + emit upsert 重抛
 * - createSession 走 sessionManager.recordCreatedPermissionMode / recordCreatedTeamName
 *   持久化（与 cli.ts applyCliInvocation 共享同一组 helper）
 */
import { homedir } from 'node:os';
import { IpcInvoke } from '@shared/ipc-channels';
import { adapterRegistry } from '@main/adapters/registry';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import {
  on,
  IpcInputError,
  parseStringId,
  parsePermissionMode,
  parseTeamName,
} from './_helpers';

export function registerAdaptersIpc(): void {
  // Adapter actions (createSession 在 M9 实现 SDK 通道后才会真正可用)
  on(IpcInvoke.AdapterList, () => {
    return adapterRegistry.list().map((a) => ({
      id: a.id,
      displayName: a.displayName,
      capabilities: a.capabilities,
    }));
  });
  on(IpcInvoke.AdapterCreateSession, async (_e, agentId, opts) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
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
    // permissionMode 白名单：renderer 可塞任意字符串，必须收口
    const permissionMode = parsePermissionMode(raw.permissionMode);
    const prompt = typeof raw.prompt === 'string' ? raw.prompt : undefined;
    // REVIEW_4 M4：首条 prompt 也走 100KB 上限（与 sdk-bridge MAX_MESSAGE_BYTES 对齐）
    if (prompt !== undefined && Buffer.byteLength(prompt, 'utf8') > 100_000) {
      throw new IpcInputError(
        'opts.prompt',
        `> 100KB (got ${Buffer.byteLength(prompt, 'utf8')} bytes)`,
      );
    }
    const model = typeof raw.model === 'string' ? raw.model : undefined;
    const resume = typeof raw.resume === 'string' ? raw.resume : undefined;
    // CHANGELOG_46：NewSessionDialog 已删 teamName 输入框；team 名由 lead 在会话内自由决定，
    // 应用通过 PreToolUse hook / fs watcher / hook 三层反向同步到 sessions.team_name DB 列。
    // 但 IPC 入口仍接 raw.teamName 兼容 CLI `agent-deck new --team-name` 命令（如有）。
    const teamName = parseTeamName(raw.teamName);

    const sid = await adapter.createSession({
      cwd,
      prompt,
      model,
      ...(permissionMode !== null ? { permissionMode } : {}),
      ...(resume !== undefined ? { resume } : {}),
      ...(teamName !== null ? { teamName } : {}),
    });
    // 持久化 permissionMode：抽到 sessionManager.recordCreatedPermissionMode，
    // CLI 路径（cli.ts applyCliInvocation）也走同一个 helper，确保两条入口语义一致。
    sessionManager.recordCreatedPermissionMode(sid, permissionMode ?? undefined);
    // CHANGELOG_46：删 recordCreatedTeamName 调用 — 不再 IPC 入口预写 sessions.team_name；
    // 让 team-coordinator 三层反向同步去写。仅当 CLI 入口（agent-deck new --team-name）
    // 显式传 teamName 时才预写（兼容老入口；用户也确实想预指定 team）。
    if (teamName) {
      sessionManager.recordCreatedTeamName(sid, teamName);
    }
    return sid;
  });
  on(IpcInvoke.AdapterInterrupt, async (_e, agentId, sessionId) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
    if (!adapter?.interruptSession) throw new Error('adapter cannot interrupt');
    await adapter.interruptSession(parseStringId('sessionId', sessionId));
    return true;
  });
  on(IpcInvoke.AdapterSendMessage, async (_e, agentId, sessionId, text) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
    if (!adapter?.sendMessage) throw new Error('adapter cannot send message');
    if (typeof text !== 'string') {
      throw new IpcInputError('text', 'must be string');
    }
    // 单条消息上限 100KB，与 sdk-bridge MAX_MESSAGE_BYTES 对齐（REVIEW_4 M4 同主题，前置在 IPC 层）
    if (Buffer.byteLength(text, 'utf8') > 100_000) {
      throw new IpcInputError('text', `> 100KB (got ${Buffer.byteLength(text, 'utf8')} bytes)`);
    }
    await adapter.sendMessage(parseStringId('sessionId', sessionId), text);
    return true;
  });
  on(IpcInvoke.AdapterRespondPermission, async (_e, agentId, sessionId, requestId, response) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.respondPermission) throw new Error('adapter cannot respond to permission');
    await adapter.respondPermission(
      String(sessionId),
      String(requestId),
      response as Parameters<NonNullable<typeof adapter.respondPermission>>[2],
    );
    return true;
  });
  on(IpcInvoke.AdapterRespondAskUserQuestion, async (_e, agentId, sessionId, requestId, answer) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.respondAskUserQuestion) {
      throw new Error('adapter cannot respond to AskUserQuestion');
    }
    await adapter.respondAskUserQuestion(
      String(sessionId),
      String(requestId),
      answer as Parameters<NonNullable<typeof adapter.respondAskUserQuestion>>[2],
    );
    return true;
  });
  on(IpcInvoke.AdapterRespondExitPlanMode, async (_e, agentId, sessionId, requestId, response) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.respondExitPlanMode) {
      throw new Error('adapter cannot respond to ExitPlanMode');
    }
    await adapter.respondExitPlanMode(
      String(sessionId),
      String(requestId),
      response as Parameters<NonNullable<typeof adapter.respondExitPlanMode>>[2],
    );
    return true;
  });
  on(IpcInvoke.AdapterSetPermissionMode, async (_e, agentId, sessionId, mode) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.setPermissionMode) throw new Error('adapter cannot set permission mode');
    const sid = String(sessionId);
    const m = mode as Parameters<NonNullable<typeof adapter.setPermissionMode>>[1];
    // bypassPermissions 必须冷切：SDK 的 allowDangerouslySkipPermissions flag 在子进程
    // 启动时锁死，运行时热切会被 SDK 静默吞（用户体感「切了但还在询问」）。
    // 冷切走 restartWithPermissionMode 销毁旧子进程 + 用新 flag 重建（复用 recoverAndSend
    // 的 H4/H1 全套护栏）。renderer 端两个入口（SessionDetail 下拉、PendingTab 批准 bypass）
    // 收口到此方法，行为一致。restartWithPermissionMode 内部已写 DB + emit upsert，
    // 失败时回滚 DB + emit error message，本 handler 不重复处理。
    if (m === 'bypassPermissions' && adapter.restartWithPermissionMode) {
      await adapter.restartWithPermissionMode(sid, m, '继续之前的会话');
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

  on(IpcInvoke.AdapterListPending, (_e, agentId, sessionId) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.listPending) return { permissions: [], askQuestions: [], exitPlanModes: [] };
    return adapter.listPending(String(sessionId));
  });
  on(IpcInvoke.AdapterListPendingAll, (_e, agentId) => {
    const adapter = adapterRegistry.get(String(agentId));
    if (!adapter?.listAllPending) return {};
    return adapter.listAllPending();
  });
}
