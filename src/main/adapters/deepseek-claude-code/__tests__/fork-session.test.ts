import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertDeepseekForkTranscriptRootCompatible } from '../index';

describe('Deepseek native fork transcript-root preflight', () => {
  let root: string;
  let settingsPath: string;
  let mainClaudeRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-deck-deepseek-fork-'));
    settingsPath = join(root, 'deepseek', 'settings.json');
    mainClaudeRoot = join(root, 'main-claude');
    mkdirSync(mainClaudeRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts the inherited main-process root without creating Deepseek settings', () => {
    assertDeepseekForkTranscriptRootCompatible(settingsPath, {
      CLAUDE_CONFIG_DIR: mainClaudeRoot,
    });

    expect(existsSync(settingsPath)).toBe(false);
  });

  it('accepts a different spelling of the same physical transcript root', () => {
    const alias = join(root, 'claude-alias');
    symlinkSync(mainClaudeRoot, alias);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ env: { CLAUDE_CONFIG_DIR: alias } }),
      'utf8',
    );

    expect(() =>
      assertDeepseekForkTranscriptRootCompatible(settingsPath, {
        CLAUDE_CONFIG_DIR: mainClaudeRoot,
      }),
    ).not.toThrow();
  });

  it('rejects a custom root mismatch without mutating process-wide environment', () => {
    const customRoot = join(root, 'custom-deepseek');
    mkdirSync(customRoot, { recursive: true });
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ env: { CLAUDE_CONFIG_DIR: customRoot } }),
      'utf8',
    );
    const before = process.env.CLAUDE_CONFIG_DIR;

    expect(() =>
      assertDeepseekForkTranscriptRootCompatible(settingsPath, {
        CLAUDE_CONFIG_DIR: mainClaudeRoot,
      }),
    ).toThrow(/differs from the main-process Claude transcript root.*contextMode "fresh"/);

    expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);
  });
});
