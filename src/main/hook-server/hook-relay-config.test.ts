import {
  chmodSync,
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
});
