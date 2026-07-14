import { describe, expect, it } from 'vitest';
import type { RawEventRevisionRow } from '@main/store/event-revision-repo';
import { CONTINUATION_CHECKPOINT_SYSTEM_PROMPT } from '../checkpoint-prompts';
import { buildCheckpointFoldChunk, groupContinuationRows } from '../checkpoint-fold-chunk';
import { estimateContinuationTokens } from '../token-estimator';

function row(input: {
  id: number;
  kind: string;
  payload: unknown;
  toolUseId?: string | null;
}): RawEventRevisionRow {
  return {
    id: input.id,
    sessionId: 'source',
    effectiveRevision: input.id,
    kind: input.kind,
    payloadJson: JSON.stringify(input.payload),
    ts: input.id,
    toolUseId: input.toolUseId ?? null,
  };
}

describe('checkpoint fold chunk backlog bounds', () => {
  it('deduplicates completed tool starts and bounds telemetry while retaining full messages', () => {
    const rows: RawEventRevisionRow[] = [];
    let id = 1;
    for (let index = 0; index < 300; index += 1) {
      const toolUseId = `tool-${index}`;
      rows.push(row({
        id: id++,
        kind: 'tool-use-start',
        toolUseId,
        payload: {
          toolUseId,
          toolName: 'exec_command',
          toolInput: { command: `verify-${index}-${'x'.repeat(1_000)}` },
          status: 'started',
        },
      }));
      rows.push(row({
        id: id++,
        kind: 'tool-use-end',
        toolUseId,
        payload: {
          toolUseId,
          toolName: 'exec_command',
          toolInput: { command: `verify-${index}-${'x'.repeat(1_000)}` },
          toolResult: `result-${index}-${'y'.repeat(10_000)}`,
          exitCode: 0,
          status: 'completed',
        },
      }));
    }
    for (let index = 0; index < 60; index += 1) {
      rows.push(row({
        id: id++,
        kind: 'file-changed',
        payload: {
          filePath: `/repo/file-${index}.ts`,
          kind: 'modified',
          before: 'b'.repeat(4_000),
          after: 'a'.repeat(4_000),
          toolCallId: `tool-${index}`,
        },
      }));
    }
    for (let index = 0; index < 80; index += 1) {
      rows.push(row({
        id: id++,
        kind: 'message',
        payload: { role: 'assistant', text: `state-${index}-${'m'.repeat(180)}` },
      }));
    }
    const messageText = `authoritative-state-${'z'.repeat(4_000)}`;
    rows.push(row({
      id: id++,
      kind: 'message',
      payload: { role: 'assistant', text: messageText },
    }));
    rows.push(row({
      id: id++,
      kind: 'tool-use-start',
      toolUseId: 'still-running',
      payload: {
        toolUseId: 'still-running',
        toolName: 'exec_command',
        toolInput: { command: `pending-${'p'.repeat(10_000)}` },
        status: 'started',
      },
    }));
    rows.push(row({
      id: id++,
      kind: 'tool-use-start',
      toolUseId: 'end-omits-input',
      payload: {
        toolUseId: 'end-omits-input',
        toolName: 'Read',
        toolInput: { filePath: '/repo/must-retain.ts' },
        status: 'started',
      },
    }));
    rows.push(row({
      id: id++,
      kind: 'tool-use-end',
      toolUseId: 'end-omits-input',
      payload: {
        toolUseId: 'end-omits-input',
        toolName: 'Read',
        toolResult: 'complete',
        status: 'completed',
      },
    }));

    const groups = groupContinuationRows(rows);
    const normalized = groups.flatMap((group) => group.normalized) as Array<{
      kind: string;
      payload: unknown;
      sourceBytes: number;
      sourceHash: string;
      truncated: boolean;
    }>;
    const chunk = buildCheckpointFoldChunk({
      groups,
      previous: null,
      finalThroughRevision: rows.at(-1)!.effectiveRevision,
      budget: 96_000,
    });

    expect(normalized.filter((event) => event.kind === 'tool-use-start')).toHaveLength(2);
    expect(normalized.filter((event) => event.kind === 'tool-use-end')).toHaveLength(301);
    expect(normalized.filter((event) => event.kind === 'file-changed')).toHaveLength(60);
    expect(normalized.filter((event) => event.kind === 'message')).toHaveLength(81);
    const largeToolEnds = normalized.filter(
      (event) => event.kind === 'tool-use-end' && event.sourceBytes > 256,
    );
    expect(largeToolEnds).toHaveLength(300);
    expect(
      largeToolEnds.every((event) => event.truncated && event.sourceHash.length === 64),
    ).toBe(true);
    expect(
      normalized.find(
        (event) =>
          event.kind === 'message' &&
          (event.payload as { text?: string }).text === messageText,
      ),
    ).toMatchObject({
      payload: { role: 'assistant', text: messageText },
      truncated: false,
    });
    expect(chunk).toMatchObject({
      throughRevision: rows.at(-1)!.effectiveRevision,
      groups: expect.arrayContaining([expect.any(Object)]),
      requiresCoverageMarker: false,
    });
    expect(chunk?.groups).toHaveLength(rows.length);
    const estimatedPromptTokens =
      estimateContinuationTokens(CONTINUATION_CHECKPOINT_SYSTEM_PROMPT) +
      estimateContinuationTokens(chunk!.prompt);
    expect(estimatedPromptTokens).toBeGreaterThan(32_000);
    expect(estimatedPromptTokens).toBeLessThanOrEqual(96_000);
  });
});
