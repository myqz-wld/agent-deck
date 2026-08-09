import { describe, expect, it, vi } from 'vitest';
import {
  resolveClaudeRuntimeModelCore,
  syncClaudeRuntimeEffortCore,
  syncClaudeRuntimeModelCore,
  type ClaudeRuntimeMetadataHost,
  type ClaudeRuntimeMetadataOwner,
} from './runtime-metadata-core';

function makeHost(): ClaudeRuntimeMetadataHost {
  return {
    read: vi.fn(() => ({ model: 'opus', thinking: 'high' })),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    emitUpdated: vi.fn(),
    warnFailure: vi.fn(),
  };
}

describe('Claude runtime metadata Core', () => {
  it('maps provider aliases and persists only changed observations', () => {
    const host = makeHost();
    const owner: ClaudeRuntimeMetadataOwner = {
      applicationSid: 'session',
      gatewayModelAliases: { opus: 'deepseek-v4-pro[1m]' },
    };
    syncClaudeRuntimeModelCore(owner, 'claude-opus-4-8', host);
    syncClaudeRuntimeEffortCore(owner, 'xhigh', host);

    expect(owner.runtimeModel).toBe('deepseek-v4-pro[1m]');
    expect(owner.runtimeEffort).toBe('xhigh');
    expect(host.setModel).toHaveBeenCalledWith('session', 'deepseek-v4-pro[1m]');
    expect(host.setEffort).toHaveBeenCalledWith('session', 'xhigh');
    expect(host.emitUpdated).toHaveBeenCalledTimes(2);
    expect(resolveClaudeRuntimeModelCore(' custom-model ')).toBe('custom-model');
  });

  it('retains in-memory observations and swallows persistence diagnostics failures', () => {
    const host = makeHost();
    vi.mocked(host.read).mockImplementation(() => { throw new Error('db unavailable'); });
    vi.mocked(host.warnFailure).mockImplementation(() => { throw new Error('logger unavailable'); });
    const owner: ClaudeRuntimeMetadataOwner = { applicationSid: 'session' };

    expect(() => syncClaudeRuntimeModelCore(owner, 'claude-sonnet-5', host)).not.toThrow();
    expect(() => syncClaudeRuntimeEffortCore(owner, 'medium', host)).not.toThrow();
    expect(owner.runtimeModel).toBe('claude-sonnet-5');
    expect(owner.runtimeEffort).toBe('medium');
  });
});
