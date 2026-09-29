import type { WorkspaceSandboxSpec } from '@contracts/workspace-sandbox';

import type { ServerCoreRuntimeDiagnostics } from './repository-host';
import type { ServerCoreProviderGrokContainerPort } from './runtime-provider-container';

export const SERVER_CORE_CREDENTIAL_FILE = '/run/secrets/agent-deck/credentials.json';
export const SERVER_CORE_PROVIDER_AUTH_SOURCE = '/run/secrets/agent-deck/provider-home';

export interface ServerCoreRuntimeCompositionOverrides {
  readonly processId?: string;
  readonly credentialFilePath?: string;
  readonly diagnostics?: ServerCoreRuntimeDiagnostics;
  readonly workspaceRoot?: string;
  readonly workspaceSandbox?: WorkspaceSandboxSpec;
  /** Test/development seam. Production Full uses the fixed read-only secrets-volume path. */
  readonly providerAuthSource?: string | null;
  /** Test/development seam. Production packages the shared CLI at the fixed /opt path. */
  readonly browserCliPath?: string;
  /** Trusted composition seam; capability publication remains independently fail-closed. */
  readonly grokContainer?: ServerCoreProviderGrokContainerPort;
}

export function createServerCoreRuntimeDiagnostics(): ServerCoreRuntimeDiagnostics {
  return Object.freeze({
    info: () => undefined,
    warn: () => {
      process.stderr.write('Server Core runtime warning; details hidden.\n');
    },
  });
}
