import type {
  AgentEvent,
  HandOffMetadata,
  UploadedAttachmentRef,
} from '@shared/types';
import type { ClaudeThinkingLevel } from '@shared/session-metadata';
import { AGENT_ID } from './constants';

export interface ClaudeFinalizeContinuationMetadata {
  formatVersion: number;
  checkpointId: number | null;
  sourceSessionId: string;
  sourceEventRevision: number;
  preparationHash: string;
  messageOrigin: 'continuation';
}

export interface ClaudeFinalizeInitialRegistration {
  spawnLink: { parentSessionId: string; depth: number };
  hiddenFromHistory?: boolean;
  onRegistered(applicationSessionId: string): void;
}

export interface ClaudeFinalizeAgentRuntimeProfile {
  agentProfileName: string | null;
  agentProfileSource: 'plugin' | null;
  agentPluginDir: string | null;
}

export interface FinalizeClaudeSessionStartArgs {
  applicationSid: string;
  cliSessionId?: string;
  cwd: string;
  prompt?: string;
  claudeSandboxMode: 'off' | 'workspace-write' | 'strict';
  runtimeProvider?: string;
  claudeAgentName?: string;
  claudePluginDir?: string;
  claudeModel?: string;
  claudeCodeEffortLevel?: ClaudeThinkingLevel;
  extraAllowWrite?: readonly string[];
  attachments?: readonly UploadedAttachmentRef[];
  handOff?: HandOffMetadata;
  continuationMetadata?: ClaudeFinalizeContinuationMetadata | null;
  skipFirstUserEmit?: boolean;
  skipSessionStartEmit?: boolean;
  initialSessionRegistration?: ClaudeFinalizeInitialRegistration;
  emit(event: AgentEvent): void;
}

export interface ClaudeSessionFinalizeHost {
  now(): number;
  updateCliSessionId(applicationSid: string, cliSessionId: string): void;
  setSandbox(applicationSid: string, mode: FinalizeClaudeSessionStartArgs['claudeSandboxMode']): void;
  setRuntimeProvider(applicationSid: string, runtimeProvider: string): void;
  setAgentRuntimeProfile(
    applicationSid: string,
    profile: ClaudeFinalizeAgentRuntimeProfile,
  ): void;
  setModel(applicationSid: string, model: string): void;
  setThinking(applicationSid: string, effort: ClaudeThinkingLevel): void;
  setExtraAllowWrite(applicationSid: string, paths: string[]): void;
  publishPersistedSession(applicationSid: string): void;
  warn(message: string, error: unknown): void;
}

export function finalizeClaudeSessionStartCore(
  input: FinalizeClaudeSessionStartArgs,
  host: ClaudeSessionFinalizeHost,
): void {
  const {
    applicationSid,
    cliSessionId,
    cwd,
    prompt,
    claudeSandboxMode,
    runtimeProvider,
    claudeAgentName,
    claudePluginDir,
    claudeModel,
    claudeCodeEffortLevel,
    extraAllowWrite,
    attachments,
    handOff,
    continuationMetadata,
    skipFirstUserEmit,
    skipSessionStartEmit,
    initialSessionRegistration,
    emit,
  } = input;

  if (!skipSessionStartEmit) {
    emit({
      sessionId: applicationSid,
      agentId: AGENT_ID,
      kind: 'session-start',
      payload: {
        cwd,
        source: 'sdk',
        ...(initialSessionRegistration
          ? { initialSpawnLink: initialSessionRegistration.spawnLink }
          : {}),
        ...(initialSessionRegistration?.hiddenFromHistory
          ? { initialHiddenFromHistory: true }
          : {}),
      },
      ts: host.now(),
      source: 'sdk',
    });
    initialSessionRegistration?.onRegistered(applicationSid);
  }

  if (cliSessionId !== undefined) {
    attempt(
      host,
      `[claude-bridge] updateCliSessionId(${applicationSid}, ${cliSessionId}) 失败`,
      () => host.updateCliSessionId(applicationSid, cliSessionId),
    );
  }
  attempt(
    host,
    `[claude-bridge] setClaudeCodeSandbox(${applicationSid}, ${claudeSandboxMode}) 失败`,
    () => host.setSandbox(applicationSid, claudeSandboxMode),
  );
  if (runtimeProvider !== undefined) {
    attempt(
      host,
      `[claude-bridge] setRuntimeProvider(${applicationSid}, ${runtimeProvider}) 失败`,
      () => host.setRuntimeProvider(applicationSid, runtimeProvider),
    );
  }
  if (claudeAgentName !== undefined || claudePluginDir !== undefined) {
    attempt(
      host,
      `[claude-bridge] setAgentRuntimeProfile(${applicationSid}) 失败`,
      () => host.setAgentRuntimeProfile(applicationSid, {
        agentProfileName: claudeAgentName ?? null,
        agentProfileSource: claudePluginDir ? 'plugin' : null,
        agentPluginDir: claudePluginDir ?? null,
      }),
    );
  }
  if (claudeModel !== undefined) {
    attempt(
      host,
      `[claude-bridge] setModel(${applicationSid}, ${claudeModel}) 失败`,
      () => host.setModel(applicationSid, claudeModel),
    );
  }
  if (claudeCodeEffortLevel !== undefined) {
    attempt(
      host,
      `[claude-bridge] setThinking(${applicationSid}, ${claudeCodeEffortLevel}) 失败`,
      () => host.setThinking(applicationSid, claudeCodeEffortLevel),
    );
  }
  if (extraAllowWrite !== undefined && extraAllowWrite.length > 0) {
    attempt(
      host,
      `[claude-bridge] setExtraAllowWrite(${applicationSid}, [${extraAllowWrite.join(', ')}]) 失败`,
      () => host.setExtraAllowWrite(applicationSid, [...extraAllowWrite]),
    );
  }
  attempt(
    host,
    `[claude-bridge] emit session-upserted after finalize(${applicationSid}) 失败`,
    () => host.publishPersistedSession(applicationSid),
  );

  if (prompt && !skipFirstUserEmit) {
    emit({
      sessionId: applicationSid,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text: prompt,
        role: 'user',
        ...(attachments?.length ? { attachments: [...attachments] } : {}),
        ...(handOff ? { handOff } : {}),
        ...(continuationMetadata
          ? {
              messageOrigin: 'continuation',
              continuation: { ...continuationMetadata },
            }
          : {}),
      },
      ts: host.now(),
      source: 'sdk',
    });
  }
}

function attempt(
  host: Pick<ClaudeSessionFinalizeHost, 'warn'>,
  message: string,
  action: () => void,
): void {
  try {
    action();
  } catch (error) {
    try {
      host.warn(message, error);
    } catch {
      // Diagnostics cannot change session registration authority.
    }
  }
}
