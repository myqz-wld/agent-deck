import type { AgentEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';

import {
  HOOK_PROCESSING_FAILED_RESPONSE,
  INVALID_HOOK_BODY_RESPONSE,
  HookRouteDiagnostics,
  createHookRoute,
} from './route-diagnostics';

function replyStub(): {
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { code, send };
}

function event(sessionId = 'session-1234'): AgentEvent {
  return {
    sessionId,
    agentId: 'claude-code',
    kind: 'session-start',
    payload: {},
    ts: 1,
  };
}

function fakeLogger() {
  const records: Array<{ level: string; args: unknown[] }> = [];
  return {
    records,
    logger: {
      error: (...args: unknown[]) => records.push({ level: 'error', args }),
      warn: (...args: unknown[]) => records.push({ level: 'warn', args }),
      info: (...args: unknown[]) => records.push({ level: 'info', args }),
    },
  };
}

describe('HookRouteDiagnostics', () => {
  it('logs one failure, summarizes suppressed repeats, and reports recovery', () => {
    let now = 100;
    const capture = fakeLogger();
    const diagnostics = new HookRouteDiagnostics({
      logger: capture.logger,
      now: () => now,
      runId: () => 'run-test',
      suppressionWindowMs: 1_000,
    });
    const failure = {
      adapter: 'claude-code' as const,
      route: '/hook/stop',
      event: 'Stop',
      origin: 'sdk' as const,
      sessionId: 'session-123456',
      phase: 'translate' as const,
      error: new TypeError('private failure detail'),
    };

    diagnostics.reportFailure(failure);
    diagnostics.reportFailure(failure);
    now = 1_099;
    diagnostics.reportFailure(failure);
    expect(capture.records).toHaveLength(1);

    now = 1_100;
    diagnostics.reportFailure(failure);
    expect(capture.records.map((record) => record.level)).toEqual(['error', 'warn']);
    expect(capture.records[1]?.args[1]).toMatchObject({
      adapter: 'claude-code',
      route: '/hook/stop',
      event: 'Stop',
      origin: 'sdk',
      session: 'session-',
      phase: 'translate',
      errorCategory: 'type-error',
      state: 'degraded',
      suppressedCount: 2,
      runId: 'run-test',
    });

    now = 1_200;
    diagnostics.reportFailure(failure);
    now = 1_300;
    diagnostics.reportRecovery(failure);
    expect(capture.records.map((record) => record.level)).toEqual([
      'error',
      'warn',
      'info',
    ]);
    expect(capture.records[2]?.args[1]).toMatchObject({
      state: 'recovered',
      suppressedCount: 1,
      failureDurationMs: 1_200,
    });
  });

  it('bounds the suppressed count without logging repeated signatures', () => {
    const capture = fakeLogger();
    const diagnostics = new HookRouteDiagnostics({
      logger: capture.logger,
      now: () => 10,
      maxSuppressedCount: 2,
    });
    const failure = {
      adapter: 'grok-build' as const,
      route: '/hook/grok/stop',
      event: 'Stop',
      origin: 'cli' as const,
      sessionId: 'grok-session',
      phase: 'emit' as const,
      error: new Error('not logged'),
    };

    diagnostics.reportFailure(failure);
    for (let index = 0; index < 5; index += 1) diagnostics.reportFailure(failure);
    expect(capture.records).toHaveLength(1);

    diagnostics.reportRecovery(failure);
    expect(capture.records).toHaveLength(2);
    expect(capture.records[1]?.args[1]).toMatchObject({
      suppressedCount: 2,
      suppressedCountCapped: true,
    });
  });
});

describe('createHookRoute', () => {
  it('returns a stable 400 for invalid identity without inspecting payload details', async () => {
    const route = createHookRoute({
      adapter: 'codex-cli',
      event: 'SessionStart',
      url: '/hook/codex/sessionstart',
      extractSessionId: () => null,
      translate: () => event(),
      emit: vi.fn(),
      diagnostics: new HookRouteDiagnostics({ logger: fakeLogger().logger }),
    });
    const reply = replyStub();

    await (route.handler as (request: unknown, reply: unknown) => Promise<void>)(
      {
        body: { prompt: 'private prompt', token: 'private credential' },
        headers: {},
      },
      reply,
    );

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(INVALID_HOOK_BODY_RESPONSE);
  });

  it('categorizes translator failure and never logs raw errors, credentials, or payloads', async () => {
    const capture = fakeLogger();
    const diagnostics = new HookRouteDiagnostics({
      logger: capture.logger,
      runId: () => 'run-private-safe',
    });
    const route = createHookRoute({
      adapter: 'claude-code',
      event: 'UserPromptSubmit',
      url: '/hook/userpromptsubmit',
      extractSessionId: (body) =>
        (body as { session_id: string }).session_id,
      translate: () => {
        throw new Error(
          'translator exposed private-credential /Users/private/project raw-prompt',
        );
      },
      emit: vi.fn(),
      diagnostics,
    });
    const reply = replyStub();

    await (route.handler as (request: unknown, reply: unknown) => Promise<void>)(
      {
        body: {
          session_id: 'session-sensitive-long',
          prompt: 'raw-prompt',
          tool_input: { token: 'private-credential' },
          cwd: '/Users/private/project',
        },
        headers: {
          authorization: 'Bearer private-credential',
          'x-agent-deck-origin': 'sdk',
        },
      },
      reply,
    );

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith(HOOK_PROCESSING_FAILED_RESPONSE);
    expect(capture.records[0]).toMatchObject({ level: 'error' });
    expect(capture.records[0]?.args[1]).toMatchObject({
      adapter: 'claude-code',
      route: '/hook/userpromptsubmit',
      event: 'UserPromptSubmit',
      origin: 'sdk',
      session: 'session-',
      phase: 'translate',
      errorCategory: 'error',
    });
    const serialized = JSON.stringify(capture.records);
    expect(serialized).not.toContain('private-credential');
    expect(serialized).not.toContain('raw-prompt');
    expect(serialized).not.toContain('/Users/private/project');
    expect(serialized).not.toContain('tool_input');
    expect(serialized).not.toContain('authorization');
  });

  it('returns the same stable 500 and emit phase when the event sink throws', async () => {
    const capture = fakeLogger();
    const route = createHookRoute({
      adapter: 'grok-build',
      event: 'Stop',
      url: '/hook/grok/stop',
      extractSessionId: () => 'grok-session',
      translate: () => event('grok-session'),
      emit: () => {
        throw new RangeError('sink detail must remain private');
      },
      diagnostics: new HookRouteDiagnostics({ logger: capture.logger }),
    });
    const reply = replyStub();

    await (route.handler as (request: unknown, reply: unknown) => Promise<void>)(
      { body: {}, headers: {} },
      reply,
    );

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith(HOOK_PROCESSING_FAILED_RESPONSE);
    expect(capture.records[0]?.args[1]).toMatchObject({
      phase: 'emit',
      errorCategory: 'range-error',
    });
    expect(JSON.stringify(capture.records)).not.toContain('sink detail');
  });
});
