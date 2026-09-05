import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPreparedWorktree,
  prepareEnterWorktree,
  type PreparedEnterWorktree,
} from '../tools/handlers/enter-worktree-impl';
import { preflightStructuredWorktreeExit } from '@main/session/worktree-transition/git-cleanup';
import type { WorktreeTransitionRecord } from '@main/session/worktree-transition/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-repository-identity-')));
  roots.push(root);
  const empty = join(root, 'empty');
  mkdirSync(empty);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (cwd: string, args: string[]) => execFileSync('git', [
    '-c', `core.hooksPath=${empty}`, '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args,
  ], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const init = (name: string, file: string, extra: string[] = []) => {
    const cwd = join(root, name);
    mkdirSync(cwd);
    git(cwd, ['init', `--template=${empty}`, '-b', 'main', ...extra]);
    writeFileSync(join(cwd, file), 'fixture\n');
    git(cwd, ['add', file]);
    git(cwd, ['commit', '-m', 'fixture']);
    return cwd;
  };
  return { root, git, init };
}

function activeLease(prepared: PreparedEnterWorktree): WorktreeTransitionRecord {
  return {
    sessionId: prepared.callerSessionId, generation: 1, direction: 'enter', phase: 'active',
    originalCwd: prepared.originalCwd, targetCwd: prepared.worktreePath,
    mainRepo: prepared.mainRepo, worktreePath: prepared.worktreePath,
    baseCommit: prepared.startCommit, toolUseId: null, continuationKey: 'fixture',
    continuationDelivered: true, discardChanges: false, requestedAt: 1, updatedAt: 1,
    lastError: null,
  };
}

async function enter(callerCwd: string, worktreePath: string) {
  const prepared = await prepareEnterWorktree({
    callerSessionId: 'fixture-session', startPoint: 'HEAD', worktreePathOverride: worktreePath,
  }, { callerCwd: () => callerCwd });
  if ('error' in prepared) throw new Error(prepared.error);
  await createPreparedWorktree(prepared);
  return prepared;
}

describe('worktree repository identity', () => {
  it('creates the submodule HEAD and accepts its clean exit without selecting the superproject', async () => {
    const { root, git, init } = fixture();
    const library = init('library', 'library.ts');
    const parent = init('super project', 'superproject.ts');
    git(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'lib']);
    git(parent, ['commit', '-am', 'add submodule']);
    const caller = join(parent, 'lib');
    const expectedHead = git(caller, ['rev-parse', 'HEAD']);
    const parentHead = git(parent, ['rev-parse', 'HEAD']);
    const prepared = await enter(caller, join(root, 'isolated library'));
    expect(prepared.mainRepo).toBe(caller);
    expect(prepared.startCommit).toBe(expectedHead);
    expect(prepared.startCommit).not.toBe(parentHead);
    expect(existsSync(join(prepared.worktreePath, 'library.ts'))).toBe(true);
    expect(existsSync(join(prepared.worktreePath, 'superproject.ts'))).toBe(false);
    await expect(preflightStructuredWorktreeExit(activeLease(prepared), {
      discardChanges: false,
    })).resolves.toEqual({ exists: true });
    await expect(preflightStructuredWorktreeExit({ ...activeLease(prepared), mainRepo: parent }, {
      discardChanges: false,
    })).rejects.toThrow('leased main repo');
  });

  it('freezes HEAD in the caller linked worktree while retaining the main checkout owner', async () => {
    const { root, git, init } = fixture();
    const main = init('repo', 'main.ts');
    const linked = join(root, 'linked');
    git(main, ['worktree', 'add', '-b', 'feature', linked]);
    writeFileSync(join(linked, 'feature.ts'), 'feature\n');
    git(linked, ['add', 'feature.ts']);
    git(linked, ['commit', '-m', 'feature']);
    const head = git(linked, ['rev-parse', 'HEAD']);
    const prepared = await enter(linked, join(root, 'nested request'));
    expect(prepared.mainRepo).toBe(main);
    expect(prepared.startCommit).toBe(head);
    expect(prepared.startCommit).not.toBe(git(main, ['rev-parse', 'HEAD']));
    expect(existsSync(join(prepared.worktreePath, 'feature.ts'))).toBe(true);
    await expect(preflightStructuredWorktreeExit(activeLease(prepared), {
      discardChanges: false,
    })).resolves.toEqual({ exists: true });
  });

  it('uses an actual checkout when Git metadata is stored in a separate directory', async () => {
    const { root, init, git } = fixture();
    const main = init('checkout', 'source.ts', [`--separate-git-dir=${join(root, 'metadata')}`]);
    const prepared = await enter(main, join(root, 'separate worktree'));
    expect(prepared.mainRepo).toBe(main);
    expect(prepared.startCommit).toBe(git(main, ['rev-parse', 'HEAD']));
    expect(existsSync(join(prepared.worktreePath, 'source.ts'))).toBe(true);
    await expect(preflightStructuredWorktreeExit(activeLease(prepared), {
      discardChanges: false,
    })).resolves.toEqual({ exists: true });
  });
});
