import type { SessionRecord } from '@shared/types';
import { codexPermissionPreset, isSessionPermissionMode, storedSessionPermissionMode } from '@shared/permission-modes';
import type { CodexThinkingLevel } from '@shared/session-metadata';
import type { ResolvedCodexGatewayProfile } from '@main/codex-config/gateway-profiles-core';
import { combineCodexDeveloperInstructions } from '../fork-session/target-runtime';
import type { CreateSessionOpts, CodexSandboxMode } from './_deps';
import {
  hasCodexReasoningConfigLayer,
  resolveCodexReasoningEffort,
} from './reasoning-effort-resolve';

export type CodexCreateResumeRecord = Pick<
  SessionRecord,
  | 'cliSessionId'
  | 'permissionMode'
  | 'codexApprovalPolicy'
  | 'codexSandbox'
  | 'runtimeProvider'
  | 'thinking'
>;

export interface CodexCreateRuntimeHostValues {
  resumeRecord: CodexCreateResumeRecord | null;
  readApplicationInstructions: () => string | undefined;
  readConfiguredReasoningEffort: () => CodexThinkingLevel | null;
  readGatewayProfile: (
    gateway: string | null | undefined,
  ) => ResolvedCodexGatewayProfile | null;
  readDefaultSandbox: () => CodexSandboxMode;
}

export interface ResolvedCodexCreateRuntime {
  permissionMode?: import('@shared/permission-modes').SessionPermissionMode;
  approvalPolicy: CreateSessionOpts['approvalPolicy'];
  developerInstructions?: string;
  effectiveOpts: CreateSessionOpts;
  effectiveResumeThreadId: string | null;
  gatewayConfigOverrides?: ResolvedCodexGatewayProfile['configOverrides'];
  modelProvider?: string;
  provider?: string;
  sandboxMode: CodexSandboxMode;
  threadModelReasoningEffort?: CodexThinkingLevel;
}

/** Resolve one live create/resume runtime without reading desktop stores or application assets. */
export function resolveCodexCreateRuntime(
  opts: CreateSessionOpts,
  host: CodexCreateRuntimeHostValues,
): ResolvedCodexCreateRuntime {
  const record = host.resumeRecord;
  const provider = opts.provider ?? record?.runtimeProvider ?? undefined;
  const gateway = host.readGatewayProfile(provider);
  const model = opts.model ?? gateway?.defaultModel;
  const requestedPermission = opts.permissionMode ?? (record && isSessionPermissionMode(record.permissionMode)
    ? storedSessionPermissionMode({ ...record, agentId: 'codex-cli' }) : null);
  const permissionMode = isSessionPermissionMode(requestedPermission)
    ? requestedPermission : undefined;
  const approvalPolicy =
    permissionMode ? codexPermissionPreset(permissionMode).approvalPolicy
      : opts.approvalPolicy ?? record?.codexApprovalPolicy ?? undefined;
  const sandboxMode =
    opts.codexSandbox ?? record?.codexSandbox ?? host.readDefaultSandbox();
  const reasoning = resolveCodexReasoningEffort({
    explicit: opts.modelReasoningEffort,
    isResume: opts.resume !== undefined,
    persisted: record?.thinking,
    hasLayerOverride: hasCodexReasoningConfigLayer(opts.codexConfigOverrides),
    readConfigured: () => gateway
      ? gateway.defaultThinking ?? null
      : host.readConfiguredReasoningEffort(),
  });
  const effectiveOpts =
    reasoning.sessionValue === opts.modelReasoningEffort &&
    provider === opts.provider &&
    model === opts.model &&
    approvalPolicy === opts.approvalPolicy &&
    permissionMode === opts.permissionMode
      ? opts
      : {
          ...opts,
          provider,
          model,
          approvalPolicy,
          permissionMode,
          modelReasoningEffort: reasoning.sessionValue,
        };
  const developerInstructions = combineCodexDeveloperInstructions(
    host.readApplicationInstructions(),
    opts.developerInstructions,
  );
  const effectiveResumeThreadId =
    opts.resume && opts.resumeMode !== 'fresh-cli-reuse-app'
      ? (opts.resumeCliSid ?? record?.cliSessionId ?? opts.resume)
      : null;

  return {
    permissionMode,
    approvalPolicy,
    developerInstructions,
    effectiveOpts,
    effectiveResumeThreadId,
    gatewayConfigOverrides: gateway?.configOverrides,
    modelProvider: gateway?.modelProvider,
    provider,
    sandboxMode,
    threadModelReasoningEffort: reasoning.threadValue,
  };
}
