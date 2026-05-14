/**
 * Session 列表 / 详情 / 归档 / 删除 / 历史 IPC handler。
 */
import { IpcInvoke } from '@shared/ipc-channels';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { eventRepo } from '@main/store/event-repo';
import { fileChangeRepo } from '@main/store/file-change-repo';
import { summaryRepo } from '@main/store/summary-repo';
import { summariseSessionForHandOff } from '@main/session/summarizer';
import { adapterRegistry } from '@main/adapters/registry';
import { eventBus } from '@main/event-bus';
import { buildHandOffCreateSessionOpts, dedupHandOff } from './sessions-hand-off-helper';
import { on, parseStringId, parsePositiveInt, parseStringIdArray, IpcInputError } from './_helpers';

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
  on(IpcInvoke.SessionListSummaries, (_e, id) =>
    summaryRepo.listForSession(parseStringId('sessionId', id)),
  );
  on(IpcInvoke.SessionLatestSummaries, (_e, ids) => {
    const arr = parseStringIdArray('ids', ids ?? []);
    return summaryRepo.latestForSessions(arr);
  });
  on(IpcInvoke.SessionArchive, async (_e, id) => {
    await sessionManager.archive(parseStringId('sessionId', id));
    return true;
  });
  on(IpcInvoke.SessionUnarchive, async (_e, id) => {
    await sessionManager.unarchive(parseStringId('sessionId', id));
    return true;
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
   * K3 hand-off Stage 1 (plan mcp-bug-and-feature-batch-20260513 Phase 4c)：
   * 拉历史 → LLM oneshot 生成结构化接力简报，返回供 renderer 在 modal preview / 编辑
   * 后再调 SessionHandOffSpawn 起新 session。
   *
   * 失败：throw → renderer modal inline error 让用户重试。不做兜底文本（让用户看到真实
   * 错误便于决策：是 LLM 超时还是 session 已删 / 其它）。
   */
  on(IpcInvoke.SessionHandOffSummarize, async (_e, id) => {
    const sid = parseStringId('sessionId', id);
    const session = sessionRepo.get(sid);
    if (!session) {
      throw new IpcInputError('sessionId', `session not found: ${sid}`);
    }
    const events = eventRepo.listForSession(sid, 200);
    // R37 P2-I Step 3.3：dispatch 已下放到 adapter.summariseEvents（kind: 'handoff'）。
    // - claude-code → claude SDK + sonnet（4 节简报，60s timeout）
    // - codex-cli   → codex SDK + 'medium' effort（reasoning，60s timeout，model 由
    //   ~/.codex/config.toml 决定，settings.handOffModel 对 codex 路径无影响）
    // - 其他 adapter（aider / generic-pty）未实装 summariseEvents → fallback 兜底走 claude
    //   path 的 `summariseSessionForHandOff`（保历史兼容；这俩 adapter 实际不会触发 hand-off
    //   UI 入口，但保留兜底防止入口意外暴露时静默炸）
    const adapter = adapterRegistry.get(session.agentId);
    const summary = adapter?.summariseEvents
      ? await adapter.summariseEvents(session.cwd, events, 'handoff')
      : await summariseSessionForHandOff(session.cwd, events);
    if (!summary) {
      // events 为空（新会话）/ LLM 返回空串都视为「没东西可总结」—— 让 renderer
      // 显示「会话还没活动可总结」inline error，用户可手动写兜底 prompt 起新会话。
      throw new Error('no summary generated (empty session or LLM returned empty)');
    }
    return {
      summary,
      sourceCwd: session.cwd,
      sourceAgentId: session.agentId,
      sourcePermissionMode: session.permissionMode ?? null,
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
  on(IpcInvoke.SessionHandOffSpawn, async (_e, id, finalPrompt) => {
    const sid = parseStringId('sessionId', id);
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
    const session = sessionRepo.get(sid);
    if (!session) {
      throw new IpcInputError('sessionId', `session not found: ${sid}`);
    }
    const adapter = adapterRegistry.get(session.agentId);
    if (!adapter?.createSession) {
      throw new Error(`adapter cannot create session: ${session.agentId}`);
    }
    // REVIEW_33 H7：dedupHandOff 单飞 —— 同 sourceSid 并发 IPC 复用同一 in-flight Promise，
    // 避免「双击 / 多 renderer 实例」起两个 SDK 子进程（按次计费 + UI 状态分裂）。
    // renderer 端 ref guard 是第一道闸（HandOffPreviewDialog summarizeInFlightRef /
    // submitInFlightRef 同步守门，比 React state setSpawning 快 16-200ms），main 端
    // dedupHandOff 是兜底闸：第二次 IPC 拿到同一个 newSid 返回 + 同款 session-focus-request。
    return await dedupHandOff(sid, async () => {
      // REVIEW_33 H6：opts 拼装抽到 buildHandOffCreateSessionOpts —— 透传 cwd / permissionMode /
      // codexSandbox / claudeCodeSandbox 四字段，避免「用户原 session 切到 read-only / strict 后
      // hand-off 起的新 session 落 settings 全局默认」隐性沙盒 downgrade。详 helper 注释。
      const newSid = await adapter.createSession!(
        buildHandOffCreateSessionOpts(session, finalPrompt),
      );
      // permissionMode 持久化到新 session（沿用原 session，让 detail 视图显示一致）
      if (session.permissionMode && session.permissionMode !== 'default') {
        sessionManager.recordCreatedPermissionMode(newSid, session.permissionMode);
      }
      // 自动归档原 session：失败仅 warn 不阻塞 newSid 返回（用户至少能切到新 session 工作）。
      try {
        await sessionManager.archive(sid);
      } catch (err) {
        console.warn(`[ipc sessions hand-off] archive source session ${sid} failed:`, err);
      }
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
