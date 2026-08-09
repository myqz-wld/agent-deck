import { describe, expect, it, vi } from 'vitest';

import type { RemoteHostScopedClient } from './service-scope';
import { SESSION_IMAGE_ASSET_CHUNK_BYTES } from '@contracts/index';
import {
  requestRemoteFileChange,
  requestRemoteFileChanges,
  requestRemoteFileFinalDiff,
  requestRemoteImageAsset,
  requestRemoteEvents,
  requestRemoteSummaries,
  requestRemoteTasks,
} from './service-session-detail';

function scope(request: ReturnType<typeof vi.fn>): RemoteHostScopedClient {
  return {
    client: { request } as unknown as RemoteHostScopedClient['client'],
    profileEpoch: 1,
    profileId: 'remote-a',
    sourceEpoch: 1,
  };
}

describe('Remote session-detail request helpers', () => {
  it('requests one bounded event page without a Local fallback', async () => {
    const result = {
      events: [{
        id: 1,
        sessionId: 'session-a',
        agentId: 'codex-cli',
        kind: 'message' as const,
        payload: { role: 'assistant', text: 'done' },
        ts: 2,
      }],
      revision: 3,
      truncated: false,
    };
    const request = vi.fn(async () => result);
    await expect(requestRemoteEvents(scope(request), {
      profileId: 'remote-a', sessionId: 'session-a', limit: 20,
    })).resolves.toEqual(result);
    expect(request).toHaveBeenCalledWith(
      'session.events.list',
      { sessionId: 'session-a', limit: 20 },
      { deadlineMs: 45_000 },
    );
  });

  it('requests bounded summaries and binds every row to the selected session', async () => {
    const result = {
      summaries: [{
        id: 1,
        sessionId: 'session-a',
        content: 'summary',
        trigger: 'time',
        ts: 2,
        sourceEventRevision: 1,
        sourceRebuildAfterRevision: 0,
        generationSource: 'llm',
      }],
      revision: 3,
    };
    const request = vi.fn(async () => result);
    await expect(requestRemoteSummaries(scope(request), {
      profileId: 'remote-a', sessionId: 'session-a', limit: 20,
    })).resolves.toEqual(result);
    expect(request).toHaveBeenCalledWith(
      'session.summaries.list',
      { sessionId: 'session-a', limit: 20 },
      { deadlineMs: 45_000 },
    );
  });

  it('requests and validates a bounded task projection', async () => {
    const task = {
      id: 'task-1', ownerSessionId: 'session-a', teamId: null, subject: 'Remote task',
      description: null, status: 'active', activeForm: null, priority: 5,
      blocks: [], blockedBy: [], labels: [], createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:01:00.000Z',
    };
    const request = vi.fn(async () => ({ tasks: [task], revision: 3 }));
    await expect(requestRemoteTasks(scope(request), {
      profileId: 'remote-a', sessionId: 'session-a', limit: 20,
    })).resolves.toEqual({ tasks: [task], revision: 3 });
    expect(request).toHaveBeenCalledWith(
      'session.tasks.list',
      { sessionId: 'session-a', limit: 20 },
      { deadlineMs: 45_000 },
    );
  });

  it('omits an absent cursor and rejects absolute file paths from a host', async () => {
    const item = {
      id: 3,
      sessionId: 'session-a',
      filePath: 'repo/src/index.ts',
      kind: 'text',
      toolCallId: null,
      hasBeforeBlob: true,
      hasAfterBlob: true,
      hasBeforeSnapshot: false,
      hasAfterSnapshot: false,
      ts: 3,
    };
    const request = vi.fn(async () => ({ items: [item], nextCursor: null, revision: 4 }));
    await requestRemoteFileChanges(scope(request), {
      profileId: 'remote-a', sessionId: 'session-a', limit: 40,
    });
    expect(request).toHaveBeenCalledWith(
      'session.file-changes.list',
      { sessionId: 'session-a', limit: 40 },
      { deadlineMs: 45_000 },
    );
    request.mockResolvedValueOnce({
      items: [{ ...item, filePath: '/workspaces/repo/src/index.ts' }],
      nextCursor: null,
      revision: 4,
    });
    await expect(requestRemoteFileChanges(scope(request), {
      profileId: 'remote-a', sessionId: 'session-a', limit: 40,
    })).rejects.toThrow();
  });

  it('uses session-bound ids and Workspace-relative paths for payload and final diff', async () => {
    const payloadRequest = vi.fn(async (): Promise<unknown> => ({ change: null, revision: 4 }));
    await requestRemoteFileChange(scope(payloadRequest), {
      profileId: 'remote-a', sessionId: 'session-a', changeId: 3,
    });
    expect(payloadRequest).toHaveBeenCalledWith(
      'session.file-changes.get',
      { sessionId: 'session-a', changeId: 3 },
      { deadlineMs: 45_000 },
    );
    payloadRequest.mockResolvedValueOnce({
      change: {
        id: 4, sessionId: 'session-a', filePath: 'repo/src/other.ts', kind: 'text',
        beforeBlob: null, afterBlob: 'after', beforeSnapshot: null, afterSnapshot: null,
        metadata: {}, toolCallId: null, ts: 3,
      },
      revision: 4,
    });
    await expect(requestRemoteFileChange(scope(payloadRequest), {
      profileId: 'remote-a', sessionId: 'session-a', changeId: 3,
    })).rejects.toThrow();
    const finalResult = {
      fileDiff: {
        ok: true,
        filePath: 'repo/src/index.ts',
        diff: '@@ -1 +1 @@',
        source: 'recorded-snapshot',
      },
      revision: 5,
    };
    const finalRequest = vi.fn(async () => finalResult);
    await expect(requestRemoteFileFinalDiff(scope(finalRequest), {
      profileId: 'remote-a', sessionId: 'session-a', filePath: 'repo/src/index.ts',
    })).resolves.toEqual(finalResult);
    expect(finalRequest).toHaveBeenCalledWith(
      'session.file-changes.final-diff',
      { sessionId: 'session-a', filePath: 'repo/src/index.ts' },
      { deadlineMs: 45_000 },
    );
  });

  it('assembles identity-fenced image chunks without exposing a Worker path', async () => {
    const firstBytes = Buffer.alloc(SESSION_IMAGE_ASSET_CHUNK_BYTES, 0x41);
    const finalBytes = Buffer.from('tail');
    const assetId = 'A'.repeat(43);
    const request = vi.fn(async (_method: string, params: { offset: number }) =>
      params.offset === 0
        ? {
            ok: true, assetId, base64: firstBytes.toString('base64'),
            bytes: firstBytes.byteLength, changeId: 3, mime: 'image/png',
            nextOffset: SESSION_IMAGE_ASSET_CHUNK_BYTES, offset: 0, revision: 4,
            sessionId: 'session-a', side: 'after',
            totalBytes: firstBytes.byteLength + finalBytes.byteLength,
          }
        : {
            ok: true, assetId, base64: finalBytes.toString('base64'),
            bytes: finalBytes.byteLength, changeId: 3, mime: 'image/png', nextOffset: null,
            offset: SESSION_IMAGE_ASSET_CHUNK_BYTES, revision: 5,
            sessionId: 'session-a', side: 'after',
            totalBytes: firstBytes.byteLength + finalBytes.byteLength,
          });
    const result = await requestRemoteImageAsset(scope(request), {
      profileId: 'remote-a',
      sessionId: 'session-a',
      source: { kind: 'remote-file-change', changeId: 3, side: 'after' },
    });
    expect(result).toMatchObject({
      ok: true,
      mime: 'image/png',
      bytes: firstBytes.byteLength + finalBytes.byteLength,
    });
    if (!result.ok) throw new Error('asset unavailable');
    expect(Buffer.from(result.dataUrl.split(',')[1]!, 'base64'))
      .toEqual(Buffer.concat([firstBytes, finalBytes]));
    expect(request).toHaveBeenNthCalledWith(2,
      'session.assets.image-chunk.read',
      {
        sessionId: 'session-a', changeId: 3, side: 'after',
        offset: SESSION_IMAGE_ASSET_CHUNK_BYTES, expectedAssetId: assetId,
      },
      { deadlineMs: 45_000 },
    );
  });

  it('rejects an image chunk that is not bound to the requested offset', async () => {
    const bytes = Buffer.from('wrong-order');
    const request = vi.fn(async () => ({
      ok: true,
      assetId: 'A'.repeat(43),
      base64: bytes.toString('base64'),
      bytes: bytes.byteLength,
      changeId: 3,
      mime: 'image/png',
      nextOffset: null,
      offset: SESSION_IMAGE_ASSET_CHUNK_BYTES,
      revision: 4,
      sessionId: 'session-a',
      side: 'after',
      totalBytes: SESSION_IMAGE_ASSET_CHUNK_BYTES + bytes.byteLength,
    }));
    await expect(requestRemoteImageAsset(scope(request), {
      profileId: 'remote-a',
      sessionId: 'session-a',
      source: { kind: 'remote-file-change', changeId: 3, side: 'after' },
    })).resolves.toEqual({ ok: false, reason: 'changed' });
  });

  it('rejects the first image chunk when its source identity is mismatched', async () => {
    const bytes = Buffer.from('wrong-source');
    const request = vi.fn(async () => ({
      ok: true, assetId: 'A'.repeat(43), base64: bytes.toString('base64'),
      bytes: bytes.byteLength, changeId: 9, mime: 'image/png', nextOffset: null,
      offset: 0, revision: 4, sessionId: 'session-b', side: 'before',
      totalBytes: bytes.byteLength,
    }));
    await expect(requestRemoteImageAsset(scope(request), {
      profileId: 'remote-a', sessionId: 'session-a',
      source: { kind: 'remote-file-change', changeId: 3, side: 'after' },
    })).rejects.toThrow();
  });
});
