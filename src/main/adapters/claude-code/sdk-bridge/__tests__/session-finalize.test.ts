import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeSessionStart } from '../session-finalize';
import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { eventBus } from '@main/event-bus';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    setClaudeCodeSandbox: vi.fn(),
    setModel: vi.fn(),
    setThinking: vi.fn(),
    setExtraAllowWrite: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    updateCliSessionId: vi.fn(),
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
  },
}));

describe('claude finalizeSessionStart', () => {
  beforeEach(() => {
    vi.mocked(sessionRepo.setClaudeCodeSandbox).mockReset();
    vi.mocked(sessionRepo.setModel).mockReset();
    vi.mocked(sessionRepo.setThinking).mockReset();
    vi.mocked(sessionRepo.setExtraAllowWrite).mockReset();
    vi.mocked(sessionRepo.get).mockReset();
    vi.mocked(sessionManager.updateCliSessionId).mockReset();
    vi.mocked(eventBus.emit).mockReset();
  });

  it('persists Claude effort as session thinking when provided', () => {
    const emit = vi.fn();
    vi.mocked(sessionRepo.get).mockReturnValue(null);

    finalizeSessionStart({
      applicationSid: 'sid-app',
      cliSessionId: 'sid-cli',
      cwd: '/repo',
      prompt: 'hello',
      claudeSandboxMode: 'workspace-write',
      claudeCodeEffortLevel: 'xhigh',
      emit,
    });

    expect(sessionManager.updateCliSessionId).toHaveBeenCalledWith('sid-app', 'sid-cli');
    expect(sessionRepo.setClaudeCodeSandbox).toHaveBeenCalledWith(
      'sid-app',
      'workspace-write',
    );
    expect(sessionRepo.setThinking).toHaveBeenCalledWith('sid-app', 'xhigh');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sid-app',
        kind: 'session-start',
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sid-app',
        kind: 'message',
        payload: expect.objectContaining({ role: 'user', text: 'hello' }),
      }),
    );
  });
});
