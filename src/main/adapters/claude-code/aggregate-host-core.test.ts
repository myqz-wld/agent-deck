import { describe, expect, it, vi } from 'vitest';

import { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';
import type { AdapterContext } from '../types';
import {
  createClaudeCodeAdapterHost,
  type ClaudeCodeAggregateHostOptions,
} from './aggregate-host-core';
import { CLAUDE_HOOK_EVENTS, HookInstallerCore } from './hook-installer-core';

function fixture() {
  const createBridge = vi.fn();
  const readPermissionTimeoutMs = vi.fn(() => 12_000);
  const validateForkTarget = vi.fn();
  const summariseEvents = vi.fn(async () => 'summary');
  const bridge = {
    createBridge,
    readPermissionTimeoutMs,
    sessionManager: { delete: vi.fn(async () => undefined) },
  } as unknown as ClaudeCodeAggregateHostOptions['bridge'];
  const options: ClaudeCodeAggregateHostOptions = {
    bridge,
    fork: {} as ClaudeCodeAggregateHostOptions['fork'],
    hookDiagnostics: new HookRouteDiagnostics(),
    hookInstallerObserver: { statusReadFailed: vi.fn() },
    forkSafety: { validateForkTarget },
    summary: { summariseEvents },
  };
  return {
    createBridge,
    options,
    readPermissionTimeoutMs,
    summariseEvents,
    validateForkTarget,
  };
}

describe('Claude aggregate host Core', () => {
  it('constructs an immutable bridge and delegates value-owned behavior', async () => {
    const input = fixture();
    const host = createClaudeCodeAdapterHost(input.options);

    expect(Object.isFrozen(host)).toBe(true);
    expect(Object.isFrozen(host.bridge)).toBe(true);
    expect(host.bridge).not.toBe(input.options.bridge);
    expect(host.bridge.createBridge).toBe(input.createBridge);
    expect(host.bridge.readPermissionTimeoutMs()).toBe(12_000);

    host.validateForkTarget('gateway-a');
    expect(input.validateForkTarget).toHaveBeenCalledWith('gateway-a');
    await expect(
      host.summariseEvents('/repo', [], 'evidence', {
        provider: 'gateway-a',
        model: 'small',
        thinking: 'low',
      }),
    ).resolves.toBe('summary');
    expect(input.summariseEvents).toHaveBeenCalledWith(
      '/repo',
      [],
      'evidence',
      { provider: 'gateway-a', model: 'small', thinking: 'low' },
    );
  });

  it('owns hook construction and registers the exact Claude route surface', () => {
    const input = fixture();
    const host = createClaudeCodeAdapterHost(input.options);
    const registerForAdapter = vi.fn();
    const context: AdapterContext = {
      hookServer: {
        isRunning: true,
        listeningPort: 47_821,
        bearerToken: 'h'.repeat(64),
        mcpBearerToken: 'm'.repeat(64),
      },
      routeRegistry: { registerForAdapter },
      emit: vi.fn(),
      paths: {
        appUserData: '/private/app-data',
        userHome: '/private/home',
        userClaudeSettings: '/private/home/.claude/settings.json',
      },
    };

    expect(host.createHookIntegration(context)).toBeInstanceOf(HookInstallerCore);
    host.registerHookRoutes(context, 'claude-code');
    expect(registerForAdapter).toHaveBeenCalledTimes(CLAUDE_HOOK_EVENTS.length);
    expect(registerForAdapter.mock.calls.map(([adapterId, route]) => [
      adapterId,
      route.url,
    ])).toEqual(CLAUDE_HOOK_EVENTS.map((event) => [
      'claude-code',
      `/hook/${event.toLowerCase()}`,
    ]));
  });
});
