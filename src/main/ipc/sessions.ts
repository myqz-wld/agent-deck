/**
 * Session 列表 / 详情 / 归档 / 删除 / 历史 IPC handler。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IpcInvoke } from '@shared/ipc-channels';
import { sessionManager } from '@main/session/manager';
import { sessionRepo, SessionRowMissingError } from '@main/store/session-repo';
import { eventRepo } from '@main/store/event-repo';
import { fileChangeRepo } from '@main/store/file-change-repo';
import { summaryRepo } from '@main/store/summary-repo';
import { taskRepo } from '@main/store/task-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { settingsStore } from '@main/store/settings-store';
import { summariseSessionForHandOff } from '@main/session/summarizer';
import {
  buildHandOffContextPrompt,
  DEFAULT_HAND_OFF_CONTINUATION_INSTRUCTION,
} from '@main/session/hand-off/context-prompt';
import { getSessionFileFinalDiff } from '@main/session/final-file-diff';
import { adapterRegistry } from '@main/adapters/registry';
import { eventBus } from '@main/event-bus';
import type { EventMap } from '@main/event-bus';
import type {
  AppSettings,
  HandOffSpawnRequest,
  SessionAdapterId,
  TaskRecord,
} from '@shared/types';
import { buildHandOffCreateSessionOpts, dedupHandOff, archiveSourceSessionWithEmit } from './sessions-hand-off-helper';
import { transferHandOffResources } from '@main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator';
import { isAgentId } from '@main/adapters/options-builder';
import { SessionModelOptionsError } from '@main/adapters/session-model-options';
import { on, parseStringId, parsePositiveInt, parseStringIdArray, IpcInputError } from './_helpers';
import log from '@main/utils/logger';

const logger = log.scope('ipc-sessions');
const execFileAsync = promisify(execFile);

export function registerSessionsIpc(): void {
  // Session
  on(IpcInvoke.SessionList, () => sessionManager.list());
  // plan team-cohesion-fix-20260513 Phase A：走 sessionManager.get 而非 sessionRepo.get，
  // 让 SessionRecord.teams[] enrich 透明生效。
  on(IpcInvoke.SessionGet, (_e, id) => sessionManager.get(String(id)));
  on(IpcInvoke.SessionListEvents, (_e, id, limit) => {
    const sid = parseStringId('sessionId', id);
    // limit 上限 5000：renderer 默认 100/200，留空间给 history 详情页拉更多
    const lim = parsePositiveInt('limit', limit, { fallback: 200, min: 1, max: 5000 });
    return eventRepo.listForSession(sid, lim);
  });
  on(IpcInvoke.SessionListFileChanges, (_e, id) =>
    fileChangeRepo.listForSession(parseStringId('sessionId', id)),
  );
  on(IpcInvoke.SessionGetFileFinalDiff, (_e, id, filePath) =>
    getSessionFileFinalDiff(
      parseStringId('sessionId', id),
      parseStringId('filePath', filePath, 4096),
    ),
  );
  on(IpcInvoke.SessionGetGitBranch, async (_e, id) => {
    const sid = parseStringId('sessionId', id);
    const session = sessionRepo.get(sid);
    if (!session) return null;
    return getCurrentGitBranch(session.cwd);
  });
  on(IpcInvoke.SessionListSummaries, (_e, id) =>
    summaryRepo.listForSession(parseStringId('sessionId', id)),
  );
  on(IpcInvoke.SessionLatestSummaries, (_e, ids) => {
    const arr = parseStringIdArray('ids', ids ?? []);
    return summaryRepo.latestForSessions(arr);
  });
  on(IpcInvoke.SessionListTasks, (_e, id): { tasks: TaskRecord[] } => {
    const sid = parseStringId('sessionId', id);
    if (!sessionRepo.get(sid)) return { tasks: [] };
    const teamIds = agentDeckTeamRepo
      .findActiveTeamMembershipsBySession(sid)
      .map((m) => m.teamId);
    return {
      tasks: taskRepo.list({
        visibleScope: { teamIds, callerSid: sid },
        limit: 200,
      }),
    };
  });
  on(IpcInvoke.SessionArchive, async (_e, id) => {
    const sid = parseStringId('sessionId', id);
    // archive-toctou-fix-20260515 plan (R1 reviewer-codex MED-3 修法): 用户主动归档撞 race window
    // (sync probe 后 setArchived 之间 row 被外部删) → setArchived throw SessionRowMissingError。
    // 该路径 row 已不存在 = 等价已归档无害,**幂等静默 return true** 让 UI 视为成功(用户主动操作
    // 已删 row 应当无害,通知反而打扰;P1 emit caller-archive-failed 通道是给 mcp/K3 自动归档场景设
    // 计的,IPC 用户主动操作不走该通道避免 noise)。其他 archive 异常 (FK constraint / DB locked 等
    // 非 SessionRowMissingError) 仍 throw 让 IPC reply error → renderer 可见 inline error
    // (HistoryPanel.tsx:106 / SessionCard.tsx:39 当前裸 await 无 catch,P2 toast plan 后续接 catch)。
    try {
      await sessionManager.archive(sid);
      return true;
    } catch (err) {
      if (err instanceof SessionRowMissingError) {
        logger.warn(
          `[ipc SessionArchive] ${sid} setArchived no-op (row 已不在,幂等静默 return true):`,
          err,
        );
        return true;
      }
      throw err;
    }
  });
  on(IpcInvoke.SessionUnarchive, async (_e, id) => {
    const sid = parseStringId('sessionId', id);
    // archive-toctou-fix-20260515 plan (R1 reviewer-claude LOW + reviewer-codex 共识): 用户从历史
    // 列表「右键取消归档」撞 race window → setArchived(sid, null) throw SessionRowMissingError。
    // row 已不存在 = 等价「已经不在归档列表」无害,**try/catch + console.warn 静默 return true**
    // (与 SessionArchive 同款幂等语义,通知反而打扰)。其他异常 throw 让 IPC reply error。
    try {
      await sessionManager.unarchive(sid);
      return true;
    } catch (err) {
      if (err instanceof SessionRowMissingError) {
        logger.warn(
          `[ipc SessionUnarchive] ${sid} setArchived(null) no-op (row 已不在,幂等静默 return true):`,
          err,
        );
        return true;
      }
      throw err;
    }
  });
  on(IpcInvoke.SessionReactivate, (_e, id) => {
    sessionManager.reactivate(parseStringId('sessionId', id));
    return true;
  });
  on(IpcInvoke.SessionDelete, async (_e, id) => {
    await sessionManager.delete(parseStringId('sessionId', id));
    return true;
  });

  /**
   * K3 hand-off Stage 1：在稳定的 sourceMaxEventId 边界内构建可编辑压缩胶囊。
   * LLM 结构化总结是可选增强；总结失败时保留最近原始对话，不因外部 provider
   * 超时丢掉可接力的历史。只有总结和合格原始对话都不存在时才报空会话。
   */
  on(IpcInvoke.SessionHandOffSummarize, async (_e, id) => {
    const sid = parseStringId('sessionId', id);
    const session = sessionRepo.get(sid);
    if (!session) {
      throw new IpcInputError('sessionId', `session not found: ${sid}`);
    }
    // Capture the high-water mark before the synchronous snapshot query. Events that arrive while
    // the LLM summary is running must make Stage 2 reject this preview as stale.
    // Use 0 as the stable empty-history boundary. A nullable boundary would disable Stage 2's
    // stale-preview check and could let the first event created during summarization slip through.
    const sourceMaxEventId = eventRepo.maxEventId(sid) ?? 0;
    const events = eventRepo.listForSession(sid, 200);
    // plan prancy-forging-penguin 改造:dispatch 改成按 **settings.handOffProvider** 选 adapter
    // 出简报(与被 hand-off 的目标会话原 adapter 解耦)。原 R37 P2-I 是按 session.agentId 走,
    // 现在变成 user 在 settings 选 'claude' / 'deepseek' / 'codex' 出简报 — claude session 也可能
    // 由 Deepseek 或 codex SDK 出简报,反之亦然。user 责任:settings.handOffModel 填的 model id
    // 必须对当前 provider 可用。
    //
    // 关键边界:**两个 adapter 变量分开取**:
    // - summaryAdapter (provider-driven):仅用于出简报 LLM 调用 (line summary = ...)
    // - sessionAdapter (session.agentId driven):用于 Stage 2 fail-fast 校验 createSession,
    //   因为 Stage 2 起新会话用的是被 hand-off 目标会话**自己的** adapter (新 session 沿用原
    //   adapter,与 user 选的 simulate provider 无关)
    const provider = settingsStore.get('handOffProvider');
    const summaryProviderAgentId = handOffProviderToAdapterId(provider);
    const summaryAdapter = adapterRegistry.get(summaryProviderAgentId);
    const sessionAdapter = adapterRegistry.get(session.agentId);
    // plan remove-aider-generic-pty-adapters-20260520 P9 R2 reviewer-codex MED 修法：
    // hand-off 是 2 stage 流程(Stage 1 paid LLM summary + Stage 2 SessionHandOffSpawn)。
    // Stage 2 (line 156+) 对 `!adapter?.createSession` 硬性 throw；Stage 1 必须 fail-fast
    // 同款 check,否则老 SQLite row(adapter='aider'/'generic-pty' 已删,adapterRegistry.get
    // 返 undefined)走 fallback `summariseSessionForHandOff` 跑 paid Claude oneshot 后
    // Stage 2 必然 throw,浪费 LLM API quota + 用户钱。defense-in-depth 不依赖 plan D1
    // "用户无历史数据" 假设。
    // **plan prancy-forging-penguin 修订**:check 必须用 sessionAdapter (Stage 2 用此 adapter
    // createSession),不是 summaryAdapter。
    if (!sessionAdapter?.createSession) {
      throw new Error(
        `adapter cannot create session: ${session.agentId} (hand-off Stage 1 fail-fast)`,
      );
    }
    let summary: string | null = null;
    try {
      const generated = summaryAdapter?.summariseEvents
        ? await summaryAdapter.summariseEvents(session.cwd, events, 'handoff')
        : await summariseSessionForHandOff(session.cwd, events);
      summary = generated?.trim() ? generated : null;
      if (!summary) {
        logger.warn(`[ipc hand-off] summary provider returned empty for ${sid}; using raw history`);
      }
    } catch (error) {
      logger.warn(`[ipc hand-off] summary provider failed for ${sid}; using raw history`, error);
    }

    let recentMessages: ReturnType<typeof eventRepo.listRecentMessages> = [];
    try {
      recentMessages = eventRepo.listRecentMessages(
        sid,
        settingsStore.get('resumeRecentMessagesCount'),
        sourceMaxEventId,
      );
    } catch (error) {
      logger.warn(`[ipc hand-off] recent message snapshot failed for ${sid}`, error);
    }

    const context = buildHandOffContextPrompt({
      source: {
        sessionId: sid,
        adapter: session.agentId,
        cwd: session.cwd,
        model: session.model ?? null,
        thinking: session.thinking ?? null,
        sourceMaxEventId,
      },
      summary,
      recentMessages,
      currentInstruction: DEFAULT_HAND_OFF_CONTINUATION_INSTRUCTION,
    });
    if (!summary && context.includedMessageCount === 0) {
      throw new Error('no summary generated (empty session or no eligible raw messages)');
    }
    return {
      summary: context.prompt,
      contextQuality: context.quality,
      summaryIncluded: context.summaryIncluded,
      includedMessageCount: context.includedMessageCount,
      omittedMessageCount: context.omittedMessageCount,
      sourceCwd: session.cwd,
      sourceAgentId: session.agentId,
      sourcePermissionMode: session.permissionMode ?? null,
      sourceModel: session.model ?? null,
      sourceThinking: session.thinking ?? null,
      sourceMaxEventId,
    };
  });

  /**
   * K3 hand-off Stage 2：用 finalPrompt（renderer modal 可能已编辑）起新 SDK session
   * （adapter / cwd / permissionMode 沿用原 session）+ 自动归档原 session。
   *
   * archive 失败仅 console.warn 不阻塞 newSid 返回（用户至少能切到新 session 工作；
   * 原 session 留 active 影响小，用户可手动右键归档）—— 与 user CLAUDE.md「资源清理 &
   * TOCTOU 防线」节「失败路径也要清理」精神：这里不是「释放标记 / 清 Map」类清理，
   * 是「联动 UX 行为」，失败不传递错误更合用户预期。
   */
  on(IpcInvoke.SessionHandOffSpawn, async (_e, id, rawRequest) => {
    const sid = parseStringId('sessionId', id);
    const source = sessionRepo.get(sid);
    if (!source) {
      throw new IpcInputError('sessionId', `session not found: ${sid}`);
    }
    const request: HandOffSpawnRequest =
      typeof rawRequest === 'string'
        ? {
            prompt: rawRequest,
            target: {
              adapter: source.agentId as SessionAdapterId,
              model: source.model ?? null,
              thinking: source.thinking ?? null,
            },
            expectedSourceMaxEventId: null,
          }
        : parseHandOffSpawnRequest(rawRequest);
    const finalPrompt = request.prompt;
    if (typeof finalPrompt !== 'string' || finalPrompt.length === 0) {
      throw new IpcInputError('finalPrompt', 'must be non-empty string');
    }
    if (finalPrompt.length > 102_400) {
      // 102_400 字符上限与 sdk-bridge MAX_MESSAGE_LENGTH + agent-deck-message-repo
      // MAX_BODY_LENGTH 全局对齐（同 ipc/adapters.ts AdapterCreateSession）。
      throw new IpcInputError(
        'finalPrompt',
        `> 102400 chars (got ${finalPrompt.length.toLocaleString()})`,
      );
    }
    const adapter = adapterRegistry.get(request.target.adapter);
    if (!adapter?.createSession) {
      throw new Error(`adapter cannot create session: ${request.target.adapter}`);
    }
    // REVIEW_33 H7：dedupHandOff 单飞 —— 同 sourceSid 并发 IPC 复用同一 in-flight Promise，
    // 避免「双击 / 多 renderer 实例」起两个 SDK 子进程（按次计费 + UI 状态分裂）。
    // renderer 端 ref guard 是第一道闸（HandOffPreviewDialog summarizeInFlightRef /
    // submitInFlightRef 同步守门，比 React state setSpawning 快 16-200ms），main 端
    // dedupHandOff 是兜底闸：第二次 IPC 拿到同一个 newSid 返回 + 同款 session-focus-request。
    return await dedupHandOff(sid, async () => {
      const currentMaxEventId = eventRepo.maxEventId(sid) ?? 0;
      if (
        request.expectedSourceMaxEventId !== null &&
        currentMaxEventId !== request.expectedSourceMaxEventId
      ) {
        throw new Error('接力预览已过期：源会话在总结后产生了新活动，请重新生成压缩上下文。');
      }
      // REVIEW_33 H6：opts 拼装抽到 buildHandOffCreateSessionOpts —— 透传 cwd / permissionMode /
      // codexSandbox / claudeCodeSandbox 四字段，避免「用户原 session 切到 read-only / strict 后
      // hand-off 起的新 session 落 settings 全局默认」隐性沙盒 downgrade。详 helper 注释。
      let createOptions: ReturnType<typeof buildHandOffCreateSessionOpts>;
      try {
        createOptions = buildHandOffCreateSessionOpts(
          source,
          finalPrompt,
          request.target,
          currentMaxEventId,
        );
      } catch (error) {
        if (error instanceof SessionModelOptionsError) {
          throw new IpcInputError(`target.${error.field}`, error.message);
        }
        throw error;
      }
      const newSid = await adapter.createSession!(createOptions);
      // permissionMode 持久化到新 session（沿用原 session，让 detail 视图显示一致）
      if (
        request.target.adapter === source.agentId &&
        source.permissionMode &&
        source.permissionMode !== 'default'
      ) {
        sessionManager.recordCreatedPermissionMode(newSid, source.permissionMode);
      }

      const resourceTransfer = transferHandOffResources({
        callerSessionId: sid,
        callerRow: source,
        newSessionId: newSid,
      });
      if (
        resourceTransfer.tasks.status === 'failed' ||
        resourceTransfer.teams.status === 'failed' ||
        resourceTransfer.worktreeMarker.status === 'failed'
      ) {
        try {
          await sessionManager.close(newSid);
        } catch (cleanupError) {
          logger.warn(`[ipc hand-off] successor cleanup failed: ${newSid}`, cleanupError);
        }
        throw new Error(
          `接力资源迁移失败，源会话仍保持可用：${JSON.stringify(resourceTransfer)}`,
        );
      }
      // 自动归档原 session：失败仅 warn 不阻塞 newSid 返回（用户至少能切到新 session 工作）。
      // archive-failure-ux-upthrow-20260515 plan: K3 走独立 sessionManager.archive(sid) 不经
      // baton-cleanup helper,通过 archiveSourceSessionWithEmit 上抛 'caller-archive-failed' event,
      // main bootstrap listener 桥到 notifyUser + IPC channel,避免 archive 失败被静默吞掉。
      // toolName='SessionHandOffSpawn' 区分 mcp baton-cleanup ('archive_plan' / 'hand_off_session')
      // 让 UI 能识别触发场景 (main/index.ts listener 通过 TOOL_DISPLAY_NAME 映射成「会话接力」)。
      // EventMap satisfies 编译期守门 helper payload schema 与 event-bus.ts 类型一致。
      // R2 reviewer-codex MED-1 修法: 必传 getSession seam,helper 内部重新探针 source row
      // (createSession 是 long-running async,row 可能在期间被异常清理),与 mcp baton-cleanup 行为
      // 对齐 (row-missing → emit 'row-missing' 短路 / row 存在 → archive → 异常 emit 'archive-throw')。
      await sessionManager.close(sid);
      await archiveSourceSessionWithEmit(sid, {
        archive: (id) => sessionManager.archive(id),
        getSession: (id) => sessionRepo.get(id),
        emitArchiveFailed: (payload) =>
          eventBus.emit('caller-archive-failed', payload satisfies EventMap['caller-archive-failed'][0]),
      });
      // emit session-focus-request → main/index.ts forwarder 转发到 IpcEvent.SessionFocusRequest →
      // App.tsx onSessionFocusRequest listener 自动 setView('live') + select(newSid)。与 cli.ts
      // `agent-deck new` / NewSessionDialog onCreated 同款 UX：起新 session 后 detail 自动切到新
      // session，避免用户疑惑「点了没反应」。
      eventBus.emit('session-focus-request', newSid);
      return newSid;
    });
  });

  // History
  on(IpcInvoke.SessionListHistory, (_e, filters) => {
    // plan team-cohesion-fix-20260513 Phase A：history 列表也 batch enrich teams[]，让历史 session
    // detail 也能正确显示 team chip。
    return sessionManager.enrichWithTeamsBatch(
      sessionRepo.listHistory(
        (filters ?? {}) as Parameters<typeof sessionRepo.listHistory>[0],
      ),
    );
  });
}

