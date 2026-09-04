import { describe, expect, it } from 'vitest';
import { sessionConsoleCreateOptionsFixture } from '@contracts/session-console-capabilities.fixture';

import {
  parseRemoteHostCreateSession,
  parseRemoteHostMutationAuthority,
  parseRemoteHostPendingResponse as parseRemoteHostPendingResponseInput,
  parseRemoteHostProfileDraft,
  parseRemoteHostRuntimeUpdate,
  parseRemoteHostSend,
  parseRemoteHostSessionCapabilitiesRequest,
  parseRemoteHostWorkspaceDirectoryRequest,
} from './input-validation';
import {
  parseRemoteHostFileChangeGetRequest,
  parseRemoteHostFileChangePageRequest,
  parseRemoteHostFileFinalDiffRequest,
  parseRemoteHostEventListRequest,
  parseRemoteHostSummaryRequest,
  parseRemoteHostTaskListRequest,
} from './input-validation-session-detail';

const EXPECTED_PRESENTATION_DIGEST = `sha256:${'a'.repeat(64)}`;
const EXPECTED_AUTHORITY = {
  authoritativeCoreId: 'core-a',
  workerGeneration: 3,
};

function parseRemoteHostPendingResponse(value: unknown) {
  return parseRemoteHostPendingResponseInput({
    ...(value as Record<string, unknown>),
    expectedAuthority: EXPECTED_AUTHORITY,
    expectedPresentationDigest: EXPECTED_PRESENTATION_DIGEST,
  });
}

function draft() {
  return {
    label: '生产 Core',
    connectionSelectionId: 'connection-token',
  };
}

