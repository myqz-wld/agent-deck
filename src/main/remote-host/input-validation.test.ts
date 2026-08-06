import { describe, expect, it } from 'vitest';

import {
  parseRemoteHostCreateSession,
  parseRemoteHostHistoryRequest,
  parseRemoteHostPendingResponse,
  parseRemoteHostProfileDraft,
  parseRemoteHostRuntimeUpdate,
  parseRemoteHostSessionPageRequest,
} from './input-validation';

function draft() {
  return {
    label: '生产 Core',
    connectionSelectionId: 'connection-token',
  };
}

describe('remote-host IPC input validation', () => {
  it('accepts only an opaque connection selection and rejects renderer paths or argv', () => {
    expect(parseRemoteHostProfileDraft(draft())).toEqual(draft());
    expect(() => parseRemoteHostProfileDraft({
      ...draft(),
      identityFile: '/tmp/id_ed25519',
    })).toThrow('unexpected fields');
    expect(() => parseRemoteHostProfileDraft({
      ...draft(),
      argv: ['ssh', '-o', 'StrictHostKeyChecking=no'],
    })).toThrow('unexpected fields');
  });

  it('enforces bounded pagination and safe cursors at the IPC boundary', () => {
    expect(parseRemoteHostSessionPageRequest({
      profileId: 'remote-a',
      limit: 100,
      includeArchived: false,
    })).toMatchObject({ profileId: 'remote-a', limit: 100 });
    expect(() => parseRemoteHostSessionPageRequest({
      profileId: 'remote-a',
      limit: 101,
    })).toThrow('range');
    expect(() => parseRemoteHostHistoryRequest({
      profileId: 'remote-a',
      sessionId: 'session-a',
      cursor: 'line\nbreak',
      limit: 20,
    })).toThrow('invalid');
  });

  it('accepts only Workspace-relative working directories for session creation', () => {
    const valid = {
      profileId: 'remote-a',
      adapterId: 'codex-cli',
      initialMessage: 'Inspect the repository',
      workingDirectory: 'repo/subdir',
      options: {},
      intentId: 'intent-create-a',
    };
    expect(parseRemoteHostCreateSession(valid).workingDirectory).toBe('repo/subdir');
    expect(parseRemoteHostCreateSession({ ...valid, workingDirectory: '.' }).workingDirectory)
      .toBe('.');
    for (const workingDirectory of ['/etc', '../outside', 'repo/../outside', 'repo\\child']) {
      expect(() => parseRemoteHostCreateSession({ ...valid, workingDirectory }))
        .toThrow('relative directory inside Workspace');
    }
    expect(() => parseRemoteHostCreateSession({
      ...valid,
      projectRef: 'legacy-project',
    })).toThrow('unexpected fields');
    expect(() => parseRemoteHostCreateSession({ ...valid, initialMessage: '   ' }))
      .toThrow('initialMessage');
  });

  it('bounds JSON runtime and pending values and rejects prototype-bearing keys', () => {
    expect(parseRemoteHostRuntimeUpdate({
      profileId: 'remote-a',
      sessionId: 'session-a',
      intentId: 'intent-runtime-a',
      patch: { model: 'gpt-5', nested: { enabled: true } },
      expectedRevision: 4,
    })).toMatchObject({ expectedRevision: 4 });
    const polluted = JSON.parse('{"__proto__":{"admin":true}}') as unknown;
    expect(() => parseRemoteHostRuntimeUpdate({
      profileId: 'remote-a',
      sessionId: 'session-a',
      intentId: 'intent-runtime-a',
      patch: polluted,
      expectedRevision: 4,
    })).toThrow('invalid key');
    expect(() => parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'allow; rm -rf /',
      expectedRevision: 3,
    })).toThrow('invalid token');
    expect(parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'submit',
      value: { first: 'yes', second: ['one', 'two'] },
      expectedRevision: 3,
    })).toMatchObject({
      action: 'submit',
      value: { first: 'yes', second: ['one', 'two'] },
    });
    expect(() => parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'allow',
      expectedRevision: 3,
    })).toThrow('unsupported pending action');
    expect(() => parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'submit',
      value: 'bare answer',
      expectedRevision: 3,
    })).toThrow('must be a JSON object');
    expect(() => parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'submit',
      value: {},
      expectedRevision: 3,
    })).toThrow('invalid pending answer object');
    expect(() => parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'submit',
      expectedRevision: 3,
    })).toThrow('requires an answer object');
    expect(() => parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'approve',
      value: { answer: 'unexpected' },
      expectedRevision: 3,
    })).toThrow('not allowed');
    expect(() => parseRemoteHostRuntimeUpdate({
      profileId: 'remote-a',
      sessionId: 'session-a',
      patch: {},
      expectedRevision: 4,
    })).toThrow('unexpected fields');
  });
});
