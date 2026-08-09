import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  projectProviderHomeAuthFiles,
  syncProviderHomeAuthFiles,
} from './provider-home-projection';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provider-home-projection-')));
  roots.push(root);
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  return { destination, source };
}

function authFile(home: string, relative: string, content: string): string {
  const path = join(home, relative);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

describe('provider home auth projection', () => {
  it('atomically refreshes allowlisted auth and removes an absent credential', () => {
    const { destination, source } = fixture();
    const codexSource = authFile(source, '.codex/auth.json', '{"token":"one"}\n');
    authFile(destination, '.grok/auth.json', '{"scope":{"key":"retired"}}\n');

    expect(syncProviderHomeAuthFiles(source, destination)).toEqual(['.codex/auth.json']);
    expect(readFileSync(join(destination, '.codex/auth.json'), 'utf8'))
      .toBe('{"token":"one"}\n');
    expect(() => readFileSync(join(destination, '.grok/auth.json'))).toThrow();

    writeFileSync(codexSource, '{"token":"two"}\n', { mode: 0o600 });
    syncProviderHomeAuthFiles(source, destination);
    expect(readFileSync(join(destination, '.codex/auth.json'), 'utf8'))
      .toBe('{"token":"two"}\n');
    syncProviderHomeAuthFiles(null, destination);
    expect(() => readFileSync(join(destination, '.codex/auth.json'))).toThrow();
  });

  it('does not copy settings, hooks, MCP configuration, or arbitrary files', () => {
    const { destination, source } = fixture();
    authFile(source, '.claude/.credentials.json', '{}\n');
    authFile(source, '.claude/settings.json', '{"hooks":{}}\n');
    authFile(source, '.codex/config.toml', '[mcp_servers.escape]\ncommand="sh"\n');
    authFile(source, '.grok/auth.json', '{"scope":{"key":"private"}}\n');
    authFile(source, '.grok/config.toml', '[plugins]\nenabled=true\n');
    authFile(source, '.ssh/id_ed25519', 'never\n');

    expect(projectProviderHomeAuthFiles(source, destination)).toEqual([
      '.claude/.credentials.json',
    ]);
    for (const relative of [
      '.claude/settings.json',
      '.codex/config.toml',
      '.grok/auth.json',
      '.grok/config.toml',
      '.ssh/id_ed25519',
    ]) expect(() => readFileSync(join(destination, relative))).toThrow();
  });

  it('rejects group/world-readable credentials and non-private homes', () => {
    const first = fixture();
    const credential = authFile(first.source, '.codex/auth.json', '{}\n');
    chmodSync(credential, 0o644);
    expect(() => projectProviderHomeAuthFiles(first.source, first.destination))
      .toThrow('source file trust');

    const second = fixture();
    chmodSync(second.destination, 0o755);
    expect(() => syncProviderHomeAuthFiles(second.source, second.destination))
      .toThrow('private and user-owned');
  });
});
