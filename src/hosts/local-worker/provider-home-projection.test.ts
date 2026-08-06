import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { projectLocalWorkerProviderHome } from './provider-home-projection';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-provider-home-')));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  return { destination, root, source };
}

describe('Local Worker provider home projection', () => {
  it('copies only allowlisted files into private provider roots', () => {
    const { destination, source } = fixture();
    mkdirSync(join(source, '.codex'), { mode: 0o700 });
    mkdirSync(join(source, '.ssh'), { mode: 0o700 });
    writeFileSync(join(source, '.codex', 'auth.json'), '{"token":"test"}\n', { mode: 0o600 });
    writeFileSync(join(source, '.codex', 'config.toml'), 'model = "test"\n', { mode: 0o600 });
    writeFileSync(join(source, '.codex', 'AGENTS.md'), 'host-only instructions\n', { mode: 0o600 });
    writeFileSync(join(source, '.ssh', 'id_ed25519'), 'never-copy\n', { mode: 0o600 });

    expect(projectLocalWorkerProviderHome(source, destination)).toEqual(['.codex/auth.json']);
    expect(readFileSync(join(destination, '.codex', 'auth.json'), 'utf8'))
      .toBe('{"token":"test"}\n');
    expect(() => readFileSync(join(destination, '.codex', 'AGENTS.md'))).toThrow();
    expect(() => readFileSync(join(destination, '.codex', 'config.toml'))).toThrow();
    expect(() => readFileSync(join(destination, '.ssh', 'id_ed25519'))).toThrow();
  });

  it('does not project provider settings, hooks, MCP definitions, or global instructions', () => {
    const { destination, source } = fixture();
    for (const name of ['.claude', '.codex', '.grok']) {
      mkdirSync(join(source, name), { mode: 0o700 });
    }
    writeFileSync(join(source, '.claude', '.credentials.json'), '{}\n', { mode: 0o600 });
    writeFileSync(join(source, '.claude', 'settings.json'), '{"hooks":{"PreToolUse":[]}}\n', {
      mode: 0o600,
    });
    writeFileSync(join(source, '.codex', 'config.toml'), '[mcp_servers.escape]\ncommand="cat"\n', {
      mode: 0o600,
    });
    writeFileSync(join(source, '.grok', 'config.toml'), '[plugins]\nenabled=true\n', {
      mode: 0o600,
    });

    expect(projectLocalWorkerProviderHome(source, destination)).toEqual([
      '.claude/.credentials.json',
    ]);
    expect(() => readFileSync(join(destination, '.claude', 'settings.json'))).toThrow();
    expect(() => readFileSync(join(destination, '.codex', 'config.toml'))).toThrow();
    expect(() => readFileSync(join(destination, '.grok', 'config.toml'))).toThrow();
  });

  it('rejects a symlinked or writable source instead of widening the projection', () => {
    const { destination, root, source } = fixture();
    mkdirSync(join(source, '.codex'), { mode: 0o700 });
    const outside = join(root, 'outside-auth.json');
    writeFileSync(outside, '{}\n', { mode: 0o600 });
    symlinkSync(outside, join(source, '.codex', 'auth.json'));
    expect(() => projectLocalWorkerProviderHome(source, destination)).toThrow(
      'provider source file is not canonical',
    );

    const second = fixture();
    mkdirSync(join(second.source, '.codex'), { mode: 0o700 });
    const writable = join(second.source, '.codex', 'auth.json');
    writeFileSync(writable, '{}\n', { mode: 0o600 });
    chmodSync(writable, 0o622);
    expect(() => projectLocalWorkerProviderHome(second.source, second.destination)).toThrow(
      'provider source file trust check failed',
    );
  });
});
