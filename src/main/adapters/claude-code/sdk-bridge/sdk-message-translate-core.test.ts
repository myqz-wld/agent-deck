import { describe, expect, it, vi } from 'vitest';

import { makeInternalSession, type PendingUserMessage } from './types';
import {
  translateSdkMessageCore,
  type ClaudeSdkMessageTranslationHost,
} from './sdk-message-translate-core';

function host(): ClaudeSdkMessageTranslationHost & {
  now: ReturnType<typeof vi.fn>;
  runtimeMetadata: ClaudeSdkMessageTranslationHost['runtimeMetadata'] & {
    setModel: ReturnType<typeof vi.fn>;
    emitUpdated: ReturnType<typeof vi.fn>;
  };
  state: ClaudeSdkMessageTranslationHost['state'] & {
    setPermissionMode: ReturnType<typeof vi.fn>;
    publishUpdated: ReturnType<typeof vi.fn>;
  };
} {
  const records = new Map<string, { model?: string; permissionMode?: string }>([
    ['session-a', { model: 'old-model', permissionMode: 'default' }],
  ]);
  const runtimeMetadata = {
    read: (sessionId: string) => records.get(sessionId) ?? null,
    setModel: vi.fn((sessionId: string, model: string) => {
      records.set(sessionId, { ...records.get(sessionId), model });
    }),
    setEffort: vi.fn(),
    emitUpdated: vi.fn(),
    warnFailure: vi.fn(),
  };
  const state = {
    read: (sessionId: string) => records.get(sessionId) ?? null,
    setPermissionMode: vi.fn((sessionId: string, permissionMode: string) => {
      records.set(sessionId, { ...records.get(sessionId), permissionMode });
    }),
    publishUpdated: vi.fn(),
  };
  return {
    agentId: 'claude-core',
    now: vi.fn(() => 5150),
    runtimeMetadata,
    liveRate: {
      resolveModel: () => 'claude-opus-4-8',
      emitTokenRateTick: vi.fn(),
    },
    state,
  };
}

