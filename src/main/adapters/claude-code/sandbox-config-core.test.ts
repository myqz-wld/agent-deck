import { describe, expect, it, vi } from 'vitest';
import {
  buildSandboxOptionsCore,
  type ClaudeSandboxHost,
  type SandboxMode,
} from './sandbox-config-core';

function host(home = '/home/core'): ClaudeSandboxHost {
  return {
    homeDir: vi.fn(() => home),
    observeState: vi.fn(),
  };
}

describe('Claude sandbox configuration Core', () => {
  it('builds workspace policy only from the injected home and ordered roots', () => {
    const injected = host();

    const result = buildSandboxOptionsCore(
      'workspace-write',
      '/repo',
      injected,
      ['/repo', '/shared', '/shared'],
    );

    expect(result.sandbox?.filesystem?.allowWrite).toEqual([
      '/repo',
      '/shared',
      '/tmp',
      '/home/core/.cache/claude-code',
    ]);
    expect(result.sandbox?.filesystem?.denyRead).toContain('/home/core/.ssh');
    expect(injected.homeDir).toHaveBeenCalledOnce();
    expect(injected.observeState).toHaveBeenCalledWith('healthy');
  });

  it('fails an unknown mode closed without reflecting it or trusting diagnostics', () => {
    const injected = host();
    injected.observeState = vi.fn(() => { throw new Error('diagnostic failure'); });

    expect(buildSandboxOptionsCore(
      { raw: 'secret' } as unknown as SandboxMode,
      '/private/repo',
      injected,
    )).toEqual({});
    expect(injected.homeDir).not.toHaveBeenCalled();
    expect(injected.observeState).toHaveBeenCalledWith('invalid-mode');
  });
});
