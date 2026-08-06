import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  defaultDesktopClaudeGatewayPaths,
  desktopClaudeGatewayProfileHost,
} from './gateway-profiles-host';

describe('desktop Claude Gateway profile host', () => {
  it('owns the home-relative default and concrete filesystem probes', () => {
    expect(defaultDesktopClaudeGatewayPaths()).toEqual({
      gatewaysDir: join(homedir(), '.claude', 'gateways'),
    });

    const directory = mkdtempSync(join(tmpdir(), 'agent-deck-gateway-host-'));
    const settingsPath = join(directory, 'deepseek.json');
    writeFileSync(settingsPath, '{"env":{}}');
    mkdirSync(join(directory, 'not-a-file.json'));

    const entries = desktopClaudeGatewayProfileHost.listDirectory(directory);
    expect(entries).toEqual(expect.arrayContaining([
      { name: 'deepseek.json', isFile: true, isSymbolicLink: false },
      { name: 'not-a-file.json', isFile: false, isSymbolicLink: false },
    ]));
    expect(desktopClaudeGatewayProfileHost.pathExists(settingsPath)).toBe(true);
    expect(desktopClaudeGatewayProfileHost.isFile(settingsPath)).toBe(true);
    expect(desktopClaudeGatewayProfileHost.readText(settingsPath)).toBe(
      '{"env":{}}',
    );
    expect(
      desktopClaudeGatewayProfileHost.joinPath(directory, 'deepseek.json'),
    ).toBe(settingsPath);
  });
});
