import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./bundled-assets', () => ({
  __metaBuilders: {
    buildAgentMeta: (
      name: string,
      absPath: string,
      frontmatter: Record<string, string>,
      source: 'user',
      adapter: 'claude-code' | 'codex-cli',
    ) => ({
      kind: 'agent' as const,
      source,
      adapter,
      name,
      qualifiedName: name,
      description: frontmatter.description ?? '',
      absPath,
    }),
    buildSkillMeta: (
      name: string,
      absPath: string,
      frontmatter: Record<string, string>,
      source: 'user',
      adapter: 'claude-code' | 'codex-cli',
    ) => ({
      kind: 'skill' as const,
      source,
      adapter,
      name,
      qualifiedName: name,
      description: frontmatter.description ?? '',
      absPath,
    }),
  },
}));

import { getUserAssetPath } from './user-assets';

describe('read-only user asset path resolution', () => {
  let root: string;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-deck-user-assets-'));
    process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  });

  afterEach(() => {
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts native names and requires an exact path hint when one is supplied', () => {
    const name = 'Plugin.Agent_Name';
    const assetPath = join(process.env.CLAUDE_CONFIG_DIR!, 'agents', `${name}.md`);
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, 'agents'), { recursive: true });
    writeFileSync(assetPath, `---\nname: ${name}\ndescription: direct\n---\nBody`, 'utf8');

    expect(getUserAssetPath('agent', name, 'claude-code')).toBe(assetPath);
    expect(getUserAssetPath('agent', name, 'claude-code', join(root, 'missing.md'))).toBeNull();
  });
});
