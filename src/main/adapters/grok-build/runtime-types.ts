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
  ContextRuntimeIdentityEvidence,
  HandOffMetadata,
  PermissionRequest,
  UploadedAttachmentRef,
} from '@shared/types';

import type { GrokAcpSession } from './acp-process';
import type { GrokTranslationState } from './translate';
import type { TrustedContinuationAcceptanceController } from '@main/adapters/trusted-continuation';

export interface GrokPendingMessage extends PendingAgentMessage {
  providerText?: string;
  continuation?: TrustedContinuationInitialTurn['metadata'];
  attachments?: UploadedAttachmentRef[];
  handOff?: HandOffMetadata;
  deferUserEventUntilTurnStart?: boolean;
  suppressUserEvent?: boolean;
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
  process: GrokAcpSession | null;
  ready: boolean;
  queue: GrokPendingMessage[];
  /** Prompt removed from FIFO but not yet acknowledged by a provider session update. */
  submittingMessage?: GrokSubmittingMessage | null;
  running: boolean;
  /** Owns the currently pending session/prompt JSON-RPC request. */
  currentTurnController?: AbortController | null;
  /** Distinguishes a user interrupt from provider/transport failures in turn finalization. */
  interruptRequested?: boolean;
  /** Generation-scoped cwd transition gate; drain/interjection must stop while set. */
  cwdTransitionGeneration?: number | null;
  /** null = not probed, false = this Grok version only supports queued prompts. */
  interjectionSupported: boolean | null;
  sealed: boolean;
  closed: boolean;
  disposed: boolean;
  suppressUpdates: boolean;
  /** Requested/selected model label used for setup and token accounting; it may be an alias. */
  model: string | null;
  /** Exact model identity reported by the native ACP session; never derived from a request alias. */
  runtimeIdentity: ContextRuntimeIdentityEvidence | null;
  /** Present only while the first trusted continuation turn crosses its native readiness boundary. */
  trustedContinuationAcceptance?: TrustedContinuationAcceptanceController;
  /** Persisted explicit override; null delegates to the ACP-reported native default. */
  modelOverride?: string | null;
  /** Native default reported by ACP initialize, never guessed by Agent Deck. */
  nativeDefaultModel?: string | null;
  thinking: string | null;
  /** Persisted explicit reasoning override; null delegates to Grok. */
  thinkingOverride?: string | null;
  sessionMode: AdapterSessionMode | null;
  /** Sandbox requested for the next ACP child; it may lead the active child during a turn. */
  grokSandbox: string | null;
  /** Sandbox used to launch the current ACP child. */
  activeGrokSandbox: string | null;
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
