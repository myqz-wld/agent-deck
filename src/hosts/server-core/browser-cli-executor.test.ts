import { describe, expect, it, vi } from 'vitest';

import type { BrowserLeaseBinding } from '@main/browser-use/browser-lease-registry-core';
import {
  BROWSER_OPERATION_PROTOCOL_VERSION,
  type BrowserOperationRequest,
} from '@main/browser-use/operation-contract';

import { createServerCoreBrowserCliExecutor } from './browser-cli-executor';
import { ServerCoreDesktopBrokerError } from './desktop-broker-port';

const binding: BrowserLeaseBinding = {
  applicationSessionId: 'core-session-a',
  adapterId: 'claude-code',
  runtimeGeneration: 3,
  sourceIdentity: 'runtime-source-a',
  expiresAt: Date.now() + 60_000,
};

function request(
  operation: BrowserOperationRequest['operation'],
  args: BrowserOperationRequest['args'] = {},
): BrowserOperationRequest {
  return { protocolVersion: BROWSER_OPERATION_PROTOCOL_VERSION, operation, args } as BrowserOperationRequest;
}

describe('Server Core Browser CLI executor', () => {
  it('binds the trusted lease identity to the existing Desktop broker invocation', async () => {
    const invoke = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"tabs":[]}' }],
    }));
    const execute = createServerCoreBrowserCliExecutor({
      desktopBroker: { invoke },
      artifacts: { persist: vi.fn() },
    });

    const result = await execute(binding, request('tabs'));

    expect(invoke).toHaveBeenCalledWith('core-session-a', 'browser_tabs', {});
    expect(result).toMatchObject({ ok: true, operation: 'tabs', data: { tabs: [] } });
    expect(JSON.stringify(result)).not.toMatch(/core-session-a|runtime-source-a/);
  });

  it('persists a Desktop screenshot as a Core-local artifact without returning inline data', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const persist = vi.fn(async () => '/workspaces/project/.agent-deck/browser/tab-4.png');
    const execute = createServerCoreBrowserCliExecutor({
      desktopBroker: {
        invoke: vi.fn(async () => ({
          content: [
            { type: 'text' as const, text: '{"tabId":4,"url":"about:blank"}' },
            { type: 'image' as const, mimeType: 'image/png' as const, data: png.toString('base64') },
          ],
        })),
      },
      artifacts: { persist },
    });

    const result = await execute(binding, request('screenshot', { tabId: 4 }));

    expect(persist).toHaveBeenCalledWith({
      applicationSessionId: 'core-session-a', sourceIdentity: 'runtime-source-a',
      tabId: 4, png,
    });
    expect(result).toMatchObject({
      ok: true,
      artifacts: [{ path: '/workspaces/project/.agent-deck/browser/tab-4.png' }],
    });
    expect(JSON.stringify(result)).not.toContain(png.toString('base64'));
  });

  it('collapses Desktop transport failures without exposing internal messages', async () => {
    const execute = createServerCoreBrowserCliExecutor({
      desktopBroker: {
        invoke: vi.fn(async () => {
          throw new ServerCoreDesktopBrokerError('unavailable', '/private/core/socket missing');
        }),
      },
      artifacts: { persist: vi.fn() },
    });

    const result = await execute(binding, request('tabs'));

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable', retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain('/private/core/socket');
  });
});
