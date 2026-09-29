import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { persistFileChange } from '../persist-file-change';
import { fileChangeRepo } from '@main/store/file-change-repo';
import { captureFileChangePath } from '../file-change-path-authority';

vi.mock('@main/store/file-change-repo', () => ({ fileChangeRepo: { insert: vi.fn(() => 42) } }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: { get: () => ({ cwd: '/repo' }) } }));
vi.mock('../file-change-path-authority', () => ({ captureFileChangePath: vi.fn(() => ({ authority: '/repo/demo.ts', afterSnapshot: 'new' })) }));

beforeEach(() => vi.clearAllMocks());
describe('file-change activity references', () => {
  it('stores content once and returns a small reference without mutating the provider event', () => {
    const event: AgentEvent = { sessionId: 'session', agentId: 'codex-cli', ts: 10, kind: 'file-changed',
      payload: { filePath: 'demo.ts', kind: 'text', before: null, after: null, toolCallId: 'tool-1',
        metadata: { source: 'codex', changeKind: 'update', patchStatus: 'completed',
          diff: '@@ -1 +1 @@\n-old\n+new', extra: 'x'.repeat(500_000) } } };
    const ref = persistFileChange(event);
    expect(ref.payload).toEqual({ fileChangeId: 42, filePath: 'demo.ts', kind: 'text', toolCallId: 'tool-1',
      metadata: { source: 'codex', changeKind: 'update', patchStatus: 'completed' } });
    expect(JSON.stringify(ref).length).toBeLessThan(500);
    expect(JSON.stringify(event).length).toBeGreaterThan(500_000);
    expect(fileChangeRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session',
      beforeSnapshot: 'old', afterSnapshot: 'new', ts: 10, toolCallId: 'tool-1' }));
    expect(captureFileChangePath).toHaveBeenCalledWith('/repo', 'demo.ts', true);
  });
  it('does not create references for malformed or unrelated events', () => {
    const event: AgentEvent = { sessionId: 'session', agentId: 'claude-code', ts: 1, kind: 'file-changed', payload: {} };
    expect(persistFileChange(event)).toBe(event);
    const message = { ...event, kind: 'message' as const };
    expect(persistFileChange(message)).toBe(message);
    expect(fileChangeRepo.insert).not.toHaveBeenCalled();
  });
});
