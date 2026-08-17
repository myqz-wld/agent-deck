import type { SessionRecord } from '@shared/types';
import type { CodexThinkingLevel } from '@shared/session-metadata';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import { combineCodexDeveloperInstructions } from '../fork-session/target-runtime';
import type { CreateSessionOpts, CodexSandboxMode } from './_deps';
import {
  hasCodexReasoningConfigLayer,
  resolveCodexReasoningEffort,
} from './reasoning-effort-resolve';

export type CodexCreateResumeRecord = Pick<
  SessionRecord,
  | 'cliSessionId'
  | 'codexApprovalPolicy'
  | 'codexSandbox'
  | 'runtimeProvider'
  | 'thinking'
>;

export interface CodexCreateRuntimeHostValues {
  resumeRecord: CodexCreateResumeRecord | null;
  readApplicationInstructions: () => string | undefined;
  readConfiguredReasoningEffort: () => CodexThinkingLevel | null;
  readProviderConfigOverrides: (
    provider: string | null | undefined,
  ) => CodexConfigObject | null;
  readDefaultSandbox: () => CodexSandboxMode;
}

export interface ResolvedCodexCreateRuntime {
  approvalPolicy: CreateSessionOpts['approvalPolicy'];
  developerInstructions?: string;
  effectiveOpts: CreateSessionOpts;
  effectiveResumeThreadId: string | null;
  provider?: string;
  providerConfigOverrides?: CodexConfigObject;
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
  const approvalPolicy =
    opts.approvalPolicy ?? record?.codexApprovalPolicy ?? undefined;
  const sandboxMode =
    opts.codexSandbox ?? record?.codexSandbox ?? host.readDefaultSandbox();
  const reasoning = resolveCodexReasoningEffort({
    explicit: opts.modelReasoningEffort,
    isResume: opts.resume !== undefined,
    persisted: record?.thinking,
    hasLayerOverride: hasCodexReasoningConfigLayer(opts.codexConfigOverrides),
    readConfigured: host.readConfiguredReasoningEffort,
  });
  const effectiveOpts =
    reasoning.sessionValue === opts.modelReasoningEffort &&
    provider === opts.provider &&
    approvalPolicy === opts.approvalPolicy
      ? opts
      : {
          ...opts,
          provider,
          approvalPolicy,
          modelReasoningEffort: reasoning.sessionValue,
        };
  const developerInstructions = combineCodexDeveloperInstructions(
    host.readApplicationInstructions(),
    opts.developerInstructions,
  );
  const providerConfigOverrides =
    host.readProviderConfigOverrides(provider) ?? undefined;
  const effectiveResumeThreadId =
    opts.resume && opts.resumeMode !== 'fresh-cli-reuse-app'
      ? (opts.resumeCliSid ?? record?.cliSessionId ?? opts.resume)
      : null;

  return {
    approvalPolicy,
    developerInstructions,
    effectiveOpts,
    effectiveResumeThreadId,
    provider,
    providerConfigOverrides,
    sandboxMode,
    threadModelReasoningEffort: reasoning.threadValue,
  };
}
