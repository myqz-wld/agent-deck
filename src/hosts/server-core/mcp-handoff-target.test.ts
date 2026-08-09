import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { SessionRecord } from '@shared/types';

import { resolveServerCoreHandOffTarget } from './mcp-handoff-target';
import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';

const roots: string[] = [];

function workspace(): { root: string; project: string } {
  const parent = mkdtempSync(join(tmpdir(), 'agent-deck-core-handoff-target-'));
  roots.push(parent);
  const root = join(parent, 'Workspace');
  const project = join(root, 'project-a');
  mkdirSync(project, { recursive: true });
  return { root: realpathSync(root), project: realpathSync(project) };
}

function source(cwd: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'source-a',
    agentId: 'codex-cli',
    cwd,
    title: 'source',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    runtimeProvider: 'openai',
    model: 'gpt-5.6',
    thinking: 'high',
    codexApprovalPolicy: 'never',
    codexSandbox: 'workspace-write',
    networkAccessEnabled: true,
    additionalDirectories: [cwd, '/private/outside'],
    ...overrides,
  };
}

function capabilities() {
  const describe = vi.fn(async (input: {
    adapterId: 'claude-code' | 'codex-cli' | 'grok-build';
    workingDirectory: string;
  }) => sessionConsoleCapabilitiesFixture(input.adapterId, input.workingDirectory));
  const validateCreate = vi.fn(async (
    adapterId: 'claude-code' | 'codex-cli' | 'grok-build',
    _revision: string,
    cwd: string,
  ) => sessionConsoleCapabilitiesFixture(adapterId, cwd));
  return {
    port: { describe, validateCreate } as unknown as ServerCoreSessionCreateCapabilities,
    describe,
    validateCreate,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveServerCoreHandOffTarget', () => {
  it('inherits same-adapter runtime controls while exposing only a Workspace-relative cwd', async () => {
    const paths = workspace();
    const api = capabilities();
    const resolved = await resolveServerCoreHandOffTarget({
      args: { prompt: 'Continue the work' },
      source: source(paths.project),
      workspaceRoot: paths.root,
      capabilities: api.port,
      sourceMaxEventId: 42,
    });

    expect(resolved.cwdRef).toBe('project-a');
    expect(resolved.cwd).toBe(paths.project);
    expect(resolved.createOptions).toMatchObject({
      agentId: 'codex-cli',
      cwd: paths.project,
      model: 'gpt-5.6',
      modelReasoningEffort: 'high',
      provider: 'openai',
      approvalPolicy: 'never',
      codexSandbox: 'workspace-write',
      networkAccessEnabled: true,
      additionalDirectories: [paths.project],
      handOff: {
        mode: 'session',
        fromCallerSid: 'source-a',
        sourceMaxEventId: 42,
      },
    });
    expect(resolved.spec.contextCapacity).toMatchObject({ status: 'unknown' });
    expect(resolved.spec.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(api.validateCreate).toHaveBeenCalledWith(
      'codex-cli',
      resolved.capabilityRevision,
      'project-a',
      resolved.options,
    );
  });

  it('uses target defaults across adapters and rejects adapter-owned control confusion', async () => {
    const paths = workspace();
    const api = capabilities();
    const resolved = await resolveServerCoreHandOffTarget({
      args: {
        prompt: 'Move to Claude',
        adapter: 'claude-code',
        cwd: '.',
      },
      source: source(paths.project),
      workspaceRoot: paths.root,
      capabilities: api.port,
      sourceMaxEventId: null,
    });

    expect(resolved.adapterId).toBe('claude-code');
    expect(resolved.cwdRef).toBe('.');
    expect(resolved.createOptions).not.toHaveProperty('provider');
    expect(resolved.createOptions).not.toHaveProperty('codexApprovalPolicy');
    expect(resolved.createOptions).not.toHaveProperty('networkAccessEnabled');

    await expect(resolveServerCoreHandOffTarget({
      args: {
        prompt: 'Wrong owner',
        adapter: 'claude-code',
        approvalPolicy: 'never',
      },
      source: source(paths.project),
      workspaceRoot: paths.root,
      capabilities: api.port,
      sourceMaxEventId: null,
    })).rejects.toThrow(/approvalPolicy/);
  });

  it('fails closed when the caller or requested cwd escapes Workspace', async () => {
    const paths = workspace();
    const api = capabilities();
    await expect(resolveServerCoreHandOffTarget({
      args: { prompt: 'Keep cwd' },
      source: source(join(paths.root, '..', 'private')),
      workspaceRoot: paths.root,
      capabilities: api.port,
      sourceMaxEventId: null,
    })).rejects.toThrow();
    await expect(resolveServerCoreHandOffTarget({
      args: { prompt: 'Escape', cwd: '../private' },
      source: source(paths.project),
      workspaceRoot: paths.root,
      capabilities: api.port,
      sourceMaxEventId: null,
    })).rejects.toThrow();
    expect(api.describe).not.toHaveBeenCalled();
  });
});