describe('remote-host IPC input validation', () => {
  it('accepts only one exact bounded Remote mutation authority token', () => {
    expect(parseRemoteHostMutationAuthority(EXPECTED_AUTHORITY)).toEqual(EXPECTED_AUTHORITY);
    expect(parseRemoteHostMutationAuthority({
      authoritativeCoreId: null,
      workerGeneration: null,
    })).toEqual({ authoritativeCoreId: null, workerGeneration: null });
    expect(() => parseRemoteHostMutationAuthority({ authoritativeCoreId: 'core-a' }))
      .toThrow('unexpected fields');
    expect(() => parseRemoteHostMutationAuthority({
      ...EXPECTED_AUTHORITY,
      workerGeneration: -1,
    })).toThrow('non-negative safe integer');
    expect(() => parseRemoteHostMutationAuthority({
      ...EXPECTED_AUTHORITY,
      authoritativeCoreId: 'core-a\nforged',
    })).toThrow('invalid token');
  });

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

  it('accepts only bounded session-detail requests and Workspace-relative diff paths', () => {
    expect(parseRemoteHostSummaryRequest({
      profileId: 'remote-a', sessionId: 'session-a', limit: 50,
    })).toEqual({ profileId: 'remote-a', sessionId: 'session-a', limit: 50 });
    expect(parseRemoteHostEventListRequest({
      profileId: 'remote-a', sessionId: 'session-a', limit: 100,
    })).toEqual({ profileId: 'remote-a', sessionId: 'session-a', limit: 100 });
    expect(() => parseRemoteHostEventListRequest({
      profileId: 'remote-a', sessionId: 'session-a', limit: 101,
    })).toThrow('invalid event request');
    expect(parseRemoteHostTaskListRequest({
      profileId: 'remote-a', sessionId: 'session-a', limit: 50,
    })).toEqual({ profileId: 'remote-a', sessionId: 'session-a', limit: 50 });
    expect(parseRemoteHostFileChangePageRequest({
      profileId: 'remote-a', sessionId: 'session-a', cursor: 'page_1', limit: 100,
    })).toMatchObject({ cursor: 'page_1', limit: 100 });
    expect(parseRemoteHostFileChangeGetRequest({
      profileId: 'remote-a', sessionId: 'session-a', changeId: 3,
    })).toMatchObject({ changeId: 3 });
    expect(parseRemoteHostFileFinalDiffRequest({
      profileId: 'remote-a', sessionId: 'session-a', filePath: 'repo/src/index.ts',
    })).toMatchObject({ filePath: 'repo/src/index.ts' });
    expect(() => parseRemoteHostFileFinalDiffRequest({
      profileId: 'remote-a', sessionId: 'session-a', filePath: '/workspaces/repo/index.ts',
    })).toThrow('invalid final-diff request');
    expect(() => parseRemoteHostFileChangePageRequest({
      profileId: 'remote-a', sessionId: 'session-a', cursor: undefined, limit: 20,
    })).toThrow('invalid remote host input');
  });

  it('accepts only Workspace-relative working directories for session creation', () => {
    const valid = {
      profileId: 'remote-a',
      adapterId: 'codex-cli',
      attachments: [],
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
      initialMessage: 'Inspect the repository',
      projectTrust: { revision: `sha256:${'b'.repeat(64)}`, grant: false },
      workingDirectory: 'repo/subdir',
      options: sessionConsoleCreateOptionsFixture(),
      expectedAuthority: EXPECTED_AUTHORITY,
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
    expect(parseRemoteHostSessionCapabilitiesRequest({
      profileId: 'remote-a',
      adapterId: null,
      provider: '',
      workingDirectory: '.',
    })).toMatchObject({ adapterId: null, workingDirectory: '.' });
    expect(parseRemoteHostWorkspaceDirectoryRequest({
      profileId: 'remote-a',
      directory: 'repo/subdir',
    })).toEqual({ profileId: 'remote-a', directory: 'repo/subdir' });
    expect(() => parseRemoteHostWorkspaceDirectoryRequest({
      profileId: 'remote-a',
      directory: '../outside',
    })).toThrow('relative directory inside Workspace');
    expect(() => parseRemoteHostCreateSession({
      ...valid,
      options: { ...valid.options, cwd: '/escape' },
    })).toThrow('invalid create options');
  });

  it('accepts bounded Remote message images and rejects empty or path-shaped payloads', () => {
    const valid = {
      profileId: 'remote-a',
      sessionId: 'session-a',
      text: '',
      attachments: [{ kind: 'image', mime: 'image/png', bytes: 1, base64: 'YQ==' }],
      expectedAuthority: EXPECTED_AUTHORITY,
      intentId: 'intent-send-a',
    };
    expect(parseRemoteHostSend(valid)).toEqual(valid);
    expect(() => parseRemoteHostSend({ ...valid, attachments: [] }))
      .toThrow('message or attachment is required');
    expect(() => parseRemoteHostSend({
      ...valid,
      attachments: [{ ...valid.attachments[0], path: '/tmp/local.png' }],
    })).toThrow('invalid Remote image attachments');
  });

  it('bounds JSON runtime and pending values and rejects prototype-bearing keys', () => {
    expect(parseRemoteHostRuntimeUpdate({
      profileId: 'remote-a',
      sessionId: 'session-a',
      expectedAuthority: EXPECTED_AUTHORITY,
      intentId: 'intent-runtime-a',
      patch: { model: 'gpt-5', nested: { enabled: true } },
      expectedRevision: 4,
    })).toMatchObject({ expectedRevision: 4 });
    const polluted = JSON.parse('{"__proto__":{"admin":true}}') as unknown;
    expect(() => parseRemoteHostRuntimeUpdate({
      profileId: 'remote-a',
      sessionId: 'session-a',
      expectedAuthority: EXPECTED_AUTHORITY,
      intentId: 'intent-runtime-a',
      patch: polluted,
      expectedRevision: 4,
    })).toThrow('invalid key');
    expect(() => parseRemoteHostPendingResponseInput({
      profileId: 'remote-a', sessionId: 'session-a', requestId: 'request-a',
      expectedAuthority: EXPECTED_AUTHORITY,
      intentId: 'intent-pending-a', action: 'approve', expectedRevision: 3,
    })).toThrow('unexpected fields');
    expect(() => parseRemoteHostPendingResponseInput({
      profileId: 'remote-a', sessionId: 'session-a', requestId: 'request-a',
      expectedAuthority: EXPECTED_AUTHORITY,
      intentId: 'intent-pending-a', action: 'approve', expectedRevision: 3,
      expectedPresentationDigest: 'sha256:not-a-digest',
    })).toThrow('invalid digest');
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
    expect(parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'submit',
      value: {
        first: { selected: ['yes'], other: 'details', note: 'context' },
        second: { selected: [] },
      },
      expectedRevision: 3,
    })).toMatchObject({
      value: {
        first: { selected: ['yes'], other: 'details', note: 'context' },
        second: { selected: [] },
      },
    });
    expect(parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'reject',
      value: { feedback: '  revise this  ' },
      expectedRevision: 3,
    })).toMatchObject({ action: 'reject', value: { feedback: 'revise this' } });
    expect(parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'accept',
      value: { targetMode: 'acceptEdits' },
      expectedRevision: 3,
    })).toMatchObject({ action: 'accept', value: { targetMode: 'acceptEdits' } });
    expect(() => parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'accept',
      value: { targetMode: 'acceptEdits', ignored: true },
      expectedRevision: 3,
    })).toThrow('invalid exit-plan target mode');
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
      value: { first: { selected: [], ignored: 'silent data loss' } },
      expectedRevision: 3,
    })).toThrow('invalid pending answer object');
    expect(() => parseRemoteHostPendingResponse({
      profileId: 'remote-a',
      sessionId: 'session-a',
      requestId: 'request-a',
      intentId: 'intent-pending-a',
      action: 'submit',
      value: { first: { selected: ['yes', 'yes'] } },
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
