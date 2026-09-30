import { mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueRemoteOwnerGrantClaim } from '@contracts/index';
import { roots, context, harness, createParams } from './session-console-authority.test-fixture';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ServerCoreSessionConsoleAuthority', () => {
  it('paginates live and historical session projections without cwd disclosure', () => {
    const { authority } = harness();
    const first = authority.listSessions({ limit: 1 }, context());
    expect(first).toEqual({
      sessions: [{
        id: 'live-a', adapterId: 'claude-code', title: 'title live-a',
        status: 'active-idle', archived: false, createdAt: 10, updatedAt: 20,
      }],
      nextCursor: 'v1:live:1',
      total: 2,
      revision: 3,
    });
    expect(first.sessions[0]).not.toHaveProperty('cwd');
    expect(authority.listSessions({
      limit: 1,
      cursor: first.nextCursor!,
    }, context()).sessions[0]?.id).toBe('live-b');
    expect(authority.listSessions({ limit: 10, includeArchived: true }, context()))
      .toMatchObject({ sessions: [{ id: 'closed-a' }], total: 1 });
  });

  it('lists and resolves only public project references', () => {
    const { authority } = harness();
    const listed = authority.listProjects({ limit: 10 }, context());
    expect(listed).toEqual({
      projects: [{
        projectId: 'project-alpha', projectRef: 'alpha',
        alias: 'alpha', title: 'Project Alpha',
      }],
      nextCursor: null,
      total: 1,
      revision: 3,
    });
    expect(listed.projects[0]).not.toHaveProperty('workspacePath');
  });

  it('classifies unavailable Workspace directory pages as invalid requests', () => {
    const { authority } = harness();
    expect(() => authority.listWorkspaceDirectories({ directory: 'missing' }, context()))
      .toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('creates through the exact adapter and completes durable idempotency', async () => {
    const { authority, commitSessionCreate, createSession } = harness();
    await expect(authority.createSession(
      await createParams(authority),
      context(),
    )).resolves.toEqual({ sessionId: 'created-session', revision: 4 });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude-code',
      cwd: expect.stringContaining('/workspaces/alpha'),
      prompt: 'Inspect the repository',
      permissionMode: 'bypassPermissions',
      claudeCodeSandbox: 'workspace-write',
    }));
    expect(createSession.mock.calls[0]?.[0]).toHaveProperty('awaitCanonicalId', true);
    expect(commitSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionScope: 'credential-a',
        method: 'session.console.create',
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      'created-session',
      expect.objectContaining({ sessionId: 'created-session' }),
    );
  });

  it('commits and replays only the canonical provider handle after temporary-id registration', async () => {
    const t = harness();
    let ready!: (id: string) => void;
    const canonical = new Promise<string>(resolve => { ready = resolve; });
    t.createSession.mockImplementation(async (options?: unknown) =>
      (options as { awaitCanonicalId?: boolean }).awaitCanonicalId ? canonical : 'temporary-id');
    const params = await createParams(t.authority);
    const creating = t.authority.createSession(params, context());
    await vi.waitFor(() => expect(t.createSession).toHaveBeenCalledOnce());
    expect(t.commitSessionCreate).not.toHaveBeenCalled();
    ready('canonical-id');
    const result = await creating;
    expect(result.sessionId).toBe('canonical-id');
    expect(t.commitSessionCreate).toHaveBeenCalledWith(expect.anything(), 'canonical-id',
      expect.objectContaining({ sessionId: 'canonical-id' }));
    t.setClaim({ state: 'completed', result: { ...result }, revision: result.revision });
    expect(await t.authority.createSession(params, context())).toEqual(result);
    expect(t.createSession).toHaveBeenCalledOnce();
  });

  it('passes trusted spawn registration without claiming an SSH mutation identity', async () => {
    const { authority, commitSessionCreate, createSession, metadata } = harness();
    const onRegistered = vi.fn();
    createSession.mockImplementationOnce(async (options?: unknown) => {
      const registration = (options as {
        initialSessionRegistration?: { onRegistered(sessionId: string): void };
      }).initialSessionRegistration;
      registration?.onRegistered('created-session');
      return 'created-session';
    });
    await expect(authority.createSpawnSession({
      params: await createParams(authority),
      initialSessionRegistration: {
        spawnLink: { parentSessionId: 'lead-session', depth: 2 },
        onRegistered,
      },
      teamName: 'review-team',
    })).resolves.toEqual({ sessionId: 'created-session', revision: 4 });
    expect(onRegistered).toHaveBeenCalledWith('created-session');
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      awaitCanonicalId: true,
      teamName: 'review-team',
      initialSessionRegistration: expect.objectContaining({
        spawnLink: { parentSessionId: 'lead-session', depth: 2 },
      }),
    }));
    expect(metadata.claimMutation).not.toHaveBeenCalled();
    expect(commitSessionCreate).not.toHaveBeenCalled();
  });

  it('passes private attachment references and rolls them back on provider failure', async () => {
    const current = harness();
    const input = {
      kind: 'image' as const,
      base64: Buffer.from('png').toString('base64'),
      mime: 'image/png' as const,
      bytes: 3,
    };
    const params = { ...await createParams(current.authority), attachments: [input] };
    await current.authority.createSession(params, context());
    expect(current.persistAttachments).toHaveBeenCalledWith([input]);
    expect(current.createSession).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [current.attachmentRef],
    }));
    expect(current.removeAttachments).not.toHaveBeenCalled();

    const failed = harness();
    failed.createSession.mockRejectedValueOnce(new Error('provider failed'));
    await expect(failed.authority.createSession(
      { ...await createParams(failed.authority), attachments: [input] },
      context(),
    )).rejects.toThrow('provider failed');
    expect(failed.removeAttachments).toHaveBeenCalledWith([failed.attachmentRef]);
    expect(failed.releaseMutationClaim).toHaveBeenCalledTimes(1);
  });
  it('applies project trust before attachments and retains it after provider failure', async () => {
    const current = harness();
    const order: string[] = [];
    current.projectTrustApply.mockImplementationOnce(async () => {
      order.push('trust');
      return {
        status: 'trusted', canGrant: false, reasonCode: null,
        revision: `sha256:${'d'.repeat(64)}`,
      };
    });
    current.persistAttachments.mockImplementationOnce(async () => {
      order.push('attachments');
      return [current.attachmentRef];
    });
    current.createSession.mockImplementationOnce(async () => {
      order.push('provider');
      throw new Error('provider failed after trust');
    });
    const input = { kind: 'image' as const, base64: Buffer.from('png').toString('base64'),
      mime: 'image/png' as const, bytes: 3 };
    const params = await createParams(current.authority);
    await expect(current.authority.createSession({
      ...params, attachments: [input],
      projectTrust: { ...params.projectTrust, grant: true },
    }, context())).rejects.toThrow('provider failed after trust');
    expect(order).toEqual(['trust', 'attachments', 'provider']);
    expect(current.projectTrustApply).toHaveBeenCalledOnce();
    expect(current.removeAttachments).toHaveBeenCalledWith([current.attachmentRef]);
  });
  it('rolls back a provider session when atomic metadata commit fails', async () => {
    const current = harness();
    current.commitSessionCreate.mockImplementationOnce(() => {
      throw new Error('metadata commit failed');
    });
    await expect(current.authority.createSession(
      await createParams(current.authority),
      context(),
    )).rejects.toThrow('metadata commit failed');
    expect(current.rollbackCreatedSession).toHaveBeenCalledWith(
      'claude-code', 'created-session',
    );
    expect(current.releaseMutationClaim).toHaveBeenCalledTimes(1);
  });

  it('retains an uncertain claim when strict provider rollback cannot be proven', async () => {
    const current = harness();
    current.commitSessionCreate.mockImplementationOnce(() => {
      throw new Error('metadata commit failed');
    });
    current.rollbackCreatedSession.mockRejectedValueOnce(new Error('rollback failed'));
    await expect(current.authority.createSession(
      await createParams(current.authority),
      context(),
    )).rejects.toMatchObject({
      code: 'provider_lost',
      retryable: true,
      message: 'Created provider session could not be rolled back',
    });
    expect(current.releaseMutationClaim).not.toHaveBeenCalled();
  });

  it('creates in an existing nested directory without a preconfigured project', async () => {
    const { authority, createSession, workspaceRoot } = harness();
    const nested = join(workspaceRoot, 'nested', 'child');
    mkdirSync(nested, { recursive: true });

    await expect(authority.createSession(
      await createParams(authority, 'nested/child', 'Inspect the nested directory'),
      context(),
    )).resolves.toEqual({ sessionId: 'created-session', revision: 4 });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: realpathSync(nested),
    }));
  });

  it('applies one authoritative Workspace ceiling to desktop and Feishu clients', async () => {
    const { authority, createSession, workspaceRoot } = harness();
    const nested = join(workspaceRoot, 'shared', 'project');
    const outside = join(workspaceRoot, '..', 'worker-private');
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(workspaceRoot, 'private-link'));
    const desktop = context(undefined, 'desktop-create');
    const feishu = context({
      kind: 'authenticated-client',
      topology: 'full',
      instanceId: 'instance-a',
      clientId: 'feishu-client',
      transport: 'feishu',
      connectionScope: 'feishu-credential',
      authority: 'owner-equivalent',
      surface: 'feishu',
      grant: issueRemoteOwnerGrantClaim('feishu'),
    }, 'feishu-create');

    for (const client of [desktop, feishu]) {
      expect(authority.listProjects({ limit: 10 }, client).projects[0])
        .not.toHaveProperty('workspacePath');
      await expect(authority.createSession(
        await createParams(authority, 'shared/project', 'Inspect the shared Workspace directory'),
        client,
      )).resolves.toMatchObject({ sessionId: 'created-session' });
    }
    expect(createSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cwd: realpathSync(nested),
    }));
    expect(createSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cwd: realpathSync(nested),
    }));
    await expect(authority.getCapabilities({
      adapterId: 'claude-code',
      provider: '',
      workingDirectory: 'private-link',
    }, context(feishu.access, 'feishu-escape'))).rejects.toThrow(/unavailable|Workspace/);
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('returns completed mutations without invoking a provider twice', async () => {
    const { authority, createSession, setClaim } = harness();
    const params = await createParams(authority);
    setClaim({
      state: 'completed',
      result: { sessionId: 'prior-session', revision: 9 },
      revision: 9,
    });
    await expect(authority.createSession(
      { ...params, capabilityRevision: `sha256:${'f'.repeat(64)}` },
      context(),
    )).resolves.toEqual({ sessionId: 'prior-session', revision: 9 });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('fails closed for ambiguous, conflicting, or widened creates', async () => {
    const { authority, releaseMutationClaim, setClaim } = harness();
    setClaim({ state: 'uncertain' });
    await expect(authority.createSession(
      await createParams(authority),
      context(),
    )).rejects.toMatchObject({ code: 'provider_lost' });
    setClaim({ state: 'conflict' });
    await expect(authority.createSession(
      await createParams(authority),
      context(),
    )).rejects.toMatchObject({ code: 'conflict' });
    setClaim({ state: 'claimed' });
    const stale = await createParams(authority);
    await expect(authority.createSession({
      ...stale,
      capabilityRevision: `sha256:${'f'.repeat(64)}`,
    }, context())).rejects.toMatchObject({ code: 'conflict' });
    expect(releaseMutationClaim).toHaveBeenCalledTimes(1);
  });
  it('rejects a non-owner context before claiming mutation authority', async () => {
    const { authority, metadata } = harness();
    await expect(authority.createSession(await createParams(authority), context({
      kind: 'standalone', topology: 'standalone', instanceId: 'local',
      clientId: 'local', transport: 'local-ipc', accessCredentialId: null,
      authority: 'local-owner', surface: 'desktop',
    }))).rejects.toMatchObject({ code: 'access_denied' });
    expect(metadata.claimMutation).not.toHaveBeenCalled();
  });
});
