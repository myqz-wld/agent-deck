import { describe, expect, it } from 'vitest';
import type { CodexAppServerNotification } from './client';
import { APPEND_AGGREGATED_OUTPUT } from '@shared/agent-event-merge';

import { translateCodexAppServerNotification } from './translate';

function collect() {
  const events: { kind: string; payload: unknown }[] = [];
  return {
    emit: (kind: string, payload: unknown) => events.push({ kind, payload }),
    events,
  };
}

describe('translateCodexAppServerNotification', () => {
  it('marks command output deltas so downstream event stores append output and preserve command input', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/commandExecution/outputDelta',
        params: { itemId: 'cmd-1', delta: 'src/main/foo.ts\n' },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'tool-use-start',
        payload: {
          toolName: 'Bash',
          toolUseId: 'cmd-1',
          aggregatedOutput: 'src/main/foo.ts\n',
          [APPEND_AGGREGATED_OUTPUT]: true,
          status: 'inProgress',
        },
      },
    ]);
  });

  it('keeps Bash command input on command completion as a detail fallback', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'cmd-2',
            type: 'commandExecution',
            command: 'rg foo src',
            aggregatedOutput: 'src/a.ts\n',
            exitCode: 0,
            status: 'completed',
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'cmd-2',
          toolName: 'Bash',
          toolInput: { command: 'rg foo src' },
          toolResult: 'src/a.ts\n',
          exitCode: 0,
          durationMs: null,
          status: 'completed',
        },
      },
    ]);
  });

  it('normalizes app-server file change kind objects before persisting metadata', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'patch-1',
            type: 'fileChange',
            status: 'completed',
            changes: [
              {
                path: '/tmp/a.ts',
                kind: { type: 'update', move_path: null },
                diff: '@@ -1 +1 @@\n-old\n+new',
              },
            ],
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([
      {
        kind: 'file-changed',
        payload: {
          filePath: '/tmp/a.ts',
          kind: 'text',
          before: null,
          after: null,
          metadata: {
            source: 'codex',
            changeKind: 'update',
            patchStatus: 'completed',
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
          toolCallId: 'patch-1',
        },
      },
    ]);
  });

  it('skips Codex file changes that did not produce an effective content change', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'patch-noop',
            type: 'fileChange',
            status: 'completed',
            changes: [
              { path: '/tmp/empty.ts', kind: { type: 'update' }, diff: '' },
              {
                path: '/tmp/header-only.ts',
                kind: { type: 'update' },
                diff: [
                  'diff --git a/header-only.ts b/header-only.ts',
                  'index 1111111..1111111 100644',
                  '--- a/header-only.ts',
                  '+++ b/header-only.ts',
                ].join('\n'),
              },
              {
                path: '/tmp/same.ts',
                kind: { type: 'update' },
                diff: [
                  'diff --git a/same.ts b/same.ts',
                  '--- a/same.ts',
                  '+++ b/same.ts',
                  '@@ -1 +1 @@',
                  '-same',
                  '+same',
                ].join('\n'),
              },
            ],
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([]);
  });

  it('skips incomplete Codex file change items', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'patch-failed',
            type: 'fileChange',
            status: 'failed',
            changes: [
              {
                path: '/tmp/a.ts',
                kind: { type: 'update' },
                diff: '@@ -1 +1 @@\n-old\n+new',
              },
            ],
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toEqual([]);
  });

  it('keeps non-text Codex diff signals that do not have parseable hunks', () => {
    const { emit, events } = collect();
    translateCodexAppServerNotification(
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'patch-binary',
            type: 'fileChange',
            status: 'completed',
            changes: [
              {
                path: '/tmp/image.png',
                kind: { type: 'update' },
                diff: [
                  'diff --git a/image.png b/image.png',
                  'Binary files a/image.png and b/image.png differ',
                ].join('\n'),
              },
              {
                path: '/tmp/renamed.ts',
                kind: { type: 'move' },
                diff: [
                  'diff --git a/old.ts b/renamed.ts',
                  'similarity index 100%',
                  'rename from old.ts',
                  'rename to renamed.ts',
                ].join('\n'),
              },
            ],
          },
        },
      } as CodexAppServerNotification,
      emit,
    );

    expect(events).toHaveLength(2);
    expect(events[0].payload).toMatchObject({
      filePath: '/tmp/image.png',
      metadata: { changeKind: 'update' },
    });
    expect(events[1].payload).toMatchObject({
      filePath: '/tmp/renamed.ts',
      metadata: { changeKind: 'move' },
    });
  });
});