function parseHandOffSpawnRequest(value: unknown): HandOffSpawnRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IpcInputError('request', 'must be object');
  }
  const raw = value as Record<string, unknown>;
  if (!raw.target || typeof raw.target !== 'object' || Array.isArray(raw.target)) {
    throw new IpcInputError('request.target', 'must be object');
  }
  const target = raw.target as Record<string, unknown>;
  if (typeof target.adapter !== 'string' || !isAgentId(target.adapter)) {
    throw new IpcInputError('request.target.adapter', 'unknown adapter');
  }
  const checkpoint = raw.expectedSourceMaxEventId;
  if (
    checkpoint !== null &&
    (!Number.isSafeInteger(checkpoint) || (checkpoint as number) < 0)
  ) {
    throw new IpcInputError(
      'request.expectedSourceMaxEventId',
      'must be a non-negative integer or null',
    );
  }
  if (target.model !== null && typeof target.model !== 'string') {
    throw new IpcInputError('request.target.model', 'must be a string or null');
  }
  if (target.thinking !== null && typeof target.thinking !== 'string') {
    throw new IpcInputError('request.target.thinking', 'must be a string or null');
  }
  return {
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    target: {
      adapter: target.adapter,
      model: target.model,
      thinking: target.thinking,
    },
    expectedSourceMaxEventId: checkpoint as number | null,
  };
}

async function getCurrentGitBranch(cwd: string): Promise<string | null> {
  const gitCwd = cwd.trim();
  if (!gitCwd) return null;

  try {
    const { stdout } = await execFileAsync('git', ['-C', gitCwd, 'branch', '--show-current'], {
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    const branch = stdout.trim();
    if (branch) return branch;
  } catch {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', gitCwd, 'rev-parse', '--short', 'HEAD'], {
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    const sha = stdout.trim();
    return sha ? `HEAD ${sha}` : null;
  } catch {
    return null;
  }
}

function handOffProviderToAdapterId(
  provider: AppSettings['handOffProvider'],
): 'claude-code' | 'deepseek-claude-code' | 'codex-cli' {
  switch (provider) {
    case 'codex':
      return 'codex-cli';
    case 'deepseek':
      return 'deepseek-claude-code';
    case 'claude':
    default:
      return 'claude-code';
  }
}
