import { describe, expect, it, vi } from 'vitest';

import type { DaemonCredentialIdentity } from '@hosts/daemon';
import {
  ServerCoreCredentialFile,
  parseServerCoreCredentialDocument,
} from './credential-file';

const INSTANCE_ID = 'instance-a';
const PROCESS_ID = 'instance-a:123:runtime';

function document(credentials: Array<{
  credentialId: string;
  surface: 'desktop' | 'feishu';
  status: 'active' | 'revoked';
}> = []) {
  return { schemaVersion: 2, instanceId: INSTANCE_ID, credentials };
}

function identity(
  credentialId: string,
  surface: 'desktop' | 'feishu' = 'desktop',
): DaemonCredentialIdentity {
  return {
    instanceId: INSTANCE_ID,
    processId: PROCESS_ID,
    accessCredentialId: credentialId,
    accessSurface: surface,
  };
}

function diagnostics() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('ServerCoreCredentialFile', () => {
  it('parses one exact instance-scoped credential document', () => {
    expect(parseServerCoreCredentialDocument(document([{
      credentialId: 'desktop-a', surface: 'desktop', status: 'active',
    }, {
      credentialId: 'feishu-a', surface: 'feishu', status: 'revoked',
    }]), INSTANCE_ID)).toEqual(document([{
      credentialId: 'desktop-a', surface: 'desktop', status: 'active',
    }, {
      credentialId: 'feishu-a', surface: 'feishu', status: 'revoked',
    }]));
  });

  it.each([
    null,
    { schemaVersion: 3, instanceId: INSTANCE_ID, credentials: [] },
    { schemaVersion: 1, instanceId: 'other', credentials: [] },
    { schemaVersion: 1, instanceId: INSTANCE_ID, credentials: [], extra: true },
    document([{ credentialId: '../bad', surface: 'desktop', status: 'active' }]),
    document([{ credentialId: 'a', surface: 'desktop', status: 'active' }, {
      credentialId: 'a', surface: 'desktop', status: 'revoked',
    }]),
  ])('rejects an invalid credential authority %#', (value) => {
    expect(() => parseServerCoreCredentialDocument(value, INSTANCE_ID)).toThrow();
  });

  it('rejects retired credential documents and surfaces', () => {
    expect(() => parseServerCoreCredentialDocument({
      schemaVersion: 1,
      instanceId: INSTANCE_ID,
      credentials: [
        { credentialId: 'desktop-a', surface: 'desktop-full', status: 'active' },
        { credentialId: 'feishu-a', surface: 'feishu-session-console', status: 'active' },
      ],
    }, INSTANCE_ID)).toThrow('schemaVersion');
    expect(() => parseServerCoreCredentialDocument({
      schemaVersion: 2,
      instanceId: INSTANCE_ID,
      credentials: [{ credentialId: 'desktop-a', surface: 'desktop-full', status: 'active' }],
    }, INSTANCE_ID)).toThrow('surface');
  });

  it('pull-checks the exact process, surface, and latest document', async () => {
    let current: unknown = document([{
      credentialId: 'credential-a', surface: 'desktop', status: 'active',
    }]);
    const file = new ServerCoreCredentialFile({
      instanceId: INSTANCE_ID,
      processId: PROCESS_ID,
      path: '/run/secrets/agent-deck/credentials.json',
      diagnostics: diagnostics(),
      readDocument: async () => current,
    });
    const signal = new AbortController().signal;

    await expect(file.isActive({ identity: identity('credential-a'), signal })).resolves.toBe(true);
    await expect(file.isActive({
      identity: identity('credential-a', 'feishu'), signal,
    })).resolves.toBe(false);
    await expect(file.isActive({
      identity: { ...identity('credential-a'), processId: 'stale-process' }, signal,
    })).resolves.toBe(false);

    current = document([{
      credentialId: 'credential-a', surface: 'desktop', status: 'revoked',
    }]);
    await expect(file.isActive({ identity: identity('credential-a'), signal })).resolves.toBe(false);
  });

  it('pushes only active-to-inactive identities and stops polling exactly once', async () => {
    vi.useFakeTimers();
    try {
      let current: unknown = document([{
        credentialId: 'desktop-a', surface: 'desktop', status: 'active',
      }, {
        credentialId: 'feishu-a', surface: 'feishu', status: 'active',
      }]);
      const file = new ServerCoreCredentialFile({
        instanceId: INSTANCE_ID,
        processId: PROCESS_ID,
        path: '/run/secrets/agent-deck/credentials.json',
        diagnostics: diagnostics(),
        pollIntervalMs: 10,
        readDocument: async () => current,
      });
      const revoked = vi.fn();
      const subscription = await file.subscribeRevocations(revoked);

      current = document([{
        credentialId: 'desktop-a', surface: 'desktop', status: 'revoked',
      }, {
        credentialId: 'feishu-a', surface: 'feishu', status: 'active',
      }, {
        credentialId: 'desktop-b', surface: 'desktop', status: 'active',
      }]);
      await vi.advanceTimersByTimeAsync(10);
      expect(revoked).toHaveBeenCalledOnce();
      expect(revoked).toHaveBeenCalledWith(identity('desktop-a'));

      await subscription.close();
      await subscription.close();
      current = document([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(revoked).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes every previously active identity when the authority becomes unreadable', async () => {
    vi.useFakeTimers();
    try {
      let fail = false;
      const diagnostic = diagnostics();
      const file = new ServerCoreCredentialFile({
        instanceId: INSTANCE_ID,
        processId: PROCESS_ID,
        path: '/run/secrets/agent-deck/credentials.json',
        diagnostics: diagnostic,
        pollIntervalMs: 10,
        readDocument: async () => {
          if (fail) throw new Error('raw secret path');
          return document([{
            credentialId: 'credential-a', surface: 'desktop', status: 'active',
          }]);
        },
      });
      const revoked = vi.fn();
      const subscription = await file.subscribeRevocations(revoked);
      fail = true;
      await vi.advanceTimersByTimeAsync(10);

      expect(revoked).toHaveBeenCalledWith(identity('credential-a'));
      expect(diagnostic.warn).toHaveBeenCalledWith('credential file became unavailable');
      expect(JSON.stringify(diagnostic.warn.mock.calls)).not.toContain('raw secret path');
      await subscription.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
