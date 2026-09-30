import type { DaemonCoreRuntime } from '@hosts/daemon';
import { FileFeishuPreferenceStore } from './feishu-preference-store';
import { FileFeishuAssistantStore } from './feishu-assistant-store';
import { ServerCoreFeishuPreferencesRuntime } from './feishu-preferences-runtime';
import { ServerCoreFeishuPreferenceService } from './feishu-preference-service';
import { ServerCoreFeishuAssistantsRuntime } from './feishu-assistants-runtime';
import { ServerCoreSessionNameService } from './session-name-service';
import { ServerCoreSessionNameRuntime } from './session-name-runtime';
import type { ServerCoreRepositoryHost } from './repository-host';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import { findSessionHandOffSuccessor } from '@main/store/session-handoff-alias-repo';
import { FeishuAssistantAuthority } from './feishu-assistant-authority';
import { ServerCoreFeishuWorkManagement } from './feishu-work-management';
import type { ServerCoreMcpSessionSpawner } from './mcp-session-spawn';
import type { ServerCoreSessionConsoleAuthority } from './session-console-authority';

export function createServerCoreFeishuComposition(input: {
  stateDirectory: string;
  repositories: ServerCoreRepositoryHost;
  metadata: ServerCoreRuntimeMetadataStore;
  capabilities: ServerCoreSessionCreateCapabilities;
  authority: ServerCoreSessionConsoleAuthority;
  spawn: Pick<ServerCoreMcpSessionSpawner, 'reserveWork'>;
  rollback(adapterId: string, sessionId: string): Promise<void>;
}) {
  const preferences = new FileFeishuPreferenceStore(input.stateDirectory);
  const assistants = new FileFeishuAssistantStore(input.stateDirectory);
  const preferenceService = new ServerCoreFeishuPreferenceService(preferences, input.metadata, input.capabilities);
  const names = new ServerCoreSessionNameService(input.repositories.sessions, input.metadata);
  const management = new ServerCoreFeishuWorkManagement({
    assistants: new FeishuAssistantAuthority(assistants, input.repositories.sessions, findSessionHandOffSuccessor),
    sessions: input.repositories.sessions, preferences: preferenceService, names, metadata: input.metadata,
    authority: input.authority, capabilities: input.capabilities, rollback: input.rollback,
    reserve: caller => input.spawn.reserveWork(caller),
  });
  return {
    preferences, assistants, preferenceService, names, management,
    wrap: (base: DaemonCoreRuntime): DaemonCoreRuntime => new ServerCoreSessionNameRuntime(
      new ServerCoreFeishuAssistantsRuntime(new ServerCoreFeishuPreferencesRuntime(base,
        preferences, input.metadata, input.capabilities), assistants, input.metadata, input.repositories.sessions), names),
  };
}
