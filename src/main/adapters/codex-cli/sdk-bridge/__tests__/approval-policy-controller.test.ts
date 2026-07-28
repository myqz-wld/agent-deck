import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';

const mocks = vi.hoisted(() => ({
  record: null as SessionRecord | null,
  setCodexApprovalPolicy: vi.fn(),
  eventEmit: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(() => mocks.record),
    setCodexApprovalPolicy: mocks.setCodexApprovalPolicy,
  },
}));
vi.mock('@main/event-bus', () => ({
  eventBus: { emit: mocks.eventEmit },
}));
vi.mock('@main/utils/logger', () => ({
  default: {
    scope: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

import {
  RestartController,
  type RestartCtx,
} from '../restart-controller';

function record(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id: 'codex-session',
    agentId: 'codex-cli',
    cwd: '/repo',
    title: 'Codex',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    codexApprovalPolicy: 'never',
    ...overrides,
  };
}

function controller(
  applyLiveApprovalPolicy: RestartCtx['applyLiveApprovalPolicy'],
  emit = vi.fn(),
): { controller: RestartController; emit: ReturnType<typeof vi.fn> } {
  return {
    controller: new RestartController({
      recovering: new Map(),
      emit,
      applyLiveApprovalPolicy,
      applyLiveSandbox: vi.fn(() => false),
    }),
    emit,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.record = record();
  mocks.setCodexApprovalPolicy.mockImplementation(
    (_sessionId: string, policy: SessionRecord['codexApprovalPolicy']) => {
      if (mocks.record) {
        mocks.record = { ...mocks.record, codexApprovalPolicy: policy };
      }
    },
  );
});

describe('Codex approval-policy next-turn controller', () => {
  it('persists, emits, and patches a live thread', async () => {
    const applyLive = vi.fn(() => true);
    const { controller: subject, emit } = controller(applyLive);

    await subject.setCodexApprovalPolicy('codex-session', 'on-request');

    expect(mocks.setCodexApprovalPolicy).toHaveBeenCalledWith(
      'codex-session',
      'on-request',
    );
    expect(mocks.eventEmit).toHaveBeenCalledWith(
      'session-upserted',
      expect.objectContaining({ codexApprovalPolicy: 'on-request' }),
    );
    expect(applyLive).toHaveBeenCalledWith('codex-session', 'on-request');
    expect(emit).not.toHaveBeenCalled();
  });

  it('persists for a dormant session without requiring a live thread', async () => {
    mocks.record = record({ lifecycle: 'dormant' });
    const applyLive = vi.fn(() => false);
    const { controller: subject } = controller(applyLive);

    await expect(
      subject.setCodexApprovalPolicy('codex-session', 'untrusted'),
    ).resolves.toBeUndefined();

    expect(mocks.record?.codexApprovalPolicy).toBe('untrusted');
    expect(applyLive).toHaveBeenCalledOnce();
  });

  it('rolls back both projections and reports an error when live patching fails', async () => {
    const applyLive = vi.fn(
      (_sessionId: string, policy: SessionRecord['codexApprovalPolicy']) => {
        if (policy === 'on-request') throw new Error('live patch failed');
        return true;
      },
    );
    const { controller: subject, emit } = controller(applyLive);

    await expect(
      subject.setCodexApprovalPolicy('codex-session', 'on-request'),
    ).rejects.toThrow('live patch failed');

    expect(mocks.setCodexApprovalPolicy).toHaveBeenNthCalledWith(
      1,
      'codex-session',
      'on-request',
    );
    expect(mocks.setCodexApprovalPolicy).toHaveBeenNthCalledWith(
      2,
      'codex-session',
      'never',
    );
    expect(applyLive).toHaveBeenNthCalledWith(
      2,
      'codex-session',
      'never',
    );
    expect(mocks.record?.codexApprovalPolicy).toBe('never');
    expect(mocks.eventEmit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'message',
        payload: expect.objectContaining({
          error: true,
          text: expect.stringContaining('切换审批策略'),
        }),
      }),
    );
  });

  it('reports state unknown instead of claiming rollback when DB and live rollback both fail', async () => {
    mocks.setCodexApprovalPolicy
      .mockImplementationOnce((_sessionId: string, policy: SessionRecord['codexApprovalPolicy']) => {
        if (mocks.record) mocks.record = { ...mocks.record, codexApprovalPolicy: policy };
      })
      .mockImplementationOnce(() => {
        throw new Error('DB rollback failed');
      });
    const applyLive = vi.fn(() => {
      throw new Error('live projection failed');
    });
    const { controller: subject, emit } = controller(applyLive);

    await expect(
      subject.setCodexApprovalPolicy('codex-session', 'on-request'),
    ).rejects.toThrow('live projection failed');

    expect(mocks.setCodexApprovalPolicy).toHaveBeenCalledTimes(2);
    expect(applyLive).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'message',
      payload: expect.objectContaining({
        error: true,
        text: expect.stringMatching(/回退未完全成功.*当前状态未知/),
      }),
    }));
    const text = (emit.mock.calls.at(-1)?.[0]?.payload as { text?: string }).text ?? '';
    expect(text).not.toContain('策略已回退');
  });
});
