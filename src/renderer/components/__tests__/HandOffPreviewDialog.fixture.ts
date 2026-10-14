import type { SessionHandOffPreparation, SessionRecord } from '@shared/types';

export const source: SessionRecord = {
  id: 'source-1',
  agentId: 'claude-code',
  cwd: '/repo',
  title: 'Source',
  source: 'sdk',
  lifecycle: 'active',
  activity: 'idle',
  startedAt: 1,
  lastEventAt: 2,
  endedAt: null,
  archivedAt: null,
  model: 'sonnet',
  thinking: 'high',
};

export const otherSource: SessionRecord = {
  ...source,
  id: 'source-2',
  title: 'Other source',
};

export const prepared: SessionHandOffPreparation = {
  preparationId: 'prep-1',
  preview: '只读的会话续接上下文',
  previewTruncated: false,
  quality: 'full',
  source: { eventRevision: 42, rebuildAfterRevision: 0 },
  checkpoint: { id: 7, throughRevision: 42, formatVersion: 1, refreshed: true },
  metrics: {
    estimatedPromptTokens: 1_234,
    checkpointTokens: 300,
    rawTailTokens: 700,
    includedUserMessages: 4,
    truncatedBoundaryMessages: 0,
    rawRetentionCeilingTokens: 64_000,
    elapsedMs: 120,
  },
  warnings: [],
  target: {
    adapter: 'codex-cli',
    provider: null,
    model: 'gpt-custom',
    thinking: 'ultra',
  },
};
