import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@shared/types';
import { ServerCoreProviderEventBus } from './provider-event-bus';
import type { ServerCoreRuntimeDiagnostics } from './repository-host';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import { createServerCoreSessionManagerObserver } from './session-manager-observer';

function event(kind: AgentEvent['kind']): AgentEvent {
  return {
    agentId: 'codex-cli',
    kind,
    payload: kind === 'token-usage' ? {
      messageId: 'usage-a',
      model: 'gpt-5.6-sol',
      inputTokens: 100,
      outputTokens: 7,
      metricScope: 3,
    } : { role: 'assistant', text: 'done' },
    sessionId: 'session-a',
    source: 'sdk',
    ts: 1_000,
  };
}

function harness(insert = vi.fn()) {
  const appendChange = vi.fn(() => 1);
  const renameSessionMutationResults = vi.fn();
  const diagnostics: ServerCoreRuntimeDiagnostics = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const reviewEvents = new ServerCoreProviderEventBus();
  const review = vi.fn();
  reviewEvents.subscribe(review);
  const observer = createServerCoreSessionManagerObserver({
    diagnostics,
    metadata: {
      appendChange,
      renameSessionMutationResults,
    } as unknown as ServerCoreRuntimeMetadataStore,
    reviewEvents,
    tokenUsage: {
      insert,
      today: vi.fn(() => []),
      ratesSince: vi.fn(() => []),
      dailyByModel: vi.fn(() => []),
      deleteOlderThan: vi.fn(() => 0),
    },
  });
  return { appendChange, diagnostics, insert, observer, renameSessionMutationResults, review };
}

describe('Server Core session manager observer', () => {
  it('publishes normal history and persists token telemetry through separate paths', () => {
    const state = harness();
    const message = event('message');
    state.observer.eventPersisted(message, 9);
    expect(state.review).toHaveBeenCalledWith(message);
    expect(state.appendChange).toHaveBeenCalledWith(
      'event.persisted',
      'session-a',
      { adapterId: 'codex-cli', eventId: 9, kind: 'message', timestamp: 1_000 },
    );

    const usage = event('token-usage');
    state.observer.tokenUsageObserved(usage);
    expect(state.insert).toHaveBeenCalledWith({
      agentId: 'codex-cli',
      cacheCreationTokens: null,
      cacheReadTokens: null,
      inputTokens: 100,
      messageId: 'usage-a',
      metricScope: 3,
      model: 'gpt-5.6-sol',
      outputTokens: 7,
      reasoningTokens: null,
      sessionId: 'session-a',
      totalTokens: null,
      ts: 1_000,
    });
    expect(state.appendChange).toHaveBeenLastCalledWith(
      'usage.tokens.changed',
      'session-a',
      { adapterId: 'codex-cli', timestamp: 1_000 },
    );
  });

  it('keeps telemetry persistence failures out of the provider event path', () => {
    const failure = new Error('database unavailable');
    const state = harness(vi.fn(() => { throw failure; }));

    expect(() => state.observer.tokenUsageObserved(event('token-usage'))).not.toThrow();
    expect(state.diagnostics.warn).toHaveBeenCalledWith(
      'Server Core token usage persistence failed',
      {},
      failure,
    );
    expect(state.appendChange).not.toHaveBeenCalled();
  });

  it('repairs create idempotency before publishing a session rename', () => {
    const state = harness();
    state.observer.sessionRenamed('temporary-a', 'canonical-a');

    expect(state.renameSessionMutationResults).toHaveBeenCalledWith(
      'temporary-a',
      'canonical-a',
    );
    expect(state.appendChange).toHaveBeenCalledWith(
      'session.renamed',
      'canonical-a',
      { fromId: 'temporary-a', toId: 'canonical-a' },
    );
  });
});
