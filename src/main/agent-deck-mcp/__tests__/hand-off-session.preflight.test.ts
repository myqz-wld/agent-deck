import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handOffSessionHandler } from '../tools/handlers/hand-off-session';
import type { HandOffSessionHandlerDeps } from '../tools/handlers/hand-off-session/_deps';
import { sessionRepo } from '@main/store/session-repo';
import type { SessionRecord } from '@shared/types';

function callerRow(): SessionRecord {
  return {
    id: 'caller-sid',
    agentId: 'codex-cli',
    cwd: '/repo',
    title: 'caller',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    model: 'gpt-source',
    thinking: 'high',
    codexSandbox: 'read-only',
  };
}

function preflightDeps(prepareContinuation: ReturnType<typeof vi.fn>): HandOffSessionHandlerDeps {
  return {
    cwdIsDirectory: () => true,
    sourceMaxEventId: () => 1,
    sourceRuntimeFingerprint: () => 'source-runtime-v1',
    validateTargetAdapter: () => null,
    prepareContinuation,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hand_off_session preflight', () => {
  it.each([
    ['permissionMode', { adapter: 'codex-cli' as const, permissionMode: 'plan' as const }],
    ['claudeCodeSandbox', { adapter: 'codex-cli' as const, claudeCodeSandbox: 'strict' as const }],
    ['extraAllowWrite', { adapter: 'codex-cli' as const, extraAllowWrite: ['/must-write'] }],
    ['codexSandbox', { adapter: 'claude-code' as const, codexSandbox: 'read-only' as const }],
  ])('rejects adapter-incompatible %s before paid preparation', async (field, targetArgs) => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const prepareContinuation = vi.fn();

    const result = await handOffSessionHandler(
      { prompt: 'continue', ...targetArgs },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      preflightDeps(prepareContinuation),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(`handoff target ${field} is incompatible`);
    expect(prepareContinuation).not.toHaveBeenCalled();
  });

  it('rejects an existing regular file as cwd before paid preparation', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-handoff-cwd-'));
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'test');
    const prepareContinuation = vi.fn();
    const deps = preflightDeps(prepareContinuation);
    delete deps.cwdIsDirectory;

    try {
      const result = await handOffSessionHandler(
        { prompt: 'continue', cwd: file },
        { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('cwd is not an existing directory');
      expect(prepareContinuation).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
