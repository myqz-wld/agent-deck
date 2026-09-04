import { describe, expect, it, vi } from 'vitest';

import { makeInternalSession } from './types';
import {
  consumePendingFileChangeIntentCore,
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

  it('deletes failed text state without emitting dirty changes', () => {
    const session = internal();
    const emit = vi.fn();
    pushFileChangeIntentCore(
      session,
      'Write',
      { file_path: '/workspace/a.ts', content: 'new' },
      'tool-text',
    );
    consumePendingFileChangeIntentCore(emit, session, 'tool-text', 'failed');

    expect(emit).not.toHaveBeenCalled();
    expect(session.pendingFileChangeIntents).toHaveLength(0);
  });
});
