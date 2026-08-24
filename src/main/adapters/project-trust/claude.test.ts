import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeProjectTrustProvider } from './claude';
import { PROJECT_TRUST_MAX_STATE_BYTES } from './secure-state-file';

const roots: string[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'agent-deck-claude-trust-')));
  roots.push(root);
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  return { cwd: realpathSync(cwd), statePath: join(root, '.claude.json') };
}

function privateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Claude project trust provider', () => {
  it('detects without mutation and performs a latest-read preserving private merge', async () => {
    const { cwd, statePath } = fixture();
    privateJson(statePath, {
      custom: { preserved: true },
      projects: { [cwd]: { customProjectKey: 'keep' } },
    });
    const provider = createClaudeProjectTrustProvider({ stateFile: () => statePath });
    const before = readFileSync(statePath, 'utf8');

    const observed = await provider.observe({ adapterId: 'claude-code', cwd });
    expect(observed.descriptor).toMatchObject({ status: 'untrusted', canGrant: true });
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    await observed.grant?.();

    const stored = JSON.parse(readFileSync(statePath, 'utf8')) as {
      custom: unknown;
      projects: Record<string, Record<string, unknown>>;
    };
    expect(stored.custom).toEqual({ preserved: true });
    expect(stored.projects[cwd]).toEqual({
      customProjectKey: 'keep', hasTrustDialogAccepted: true,
    });
    expect(lstatSync(statePath).mode & 0o777).toBe(0o600);
    await expect(provider.observe({ adapterId: 'claude-code', cwd }))
      .resolves.toMatchObject({ descriptor: { status: 'trusted', canGrant: false } });
  });

  it('re-reads under the native lock so concurrent unrelated keys survive', async () => {
    const { cwd, statePath } = fixture();
    privateJson(statePath, { projects: {} });
    const provider = createClaudeProjectTrustProvider({ stateFile: () => statePath });
    const observed = await provider.observe({ adapterId: 'claude-code', cwd });
    privateJson(statePath, { concurrent: 'native', projects: {} });

    await observed.grant?.();
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      concurrent: 'native',
      projects: { [cwd]: { hasTrustDialogAccepted: true } },
    });
  });

  it('reports malformed or unsafe state and never exposes a grant', async () => {
    const malformed = fixture();
    privateJson(malformed.statePath, { projects: 'invalid' });
    await expect(createClaudeProjectTrustProvider({
      stateFile: () => malformed.statePath,
    }).observe({ adapterId: 'claude-code', cwd: malformed.cwd })).resolves.toMatchObject({
      descriptor: { status: 'unknown', canGrant: false, reasonCode: 'state-malformed' },
    });

    const unsafe = fixture();
    privateJson(unsafe.statePath, { projects: {} });
    chmodSync(unsafe.statePath, 0o666);
    const observation = await createClaudeProjectTrustProvider({
      stateFile: () => unsafe.statePath,
    }).observe({ adapterId: 'claude-code', cwd: unsafe.cwd });
    expect(observation.descriptor).toMatchObject({
      status: 'unknown', canGrant: false, reasonCode: 'state-unsafe',
    });
    expect(observation.grant).toBeUndefined();

    const oversized = fixture();
    writeFileSync(oversized.statePath, 'x'.repeat(PROJECT_TRUST_MAX_STATE_BYTES + 1), {
      mode: 0o600,
    });
    await expect(createClaudeProjectTrustProvider({
      stateFile: () => oversized.statePath,
    }).observe({ adapterId: 'claude-code', cwd: oversized.cwd })).resolves.toMatchObject({
      descriptor: { status: 'unknown', canGrant: false, reasonCode: 'state-unsafe' },
    });
  });

  (process.platform === 'win32' ? it.skip : it)(
    'rejects a symlinked native state file without following it',
    async () => {
      const { cwd, statePath } = fixture();
      const target = `${statePath}.target`;
      privateJson(target, { projects: { [cwd]: { hasTrustDialogAccepted: true } } });
      symlinkSync(target, statePath);
      const provider = createClaudeProjectTrustProvider({ stateFile: vi.fn(() => statePath) });
      await expect(provider.observe({ adapterId: 'claude-code', cwd })).resolves.toMatchObject({
        descriptor: { status: 'unknown', canGrant: false, reasonCode: 'state-unsafe' },
      });
    },
  );
});
