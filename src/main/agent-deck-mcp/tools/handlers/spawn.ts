/** spawn_session orchestration: preflight, guards, provider creation, links, teams, and anchor. */

import { sessionRepo } from '@main/store/session-repo';
import { adapterRegistry } from '@main/adapters/registry';
import type { ForkedSessionHandle, ForkSessionSource } from '@main/adapters/types';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';

import { applySpawnGuards } from '../../spawn-guards';
import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { SpawnSessionArgs, SpawnSessionResult } from '../schemas';
import { shouldWriteSpawnLink } from './spawn-link-guard';
import { persistSpawnLinkFallback } from './spawn-link-registration';
import {
  type SpawnClaudeCodeEffortLevel,
  type SpawnCodexReasoningEffort,
  type SpawnGrokReasoningEffort,
} from './spawn-model-options';
import { resolveSpawnAgent } from './spawn-agent-resolver';
import { finalizeSpawnLimits } from './spawn-limits';
import {
  buildSpawnPromptContext,
  persistSpawnPromptAnchor,
  rollbackFailedSpawnTransaction,
} from './spawn-prompt';
import { validateSpawnForkPreflight } from './spawn-fork-preflight';
import {
  buildSpawnTargetOptions,
  resolveSpawnCodexRuntimeAccess,
  setSpawnTargetInitialRegistration,
  setSpawnTargetPrompt,
} from './spawn-target-options';
import {
  cleanupEmptySpawnTeam,
  completeSpawnTeamMembership,
  ensureSpawnTeam,
} from './spawn-team';
import { createOrdinaryInitialTurn } from '@main/session/continuation-context/initial-turn';
import { executeFreshSession } from '@main/session/continuation-context/fresh-session-executor';
import type { SpawnSessionHandlerOptions } from './spawn-handler-options';
import { resolveSpawnRuntimeControls, validateSpawnRuntimeControls } from './spawn-runtime-controls';
import { resolveSpawnRuntimeSelection } from './spawn-runtime-selection';
import { persistSpawnSessionMetadata } from './spawn-session-metadata';

