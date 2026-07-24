import type {
  PermissionOption,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type {
  PendingAgentMessage,
} from '@main/adapters/types';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type {
  AdapterSessionMode,
  HandOffMetadata,
  PermissionRequest,
  UploadedAttachmentRef,
} from '@shared/types';

import type { GrokAcpProcess } from './acp-process';
import type { GrokTranslationState } from './translate';

export interface GrokPendingMessage extends PendingAgentMessage {
  providerText?: string;
  continuation?: TrustedContinuationInitialTurn['metadata'];
  attachments?: UploadedAttachmentRef[];
  handOff?: HandOffMetadata;
  deferUserEventUntilTurnStart?: boolean;
  turnCorrelationId?: string;
}

export interface GrokPendingPermission {
  request: PermissionRequest;
  options: PermissionOption[];
  resolve: (response: RequestPermissionResponse) => void;
  timer: NodeJS.Timeout | null;
}

export interface GrokRuntime {
  applicationSessionId: string;
  nativeSessionId: string | null;
  cwd: string;
  process: GrokAcpProcess | null;
  queue: GrokPendingMessage[];
  running: boolean;
  sealed: boolean;
  closed: boolean;
  suppressUpdates: boolean;
  model: string | null;
  thinking: string | null;
  sessionMode: AdapterSessionMode | null;
  agentProfileName: string | null;
  pendingPermissions: Map<string, GrokPendingPermission>;
  acceptedEnqueueFingerprints: Map<string, string>;
  translation: GrokTranslationState;
}
