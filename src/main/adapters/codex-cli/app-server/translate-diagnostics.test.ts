import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerNotification } from './protocol';
import { translateCodexAppServerNotification } from './translate';

function completedItem(type: unknown): CodexAppServerNotification {
  return {
    method: 'item/completed',
    params: { item: { id: 'item-1', type } },
  };
}

describe('Codex app-server translation diagnostics port', () => {
  it('reports a future item type without emitting a business event', () => {
    const emit = vi.fn();
    const observeIgnoredItemType = vi.fn();

    translateCodexAppServerNotification(completedItem('futureItem'), emit, {
      observeIgnoredItemType,
    });

    expect(observeIgnoredItemType).toHaveBeenCalledWith('futureItem');
    expect(emit).not.toHaveBeenCalled();
  });

  it('normalizes a non-string item type before it reaches diagnostics', () => {
    const observeIgnoredItemType = vi.fn();

    translateCodexAppServerNotification(completedItem({ raw: 'secret' }), vi.fn(), {
      observeIgnoredItemType,
    });

    expect(observeIgnoredItemType).toHaveBeenCalledWith('unknown');
  });

  it('contains diagnostics failures without changing translation', () => {
    const emit = vi.fn();

    expect(() => translateCodexAppServerNotification(completedItem('futureItem'), emit, {
      observeIgnoredItemType: () => {
        throw new Error('diagnostics failed');
      },
    })).not.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not let heuristic text override a terminal native retry flag', () => {
    const emit = vi.fn();
    const observeHeuristicStreamError = vi.fn();
    const message = 'provider disconnected and retrying with a new stream';

    translateCodexAppServerNotification({
      method: 'error',
      params: { error: { message }, willRetry: false },
    }, emit, { observeHeuristicStreamError });

    expect(observeHeuristicStreamError).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('finished', { ok: false, subtype: 'error' });
  });

  it('contains heuristic diagnostics failures without changing classification', () => {
    const emit = vi.fn();

    expect(() => translateCodexAppServerNotification({
      method: 'error',
      params: { error: { message: 'connection disconnected and retrying' } },
    }, emit, {
      observeHeuristicStreamError: () => {
        throw new Error('diagnostics failed');
      },
    })).not.toThrow();
    expect(emit).toHaveBeenCalledWith('message', { text: 'Codex 正在重连...' });
  });
});
