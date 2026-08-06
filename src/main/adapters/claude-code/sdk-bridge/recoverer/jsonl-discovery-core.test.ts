import { describe, expect, it, vi } from 'vitest';

import {
  defaultCwdExistsCore,
  defaultResumeJsonlExistsCore,
  defaultResumeJsonlMtimeMsCore,
  type ClaudeJsonlDiscoveryHost,
} from './jsonl-discovery-core';

function host(overrides: Partial<ClaudeJsonlDiscoveryHost> = {}): ClaudeJsonlDiscoveryHost {
  return {
    transcriptPath: vi.fn((cwd, sessionId) => `/transcripts/${cwd}/${sessionId}.jsonl`),
    pathExists: vi.fn(() => false),
    pathMtimeMs: vi.fn(() => 123),
    ...overrides,
  };
}

describe('Claude JSONL discovery Core', () => {
  it('probes the host-resolved transcript path', () => {
    const gatewayHost = host({ pathExists: vi.fn(() => false) });

    expect(defaultResumeJsonlExistsCore('repo', 'session-a', gatewayHost)).toBe(false);
    expect(gatewayHost.transcriptPath).toHaveBeenCalledWith('repo', 'session-a');
    expect(gatewayHost.pathExists).toHaveBeenCalledWith('/transcripts/repo/session-a.jsonl');
  });

  it.each(['path', 'probe'] as const)('fails resume existence open after a %s error', (seam) => {
    const gatewayHost = host(seam === 'path'
      ? { transcriptPath: () => { throw new Error('path failed'); } }
      : { pathExists: () => { throw new Error('probe failed'); } });

    expect(defaultResumeJsonlExistsCore('repo', 'session-a', gatewayHost)).toBe(true);
  });

  it('returns the transcript mtime and fails closed to null when it is unavailable', () => {
    expect(defaultResumeJsonlMtimeMsCore('repo', 'session-a', host())).toBe(123);
    expect(defaultResumeJsonlMtimeMsCore('repo', 'session-a', host({
      pathMtimeMs: () => { throw new Error('stat failed'); },
    }))).toBeNull();
  });

  it('probes cwd directly and fails open after an existence error', () => {
    const pathExists = vi.fn((path: string) => path === '/repo');
    expect(defaultCwdExistsCore('/repo', host({ pathExists }))).toBe(true);
    expect(pathExists).toHaveBeenCalledWith('/repo');
    expect(defaultCwdExistsCore('/repo', host({
      pathExists: () => { throw new Error('probe failed'); },
    }))).toBe(true);
  });
});