describe('Claude SDK message translator Core', () => {
  it('keeps child content and tools out of the parent timeline while retaining billed usage', () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
    internal.userTurnInFlight = false;
    internal.toolUseNames.set('main-call', 'Bash');
    const emit = vi.fn();
    const translationHost = host();
    const child = {
      type: 'assistant', parent_tool_use_id: 'agent-call', error: 'rate_limit',
      message: {
        id: 'child-message', model: 'claude-opus-4-8',
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [
          { type: 'thinking', thinking: 'Child reasoning' },
          { type: 'text', text: 'Child report' },
          { type: 'image', source: { type: 'base64', data: 'test-image' } },
          { type: 'tool_use', id: 'child-shell', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_use', id: 'child-write', name: 'Write',
            input: { file_path: '/workspace/child.txt', content: 'child output' } },
        ],
      },
    };
    translateSdkMessageCore(emit, 'session-a', child, internal, translationHost);
    translateSdkMessageCore(emit, 'session-a', child, internal, translationHost);
    translateSdkMessageCore(emit, 'session-a', {
      type: 'user', parent_tool_use_id: 'agent-call', message: { content: [
        { type: 'tool_result', tool_use_id: 'child-shell', content: '/workspace' },
        { type: 'tool_result', tool_use_id: 'child-write', content: 'Written' },
        { type: 'tool_result', tool_use_id: 'main-call', content: 'Child cannot settle main tool' },
      ] },
    }, internal, translationHost);

    expect(emit.mock.calls.map(([event]) => event.kind)).toEqual(['token-usage']);
    expect(emit.mock.calls[0][0].payload).toMatchObject({
      messageId: 'child-message', inputTokens: 100, outputTokens: 20,
    });
    expect(internal.toolUseNames).toEqual(new Map([['main-call', 'Bash']]));
    expect(internal.pendingFileChangeIntents).toHaveLength(0);
    expect(internal.userTurnInFlight).toBe(false);
  });

  it('does not let child streaming frames overwrite the main live-rate state', () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
    const translationHost = host();
    const emit = vi.fn();
    translateSdkMessageCore(emit, 'session-a', {
      type: 'stream_event', parent_tool_use_id: null,
      event: { type: 'message_start', message: { role: 'assistant', model: 'claude-opus-4-8' } },
    }, internal, translationHost);
    const mainEstimate = internal.liveTokenEstimate;
    const before = { ...mainEstimate };
    for (const event of [
      { type: 'message_start', message: { role: 'assistant', model: 'claude-haiku-4-5' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Child output' } },
    ]) {
      translateSdkMessageCore(emit, 'session-a', {
        type: 'stream_event', parent_tool_use_id: 'agent-call', event,
      }, internal, translationHost);
    }
    expect(internal.liveTokenEstimate).toBe(mainEstimate);
    expect(internal.liveTokenEstimate).toEqual(before);
    expect(translationHost.liveRate.emitTokenRateTick).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('preserves main Agent and Bash calls with parent id %s', (parentToolUseId) => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
    const translationHost = host();
    const emit = vi.fn();
    const send = (type: string, content: unknown[]) => translateSdkMessageCore(emit, 'session-a', {
      type, parent_tool_use_id: parentToolUseId, message: { content },
    }, internal, translationHost);
    send('assistant', [
      { type: 'tool_use', id: 'agent-call', name: 'Agent', input: { prompt: 'Inspect code' } },
      { type: 'tool_use', id: 'main-shell', name: 'Bash', input: { command: 'pwd' } },
    ]);
    send('user', [
      { type: 'tool_result', tool_use_id: 'agent-call', content: 'Agent started' },
      { type: 'tool_result', tool_use_id: 'main-shell', content: '/workspace' },
    ]);
    expect(emit.mock.calls.map(([event]) => [event.kind, event.payload.toolName])).toEqual([
      ['tool-use-start', 'Agent'], ['tool-use-start', 'Bash'],
      ['tool-use-end', 'Agent'], ['tool-use-end', 'Bash'],
    ]);
    expect(internal.toolUseNames.size).toBe(0);
  });

  it.each(['completed', 'failed', 'stopped'])(
    'retains background subagent progress and %s after the main turn finishes', (status) => {
      const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
      internal.userTurnInFlight = false;
      const translationHost = host();
      const emit = vi.fn();
      const send = (frame: { type: string; [key: string]: unknown }) =>
        translateSdkMessageCore(emit, 'session-a', frame, internal, translationHost);
      send({ type: 'system', subtype: 'task_started', task_id: 'child-task', run_id: 'run-1',
        tool_use_id: 'agent-call', task_type: 'local_agent', is_backgrounded: true,
        description: 'Inspect code' });
      send({ type: 'result', subtype: 'success' });
      send({ type: 'assistant', parent_tool_use_id: 'agent-call', message: { content: [
        { type: 'tool_use', id: 'child-shell', name: 'Bash', input: { command: 'pwd' } },
      ] } });
      send({ type: 'user', parent_tool_use_id: 'agent-call', message: { content: [
        { type: 'tool_result', tool_use_id: 'child-shell', content: '/workspace' },
      ] } });
      send({ type: 'system', subtype: 'task_progress', task_id: 'child-task', run_id: 'run-1',
        description: 'Reading code', last_tool_name: 'Bash',
        usage: { total_tokens: 120, tool_uses: 2, duration_ms: 5_000 } });
      send({ type: 'system', subtype: 'task_notification', task_id: 'child-task', run_id: 'run-1',
        status, summary: 'Child outcome', output_file: '/workspace/child.log' });
      send({ type: 'system', subtype: 'task_progress', task_id: 'child-task', run_id: 'run-1',
        description: 'Late progress' });

      const parentEvents = emit.mock.calls.map(([event]) => event).filter(event => event.kind !== 'native-work-detail');
      expect(parentEvents.map(event => event.kind)).toEqual([
        'background-task', 'finished', 'background-task', 'background-task',
      ]);
      expect(parentEvents.at(-1)!.payload).toMatchObject({
        taskId: 'child-task', taskType: 'local_agent', status, toolUseId: 'agent-call',
        description: 'Reading code', summary: 'Child outcome', toolUses: 2,
        durationMs: 5_000, outputFile: '/workspace/child.log',
      });
      expect(internal.userTurnInFlight).toBe(false);
    },
  );

  it.each([
    { type: 'assistant', parent_tool_use_id: 'child-call', message: { content: [] } },
    { type: 'stream_event', parent_tool_use_id: 'child-call',
      event: { type: 'message_start', message: { role: 'assistant' } } },
    { type: 'stream_event', event: { type: 'ping' } },
    { type: 'system', subtype: 'task_started', task_id: 'background', is_backgrounded: true },
  ])('does not confuse child/background activity with a foreground turn: %j', (frame) => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
    internal.userTurnInFlight = false;
    translateSdkMessageCore(vi.fn(), 'session-a', frame, internal, host());
    expect(internal.userTurnInFlight).toBe(false);
  });

  it('projects SDK background lifecycle events into the durable activity stream', () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
    const emit = vi.fn();
    translateSdkMessageCore(emit, 'session-a', {
      type: 'system', subtype: 'task_notification', task_id: 'background',
      status: 'failed', summary: 'Build failed',
    }, internal, host());
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a', kind: 'background-task',
      payload: expect.objectContaining({ taskId: 'background', status: 'failed', summary: 'Build failed' }),
    }));
    expect(emit.mock.calls.some(([event]) => event.kind === 'finished')).toBe(false);
  });

  it('persists a deferred user turn before translating its UUID-rewritten assistant response', () => {
    const translationHost = host();
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'session-a',
    });
    const pending = vi.fn(async () => ({})) as unknown as PendingUserMessage;
    pending.deferredUserEvent = {
      text: 'queued input',
      turnCorrelationId: 'turn-queued',
    };
    internal.submittingUserMessage = {
      pending,
      providerMessageId: 'sdk-input-uuid',
      status: 'submitting',
    };
    const emitted: Array<{ payload: unknown }> = [];

    translateSdkMessageCore(
      (event) => emitted.push(event),
      'session-a',
      {
        type: 'assistant',
        uuid: 'assistant-uuid',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'response' }] },
      },
      internal,
      translationHost,
    );

    expect(internal.submittingUserMessage).toBeNull();
    expect(emitted.map((event) => event.payload)).toEqual([
      { text: 'queued input', role: 'user', turnCorrelationId: 'turn-queued' },
      { text: 'response', role: 'assistant' },
    ]);
  });

  it('uses the injected identity and clock for translated assistant content', () => {
    const translationHost = host();
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'session-a',
    });
    const emit = vi.fn();

    translateSdkMessageCore(
      emit,
      'session-a',
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      },
      internal,
      translationHost,
    );

    expect(emit).toHaveBeenCalledWith({
      sessionId: 'session-a',
      agentId: 'claude-core',
      kind: 'message',
      payload: { text: 'done', role: 'assistant' },
      ts: 5150,
      source: 'sdk',
    });
  });

  it('routes init model and permission state through separate injected ports', () => {
    const translationHost = host();
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'session-a',
      permissionMode: 'default',
    });

    translateSdkMessageCore(
      vi.fn(),
      'session-a',
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-4-8',
        permissionMode: 'plan',
      },
      internal,
      translationHost,
    );

    expect(internal.runtimeModel).toBe('claude-opus-4-8');
    expect(internal.permissionMode).toBe('plan');
    expect(translationHost.runtimeMetadata.setModel).toHaveBeenCalledWith(
      'session-a',
      'claude-opus-4-8',
    );
    expect(translationHost.runtimeMetadata.emitUpdated).toHaveBeenCalledWith('session-a');
    expect(translationHost.state.setPermissionMode).toHaveBeenCalledWith(
      'session-a',
      'plan',
    );
    expect(translationHost.state.publishUpdated).toHaveBeenCalledWith('session-a');
  });

  it('keeps expected-close results silent while clearing live-rate state', () => {
    const translationHost = host();
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'session-a',
    });
    internal.expectedClose = true;
    internal.liveTokenEstimate = {
      bucketKey: 'claude-opus-4-8',
      estTokensSinceFlush: 1,
      lastFlushTs: 1,
      hasFlushAnchor: true,
      decodeElapsedMs: 10,
    };
    const emit = vi.fn();

    translateSdkMessageCore(
      emit,
      'session-a',
      { type: 'result', subtype: 'error_during_execution', is_error: true },
      internal,
      translationHost,
    );

    expect(emit).not.toHaveBeenCalled();
    expect(internal.liveTokenEstimate).toBeUndefined();
    expect(translationHost.liveRate.emitTokenRateTick).toHaveBeenCalledWith({
      sessionId: 'session-a',
      bucketKey: 'claude-opus-4-8',
      tps: 0,
      ts: 5150,
      done: true,
    });
  });

  it.each([
    { name: 'idle failure', ids: [], errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'] },
    { name: 'API failure', ids: ['correction'], errors: ['API connection failed'] },
    { name: 'mixed failure', ids: ['correction'], errors: [
      '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null', 'API connection failed',
    ] },
  ])('continues to project $name as a failure', ({ ids, errors }) => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
    internal.midTurnUserMessageIds = new Set(ids);
    const emit = vi.fn();
    translateSdkMessageCore(emit, 'session-a', {
      type: 'result', subtype: 'error_during_execution', is_error: true,
      user_message_uuid: 'original', errors,
    }, internal, host());
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'message', payload: { text: `⚠ ${errors.join('\n')}`, error: true },
    }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'finished', payload: { ok: false, subtype: 'error_during_execution' },
    }));
  });
});
