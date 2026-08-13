import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type {
  CreateSessionOptions,
  ForkSessionSource,
} from '@main/adapters/types';

import {
  closeSpawnHarnessDatabases,
  harness,
  session,
} from './mcp-session-spawn.test-fixtures';

afterEach(closeSpawnHarnessDatabases);

describe('ServerCoreMcpSessionSpawner', () => {
  it('applies the selected built-in Agent config while explicit runtime values win', async () => {
    const state = harness({
      agents: {
        resolveBundledAgent: (adapterId, agentName) => adapterId === 'codex-cli' &&
          agentName === 'reviewer-codex' ? {
            dto: {
              adapterId,
              kind: 'agent',
              source: 'bundled',
              name: agentName,
              qualifiedName: 'agent-deck:codex-cli:reviewer-codex',
              description: 'Reviewer',
              location: 'packaged',
              tools: null,
              model: 'agent-model',
              thinking: 'xhigh',
              provider: 'agent-provider',
              origin: null,
              pluginName: null,
              runtimeName: null,
              runtimeDefaults: { model: 'default-model', thinking: 'high', provider: null },
              runtimeOverride: {
                model: 'agent-model', thinking: 'xhigh', provider: 'agent-provider',
              },
            },
            content: [
              'name = "reviewer-codex"',
              'description = "Reviewer"',
              'model = "default-model"',
              'model_reasoning_effort = "high"',
              'developer_instructions = "Review this batch"',
              '[features]',
              'web_search = true',
            ].join('\n'),
          } : null,
      },
    });
    const result = await state.spawner.spawn('caller', {
      adapter: 'codex-cli',
      agentName: 'reviewer-codex',
      cwd: '.',
      prompt: 'Inspect',
      model: 'explicit-model',
    });

    expect(result).toMatchObject({
      agentName: 'reviewer-codex',
      displayName: 'reviewer-codex',
    });
    const create = state.createSpawnSession.mock.calls[0]![0];
    expect(create.params.options).toMatchObject({
      model: 'explicit-model',
      thinking: 'xhigh',
      provider: 'agent-provider',
    });
    expect(create.agent).toMatchObject({
      adapterId: 'codex-cli',
      developerInstructions: expect.stringContaining('Review this batch'),
      codexConfigOverrides: { features: { web_search: true } },
    });
    expect(state.records.get('child')?.title).toBe('reviewer-codex');
  });

  it('creates a linked provider child with Core defaults, team membership, and reply anchor', async () => {
    const state = harness();
    const result = await state.spawner.spawn('caller', {
      adapter: 'codex-cli',
      cwd: 'project-a',
      prompt: 'Inspect the bounded project',
      teamName: 'review-team',
      displayName: 'Reviewer',
      model: 'gpt-5.6-sol',
      thinking: 'ultra',
      approvalPolicy: 'never',
      codexSandbox: 'read-only',
    });
    expect(result).toMatchObject({
      sessionId: 'child',
      adapter: 'codex-cli',
      cwd: 'project-a',
      teamName: 'review-team',
      displayName: 'Reviewer',
      spawnDepth: 1,
      contextMode: 'fresh',
    });
    expect(JSON.stringify(result)).not.toContain('/workspace');
    expect(state.registeredBeforeResolve()).toBe(true);
    expect(state.records.get('child')).toMatchObject({
      spawnedBy: 'caller',
      spawnDepth: 1,
      title: 'Reviewer',
    });
    const create = state.createSpawnSession.mock.calls[0]![0];
    expect(create.params.options).toMatchObject({
      model: 'gpt-5.6-sol',
      thinking: 'ultra',
      approvalPolicy: 'never',
      codexSandbox: 'read-only',
    });
    expect(create.params.initialMessage).toMatch(
      /^\[from title-caller @ codex-cli\]\[msg [0-9a-f-]+\]\[sid caller\]/,
    );
    expect(create.params.initialMessage).not.toContain('/workspace');
    const team = state.teams.getByActiveName('review-team');
    expect(team).not.toBeNull();
    expect(state.teams.listActiveMembers(team!.id).map((row) => [row.sessionId, row.role]))
      .toEqual([['caller', 'lead'], ['child', 'teammate']]);
    expect(state.messages.get(result.spawnPromptMessageId)).toMatchObject({
      fromSessionId: 'caller',
      toSessionId: 'child',
      body: 'Inspect the bounded project',
      status: 'delivered',
    });
    expect(state.notifyMembershipChanged).toHaveBeenCalledTimes(2);
    expect(state.validateCreate).toHaveBeenCalledOnce();
  });

  it('rejects absolute and traversal cwd values before provider or team creation', async () => {
    const state = harness();
    for (const cwd of ['/workspace/project', '../project']) {
      await expect(state.spawner.spawn('caller', {
        adapter: 'codex-cli', cwd, prompt: 'Inspect', teamName: 'must-not-exist',
      })).rejects.toThrow(/workspaceDirectory|spawn_session\.cwd|Workspace-relative/i);
    }
    expect(state.createSpawnSession).not.toHaveBeenCalled();
    expect(state.teams.getByActiveName('must-not-exist')).toBeNull();
  });

  it('strictly rolls back a registered child when the anchor transaction fails', async () => {
    const state = harness({ failAnchor: true });
    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli', cwd: '.', prompt: 'Inspect',
    })).rejects.toThrow('reply anchor');
    expect(state.closeSessionForRollback).toHaveBeenCalledWith('child');
    expect(state.discardAfterProviderRollback).toHaveBeenCalledWith('child');
    expect(state.records.has('child')).toBe(false);
    expect(state.messages.listBySession('caller')).toEqual([]);
  });

  it('creates a native same-runtime fork without routing through fresh creation', async () => {
    const state = harness();
    const result = await state.spawner.spawn('caller', {
      adapter: 'codex-cli',
      contextMode: 'fork',
      cwd: '.',
      prompt: 'Continue from the active provider history',
    });

    expect(result).toMatchObject({
      contextMode: 'fork',
      forkedFromSessionId: 'caller',
      sessionId: 'child',
    });
    expect(state.createSpawnSession).not.toHaveBeenCalled();
    expect(state.validateForkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationSessionId: 'caller',
        nativeSessionId: expect.any(String),
      }),
      expect.objectContaining({ agentId: 'codex-cli', cwd: process.cwd() }),
    );
    const target = state.createForkedSession.mock.calls[0]![1];
    expect(target.prompt).toContain('Continue from the active provider history');
    expect(state.records.get('child')).toMatchObject({ spawnedBy: 'caller', spawnDepth: 1 });
  });

  it('accepts a consumed temporary registration when Codex returns its canonical fork id', async () => {
    const state = harness();
    state.createForkedSession.mockImplementationOnce(async (
      _source: ForkSessionSource,
      target: CreateSessionOptions,
    ) => {
      const tempId = 'child-temp';
      state.records.set(tempId, session(tempId, {
        agentId: target.agentId,
        cwd: target.cwd,
        spawnedBy: target.initialSessionRegistration?.spawnLink.parentSessionId,
        spawnDepth: target.initialSessionRegistration?.spawnLink.depth,
      }));
      target.initialSessionRegistration?.onRegistered(tempId);
      state.records.delete(tempId);
      state.insertSession('child', target.agentId);
      state.records.set('child', session('child', {
        agentId: target.agentId,
        cwd: target.cwd,
        spawnedBy: target.initialSessionRegistration?.spawnLink.parentSessionId,
        spawnDepth: target.initialSessionRegistration?.spawnLink.depth,
      }));
      return { sessionId: 'child', discard: state.forkDiscard };
    });

    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli', contextMode: 'fork', cwd: '.', prompt: 'Fork canonically',
    })).resolves.toMatchObject({ sessionId: 'child', contextMode: 'fork' });
    expect(state.records.has('child-temp')).toBe(false);
    expect(state.records.get('child')).toMatchObject({ spawnedBy: 'caller', spawnDepth: 1 });
  });

  it('rejects a canonical fork while its temporary registration remains live', async () => {
    const state = harness();
    const discard = vi.fn(async () => { state.records.delete('child-temp'); });
    state.createForkedSession.mockImplementationOnce(async (_source, target) => {
      const link = target.initialSessionRegistration!.spawnLink;
      state.records.set('child-temp', session('child-temp', {
        cwd: target.cwd, spawnedBy: link.parentSessionId, spawnDepth: link.depth,
      }));
      target.initialSessionRegistration!.onRegistered('child-temp');
      state.insertSession('child', target.agentId);
      state.records.set('child', session('child', {
        cwd: target.cwd, spawnedBy: link.parentSessionId, spawnDepth: link.depth,
      }));
      return { sessionId: 'child', discard };
    });

    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli', contextMode: 'fork', cwd: '.', prompt: 'Reject two targets',
    })).rejects.toThrow('different canonical spawn target');
    expect(discard).toHaveBeenCalledOnce();
    expect(state.records.has('child-temp')).toBe(false);
    expect(state.records.has('child')).toBe(false);
  });

  it('rejects a fork whose provider never reports durable registration', async () => {
    const state = harness();
    state.createForkedSession.mockImplementationOnce(async (_source, target) => {
      state.insertSession('child', target.agentId);
      state.records.set('child', session('child', {
        cwd: target.cwd, spawnedBy: 'caller', spawnDepth: 1,
      }));
      return { sessionId: 'child', discard: state.forkDiscard };
    });

    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli', contextMode: 'fork', cwd: '.', prompt: 'Require registration',
    })).rejects.toThrow('not durably registered');
    expect(state.closeSessionForRollback).toHaveBeenCalledWith('child');
    expect(state.records.has('child')).toBe(false);
  });

  it('discards native fork artifacts when the collaboration commit fails', async () => {
    const state = harness({ failAnchor: true });
    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli', contextMode: 'fork', cwd: '.', prompt: 'Fork safely',
    })).rejects.toThrow('reply anchor');
    expect(state.closeSessionForRollback).toHaveBeenCalledWith('child');
    expect(state.forkDiscard).toHaveBeenCalledOnce();
    expect(state.records.has('child')).toBe(false);
  });

  it('still discards a native fork and durable row when strict close fails', async () => {
    const state = harness({ failAnchor: true });
    state.closeSessionForRollback.mockRejectedValueOnce(new Error('strict close failed'));

    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli', contextMode: 'fork', cwd: '.', prompt: 'Fork safely',
    })).rejects.toThrow('reply anchor');
    expect(state.forkDiscard).toHaveBeenCalledOnce();
    expect(state.discardAfterProviderRollback).toHaveBeenCalledWith('child');
    expect(state.records.has('child')).toBe(false);
  });

  it('retains the durable child when close and fork discard both fail', async () => {
    const state = harness({ failAnchor: true });
    state.closeSessionForRollback.mockRejectedValueOnce(new Error('strict close failed'));
    state.forkDiscard.mockRejectedValueOnce(new Error('fork discard failed'));

    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli', contextMode: 'fork', cwd: '.', prompt: 'Fork safely',
    })).rejects.toThrow('could not prove cleanup');
    expect(state.forkDiscard).toHaveBeenCalledOnce();
    expect(state.discardAfterProviderRollback).not.toHaveBeenCalled();
    expect(state.records.has('child')).toBe(true);
  });

  it('rejects a fork runtime mismatch without silently creating a fresh child or team', async () => {
    const state = harness();
    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli',
      contextMode: 'fork',
      cwd: '.',
      prompt: 'Do not downgrade',
      provider: 'different-provider',
      teamName: 'must-not-exist',
    })).rejects.toThrow('runtime selector');
    expect(state.createForkedSession).not.toHaveBeenCalled();
    expect(state.createSpawnSession).not.toHaveBeenCalled();
    expect(state.teams.getByActiveName('must-not-exist')).toBeNull();
  });

  it('revalidates caller liveness after asynchronous native-fork validation', async () => {
    const state = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.validateForkSession.mockImplementationOnce(async () => {
      await gate;
      return undefined;
    });
    const spawning = state.spawner.spawn('caller', {
      adapter: 'codex-cli', contextMode: 'fork', cwd: '.', prompt: 'Remain caller-bound',
    });
    await vi.waitFor(() => expect(state.validateForkSession).toHaveBeenCalledOnce());
    state.records.set('caller', session('caller', { lifecycle: 'closed' }));
    release();

    await expect(spawning).rejects.toThrow('no longer live');
    expect(state.createForkedSession).not.toHaveBeenCalled();
    expect(state.createSpawnSession).not.toHaveBeenCalled();
  });

  it('rejects caller identity drift after asynchronous native-fork validation', async () => {
    const state = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.validateForkSession.mockImplementationOnce(async () => {
      await gate;
      return undefined;
    });
    const spawning = state.spawner.spawn('caller', {
      adapter: 'codex-cli', contextMode: 'fork', cwd: '.', prompt: 'Remain source-bound',
    });
    await vi.waitFor(() => expect(state.validateForkSession).toHaveBeenCalledOnce());
    state.records.set('caller', session('caller', { cliSessionId: 'native-replacement' }));
    release();

    await expect(spawning).rejects.toThrow('identity changed');
    expect(state.createForkedSession).not.toHaveBeenCalled();
    expect(state.createSpawnSession).not.toHaveBeenCalled();
  });

  it('rolls back a fork when caller identity drifts during provider creation', async () => {
    const state = harness();
    let release!: () => void;
    let registered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const childRegistered = new Promise<void>((resolve) => { registered = resolve; });
    state.createForkedSession.mockImplementationOnce(async (_source, target) => {
      state.insertSession('child', target.agentId);
      state.records.set('child', session('child', {
        cwd: target.cwd, spawnedBy: 'caller', spawnDepth: 1,
      }));
      target.initialSessionRegistration!.onRegistered('child');
      registered();
      await gate;
      return { sessionId: 'child', discard: state.forkDiscard };
    });
    const spawning = state.spawner.spawn('caller', {
      adapter: 'codex-cli', contextMode: 'fork', cwd: '.', prompt: 'Remain source-bound',
    });
    await childRegistered;
    state.records.set('caller', session('caller', { cliSessionId: 'native-replacement' }));
    release();

    await expect(spawning).rejects.toThrow('identity changed');
    expect(state.closeSessionForRollback).toHaveBeenCalledWith('child');
    expect(state.forkDiscard).toHaveBeenCalledOnce();
    expect(state.records.has('child')).toBe(false);
  });

  it('enforces the Core recursion guard without invoking a provider', async () => {
    const state = harness({ callerDepth: 3 });
    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli', cwd: '.', prompt: 'Delegate again',
    })).rejects.toMatchObject({
      name: 'ServerCoreSpawnGuardError',
      spawnLimits: { depth: { current: 3, next: 4, max: 3 } },
    });
    expect(state.createSpawnSession).not.toHaveBeenCalled();
  });

  it('revalidates caller liveness after capability awaits and before provider creation', async () => {
    const state = harness();
    let releaseDescribe!: () => void;
    const describeGate = new Promise<void>((resolve) => { releaseDescribe = resolve; });
    state.describe.mockImplementationOnce(async (params) => {
      await describeGate;
      return sessionConsoleCapabilitiesFixture(params.adapterId, params.workingDirectory);
    });
    const spawning = state.spawner.spawn('caller', {
      adapter: 'codex-cli',
      cwd: '.',
      prompt: 'Must not outlive the caller',
      teamName: 'must-not-exist',
    });
    await vi.waitFor(() => expect(state.describe).toHaveBeenCalledOnce());
    state.records.set('caller', session('caller', { lifecycle: 'closed' }));
    releaseDescribe();

    await expect(spawning).rejects.toThrow('no longer live');
    expect(state.createSpawnSession).not.toHaveBeenCalled();
    expect(state.teams.getByActiveName('must-not-exist')).toBeNull();
  });
});
