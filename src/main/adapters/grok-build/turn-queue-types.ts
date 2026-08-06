import type { AgentEnqueueOptions } from '@main/adapters/types';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { AgentEvent, HandOffMetadata } from '@shared/types';

import type { GrokPendingMessage, GrokRuntime } from './runtime-types';
import type { GrokTurnFailureReason } from './native-error';
import type { GrokBridgeRuntimeHost } from './bridge-runtime-core';

export interface PreparedGrokMessage {
  message: GrokPendingMessage;
  idempotencyKey?: string;
  fingerprint: string | null;
  bypassQueueLimit?: boolean;
}

export interface GrokInterjectRequest {
  sessionId: string;
  text: string;
  interjectionId: string;
  content: ContentBlock[];
}

export type GrokEnqueueOptions = AgentEnqueueOptions & {
  handOff?: HandOffMetadata;
  providerText?: string;
  continuation?: TrustedContinuationInitialTurn['metadata'];
};

export interface GrokTurnQueueOptions {
  runtimeHost?: GrokBridgeRuntimeHost;
  emit: (event: AgentEvent) => void;
  emitEvent: (sessionId: string, kind: AgentEvent['kind'], payload: unknown) => void;
  emitError: (
    sessionId: string,
    text: string,
    failureReason?: GrokTurnFailureReason,
  ) => void;
  closeSession: (sessionId: string) => Promise<void>;
  recycleRuntime: (runtime: GrokRuntime) => Promise<void>;
  firstModelEventTimeoutMs?: number;
  providerCompletionPollMs?: number;
  providerHistoryRoot?: string;
}
