/** spawn_session orchestration: preflight, guards, provider creation, links, teams, and anchor. */

import { sessionRepo } from '@main/store/session-repo';
import { adapterRegistry } from '@main/adapters/registry';
import type { ForkedSessionHandle, ForkSessionSource } from '@main/adapters/types';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';

import { applySpawnGuards } from '../../spawn-guards';
import {
  err,
  structuredOk,
  withMcpGuard,
  type HandlerContext,
  type HandlerResult,
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
  ): Promise<HandlerResult> => {
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
    let gatewayFromAgent: string | undefined;
    let profileFromAgent: string | undefined;
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
      gatewayFromAgent = agent.gateway;
      profileFromAgent = agent.profile;
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
    if (args.teamName && !callerExists) {
      const nextAction =
        'Do not retry this team spawn until the authenticated caller has an active durable Agent Deck session row. Then submit the request again, or omit teamName for a standalone target. No team or provider target was created.';
      return err(
        'team preflight requires a durable authenticated caller before the caller can become team lead',
        nextAction,
        {
          phase: 'team-preflight',
          preflightStep: 'caller-session',
          retryValid: false,
          residualState: [],
          nextAction,
        },
      );
    }
    const runtimeSelection = resolveSpawnRuntimeSelection({
      args,
      leadRecord,
      agent: {
        gateway: gatewayFromAgent,
        profile: profileFromAgent,
        model: modelFromAgent,
        modelReasoningEffort: modelReasoningEffortFromAgent,
        claudeCodeEffortLevel: claudeCodeEffortLevelFromAgent,
        grokReasoningEffort: grokReasoningEffortFromAgent,
      },
    });
    if (!runtimeSelection.ok) return err(runtimeSelection.error, runtimeSelection.hint);
    const {
      inherit: shouldInheritAdapterSettings,
      gateway: resolvedGateway,
      profile: resolvedProfile,
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
      gateway: resolvedGateway,
      profile: resolvedProfile,
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

    // One value drives the target title, team label, wire metadata, and success response.
    const teammateDisplayName = args.displayName ?? args.agentName ?? null;
    const leadDisplayName = leadRecord?.title ?? null;

    // Ordinary spawns from a durable caller receive a wire prefix and reply context. Hand-offs and
    // suppressed review forks do not, and the stored anchor body remains the unwrapped prompt.
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
      return { ...guard };
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

    // Keep the fan-out reservation until registration and the best-effort link write have run.
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
      if (shouldWriteNormalSpawnLink) {
        persistSpawnLinkFallback({
          sessionId: sid,
          parentSessionId: caller.callerSessionId,
          depth: parentDepth + 1,
        });
      }
    } catch (e) {
      fanOutSlot.release();
      // A provider failure must not leave a newly created, still-empty team behind.
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
      // release is idempotent, including the provider-failure path above.
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
    return structuredOk({
      sessionId: sid,
      adapter: args.adapter,
      gateway:
        args.adapter === 'claude-code'
          ? created?.runtimeProvider ?? resolvedGateway ?? null
          : null,
      profile:
        args.adapter === 'codex-cli'
          ? created?.runtimeProvider ?? resolvedProfile ?? null
          : null,
      cwd: args.cwd,
      teamId,
      teamName: args.teamName ?? null,
      agentName: args.agentName ?? null,
      displayName: teammateDisplayName,
      spawnDepth,
      spawnLimits,
      sentAt: Date.now(),
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
