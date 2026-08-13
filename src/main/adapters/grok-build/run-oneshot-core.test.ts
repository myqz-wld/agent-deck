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
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveExplicitGrokOneshotBinary,
  runGrokOneshotWithHost,
} from './run-oneshot-core';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runGrokOneshotWithHost', () => {
  it('uses the injected environment and temporary root without desktop variables', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-grok-core-test-'));
    roots.push(root);
    const temporaryRoot = join(root, 'server-temp');
    const capturePath = join(root, 'capture.json');
    const binary = join(root, 'fake-grok');
    mkdirSync(temporaryRoot);
    writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const promptIndex = process.argv.indexOf('--prompt-file');
if (promptIndex < 0) process.exit(0);
fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  cwd: process.cwd(),
  home: process.env.HOME,
  desktopOnly: process.env.DESKTOP_ONLY ?? null,
}));
process.stdout.write(JSON.stringify({
  structuredOutput: { ok: true },
  usage: { inputTokens: 4, outputTokens: 2, contextWindowTokens: 131072 },
}));
`, { mode: 0o700 });
    chmodSync(binary, 0o700);
    const previousDesktopOnly = process.env.DESKTOP_ONLY;
    process.env.DESKTOP_ONLY = 'must-not-leak';
    try {
      const result = await runGrokOneshotWithHost({
        prompt: 'checkpoint input',
        systemPrompt: 'checkpoint system',
        binaryPath: binary,
        timeoutMs: 5_000,
        timeoutErrorMessage: 'timed out',
      }, {
        environment: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: '/server-provider-home',
          CAPTURE_PATH: capturePath,
        },
        temporaryRoot,
        resolveBinary: resolveExplicitGrokOneshotBinary,
      });

      const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as {
        cwd: string;
        home: string;
        desktopOnly: string | null;
      };
      expect(relative(realpathSync(temporaryRoot), capture.cwd)).not.toMatch(/^\.\./u);
      expect(capture.home).toBe('/server-provider-home');
      expect(capture.desktopOnly).toBeNull();
      expect(result).toMatchObject({
        text: '{"ok":true}',
        inputTokens: 4,
        outputTokens: 2,
        contextWindowTokens: 131_072,
      });
    } finally {
      if (previousDesktopOnly === undefined) delete process.env.DESKTOP_ONLY;
      else process.env.DESKTOP_ONLY = previousDesktopOnly;
    }
  });
});
