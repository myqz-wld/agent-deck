import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  parseSessionConsoleInitialMessage,
  parseWorkspaceDirectoryRef,
  type SessionConsoleCreateOptions,
} from '@contracts/index';
import {
  firstUnsupportedTargetRuntimeField,
  unsupportedTargetRuntimeFieldMessage,
} from '@main/adapters/runtime-control-contracts';
import type { CreateSessionOptions } from '@main/adapters/types';
import { isSessionAdapterId } from '@main/adapters/runtime-profiles';
import type { ResolvedSuccessorSpec } from '@main/session/continuation-context/types';
import type { SessionAdapterId, SessionRecord } from '@shared/types';

import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import {
  buildRemoteCreateOptions,
} from './session-console-authority';
import { resolveServerCoreWorkspaceDirectory } from './project-catalog';
import { resolveServerCoreCreateOptions } from './mcp-session-spawn';
import type { ServerCoreHandOffSessionArgs } from './mcp-handoff-port';

const UNKNOWN_CAPACITY = Object.freeze({
  status: 'unknown' as const,
  identity: null,
  windowTokens: null,
  reason: 'no-observation' as const,
});

export interface ResolvedServerCoreHandOffTarget {
  readonly adapterId: SessionAdapterId;
  readonly cwdRef: string;
  readonly cwd: string;
  readonly createOptions: CreateSessionOptions;
  readonly spec: ResolvedSuccessorSpec;
  readonly options: SessionConsoleCreateOptions;
  readonly capabilityRevision: string;
}

function inside(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === '' || (
    child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  );
}

function inheritedArgs(
  source: SessionRecord,
  adapterId: SessionAdapterId,
): Partial<ServerCoreHandOffSessionArgs> {
  if (source.agentId !== adapterId) return {};
  return {
    ...(source.runtimeProvider && adapterId === 'claude-code'
      ? { gateway: source.runtimeProvider }
      : {}),
    ...(source.runtimeProvider && adapterId === 'codex-cli'
      ? { provider: source.runtimeProvider }
      : {}),
    ...(source.model ? { model: source.model } : {}),
    ...(source.thinking ? { thinking: source.thinking } : {}),
    ...(adapterId === 'claude-code' && source.permissionMode
      ? { permissionMode: source.permissionMode }
      : {}),
    ...(adapterId === 'codex-cli' && source.codexApprovalPolicy
      ? { approvalPolicy: source.codexApprovalPolicy }
      : {}),
    ...(adapterId === 'grok-build' && source.sessionMode
      ? { sessionMode: source.sessionMode }
      : {}),
    ...(adapterId === 'codex-cli' && source.codexSandbox
      ? { codexSandbox: source.codexSandbox }
      : {}),
    ...(adapterId === 'claude-code' && source.claudeCodeSandbox
      ? { claudeCodeSandbox: source.claudeCodeSandbox }
      : {}),
    ...(adapterId === 'grok-build' && source.grokSandbox
      ? { grokSandbox: source.grokSandbox }
      : {}),
  };
}

function runtimeFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function targetSpec(
  options: CreateSessionOptions,
  source: SessionRecord,
  workspaceRoot: string,
): ResolvedSuccessorSpec {
  const sameAdapter = options.agentId === source.agentId;
  const additionalDirectories = options.agentId === 'codex-cli' && sameAdapter
    ? (source.additionalDirectories ?? []).filter((path) => inside(workspaceRoot, path))
    : [];
  const networkAccessEnabled = options.agentId === 'codex-cli' && sameAdapter
    ? source.networkAccessEnabled ?? null
    : null;
  if (options.agentId === 'codex-cli') {
    if (additionalDirectories.length > 0) options.additionalDirectories = additionalDirectories;
    if (networkAccessEnabled !== null) options.networkAccessEnabled = networkAccessEnabled;
  }
  const provider = options.agentId === 'claude-code'
    ? options.gateway ?? null
    : options.agentId === 'codex-cli' ? options.provider ?? null : null;
  const thinking = options.agentId === 'claude-code'
    ? options.claudeCodeEffortLevel ?? null
    : options.agentId === 'codex-cli'
      ? options.modelReasoningEffort ?? null
      : options.reasoningEffort ?? null;
  const permissionMode = options.agentId === 'claude-code'
    ? options.permissionMode ?? null
    : null;
  const sessionMode = options.agentId === 'grok-build' ? options.sessionMode ?? null : null;
  const sandbox = options.agentId === 'claude-code'
    ? { kind: 'claude', mode: options.claudeCodeSandbox ?? null }
    : options.agentId === 'codex-cli'
      ? { kind: 'codex', mode: options.codexSandbox ?? null }
      : { kind: 'grok', profile: options.grokSandbox ?? null };
  const stable = {
    version: 1,
    adapter: options.agentId,
    cwd: options.cwd,
    provider,
    model: options.model ?? null,
    thinking,
    permissionMode,
    sessionMode,
    sandbox,
    networkAccessEnabled,
    additionalDirectories,
  };
  return {
    adapter: options.agentId,
    provider,
    model: options.model ?? null,
    thinking,
    sandbox,
    permissionMode,
    sessionMode,
    networkAccessEnabled,
    additionalDirectories,
    contextCapacity: UNKNOWN_CAPACITY,
    runtimeFingerprint: runtimeFingerprint(stable),
  };
}

export async function resolveServerCoreHandOffTarget(input: {
  readonly args: ServerCoreHandOffSessionArgs;
  readonly source: SessionRecord;
  readonly workspaceRoot: string;
  readonly capabilities: ServerCoreSessionCreateCapabilities;
  readonly sourceMaxEventId: number | null;
}): Promise<ResolvedServerCoreHandOffTarget> {
  const adapterId = input.args.adapter ?? input.source.agentId;
  if (!isSessionAdapterId(adapterId)) throw new Error('Caller adapter cannot be handed off');
  const unsupported = firstUnsupportedTargetRuntimeField(adapterId, input.args);
  if (unsupported) {
    throw new Error(unsupportedTargetRuntimeFieldMessage(adapterId, unsupported));
  }
  const inherited = inheritedArgs(input.source, adapterId);
  const inheritedCwd = relative(input.workspaceRoot, input.source.cwd).split(sep).join('/') || '.';
  const cwdRef = parseWorkspaceDirectoryRef(
    input.args.cwd ?? inheritedCwd,
    'hand_off_session.cwd',
  );
  const combined = {
    ...inherited,
    ...input.args,
    adapter: adapterId,
    cwd: cwdRef,
    prompt: parseSessionConsoleInitialMessage(input.args.prompt, 'hand_off_session.prompt'),
  };
  const selector = adapterId === 'claude-code'
    ? combined.gateway
    : adapterId === 'codex-cli' ? combined.provider : undefined;
  const descriptor = await input.capabilities.describe({
    adapterId,
    provider: selector ?? '',
    workingDirectory: cwdRef,
  });
  const options = resolveServerCoreCreateOptions(descriptor, combined);
  await input.capabilities.validateCreate(
    adapterId,
    descriptor.capabilityRevision,
    cwdRef,
    options,
  );
  const cwd = resolveServerCoreWorkspaceDirectory(cwdRef, input.workspaceRoot);
  const params = {
    adapterId,
    attachments: [],
    capabilityRevision: descriptor.capabilityRevision,
    initialMessage: combined.prompt,
    options,
    workingDirectory: cwdRef,
  };
  const createOptions = buildRemoteCreateOptions(params, cwd, []);
  createOptions.handOff = {
    mode: 'session',
    fromCallerSid: input.source.id,
    sourceMaxEventId: input.sourceMaxEventId,
  };
  return {
    adapterId,
    cwdRef,
    cwd,
    createOptions,
    spec: targetSpec(createOptions, input.source, input.workspaceRoot),
    options,
    capabilityRevision: descriptor.capabilityRevision,
  };
}
