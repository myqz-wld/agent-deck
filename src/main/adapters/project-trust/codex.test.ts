import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCodexProjectTrustProvider, type CodexProjectTrustClient } from './codex';
import { ProjectTrustService } from './core';

const roots: string[] = [];

function root(label: string): string {
  const value = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `agent-deck-${label}-`)));
  roots.push(value);
  return value;
}

function response(projects: Record<string, unknown>, version = 'user-v1') {
  return {
    config: { projects, project_root_markers: ['.git'] },
    layers: [{ name: { type: 'user', profile: null }, version }],
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Codex project trust provider', () => {
  it('uses exact cwd before project/main-repository decisions', async () => {
    const repo = root('codex-trust');
    mkdirSync(join(repo, '.git'));
    const cwd = join(repo, 'packages', 'app');
    mkdirSync(cwd, { recursive: true });
    const client: CodexProjectTrustClient = {
      request: vi.fn(async () => response({
        [repo]: { trust_level: 'trusted' },
        [realpathSync(cwd)]: { trust_level: 'untrusted' },
      })) as CodexProjectTrustClient['request'],
    };
    const provider = createCodexProjectTrustProvider({
      withClient: async (_provider, operation) => operation(client),
    });

    await expect(provider.observe({ adapterId: 'codex-cli', cwd }))
      .resolves.toMatchObject({ descriptor: { status: 'untrusted', canGrant: true } });
    expect(client.request).toHaveBeenCalledWith(
      'config/read', { includeLayers: true, cwd: realpathSync(cwd) }, expect.any(AbortSignal),
    );
  });

  it('writes the conventional main-checkout key with the native user-layer version', async () => {
    const parent = root('codex-worktree-trust');
    const main = join(parent, 'main');
    const worktree = join(parent, 'linked');
    const gitDir = join(main, '.git');
    mkdirSync(join(gitDir, 'worktrees', 'linked'), { recursive: true });
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(gitDir, 'worktrees', 'linked')}\n`);
    writeFileSync(join(gitDir, 'worktrees', 'linked', 'commondir'), '../..\n');
    const canonicalMain = realpathSync(main);
    const canonicalWorktree = realpathSync(worktree);
    let trusted = false;
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === 'config/read') {
        return response(trusted ? { [canonicalMain]: { trust_level: 'trusted' } } : {},
          trusted ? 'user-v2' : 'user-v1');
      }
      expect(method).toBe('config/value/write');
      expect(params).toEqual({
        keyPath: `projects.${JSON.stringify(canonicalMain)}.trust_level`,
        value: 'trusted',
        mergeStrategy: 'upsert',
        expectedVersion: 'user-v1',
      });
      trusted = true;
      return { version: 'user-v2' };
    });
    const provider = createCodexProjectTrustProvider({
      withClient: async (_provider, operation) => operation({
        request: request as CodexProjectTrustClient['request'],
      }),
    });
    const service = new ProjectTrustService({
      'claude-code': provider, 'codex-cli': provider, 'grok-build': provider,
    });
    const input = { adapterId: 'codex-cli' as const, cwd: canonicalWorktree };
    const initial = await service.describe(input);

    await expect(service.apply(input, { revision: initial.revision, grant: true }))
      .resolves.toMatchObject({ status: 'trusted' });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'config/read', 'config/read', 'config/value/write', 'config/read',
    ]);
  });

  it('fails diagnostic-only when the native user layer cannot be version-fenced', async () => {
    const cwd = root('codex-no-version');
    const provider = createCodexProjectTrustProvider({
      withClient: async (_provider, operation) => operation({
        request: vi.fn(async () => ({ config: { projects: {} }, layers: [] })) as
          CodexProjectTrustClient['request'],
      }),
    });
    await expect(provider.observe({ adapterId: 'codex-cli', cwd })).resolves.toMatchObject({
      descriptor: {
        status: 'unknown', canGrant: false, reasonCode: 'provider-unavailable',
      },
    });
  });
});
