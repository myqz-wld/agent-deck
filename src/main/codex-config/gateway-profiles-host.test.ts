import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultDesktopCodexGatewayPaths,
  desktopCodexGatewayProfileHost,
} from './gateway-profiles-host';

const roots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe('desktop Codex Gateway profile host', () => {
  it('uses CODEX_HOME and owns concrete filesystem probes', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-codex-gateway-host-'));
    roots.push(root);
    process.env.CODEX_HOME = root;
    expect(defaultDesktopCodexGatewayPaths()).toEqual({
      gatewaysDir: join(root, 'gateways'),
    });

    const directory = join(root, 'gateways');
    mkdirSync(directory);
    const profilePath = join(directory, 'team.toml');
    writeFileSync(profilePath, 'model_context_window = 1000000\n');
    expect(desktopCodexGatewayProfileHost.pathExists(profilePath)).toBe(true);
    expect(desktopCodexGatewayProfileHost.isFile(profilePath)).toBe(true);
    expect(desktopCodexGatewayProfileHost.readText(profilePath)).toContain('1000000');
    expect(desktopCodexGatewayProfileHost.listDirectory(directory)).toEqual([
      { name: 'team.toml', isFile: true, isSymbolicLink: false },
    ]);
    expect(desktopCodexGatewayProfileHost.joinPath(directory, 'team.toml')).toBe(profilePath);
  });
});
