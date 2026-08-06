import { describe, expect, it, vi } from 'vitest';

import { makeInternalSession } from './types';
import {
  consumePendingFileChangeIntentCore,
  maybeEmitImageFileChangedCore,
  pushFileChangeIntentCore,
} from './message-file-changes-core';

function internal() {
  return makeInternalSession({
    cwd: '/workspace',
    applicationSid: 'session-a',
  });
}

describe('Claude message file changes Core', () => {
  it('queues and consumes one completed text intent exactly once', () => {
    const session = internal();
    const emit = vi.fn();
    pushFileChangeIntentCore(
      session,
      'MultiEdit',
      {
        file_path: '/workspace/a.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      },
      'tool-1',
    );

    consumePendingFileChangeIntentCore(emit, session, 'tool-1', 'completed');
    consumePendingFileChangeIntentCore(emit, session, 'tool-1', 'completed');

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('file-changed', {
      filePath: '/workspace/a.ts',
      kind: 'text',
      before: 'a\n---\nc',
      after: 'b\n---\nd',
      metadata: { source: 'MultiEdit', editCount: 2 },
      toolCallId: 'tool-1',
    });
    expect(session.pendingFileChangeIntents).toHaveLength(0);
  });

  it('deletes failed text and image state without emitting dirty changes', () => {
    const session = internal();
    const emit = vi.fn();
    pushFileChangeIntentCore(
      session,
      'Write',
      { file_path: '/workspace/a.ts', content: 'new' },
      'tool-text',
    );
    session.toolUseNames.set('tool-image', 'mcp__images__ImageWrite');

    consumePendingFileChangeIntentCore(emit, session, 'tool-text', 'failed');
    maybeEmitImageFileChangedCore(
      emit,
      session,
      'tool-image',
      JSON.stringify({
        kind: 'image-write',
        file: '/workspace/a.png',
        prompt: 'draw',
      }),
      'failed',
    );

    expect(emit).not.toHaveBeenCalled();
    expect(session.pendingFileChangeIntents).toHaveLength(0);
    expect(session.toolUseNames).toHaveLength(0);
  });

  it('projects a successful image tool result with the exact tool id', () => {
    const session = internal();
    const emit = vi.fn();
    session.toolUseNames.set('tool-image', 'mcp__images__ImageWrite');

    maybeEmitImageFileChangedCore(
      emit,
      session,
      'tool-image',
      JSON.stringify({
        kind: 'image-write',
        file: '/workspace/a.png',
        prompt: 'draw',
        provider: 'test-provider',
      }),
    );

    expect(emit).toHaveBeenCalledWith('file-changed', {
      filePath: '/workspace/a.png',
      kind: 'image',
      before: null,
      after: { kind: 'path', path: '/workspace/a.png' },
      metadata: {
        source: 'ImageWrite',
        prompt: 'draw',
        provider: 'test-provider',
      },
      toolCallId: 'tool-image',
    });
    expect(session.toolUseNames).toHaveLength(0);
  });
});
