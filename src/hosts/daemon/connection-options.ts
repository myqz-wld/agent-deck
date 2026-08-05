import type { AuthenticatedClientAccessContext } from '@contracts/index';

import type { DaemonProtocolConnection } from './connection';
import type {
  DaemonConnectionAdmission,
  DaemonConnectionLimits,
  DaemonCoreRuntime,
} from './types';

export interface DaemonProtocolConnectionOptions {
  readonly instanceId: string;
  readonly appVersion: string;
  readonly authoritativeCoreId: string;
  readonly runtime: DaemonCoreRuntime;
  readonly admission: DaemonConnectionAdmission;
  readonly limits?: Partial<DaemonConnectionLimits>;
  readonly now?: () => number;
  readonly assertCredentialActive: (
    access: AuthenticatedClientAccessContext,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly onAuthenticated: (
    connection: DaemonProtocolConnection,
    access: AuthenticatedClientAccessContext,
  ) => void;
  readonly onClose?: (connection: DaemonProtocolConnection) => void;
}

export type DaemonProtocolConnectionState =
  | 'open'
  | 'terminal-flushing'
  | 'closing'
  | 'closed';
