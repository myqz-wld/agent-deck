import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSafeName,
  readBundledAssetContent,
  resolveBundledAssetPath,
  scanBundledAssets,
  type BundledAssetSource,
} from './bundled-asset-store';

const filesystem = { existsSync, readFileSync, readdirSync, statSync };

describe('bundled asset store', () => {
  let fixtureRoot: string;
  let sources: BundledAssetSource[];

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-deck-bundled-assets-'));
    sources = [
      { adapter: 'grok-build', root: join(fixtureRoot, 'grok') },
      { adapter: 'codex-cli', root: join(fixtureRoot, 'codex') },
      { adapter: 'claude-code', root: join(fixtureRoot, 'claude') },
    ];
    for (const { root } of sources) {
      mkdirSync(join(root, 'agents'), { recursive: true });
      mkdirSync(join(root, 'skills', 'shared-skill'), { recursive: true });
      writeFileSync(
        join(root, 'skills', 'shared-skill', 'SKILL.md'),
        '---\nname: shared-skill\ndescription: Shared skill\n---\n',
        'utf8',
      );
    }
    writeFileSync(
      join(fixtureRoot, 'claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Claude reviewer\nmodel: sonnet\neffort: high\ngateway: deepseek\n---\n',
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, 'codex', 'agents', 'reviewer.toml'),
      [
        'name = "reviewer"',
        'description = "Codex reviewer"',
        'model = "gpt-5.6-sol"',
        'model_reasoning_effort = "xhigh"',
        'model_provider = "openai"',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, 'grok', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Grok reviewer\nmodel: grok-code-fast\n---\n',
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('scans every adapter root with stable adapter-qualified ordering', () => {
    const snapshot = scanBundledAssets(sources, filesystem);

    expect(snapshot.agents.map((asset) => asset.qualifiedName)).toEqual([
      'agent-deck:claude-code:reviewer',
      'agent-deck:codex-cli:reviewer',
      'agent-deck:grok-build:reviewer',
    ]);
    expect(snapshot.agents[0]).toMatchObject({
      description: 'Claude reviewer',
      model: 'sonnet',
      thinking: 'high',
      provider: 'deepseek',
    });
    expect(snapshot.agents[1]).toMatchObject({
      description: 'Codex reviewer',
      model: 'gpt-5.6-sol',
      thinking: 'xhigh',
      provider: 'openai',
    });
    expect(snapshot.skills.map((asset) => asset.adapter)).toEqual([
      'claude-code',
      'codex-cli',
      'grok-build',
    ]);
  });

  it('reports a malformed Codex agent without dropping other roots', () => {
    writeFileSync(
      join(fixtureRoot, 'codex', 'agents', 'wrong.toml'),
      'name = "different"\ndescription = "mismatch"\n',
      'utf8',
    );
    const warn = vi.fn();

    const snapshot = scanBundledAssets(sources, filesystem, warn);

    expect(snapshot.agents).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith({
      adapter: 'codex-cli',
      entry: 'wrong.toml',
      kind: 'agent',
      reason: 'bundled Codex Agent name must match filename: different != wrong',
    });
  });

  it('resolves and reads only the exact adapter-native asset path', () => {
    const codexRoot = join(fixtureRoot, 'codex');
    const expectedPath = join(codexRoot, 'agents', 'reviewer.toml');

    expect(
      resolveBundledAssetPath(codexRoot, 'agent', 'reviewer', 'codex-cli', filesystem),
    ).toBe(expectedPath);
    expect(
      readBundledAssetContent(codexRoot, 'agent', 'reviewer', 'codex-cli', filesystem),
    ).toEqual({ ok: true, content: readFileSync(expectedPath, 'utf8') });
    expect(
      readBundledAssetContent(codexRoot, 'agent', 'missing', 'codex-cli', filesystem),
    ).toEqual({ ok: false, reason: 'not found: codex-cli/agent/missing' });
  });

  it('rejects traversal, hidden, uppercase, and overlong bundled names', () => {
    expect(isSafeName('agent-1')).toBe(true);
    for (const name of ['../agent', '.hidden', 'Uppercase', 'a'.repeat(65)]) {
      expect(isSafeName(name)).toBe(false);
    }
  });
});
