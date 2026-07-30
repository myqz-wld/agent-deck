import type { AgentEnqueueOptions } from '@main/adapters/types';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { AgentEvent, HandOffMetadata } from '@shared/types';

import type { GrokPendingMessage, GrokRuntime } from './runtime-types';

export interface PreparedGrokMessage {
  message: GrokPendingMessage;
  idempotencyKey?: string;
  fingerprint: string | null;
  bypassQueueLimit?: boolean;
}

export type GrokEnqueueOptions = AgentEnqueueOptions & {
  handOff?: HandOffMetadata;
  providerText?: string;
  continuation?: TrustedContinuationInitialTurn['metadata'];
};

export interface GrokTurnQueueOptions {
  emit: (event: AgentEvent) => void;
  emitEvent: (sessionId: string, kind: AgentEvent['kind'], payload: unknown) => void;
  emitError: (sessionId: string, text: string) => void;
  closeSession: (sessionId: string) => Promise<void>;
  firstModelEventTimeoutMs?: number;
  providerCompletionPollMs?: number;
  providerHistoryRoot?: string;
}

export type GrokRuntimeEvent = (runtime: GrokRuntime) => void;
