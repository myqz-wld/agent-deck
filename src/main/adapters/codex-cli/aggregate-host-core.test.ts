import { describe, expect, it, vi } from 'vitest';
import { PERIODIC_SUMMARY_TIMEOUT_MS } from '@shared/types';

import { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';
import type { AdapterContext } from '../types';
import {
  createCodexCliAdapterHost,
  type CodexCliAggregateHostOptions,
} from './aggregate-host-core';
import { CODEX_HOOK_EVENTS, CodexHookInstaller } from './hook-installer';

function fixture() {
  const createBridge = vi.fn();
  const readCodexCliPath = vi.fn(() => '/trusted/codex');
  const resolveProvider = vi.fn((provider: string | null | undefined) =>
    provider?.trim() || undefined);
  const runOneshot = vi.fn(async () => 'summary');
  const options: CodexCliAggregateHostOptions = {
    bridge: {
      createBridge,
      readCodexCliPath,
      readPermissionTimeoutMs: vi.fn(() => 12_000),
    } as unknown as CodexCliAggregateHostOptions['bridge'],
    hookRoutes: {
      filter: { shouldIgnore: vi.fn(async () => false) },
      diagnostics: new HookRouteDiagnostics(),
      openToolUseReader: { listForSession: vi.fn(() => []) },
      observer: { reconciliationFailed: vi.fn() },
    },
    hookInstallerObserver: { statusReadFailed: vi.fn() },
    providerResolver: { resolveProvider },
    summary: {
      readSummaryModel: vi.fn(() => 'small'),
      readSummaryReasoning: vi.fn(() => 'low'),
      runOneshot,
      formatEvents: vi.fn(() => ''),
    },
  };
  return { createBridge, options, readCodexCliPath, resolveProvider, runOneshot };
}

describe('Codex aggregate host Core', () => {
  it('constructs an immutable bridge and delegates provider and summary behavior', async () => {
    const input = fixture();
    const host = createCodexCliAdapterHost(input.options);

    expect(Object.isFrozen(host)).toBe(true);
    expect(Object.isFrozen(host.bridge)).toBe(true);
    expect(host.bridge).not.toBe(input.options.bridge);
    expect(host.bridge.createBridge).toBe(input.createBridge);
    expect(host.bridge.readCodexCliPath()).toBe('/trusted/codex');
    expect(host.resolveProvider(' provider-a ')).toBe('provider-a');
    expect(input.resolveProvider).toHaveBeenCalledWith(' provider-a ');

    await expect(
      host.summariseEvents('/repo', [], 'evidence', {
        provider: 'provider-a',
        model: 'model-a',
        thinking: 'medium',
      }),
    ).resolves.toBe('summary');
    expect(input.runOneshot).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      provider: 'provider-a',
      model: 'model-a',
      modelReasoningEffort: 'medium',
      timeoutMs: PERIODIC_SUMMARY_TIMEOUT_MS,
    }));
  });

  it('owns hook construction and registers the exact Codex route surface', () => {
    const input = fixture();
    const host = createCodexCliAdapterHost(input.options);
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

    expect(host.createHookIntegration(context)).toBeInstanceOf(CodexHookInstaller);
    host.registerHookRoutes(context, 'codex-cli');
    expect(registerForAdapter).toHaveBeenCalledTimes(CODEX_HOOK_EVENTS.length);
    expect(registerForAdapter.mock.calls.map(([adapterId, route]) => [
      adapterId,
      route.url,
    ])).toEqual(CODEX_HOOK_EVENTS.map((event) => [
      'codex-cli',
      `/hook/codex/${event.toLowerCase()}`,
    ]));
  });
});
