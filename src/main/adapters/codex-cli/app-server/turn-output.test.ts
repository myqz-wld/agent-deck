import { describe, expect, it } from 'vitest';
import type { CodexAppServerStreamEvent } from './protocol';
import {
  CodexAppServerTurnError,
} from './notification-helpers';
import { collectCodexTurnOutput } from './turn-output';

function stream(
  events: CodexAppServerStreamEvent[],
): AsyncIterable<CodexAppServerStreamEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

describe('collectCodexTurnOutput', () => {
  it('returns the raw native context window only when paired with exact runtime identity', async () => {
    const runtimeIdentity = {
      runtimeProvider: 'openrouter',
      model: 'gpt-5.6-sol',
      capacityConfigFingerprint: 'model-context-window:272000',
    };
    const result = await collectCodexTurnOutput(stream([
      {
        type: 'server.notification',
        runtimeIdentity,
        notification: {
          method: 'thread/tokenUsage/updated',
          params: { tokenUsage: { modelContextWindow: 272_000 } },
        },
      },
      {
        type: 'server.notification',
        runtimeIdentity,
        notification: {
          method: 'item/completed',
          params: { item: { type: 'agentMessage', text: '{"formatVersion":1}' } },
        },
      },
    ]), 10_000);

    expect(result).toEqual({
      finalResponse: '{"formatVersion":1}',
      contextWindowEvidence: {
        ...runtimeIdentity,
        windowTokens: 272_000,
        source: 'runtime-usage',
      },
    });
  });

  it('does not create capacity evidence from a bare window', async () => {
    const result = await collectCodexTurnOutput(stream([{
      type: 'server.notification',
      runtimeIdentity: null,
      notification: {
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { modelContextWindow: 272_000 } },
      },
    }]), 10_000);

    expect(result.contextWindowEvidence).toBeNull();
  });

  it('preserves structured context-window overflow metadata on terminal errors', async () => {
    const work = collectCodexTurnOutput(stream([{
      type: 'server.notification',
      runtimeIdentity: { runtimeProvider: 'openai', model: 'gpt-5.6-sol' },
      notification: {
        method: 'turn/completed',
        params: {
          turn: {
            status: 'failed',
            error: {
              message: 'request too large',
              codexErrorInfo: 'contextWindowExceeded',
            },
          },
        },
      },
    }]), 10_000);

    await expect(work).rejects.toBeInstanceOf(CodexAppServerTurnError);
    await expect(work).rejects.toMatchObject({
      message: 'request too large',
      codexErrorInfo: 'contextWindowExceeded',
    });
  });
});
