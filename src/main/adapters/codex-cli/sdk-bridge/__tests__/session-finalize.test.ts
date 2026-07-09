import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import { persistSessionFields } from '@main/adapters/codex-cli/sdk-bridge/session-finalize';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    setCodexSandbox: vi.fn(),
    setModel: vi.fn(),
    setThinking: vi.fn(),
    setExtraAllowWrite: vi.fn(),
    setNetworkAccessEnabled: vi.fn(),
    setAdditionalDirectories: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
  },
}));

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sid',
    agentId: 'codex-cli',
    cwd: '/repo',
    title: 'repo',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  } as SessionRecord;
}

describe('codex persistSessionFields', () => {
  beforeEach(() => {
    vi.mocked(sessionRepo.setCodexSandbox).mockReset();
    vi.mocked(sessionRepo.setModel).mockReset();
    vi.mocked(sessionRepo.setThinking).mockReset();
    vi.mocked(sessionRepo.setExtraAllowWrite).mockReset();
    vi.mocked(sessionRepo.setNetworkAccessEnabled).mockReset();
    vi.mocked(sessionRepo.setAdditionalDirectories).mockReset();
    vi.mocked(sessionRepo.get).mockReset();
    vi.mocked(eventBus.emit).mockReset();
  });

  it('emits a fresh session-upserted row after persisting danger-full-access sandbox', () => {
    const updated = makeSession({ codexSandbox: 'danger-full-access' });
    vi.mocked(sessionRepo.get).mockReturnValue(updated);

    persistSessionFields({
      sessionId: 'sid',
      sandboxMode: 'danger-full-access',
      modelReasoningEffort: 'max',
    });

    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledWith('sid', 'danger-full-access');
    expect(sessionRepo.setThinking).toHaveBeenCalledWith('sid', 'max');
    expect(eventBus.emit).toHaveBeenCalledWith('session-upserted', updated);
  });

  it('skips the upsert emit when the session row disappeared', () => {
    vi.mocked(sessionRepo.get).mockReturnValue(null);

    persistSessionFields({
      sessionId: 'sid',
      sandboxMode: 'read-only',
    });

    expect(sessionRepo.setCodexSandbox).toHaveBeenCalledWith('sid', 'read-only');
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
