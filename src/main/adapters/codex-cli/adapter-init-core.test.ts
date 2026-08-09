import { describe, expect, it, vi } from 'vitest';
import {
  createCodexAdapterBridgeWithHost,
  type CodexAdapterInitHost,
} from './adapter-init-core';

describe('Codex adapter init Core', () => {
  it('preserves timeout construction before the host-owned CLI path is applied', () => {
    const calls: string[] = [];
    const bridge = {
      setCodexCliPath: vi.fn((path: string | null) => {
        calls.push(`set-path:${path}`);
      }),
    };
    const recoveryContinuationHost = {} as CodexAdapterInitHost<typeof bridge>['recoveryContinuationHost'];
    const runtimeHost = {} as CodexAdapterInitHost<typeof bridge>['runtimeHost'];
    const host: CodexAdapterInitHost<typeof bridge> = {
      recoveryContinuationHost,
      runtimeHost,
      createBridge: vi.fn(() => {
        calls.push('create');
        return bridge;
      }),
      readCodexCliPath: vi.fn(() => {
        calls.push('read-path');
        return '/trusted/codex';
      }),
      readPermissionTimeoutMs: vi.fn(() => {
        calls.push('read-timeout');
        return 12_000;
      }),
    };
    const emit = vi.fn();
    const hookServer = {} as NonNullable<Parameters<typeof createCodexAdapterBridgeWithHost>[2]>;

    expect(createCodexAdapterBridgeWithHost(host, emit, hookServer)).toBe(bridge);
    expect(host.createBridge).toHaveBeenCalledWith({
      emit,
      hookServer,
      recoveryContinuationHost,
      runtimeHost,
      permissionTimeoutMs: 12_000,
    });
    expect(bridge.setCodexCliPath).toHaveBeenCalledWith('/trusted/codex');
    expect(calls).toEqual([
      'read-timeout',
      'create',
      'read-path',
      'set-path:/trusted/codex',
    ]);
  });
});
