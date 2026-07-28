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

export interface GrokSubmittingMessage {
  message: GrokPendingMessage;
  status: 'submitting' | 'cancelling' | 'cancelled';
  promptRequestIssued: boolean;
  kind: 'prompt' | 'interject';
  requestController?: AbortController;
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
  ready: boolean;
  queue: GrokPendingMessage[];
  /** Prompt removed from FIFO but not yet acknowledged by a provider session update. */
  submittingMessage?: GrokSubmittingMessage | null;
  running: boolean;
  /** null = not probed, false = this Grok version only supports queued prompts. */
  interjectionSupported: boolean | null;
  sealed: boolean;
  closed: boolean;
  disposed: boolean;
  suppressUpdates: boolean;
  /** Effective provider model used by the live ACP session. */
  model: string | null;
  /** Persisted explicit override; null delegates to the ACP-reported native default. */
  modelOverride?: string | null;
  /** Native default reported by ACP initialize, never guessed by Agent Deck. */
  nativeDefaultModel?: string | null;
  thinking: string | null;
  /** Persisted explicit reasoning override; null delegates to Grok. */
  thinkingOverride?: string | null;
  sessionMode: AdapterSessionMode | null;
  grokSandbox: string | null;
  restartingSandbox: boolean;
  /** Serializes model/mode transactions against sandbox child replacement. */
  runtimeMutationInProgress?: boolean;
  agentProfileName: string | null;
  agentProfileSource: 'bundled' | 'project' | 'user' | 'plugin' | null;
  agentPluginDir: string | null;
  pendingPermissions: Map<string, GrokPendingPermission>;
  acceptedEnqueueFingerprints: Map<string, string>;
  translation: GrokTranslationState;
}
