import type { Usage } from '@agentclientprotocol/sdk';
import type { AgentToolKind } from '@shared/types';

import type { GrokLiveRateState } from './live-token-rate';

export type GrokUsageSource = 'none' | 'standard' | 'extension';

export interface PendingGrokStandardUsage {
  resolve: (emit: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GrokTranslationState {
  toolNames: Map<string, string>;
  toolKinds: Map<string, AgentToolKind>;
  startedToolIds: Set<string>;
  thinkingToolIds: Set<string>;
  pendingText: {
    kind: 'message' | 'thinking';
    messageId: string | null;
    chunks: string[];
  } | null;
  lastUsage: Usage | null;
  standardUsageObservedForCurrentTurn: boolean;
  extensionUsageForCurrentTurn: boolean;
  usageSource: GrokUsageSource;
  pendingStandardUsage: PendingGrokStandardUsage | null;
  turnUsagePromptIds: Set<string>;
  liveRate: GrokLiveRateState | null;
}
