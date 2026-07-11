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

  it('persists only the continuation instruction plus lineage metadata', () => {
    const emit = vi.fn();
    vi.mocked(sessionRepo.get).mockReturnValue(null);
    finalizeSessionStart({
      applicationSid: 'successor',
      cwd: '/repo',
      prompt: 'Only this next-step instruction is visible.',
      continuationMetadata: {
        formatVersion: 1,
        checkpointId: 7,
        sourceSessionId: 'source',
        sourceEventRevision: 42,
        preparationHash: 'a'.repeat(64),
        messageOrigin: 'continuation',
      },
      claudeSandboxMode: 'off',
      emit,
    });
    const message = emit.mock.calls.map(([event]) => event).find((event) => event.kind === 'message');
    expect(message.payload).toMatchObject({
      text: 'Only this next-step instruction is visible.',
      role: 'user',
      messageOrigin: 'continuation',
      continuation: { checkpointId: 7, sourceEventRevision: 42 },
    });
    expect(JSON.stringify(message.payload)).not.toContain('Agent Deck Continuation Context');
  });

  it('emits a linked first session row before settling the spawn reservation', () => {
    const emit = vi.fn();
    const onRegistered = vi.fn(() => {
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'session-start',
          payload: expect.objectContaining({
            initialSpawnLink: { parentSessionId: 'lead', depth: 1 },
          }),
        }),
      );
    });
    vi.mocked(sessionRepo.get).mockReturnValue(null);

    finalizeSessionStart({
      applicationSid: 'child',
      cwd: '/repo',
      claudeSandboxMode: 'off',
      initialSessionRegistration: {
        spawnLink: { parentSessionId: 'lead', depth: 1 },
        onRegistered,
      },
      emit,
    });

    expect(onRegistered).toHaveBeenCalledWith('child');
  });
});
