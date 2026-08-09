import { describe, expect, it } from 'vitest';

import {
  parseDesktopBrokerNextResult,
  parseDesktopBrokerRespondParams,
  parseDesktopBrokerToolResult,
} from './desktop-broker';

describe('desktop broker contract', () => {
  it('round-trips one bounded browser request and mixed MCP content', () => {
    expect(parseDesktopBrokerNextResult({
      request: {
        requestId: 'browser-a',
        sessionId: 'session-a',
        kind: 'browser',
        operation: 'browser_screenshot',
        args: { fullPage: false, maxWidth: 800 },
        leaseMs: 1_000,
      },
      revision: 4,
    })).toMatchObject({
      request: { operation: 'browser_screenshot', sessionId: 'session-a' },
      revision: 4,
    });
    expect(parseDesktopBrokerRespondParams({
      requestId: 'browser-a',
      result: {
        content: [
          { type: 'text', text: '{"inlineImage":true}' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
      },
    }).result.content).toHaveLength(2);
  });

  it('rejects unknown operations, extra fields, oversized text, and non-PNG images', () => {
    expect(() => parseDesktopBrokerNextResult({
      request: {
        requestId: 'browser-a', sessionId: 'session-a', kind: 'browser',
        operation: 'browser_shell', args: {}, leaseMs: 1,
      },
      revision: 1,
    })).toThrow();
    expect(() => parseDesktopBrokerToolResult({
      content: [],
      path: '/private/desktop.png',
    })).toThrow();
    expect(() => parseDesktopBrokerToolResult({
      content: [{ type: 'text', text: 'x'.repeat(256 * 1024 + 1) }],
    })).toThrow();
    expect(() => parseDesktopBrokerToolResult({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' }],
    })).toThrow();
  });
});
