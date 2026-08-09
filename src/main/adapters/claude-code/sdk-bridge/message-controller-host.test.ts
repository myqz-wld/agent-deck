import { describe, expect, it, vi } from 'vitest';

const guardHandOffSourceIngress = vi.hoisted(() => vi.fn(() => true));
const warn = vi.hoisted(() => vi.fn());
vi.mock('@main/session/hand-off/ingress-guard', () => ({ guardHandOffSourceIngress }));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn }) },
}));

describe('desktop Claude message controller host', () => {
  it('owns ingress diversion, enqueue diagnostics, and the wall clock', async () => {
    const { desktopClaudeMessageControllerHost: host } = await import(
      './message-controller-host'
    );
    const input = {
      sourceSessionId: 'session',
      agentId: 'claude-code' as const,
      text: 'message',
      emit: vi.fn(),
      replay: vi.fn(async () => undefined),
    };
    const error = new Error('event failed');

    expect(host.guardSourceIngress(input)).toBe(true);
    host.acceptedEnqueueEventFailed('intent-1', error);

    expect(guardHandOffSourceIngress).toHaveBeenCalledWith(input);
    expect(warn).toHaveBeenCalledWith(
      '[claude-bridge] accepted enqueue event failed key=intent-1',
      error,
    );
    expect(host.now()).toEqual(expect.any(Number));
  });
});
