import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hookRelayConfigPath,
  inspectHookRelayConfig,
  prepareHookRelayConfig,
} from './hook-relay-config';

describe('hook relay config', () => {
  let root: string;
  let relayRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-deck-hook-relay-'));
    relayRoot = join(root, 'relay');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps authority in a 0600 file under a 0700 directory', () => {
    const token = 'a'.repeat(64);
    const path = prepareHookRelayConfig({
      relayRoot,
      adapterId: 'codex-cli',
      event: 'SessionStart',
      port: 47_821,
      token,
      route: '/hook/codex/sessionstart',
    });
    const content = readFileSync(path, 'utf8');

    expect(path).toBe(
      hookRelayConfigPath(relayRoot, 'codex-cli', 'SessionStart'),
    );
    expect(statSync(relayRoot).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(content).toContain(
      'url = "http://127.0.0.1:47821/hook/codex/sessionstart"',
    );
    expect(content).toContain(`header = "Authorization: Bearer ${token}"`);
    expect(content).toContain('fail-with-body');
    expect(
      inspectHookRelayConfig({
        relayRoot,
        adapterId: 'codex-cli',
        event: 'SessionStart',
        port: 47_821,
        token,
        route: '/hook/codex/sessionstart',
      }),
    ).toEqual({
      path,
      healthy: true,
      actualMode: 0o600,
      issues: [],
    });

    chmodSync(relayRoot, 0o755);
    chmodSync(path, 0o644);
    prepareHookRelayConfig({
      relayRoot,
      adapterId: 'codex-cli',
      event: 'SessionStart',
      port: 47_821,
      token,
      route: '/hook/codex/sessionstart',
    });
    expect(statSync(relayRoot).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rejects malformed authority and refuses to follow relay symlinks', () => {
    expect(() =>
      prepareHookRelayConfig({
        relayRoot,
        adapterId: 'claude-code',
        event: 'SessionStart',
        port: 47_821,
        token: 'short',
        route: '/hook/sessionstart',
      }),
    ).toThrow('canonical 64-character bearer token');

    const target = join(root, 'user-owned.curlrc');
    writeFileSync(target, 'user owned\n', 'utf8');
    const relayPath = hookRelayConfigPath(
      relayRoot,
      'claude-code',
      'SessionStart',
    );
    prepareHookRelayConfig({
      relayRoot,
      adapterId: 'claude-code',
      event: 'OtherEvent',
      port: 47_821,
      token: 'b'.repeat(64),
      route: '/hook/otherevent',
    });
    symlinkSync(target, relayPath);

    expect(() =>
      prepareHookRelayConfig({
        relayRoot,
        adapterId: 'claude-code',
        event: 'SessionStart',
        port: 47_821,
        token: 'b'.repeat(64),
        route: '/hook/sessionstart',
      }),
    ).toThrow('regular private relay file');
    expect(readFileSync(target, 'utf8')).toBe('user owned\n');
  });

  it('reports a missing relay config without creating it', () => {
    const options = {
      relayRoot,
      adapterId: 'grok-build' as const,
      event: 'SessionStart',
      port: 47_821,
      token: 'd'.repeat(64),
      route: '/hook/grok/sessionstart',
    };

    expect(inspectHookRelayConfig(options)).toEqual({
      path: hookRelayConfigPath(relayRoot, 'grok-build', 'SessionStart'),
      healthy: false,
      actualMode: null,
      issues: ['missing'],
    });
    expect(existsSync(relayRoot)).toBe(false);
  });

  it('reports stale and malformed relay contracts', () => {
    const options = {
      relayRoot,
      adapterId: 'codex-cli' as const,
      event: 'SessionStart',
      port: 47_821,
      token: 'e'.repeat(64),
      route: '/hook/codex/sessionstart',
    };
    const path = prepareHookRelayConfig(options);
    const canonical = readFileSync(path, 'utf8');

    expect(
      inspectHookRelayConfig({ ...options, port: 47_822 }).issues,
    ).toEqual(['content-mismatch']);

    for (const staleContent of [
      canonical.replace('max-time = 2', 'max-time = 20'),
      canonical.replace('request = "POST"', 'request = "GET"'),
      canonical.replace(
        'url = "http://127.0.0.1:47821/hook/codex/sessionstart"',
        'url = "http://localhost:47821/hook/codex/sessionstart"',
      ),
      canonical.replace(
        `header = "Authorization: Bearer ${options.token}"`,
        `header = "Authorization: Bearer ${'0'.repeat(64)}"`,
      ),
      `${canonical}url = "http://127.0.0.1:1/extra"\n`,
    ]) {
      writeFileSync(path, staleContent, 'utf8');
      expect(inspectHookRelayConfig(options).issues).toEqual([
        'content-mismatch',
      ]);
    }

    writeFileSync(path, 'url = not-a-valid-current-contract\n', 'utf8');
    chmodSync(path, 0o600);
    expect(inspectHookRelayConfig(options).issues).toEqual([
      'content-mismatch',
    ]);
  });

  it('reports wrong mode, symlink, and non-regular relay paths', () => {
    const options = {
      relayRoot,
      adapterId: 'claude-code' as const,
      event: 'SessionStart',
      port: 47_821,
      token: 'f'.repeat(64),
      route: '/hook/claude/sessionstart',
    };
    const path = prepareHookRelayConfig(options);

    chmodSync(path, 0o640);
    expect(inspectHookRelayConfig(options)).toMatchObject({
      healthy: false,
      actualMode: 0o640,
      issues: ['wrong-mode'],
    });

    rmSync(path);
    symlinkSync(join(root, 'missing-relay-target'), path);
    expect(inspectHookRelayConfig(options)).toMatchObject({
      healthy: false,
      issues: ['symbolic-link'],
    });

    rmSync(path);
    mkdirSync(path);
    expect(inspectHookRelayConfig(options)).toMatchObject({
      healthy: false,
      issues: ['not-regular-file'],
    });
  });
});