export const spawnSessionHandler = withMcpGuard(
  'spawn_session',
  async (
    args: SpawnSessionArgs,
    ctx: HandlerContext,
    opts?: SpawnSessionHandlerOptions,
  ) => {
    const { caller } = ctx;
    const contextMode = args.contextMode ?? 'fresh';
    if (opts?.handOffMode && contextMode === 'fork') {
      return err(
        'hand_off_session always starts a fresh successor and cannot request contextMode "fork".',
        'Remove contextMode from the internal hand-off request, or call spawn_session directly for a parallel native fork.',
      );
    }

    const adapter = adapterRegistry.get(args.adapter);
    if (!adapter || !adapter.createSession) {
      return err(
        `adapter "${args.adapter}" cannot create sessions`,
        'Choose an adapter value from the tool schema and ensure that adapter is enabled and available in Agent Deck, then retry.',
      );
    }
    if (!adapter.capabilities.canCreateSession) {
      return err(
        `adapter "${args.adapter}" does not support session creation`,
        'Choose an enabled adapter with session-creation capability: claude-code, codex-cli, or grok-build.',
      );
    }
    const strictCloseTarget = adapter.closeSessionForRollback
      ? (sessionId: string) => adapter.closeSessionForRollback!(sessionId)
      : null;
    const runtimeControlError = validateSpawnRuntimeControls(args);
    if (runtimeControlError) {
      return err(runtimeControlError.error, runtimeControlError.hint);
    }

    // Resolve fallible config/DB reads before guards so failures cannot leak a fan-out slot.
    let promptToUse = args.prompt;
    // Agent runtime fields flow into createSession after explicit tool arguments take precedence.
    let modelFromAgent: string | undefined;
    let providerFromAgent: string | undefined;
    let modelReasoningEffortFromAgent: SpawnCodexReasoningEffort | undefined;
    let claudeCodeEffortLevelFromAgent: SpawnClaudeCodeEffortLevel | undefined;
    let grokReasoningEffortFromAgent: SpawnGrokReasoningEffort | undefined;
    let developerInstructionsFromAgent: string | undefined;
    let codexSandboxFromAgent: SpawnSessionArgs['codexSandbox'] | undefined;
    let codexConfigOverridesFromAgent: CodexConfigObject | undefined;
    let claudeAgentNameFromAgent: string | undefined;
    let claudeAgentsFromAgent: Record<string, AgentDefinition> | undefined;
    let claudePluginDirFromAgent: string | undefined;
    let grokAgentNameFromAgent: string | undefined;
    let grokAgentSourceFromAgent: 'bundled' | 'project' | 'user' | 'plugin' | undefined;
    let grokPluginDirFromAgent: string | undefined;
    if (args.agentName) {
      const agent = resolveSpawnAgent(args.agentName, args.adapter, args.cwd);
      if (!agent.ok) return err(agent.error, agent.hint);
      providerFromAgent = agent.provider;
      modelFromAgent = agent.model;
      modelReasoningEffortFromAgent = agent.modelReasoningEffort;
      claudeCodeEffortLevelFromAgent = agent.claudeCodeEffortLevel;
      grokReasoningEffortFromAgent = agent.grokReasoningEffort;
      developerInstructionsFromAgent = agent.developerInstructions;
      codexSandboxFromAgent = agent.codexSandbox;
      codexConfigOverridesFromAgent = agent.codexConfigOverrides;
      claudeAgentNameFromAgent = agent.claudeAgentName;
      claudeAgentsFromAgent = agent.claudeAgents;
      claudePluginDirFromAgent = agent.claudePluginDir;
      grokAgentNameFromAgent = agent.grokAgentName;
      grokAgentSourceFromAgent = agent.grokAgentSource;
      grokPluginDirFromAgent = agent.grokPluginDir;
    }

    const leadRecord = sessionRepo.get(caller.callerSessionId);
    const callerExists = leadRecord !== null;
    const runtimeSelection = resolveSpawnRuntimeSelection({
      args,
      leadRecord,
      agent: {
        provider: providerFromAgent,
        model: modelFromAgent,
        modelReasoningEffort: modelReasoningEffortFromAgent,
        claudeCodeEffortLevel: claudeCodeEffortLevelFromAgent,
        grokReasoningEffort: grokReasoningEffortFromAgent,
      },
    });
    if (!runtimeSelection.ok) return err(runtimeSelection.error, runtimeSelection.hint);
    const {
      inherit: shouldInheritAdapterSettings,
      provider: resolvedProvider,
      modelOptions: resolvedModelOptions,
    } = runtimeSelection;

    // Explicit target controls win; only same-adapter spawns inherit runtime access.
    // Caller-scoped link, team, anchor, and depth effects remain gated by callerExists.
    const {
      effectivePermissionMode,
      effectiveSessionMode,
      effectiveCodexSandbox,
      effectiveClaudeCodeSandbox,
      effectiveGrokSandbox,
      effectiveExtraAllowWrite,
    } = resolveSpawnRuntimeControls({
      args,
      capabilities: adapter.capabilities,
      leadRecord,
      inherit: shouldInheritAdapterSettings,
      codexSandboxFromAgent,
    });
    const codexRuntimeAccess = resolveSpawnCodexRuntimeAccess(
      args.adapter,
      shouldInheritAdapterSettings,
      leadRecord,
      opts?.codexRuntimeAccess,
      args.approvalPolicy,
    );

    // Build once before fork preflight. The provisional prompt is replaced in-place after the
    // normal team/reply context is assembled, preserving fresh dispatch field order and values.
    const targetOptions = buildSpawnTargetOptions({
      args,
      prompt: promptToUse,
      effectivePermissionMode,
      effectiveSessionMode,
      effectiveCodexSandbox,
      effectiveClaudeCodeSandbox,
      effectiveGrokSandbox,
      effectiveExtraAllowWrite,
      provider: resolvedProvider,
      modelOptions: resolvedModelOptions,
      developerInstructions: developerInstructionsFromAgent,
      codexConfigOverrides: codexConfigOverridesFromAgent,
      claudeAgentName: claudeAgentNameFromAgent,
      claudeAgents: claudeAgentsFromAgent,
      claudePluginDir: claudePluginDirFromAgent,
      grokAgentName: grokAgentNameFromAgent,
      grokAgentSource: grokAgentSourceFromAgent,
      grokPluginDir: grokPluginDirFromAgent,
      codexRuntimeAccess,
    });

    let forkSource: ForkSessionSource | null = null;
    if (contextMode === 'fork') {
      const preflight = await validateSpawnForkPreflight({
        callerSessionId: caller.callerSessionId,
        caller: leadRecord,
        adapter,
        target: targetOptions,
      });
      if (!preflight.ok) return preflight.result;
      forkSource = preflight.source;
    }

    // A requested team is a provider-creation preflight. Failure must not consume guard/rate
    // capacity or silently downgrade the request to a standalone spawn.
    const teamPreflight = ensureSpawnTeam(args.teamName);
    if (!teamPreflight.ok) return teamPreflight.result;
    const { teamIdEarly, teamCreatedNow } = teamPreflight;
    if (args.teamName && !teamIdEarly) {
      return err(
        `team preflight returned no durable id for requested team "${args.teamName}"`,
        'No provider session was created. Repair the team repository invariant, then retry spawn_session.',
        {
          phase: 'team-preflight',
          retryValid: true,
          residualState: [],
        },
      );
    }

    // REVIEW_31 Bug 4：teammate display name fallback 链 = args.displayName > args.agentName > 不动。
    // teammateDisplayName 在多处被引用（wire prefix injection / setTitle / addMember / ok return），
    // 提前算供下面 lead context block 注入也能引用 lead displayName 对称信息。
    const teammateDisplayName = args.displayName ?? args.agentName ?? null;
    const leadDisplayName = leadRecord?.title ?? null;

    // plan team-cohesion-fix-20260513 Phase B7 / CHANGELOG_100 D9 升级：spawn 路径
    // wire format 与 buildWireBody 同款 `[from <name> @ <adapter>][msg <id>][sid <senderSid>]`
    // 三段，让 teammate 端 message-row.tsx parseWirePrefix 能识别这条 prompt 也是 cross-session
    // message（带 ↩ chip + lead context block 折叠 disclosure），不被当成"自己输入的 user message"渲染。
    //
    // teammate 收到 prompt 后从顶部 regex `\[msg ([0-9a-f-]+)\]\[sid ([0-9a-f-]+)\]` 提
    // messageId + senderSessionId 双锚点，调
    // send_message({replyToMessageId: msgId, sessionId: senderSid, teamId, text}) 回复 lead。
    // lead context block 显式列出 lead sessionId / teamId / lead displayName + send_message 用法，
    // 让 teammate 不必依赖 wire prefix 解析也能 send_message（双层冗余防 prompt 长度截断 / 协议漂移）。
    //
    // 注入条件：callerExists + 普通 spawn（非 handOffMode）。
    // - team spawn：teamIdEarly 写进 context block + placeholder.teamId
    // - standalone spawn：teamIdEarly=null，context block 明确让 teammate omit teamId，placeholder
    //   写 teamId=null 走 teamless DM reply-chain 校验（CHANGELOG_194）。
    // - handOffMode：仍不注入。hand_off_session 是单向接力，successor 不应 reply 旧 caller。
    // **DB messages.body 列存原始 promptToUse**（不含 prefix / lead context block），与 send_message
    // buildWireBody 同款（wire prefix 在内存里加，不写回 DB）。
    //
    // leadDisplayName fallback：优先取 leadRecord.title（用户 / cwd-basename 默认），缺失时用
    // `<leadAdapter>:<lead-sid 前 8>` 同 buildWireBody.resolveFromDisplayName 的 fallback 形态。
    // 严格说 buildWireBody 优先取 team_member.displayName，但 spawn 路径下 lead addMember 在
    // createSession 之后做（team_member sessionId FK 必须先存在），所以这里只能用 leadRecord.title。
    // teammate 看到的是 lead "first impression" 名字，与之后 send_message reply 看到的可能不同
    // —— 视觉上一致足以让用户识别"是同一个 lead"，无需强一致。
    const {
      shouldWriteNormalSpawnLink,
      willInjectWirePrefix,
      placeholderId,
      promptForSpawn,
    } = buildSpawnPromptContext({
      args,
      caller,
      callerExists,
      leadRecord,
      leadDisplayName,
      promptToUse,
      teamIdEarly,
      handOffMode: opts?.handOffMode,
      suppressLeadContext: opts?.suppressLeadContext,
    });
    setSpawnTargetPrompt(targetOptions, promptForSpawn);

    // Reserve guard/rate capacity only after every fallible preflight and prompt preparation.
    const guard = applySpawnGuards(caller, args.cwd, args.adapter, {
      handOffMode: opts?.handOffMode ?? false,
    });
    if ('isError' in guard) {
      const cleanup = cleanupEmptySpawnTeam({
        teamCreatedNow,
        teamIdEarly,
        failureLabel: 'spawn guard denial',
      });
      if (!cleanup.ok) {
        return err(
          'spawn guard denied the request and the newly created empty team could not be removed',
          `Do not retry yet. Delete team ${teamIdEarly ?? '(unknown)'} in Agent Deck Teams, then retry.`,
          {
            phase: 'guard',
            retryValid: false,
            residualState: ['empty-team-may-remain'],
            cleanup,
          },
        );
      }
      return guard;
    }
    const { parentDepth, fanOutSlot } = guard;

    if (shouldWriteNormalSpawnLink) {
      setSpawnTargetInitialRegistration(targetOptions, {
        spawnLink: {
          parentSessionId: caller.callerSessionId,
          depth: parentDepth + 1,
        },
        hiddenFromHistory: opts?.hideFromHistory === true,
        // session-start ingest is synchronous: once this callback runs, listChildren sees the
        // durable row, so the in-flight reservation must be released to avoid double-counting it.
        onRegistered: () => fanOutSlot.release(),
      });
    }

    // 实际 spawn
    // REVIEW_32 follow-up MED-1 (fan-out race) 修法：把 setSpawnLink 提到 try 块内 createSession
    // 之后，与 fanOutSlot.release()（finally）形成顺序保证。旧实现 release 在 finally 跑完才
    // setSpawnLink → applySpawnGuards 下次调用看到 inFlightChildren=0（已 release）+
    // listChildren=oldCount（新 sid 未 setSpawnLink）→ effective 比真实少 1，能突破 maxFanOut + 1。
    // 新版 setSpawnLink 在 release 之前做完，关闭 race window。
    let sid: string;
    let forkHandle: ForkedSessionHandle | null = null;
    try {
      if (contextMode === 'fork' && forkSource) {
        forkHandle = await adapter.createForkedSession!(forkSource, targetOptions);
        sid = forkHandle.sessionId;
      } else {
        sid = await executeFreshSession(
          targetOptions,
          createOrdinaryInitialTurn(targetOptions.prompt ?? ''),
        );
      }
      // Persist the normal caller edge before releasing the fan-out reservation. Hand-offs never
      // write a spawn edge because they are peer ownership transfers, not delegated children.
      // **[caller-scoped #1/4]** spawn-link 写入(grep anchor 详 L148-160 callerExists 定义)
      if (shouldWriteNormalSpawnLink) {
        persistSpawnLinkFallback({
          sessionId: sid,
          parentSessionId: caller.callerSessionId,
          depth: parentDepth + 1,
        });
      }
    } catch (e) {
      fanOutSlot.release();
      // CHANGELOG_100 R2 fix (codex MED-2): createSession 失败 → cleanup 本次新建的空 team
      // 防 active team 列表污染。再次 verify 空才删（防并发 caller 已抢先 addMember）。
      cleanupEmptySpawnTeam({
        teamCreatedNow,
        teamIdEarly,
        failureLabel: 'createSession failure',
      });
      return err(
        e instanceof Error ? e.message : String(e),
        contextMode === 'fork'
          ? `No forked session was registered. Fix the ${args.adapter} native-fork condition in the error, or retry with contextMode "fresh". If it still fails, inspect Agent Deck logs.`
          : `No session was created. Retry once with an exact catalog/provider model and a thinking value supported by ${args.adapter}, or omit model/thinking. If it still fails, verify adapter authentication and inspect Agent Deck logs.`,
      );
    } finally {
      // catch 路径已 release；finally 兜底 idempotent 二次 release（内部 dedupe）
      fanOutSlot.release();
    }

    persistSpawnSessionMetadata({
      sessionId: sid,
      canSetPermissionMode: adapter.capabilities.canSetPermissionMode,
      effectivePermissionMode,
      teammateDisplayName,
    });

    const teamMembership = await completeSpawnTeamMembership({
      teamName: args.teamName,
      teamIdEarly,
      teamCreatedNow,
      caller,
      callerExists,
      sid,
      teammateDisplayName,
      batonRole: opts?.batonRole,
    });
    if (!teamMembership.ok) {
      return rollbackFailedSpawnTransaction({
        sid,
        failurePhase: teamMembership.phase,
        failure: teamMembership.error,
        anchorIdsToCleanup: [],
        spawnLinkWritten: shouldWriteNormalSpawnLink,
        teamState: teamMembership.teamState,
        forkHandle,
        strictCloseTarget,
      });
    }
    const teamId = teamMembership.teamId;
    if (args.teamName && !teamId) {
      return rollbackFailedSpawnTransaction({
        sid,
        failurePhase: 'team-membership',
        failure: new Error(`requested team "${args.teamName}" has no durable id after membership`),
        anchorIdsToCleanup: [],
        spawnLinkWritten: shouldWriteNormalSpawnLink,
        teamState: teamMembership.teamState,
        forkHandle,
        strictCloseTarget,
      });
    }

    // The provider receives the first prompt directly; a delivered placeholder preserves the
    // reply chain without redispatching it. Standalone spawns use the same teamless-DM anchor.
    let spawnPromptMessageId: string | null = null;
    // **[caller-scoped #3/4]** placeholder message(grep anchor 详 L148-160 callerExists 定义)
    if (willInjectWirePrefix && callerExists && placeholderId) {
      const anchor = persistSpawnPromptAnchor({
        placeholderId,
        teamId,
        fromSessionId: caller.callerSessionId,
        toSessionId: sid,
        body: promptToUse,
      });
      if (!anchor.ok) {
        return rollbackFailedSpawnTransaction({
          sid,
          failurePhase: anchor.phase,
          failure: anchor.error,
          anchorIdsToCleanup: anchor.anchorIdsToCleanup,
          spawnLinkWritten: shouldWriteNormalSpawnLink,
          teamState: teamMembership.teamState,
          forkHandle,
          strictCloseTarget,
        });
      }
      spawnPromptMessageId = anchor.anchorId;
    }

    const created = sessionRepo.get(sid);
    const spawnDepth =
      created?.spawnDepth ??
      (callerExists && shouldWriteSpawnLink({ handOffMode: opts?.handOffMode })
        ? parentDepth + 1
        : 0);
    const spawnLimits = finalizeSpawnLimits(guard.spawnLimits, {
      callerSessionId: caller.callerSessionId,
      spawnDepth,
    });
    return ok({
      sessionId: sid,
      adapter: args.adapter,
      provider: created?.runtimeProvider ?? resolvedProvider ?? null,
      cwd: args.cwd,
      teamId,
      teamName: args.teamName ?? null,
      // REVIEW_32 HIGH-4：spawn-time agentName / displayName 回传给 caller
      // （deep-review SKILL 里 lead 起多组并发 review 时按这两字段区分 reviewer 实例，
      // 不再需要 list_sessions / get_session 反查）。
      agentName: args.agentName ?? null,
      displayName: teammateDisplayName,
      // **[caller-scoped #4/4]** spawnDepth fallback (grep anchor 详 L148-160 callerExists 定义)
      spawnDepth,
      spawnLimits,
      sentAt: Date.now(),
      // plan team-cohesion-fix-20260513 Phase B5：lead 用此 messageId 作为 teammate first reply anchor
      spawnPromptMessageId,
      ...(contextMode === 'fork'
        ? {
            contextMode: 'fork' as const,
            forkedFromSessionId: caller.callerSessionId,
          }
        : {}),
    } satisfies SpawnSessionResult);
  },
);
