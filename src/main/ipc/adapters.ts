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
  parseCodexSandboxMode,
} from './_helpers';
import {
  writeUploadedImage,
  deleteUploadIfExists,
} from '@main/store/image-uploads';
import { MAX_TOTAL_ATTACHMENTS_BYTES } from './_image-constants';
import type {
  GenericPtyConfig,
  UploadedAttachmentInput,
  UploadedAttachmentRef,
} from '@shared/types';
import { parseGenericPtyConfig } from '@shared/types';

/**
 * 校验 + 写盘 attachments。失败抛错，由调用方决定回滚兄弟附件。
 *
 * 校验链：
 * - 必须是数组
 * - 每个元素必须是 UploadedAttachmentInput shape
 * - bytes 总和 ≤ MAX_TOTAL_ATTACHMENTS_BYTES（30MB）
 * - 单图校验在 writeUploadedImage 内（mime 反查 ext / base64 实测对账 / 单图 ≤ 20MB）
 *
 * 失败回滚：调用方 catch 后 deleteUploadIfExists 已落盘的 refs。
 */
async function persistAttachments(
  raw: unknown,
  fieldName: string,
): Promise<UploadedAttachmentRef[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new IpcInputError(fieldName, 'must be array');
  }
  if (raw.length === 0) return [];
  if (raw.length > 20) {
    // 上限 20 张/条：避免 renderer 误投或恶意构造
    throw new IpcInputError(fieldName, `> 20 attachments (got ${raw.length})`);
  }
  let totalBytes = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new IpcInputError(fieldName, 'each item must be object');
    }
    const it = item as Partial<UploadedAttachmentInput>;
    if (it.kind !== 'image' || typeof it.base64 !== 'string' || typeof it.mime !== 'string') {
      throw new IpcInputError(fieldName, 'each item must be UploadedAttachmentInput');
    }
    if (typeof it.bytes !== 'number' || !Number.isFinite(it.bytes) || it.bytes < 0) {
      throw new IpcInputError(fieldName, 'each item.bytes must be non-negative number');
    }
    totalBytes += it.bytes;
  }
  if (totalBytes > MAX_TOTAL_ATTACHMENTS_BYTES) {
    throw new IpcInputError(
      fieldName,
      `total ${(totalBytes / 1024 / 1024).toFixed(1)}MB > ${MAX_TOTAL_ATTACHMENTS_BYTES / 1024 / 1024}MB limit`,
    );
  }
  const written: UploadedAttachmentRef[] = [];
  try {
    for (const item of raw as UploadedAttachmentInput[]) {
      const ref = await writeUploadedImage(item);
      written.push(ref);
    }
    return written;
  } catch (err) {
    // 任一图写盘失败 → 回滚已写的兄弟（best-effort）
    await Promise.all(written.map((r) => deleteUploadIfExists(r.path)));
    throw err;
  }
}

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
    // REVIEW_4 M4 + REVIEW_24 HIGH-2 follow-up：首条 prompt 走 102_400 字符上限（与
    // sdk-bridge MAX_MESSAGE_LENGTH + agent-deck-message-repo MAX_BODY_LENGTH 全局对齐）
    if (prompt !== undefined && prompt.length > 102_400) {
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
    // codexSandbox per-session 覆盖（CHANGELOG_<X>）：仅 codex-cli adapter 接收并起效，
    // 其它 adapter 静默忽略（types.ts CreateSessionOptions 通用接口加字段是约定，
    // 与 teamName / model 同模式 — 通用接口兜，adapter 自行实现）。
    // 白名单走 parseCodexSandboxMode；null = 不传 → adapter 用 settings.codexSandbox 全局值。
    const codexSandbox = parseCodexSandboxMode(raw.codexSandbox);
    // R4·F2：generic-pty / aider 专属 spawn config 透传（其它 adapter 静默忽略）。
    // zod parse 防 IPC bypass 灌入 number / undefined（schema min(1) 强制 command 非空）。
    // raw.genericPtyConfig === undefined → 不传字段，adapter fallback 走 preset；
    // 任意非 undefined 值都走 zod parse，invalid 直接 throw（renderer 层应已 zod parse 一次）。
    let genericPtyConfig: GenericPtyConfig | null = null;
    if (raw.genericPtyConfig !== undefined) {
      try {
        genericPtyConfig = parseGenericPtyConfig(raw.genericPtyConfig);
      } catch (err) {
        throw new IpcInputError(
          'opts.genericPtyConfig',
          `zod parse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // attachments 写盘：失败 throw 已回滚兄弟附件。createSession throw 时本 handler 同款回滚。
    const attachments = await persistAttachments(raw.attachments, 'opts.attachments');
    let sid: string;
    try {
      sid = await adapter.createSession({
        cwd,
        prompt,
        ...(permissionMode !== null ? { permissionMode } : {}),
        ...(resume !== undefined ? { resume } : {}),
        ...(teamName !== null ? { teamName } : {}),
        ...(codexSandbox !== null ? { codexSandbox } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(genericPtyConfig !== null ? { genericPtyConfig } : {}),
      });
    } catch (err) {
      // createSession 失败：path 还没塞进 SDK 队列，安全清干净
      await Promise.all(attachments.map((r) => deleteUploadIfExists(r.path)));
      throw err;
    }
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
  on(IpcInvoke.AdapterSendMessage, async (_e, agentId, sessionId, payload) => {
    const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
    if (!adapter?.sendMessage) throw new Error('adapter cannot send message');
    // 兼容老 IPC 调用方传 `text: string`（向后兼容，避免漏改 break）+
    // 新 envelope 形式 `{text, attachments?}`（带图）。
    let text: string;
    let rawAttachments: unknown = undefined;
    if (typeof payload === 'string') {
      text = payload;
    } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const env = payload as { text?: unknown; attachments?: unknown };
      if (typeof env.text !== 'string') {
        throw new IpcInputError('payload.text', 'must be string');
      }
      text = env.text;
      rawAttachments = env.attachments;
    } else {
      throw new IpcInputError('payload', 'must be string or {text, attachments?}');
    }
    // REVIEW_4 M4 + REVIEW_24 HIGH-2 follow-up：单条消息上限 102_400 字符（与 sdk-bridge
    // MAX_MESSAGE_LENGTH + agent-deck-message-repo MAX_BODY_LENGTH 全局对齐）
    if (text.length > 102_400) {
      throw new IpcInputError('text', `> 102400 chars (got ${text.length.toLocaleString()} chars)`);
    }
    // attachments 写盘：失败 throw 已回滚兄弟附件。sendMessage throw 时本 handler 同款回滚。
    const attachments = await persistAttachments(rawAttachments, 'attachments');
    try {
      await adapter.sendMessage(parseStringId('sessionId', sessionId), text, attachments);
    } catch (err) {
      // sendMessage throw：path 还没塞进 SDK 队列（adapter 内部入队前 throw），安全清干净
      // ⚠ 关键护栏：成功路径**不**清，因为 adapter 已把 path 塞进 pendingMessages 队列，
      //   清了 codex 子进程消费时 ENOENT。
      await Promise.all(attachments.map((r) => deleteUploadIfExists(r.path)));
      throw err;
    }
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

  /**
   * CHANGELOG_<X> A2b：codex 专属冷切 sandbox 档位。
   *
   * 与 AdapterSetPermissionMode 不同：codex 没有 PermissionMode 概念，sandbox 档位
   * 是 startThread/resumeThread spawn-time 锁定，无法热切。adapter 内部走
   * close → resumeThread(new sandbox) → handoffPrompt 触发首条 turn。失败回滚 DB。
   *
   * 校验：adapter 必须存在 + capabilities.canRestartWithCodexSandbox === true +
   * 实现了 restartWithCodexSandbox 方法（典型 = codex-cli adapter）。
   */
  on(
    IpcInvoke.AdapterRestartWithCodexSandbox,
    async (_e, agentId, sessionId, sandbox, handoffPrompt) => {
      const adapter = adapterRegistry.get(String(agentId));
      if (!adapter?.capabilities.canRestartWithCodexSandbox || !adapter.restartWithCodexSandbox) {
        throw new Error('adapter does not support codex sandbox restart');
      }
      const sid = String(sessionId);
      const sb = String(sandbox) as 'workspace-write' | 'read-only' | 'danger-full-access';
      if (sb !== 'workspace-write' && sb !== 'read-only' && sb !== 'danger-full-access') {
        throw new Error(`invalid codex sandbox: ${sb}`);
      }
      const prompt = String(handoffPrompt ?? '');
      // adapter.restartWithCodexSandbox 内部已 emit error / 回滚 DB；本 handler 直接透传
      // 返回值（重启后的 sessionId，与 claude restartWithPermissionMode 接口签名对齐）。
      return adapter.restartWithCodexSandbox(sid, sb, prompt);
    },
  );
}
