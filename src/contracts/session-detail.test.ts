import { describe, expect, it } from 'vitest';

import {
  parseSessionFileChangeGetParams,
  parseSessionFileChangeGetResult,
  parseSessionFileChangeListParams,
  parseSessionFileChangeListResult,
  parseSessionFileFinalDiffParams,
  parseSessionFileFinalDiffResult,
  parseSessionSummaryListParams,
  parseSessionSummaryListResult,
  SESSION_DETAIL_MAX_SUMMARY_BYTES,
} from './session-detail';

const sessionId = 'session-a';

describe('session detail contracts', () => {
  it('accepts exact bounded summary pages', () => {
    expect(parseSessionSummaryListParams({ sessionId, limit: 2 })).toEqual({ sessionId, limit: 2 });
    expect(parseSessionSummaryListResult({
      summaries: [{
        id: 1,
        sessionId,
        content: 'bounded summary',
        trigger: 'event-count',
        ts: 10,
        sourceEventRevision: 8,
        sourceRebuildAfterRevision: 0,
        generationSource: 'llm',
      }],
      revision: 9,
    }, sessionId, 2).summaries[0]?.content).toBe('bounded summary');
  });

  it('rejects extra fields, duplicate ids, and oversized summaries', () => {
    expect(() => parseSessionSummaryListParams({ sessionId, limit: 2, cwd: '/private' }))
      .toThrow();
    const summary = {
      id: 1,
      sessionId,
      content: 'ok',
      trigger: 'time',
      ts: 10,
      sourceEventRevision: 8,
      sourceRebuildAfterRevision: 0,
      generationSource: 'llm',
    };
    expect(() => parseSessionSummaryListResult({
      summaries: [summary, summary],
      revision: 1,
    }, sessionId, 2)).toThrow();
    expect(() => parseSessionSummaryListResult({
      summaries: [{ ...summary, content: 'x'.repeat(SESSION_DETAIL_MAX_SUMMARY_BYTES + 1) }],
      revision: 1,
    }, sessionId, 2)).toThrow();
  });

  it('accepts relative file-change pages and rejects absolute host paths', () => {
    expect(parseSessionFileChangeListParams({
      sessionId,
      cursor: 'eyJ2IjoxfQ',
      limit: 20,
    })).toEqual({ sessionId, cursor: 'eyJ2IjoxfQ', limit: 20 });
    const item = {
      id: 7,
      sessionId,
      filePath: 'repo/src/index.ts',
      kind: 'text',
      toolCallId: 'tool-a',
      hasBeforeBlob: true,
      hasAfterBlob: true,
      hasBeforeSnapshot: false,
      hasAfterSnapshot: false,
      ts: 11,
    };
    expect(parseSessionFileChangeListResult({
      items: [item],
      nextCursor: null,
      revision: 4,
    }, sessionId, 20).items).toEqual([item]);
    expect(() => parseSessionFileChangeListResult({
      items: [{ ...item, filePath: '/workspaces/repo/src/index.ts' }],
      nextCursor: null,
      revision: 4,
    }, sessionId, 20)).toThrow();
  });

  it('binds payload lookup to the session and exact JSON-safe shape', () => {
    expect(parseSessionFileChangeGetParams({ sessionId, changeId: 7 }))
      .toEqual({ sessionId, changeId: 7 });
    const change = {
      id: 7,
      sessionId,
      filePath: 'repo/src/index.ts',
      kind: 'text',
      beforeBlob: 'before',
      afterBlob: 'after',
      beforeSnapshot: null,
      afterSnapshot: null,
      metadata: { diff: '@@ -1 +1 @@' },
      toolCallId: null,
      ts: 11,
    };
    expect(parseSessionFileChangeGetResult({ change, revision: 4 }, sessionId, 7).change)
      .toEqual(change);
    expect(() => parseSessionFileChangeGetResult({
      change: { ...change, sessionId: 'session-b' },
      revision: 4,
    }, sessionId, 7)).toThrow();
    expect(() => parseSessionFileChangeGetResult({
      change: { ...change, id: 8 },
      revision: 4,
    }, sessionId, 7)).toThrow();
  });

  it('binds final diffs to one Workspace-relative file presentation', () => {
    expect(parseSessionFileFinalDiffParams({
      sessionId,
      filePath: 'repo/src/index.ts',
    })).toEqual({ sessionId, filePath: 'repo/src/index.ts' });
    const value = {
      fileDiff: {
        ok: true,
        filePath: 'repo/src/index.ts',
        diff: '@@ -1 +1 @@',
        source: 'recorded-snapshot',
      },
      revision: 5,
    };
    expect(parseSessionFileFinalDiffResult(value, 'repo/src/index.ts')).toEqual(value);
    expect(() => parseSessionFileFinalDiffResult(value, 'repo/src/other.ts')).toThrow();
    expect(() => parseSessionFileFinalDiffParams({ sessionId, filePath: '../secret' })).toThrow();
  });
});
