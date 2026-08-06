import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { encodeClaudeProjectDir } from '@main/platform';
import { desktopClaudeJsonlDiscoveryHost } from './jsonl-discovery-host';

describe('desktopClaudeJsonlDiscoveryHost', () => {
  it('builds the Claude transcript path and exposes filesystem probes', () => {
    const cwd = '/private/repository';
    expect(desktopClaudeJsonlDiscoveryHost.transcriptPath(cwd, 'session-a')).toBe(join(
      homedir(),
      '.claude',
      'projects',
      encodeClaudeProjectDir(cwd),
      'session-a.jsonl',
    ));
    expect(desktopClaudeJsonlDiscoveryHost.pathExists(__filename)).toBe(true);
    expect(desktopClaudeJsonlDiscoveryHost.pathMtimeMs(__filename)).toBe(
      statSync(__filename).mtimeMs,
    );
  });
});
