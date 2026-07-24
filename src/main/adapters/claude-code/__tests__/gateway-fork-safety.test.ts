import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertClaudeGatewayForkTranscriptRootCompatible } from '../gateway-fork-safety';
import type { ClaudeGatewayPaths } from '../gateway-profiles';

describe('Claude Gateway native fork transcript-root preflight', () => {
  let root: string;
  let paths: ClaudeGatewayPaths;
  let mainClaudeRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-deck-gateway-fork-'));
    paths = {
      gatewaysDir: join(root, '.claude', 'gateways'),
      legacyDeepseekSettingsPath: join(root, 'legacy', 'deepseek.json'),
    };
    mainClaudeRoot = join(root, 'main-claude');
    mkdirSync(mainClaudeRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts native Claude without creating a Gateway settings file', () => {
    assertClaudeGatewayForkTranscriptRootCompatible(undefined, paths, {
      CLAUDE_CONFIG_DIR: mainClaudeRoot,
    });

    expect(existsSync(paths.gatewaysDir)).toBe(false);
  });

  it('accepts a Gateway using a different spelling of the same physical root', () => {
    const alias = join(root, 'claude-alias');
    symlinkSync(mainClaudeRoot, alias);
    mkdirSync(paths.gatewaysDir, { recursive: true });
    writeFileSync(
      join(paths.gatewaysDir, 'deepseek.json'),
      JSON.stringify({ env: { CLAUDE_CONFIG_DIR: alias } }),
      'utf8',
    );

    expect(() =>
      assertClaudeGatewayForkTranscriptRootCompatible('deepseek', paths, {
        CLAUDE_CONFIG_DIR: mainClaudeRoot,
      }),
    ).not.toThrow();
  });

  it('rejects a Gateway root mismatch without mutating process-wide environment', () => {
    const customRoot = join(root, 'custom-gateway');
    mkdirSync(customRoot, { recursive: true });
    mkdirSync(paths.gatewaysDir, { recursive: true });
    writeFileSync(
      join(paths.gatewaysDir, 'deepseek.json'),
      JSON.stringify({ env: { CLAUDE_CONFIG_DIR: customRoot } }),
      'utf8',
    );
    const before = process.env.CLAUDE_CONFIG_DIR;

    expect(() =>
      assertClaudeGatewayForkTranscriptRootCompatible('deepseek', paths, {
        CLAUDE_CONFIG_DIR: mainClaudeRoot,
      }),
    ).toThrow(
      /Gateway profile "deepseek".*differs from the main-process Claude transcript root.*contextMode "fresh"/,
    );

    expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);
  });
});
