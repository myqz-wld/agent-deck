import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  permissionError: null as Error | null,
  titleError: null as Error | null,
  permissionWrites: [] as Array<[string, string]>,
  titleWrites: [] as Array<[string, string]>,
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    recordCreatedPermissionMode: (sessionId: string, mode: string) => {
      if (state.permissionError) throw state.permissionError;
      state.permissionWrites.push([sessionId, mode]);
    },
  },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    setTitle: (sessionId: string, title: string) => {
      if (state.titleError) throw state.titleError;
      state.titleWrites.push([sessionId, title]);
    },
  },
}));

vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn() }) },
}));

import { persistSpawnSessionMetadata } from '../tools/handlers/spawn-session-metadata';

beforeEach(() => {
  state.permissionError = null;
  state.titleError = null;
  state.permissionWrites.length = 0;
  state.titleWrites.length = 0;
});

describe('spawn session metadata persistence', () => {
  it('persists eligible permission and explicit title metadata', () => {
    persistSpawnSessionMetadata({
      sessionId: 'child',
      canSetPermissionMode: true,
      effectivePermissionMode: 'acceptEdits',
      teammateDisplayName: 'reviewer',
    });

    expect(state.permissionWrites).toEqual([['child', 'acceptEdits']]);
    expect(state.titleWrites).toEqual([['child', 'reviewer']]);
  });

  it('keeps each optional metadata failure non-blocking and independent', () => {
    state.permissionError = new Error('permission write failed');
    state.titleError = new Error('title write failed');

    expect(() => persistSpawnSessionMetadata({
      sessionId: 'child',
      canSetPermissionMode: true,
      effectivePermissionMode: 'default',
      teammateDisplayName: 'reviewer',
    })).not.toThrow();
  });
});
