import { describe, expect, it } from 'vitest';

import {
  BROWSER_OPERATION_NAMES,
  browserOperationFailure,
  browserOperationSuccess,
  parseBrowserOperationRequest,
} from './operation-contract';

const REQUESTS = [
  { operation: 'open', args: { url: 'https://example.com', newTab: true } },
  { operation: 'tabs', args: {} },
  { operation: 'navigate', args: { url: 'https://example.com/next', tabId: 1 } },
  { operation: 'wait', args: { kind: 'selector', selector: '#ready' } },
  { operation: 'close', args: { tabId: 1 } },
  { operation: 'snapshot', args: { includeText: true, limit: 20 } },
  { operation: 'screenshot', args: { fullPage: false, maxWidth: 800 } },
  { operation: 'click', args: { ref: '1-2' } },
  { operation: 'type', args: { ref: '1-3', text: 'hello', clear: true } },
  { operation: 'press', args: { key: 'Enter' } },
  { operation: 'scroll', args: { dy: 600 } },
  { operation: 'console', args: { limit: 25 } },
  { operation: 'network', args: { limit: 25 } },
  { operation: 'evaluate', args: { expression: 'document.title' } },
] as const;

describe('Browser operation v1 contract', () => {
  it('parses the complete provider-neutral operation surface', () => {
    expect(REQUESTS.map((request) => request.operation)).toEqual(BROWSER_OPERATION_NAMES);

    for (const request of REQUESTS) {
      expect(parseBrowserOperationRequest({ protocolVersion: 1, ...request })).toEqual({
        protocolVersion: 1,
        ...request,
      });
    }
  });

  it.each(['sessionId', 'owner', 'lease', 'token', 'endpoint', 'cwd', 'provider'])(
    'rejects caller-controlled %s identity at the request boundary',
    (field) => {
      expect(() => parseBrowserOperationRequest({
        protocolVersion: 1,
        operation: 'tabs',
        args: {},
        [field]: 'spoofed',
      })).toThrow();
      expect(() => parseBrowserOperationRequest({
        protocolVersion: 1,
        operation: 'tabs',
        args: { [field]: 'spoofed' },
      })).toThrow();
    },
  );

  it('enforces operation-specific closed-world and cross-field rules', () => {
    expect(() => parseBrowserOperationRequest({
      protocolVersion: 1, operation: 'navigate', args: {},
    })).toThrow();
    expect(() => parseBrowserOperationRequest({
      protocolVersion: 1, operation: 'navigate', args: { url: 'https://example.com', reload: true },
    })).toThrow();
    expect(() => parseBrowserOperationRequest({
      protocolVersion: 1, operation: 'wait', args: { kind: 'selector', idleMs: 500 },
    })).toThrow();
    expect(() => parseBrowserOperationRequest({
      protocolVersion: 1, operation: 'close', args: { tabId: 1, all: true },
    })).toThrow();
    expect(() => parseBrowserOperationRequest({
      protocolVersion: 1, operation: 'scroll', args: { ref: '1-2', to: 'bottom' },
    })).toThrow();
  });

  it('builds bounded versioned envelopes without ambient authority fields', () => {
    const success = browserOperationSuccess('tabs', { tabs: [] });
    const failure = browserOperationFailure('click', {
      code: 'stale_ref',
      message: 'The element reference is stale.',
      retryable: true,
      nextAction: 'Run agent-deck-browser snapshot again.',
    });

    expect(success).toEqual({
      ok: true,
      protocolVersion: 1,
      operation: 'tabs',
      data: { tabs: [] },
      artifacts: [],
    });
    expect(failure).toEqual({
      ok: false,
      protocolVersion: 1,
      operation: 'click',
      error: {
        code: 'stale_ref',
        message: 'The element reference is stale.',
        retryable: true,
        nextAction: 'Run agent-deck-browser snapshot again.',
      },
    });
    expect(JSON.stringify({ success, failure })).not.toMatch(
      /sessionId|owner|lease|token|endpoint|cwd|provider/,
    );
  });
});
