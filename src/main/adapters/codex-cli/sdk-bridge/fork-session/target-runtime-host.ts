import { getAgentDeckCodexDeveloperInstructions } from '@main/codex-config/agents-md-installer';
import {
  readTopLevelModelFromCodexConfig,
  readTopLevelModelReasoningEffortFromCodexConfig,
} from '@main/codex-config/toml-writer';
import { settingsStore } from '@main/store/settings-store';
import type { CreateSessionOpts } from '../create-session/_deps';
import {
  resolveCodexForkTargetRuntime,
  type CodexForkTargetRuntime,
} from './target-runtime';

/** Desktop settings/instruction composition for the host-neutral fork runtime resolver. */
export function resolveDesktopCodexForkTargetRuntime(
  opts: CreateSessionOpts,
): CodexForkTargetRuntime {
  return resolveCodexForkTargetRuntime(opts, {
    defaultSandboxMode: settingsStore.get('codexSandbox'),
    developerInstructions: getAgentDeckCodexDeveloperInstructions(),
    readConfiguredModel: readTopLevelModelFromCodexConfig,
    readConfiguredReasoningEffort: readTopLevelModelReasoningEffortFromCodexConfig,
  });
}
