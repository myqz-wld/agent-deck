import { getAgentDeckCodexDeveloperInstructions } from '@main/codex-config/agents-md-installer';
import { resolveCodexGatewayProfile } from '@main/codex-config/gateway-profiles';
import { readTopLevelModelReasoningEffortFromCodexConfig } from '@main/codex-config/toml-writer';
import { sessionRepo } from '@main/store/session-repo';
import { settingsStore } from '@main/store/settings-store';
import type { CreateSessionOpts } from './_deps';
import {
  resolveCodexCreateRuntime,
  type CodexCreateResumeRecord,
  type ResolvedCodexCreateRuntime,
} from './runtime-selection';

/** Capture the resume row before client acquisition, matching the established create ordering. */
export function readDesktopCodexCreateResumeRecord(
  opts: CreateSessionOpts,
): CodexCreateResumeRecord | null {
  return opts.resume ? sessionRepo.get(opts.resume) : null;
}

/** Desktop repository/settings composition for the host-neutral live create runtime policy. */
export function resolveDesktopCodexCreateRuntime(
  opts: CreateSessionOpts,
  resumeRecord: CodexCreateResumeRecord | null,
): ResolvedCodexCreateRuntime {
  return resolveCodexCreateRuntime(opts, {
    resumeRecord,
    readApplicationInstructions: getAgentDeckCodexDeveloperInstructions,
    readConfiguredReasoningEffort: readTopLevelModelReasoningEffortFromCodexConfig,
    readGatewayProfile: resolveCodexGatewayProfile,
    readDefaultSandbox: () => settingsStore.get('codexSandbox'),
  });
}
