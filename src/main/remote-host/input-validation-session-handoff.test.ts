import { describe, expect, it } from 'vitest';

import { sessionConsoleCreateOptionsFixture } from '@contracts/session-console-capabilities.fixture';
import {
  parseRemoteHostHandOffCommit,
  parseRemoteHostHandOffPreview,
} from './input-validation-session-handoff';

const target = {
  adapterId: 'codex-cli',
  workingDirectory: null,
  capabilityRevision: null,
  options: sessionConsoleCreateOptionsFixture(),
};

describe('Remote handoff IPC input validation', () => {
  it('binds one profile to exact preview and commit contracts', () => {
    const preview = {
      profileId: 'remote-a',
      sessionId: 'session-a',
      continuationInstruction: 'Continue the current work.',
      target,
    };
    expect(parseRemoteHostHandOffPreview(preview)).toEqual(preview);
    const commit = {
      ...preview,
      expectedBindingDigest: `sha256:${'a'.repeat(64)}`,
      intentId: 'handoff-intent-a',
    };
    expect(parseRemoteHostHandOffCommit(commit)).toEqual(commit);
  });

  it('rejects renderer authority expansion and invalid binding input', () => {
    const preview = {
      profileId: 'remote-a',
      sessionId: 'session-a',
      continuationInstruction: 'Continue.',
      target,
    };
    expect(() => parseRemoteHostHandOffPreview({ ...preview, localSessionId: 'local-a' }))
      .toThrow('unexpected fields');
    expect(() => parseRemoteHostHandOffCommit({
      ...preview,
      expectedBindingDigest: 'stale',
      intentId: 'handoff-intent-a',
    })).toThrow('invalid Remote handoff commit');
  });
});
