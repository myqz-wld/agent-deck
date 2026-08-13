import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanServerCoreUserAssets } from '@hosts/server-core/node-asset-user-scan';
import { LOCAL_WORKER_DESKTOP_STATE_PATH } from '@hosts/provider-state/local-worker-desktop-state';
import {
  projectLocalWorkerProviderHome,
  syncLocalWorkerProviderHome,
} from './provider-home-projection';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-provider-home-')));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  return { destination, root, source };
}

describe('Local Worker provider home projection', () => {
  it('projects only Worker-relevant desktop settings and bundled Agent overrides', () => {
    const { destination, source } = fixture();
    const userData = join(source, 'Library', 'Application Support', 'Agent Deck');
    mkdirSync(userData, { recursive: true, mode: 0o700 });
    chmodSync(userData, 0o700);
    writeFileSync(join(userData, 'agent-deck-settings.json'), JSON.stringify({
      activeWindowMs: 120_000,
      closeAfterMs: 3_600_000,
      historyRetentionDays: 14,
      claudeCodeSandbox: 'strict',
      injectAgentDeckCodexAgents: false,
      mcpServerToken: 'must-not-leave-the-desktop',
      bundledAgentRuntimeOverrides: {
        'claude-code:reviewer-claude': {
          model: 'deepseek-v4-flash[1m]', thinking: 'max', provider: 'deepseek',
        },
      },
    }), { mode: 0o666 });

    expect(projectLocalWorkerProviderHome(source, destination)).toContain(
      LOCAL_WORKER_DESKTOP_STATE_PATH,
    );
    const projected = JSON.parse(readFileSync(
      join(destination, LOCAL_WORKER_DESKTOP_STATE_PATH),
      'utf8',
    )) as Record<string, unknown>;
    expect(projected).toMatchObject({
      schemaVersion: 1,
      providerSettings: {
        claudeCodeSandbox: 'strict',
        injectAgentDeckCodexAgents: false,
        bundledAgentRuntimeOverrides: {
          'claude-code:reviewer-claude': {
            model: 'deepseek-v4-flash[1m]', thinking: 'max', provider: 'deepseek',
          },
        },
      },
      sessionLifecycle: {
        schemaVersion: 1,
        activeWindowMs: 120_000,
        closeAfterMs: 3_600_000,
        historyRetentionDays: 14,
      },
    });
    expect(JSON.stringify(projected)).not.toContain('must-not-leave-the-desktop');
    expect(projected).not.toHaveProperty('mcpServerToken');
  });

  it('copies auth plus sanitized provider runtime inputs into private provider roots', () => {
    const { destination, source } = fixture();
    mkdirSync(join(source, '.codex'), { mode: 0o700 });
    mkdirSync(join(source, '.ssh'), { mode: 0o700 });
    writeFileSync(join(source, '.codex', 'auth.json'), '{"token":"test"}\n', { mode: 0o600 });
    writeFileSync(join(source, '.codex', 'config.toml'), 'model = "test"\n', { mode: 0o600 });
    writeFileSync(join(source, '.codex', 'AGENTS.md'), 'host-only instructions\n', { mode: 0o600 });
    writeFileSync(join(source, '.ssh', 'id_ed25519'), 'never-copy\n', { mode: 0o600 });

    expect(projectLocalWorkerProviderHome(source, destination)).toEqual([
      '.codex/auth.json',
      '.codex/config.toml',
      '.agent-deck/session-create-catalog.json',
    ]);
    expect(readFileSync(join(destination, '.codex', 'auth.json'), 'utf8'))
      .toBe('{"token":"test"}\n');
    expect(() => readFileSync(join(destination, '.codex', 'AGENTS.md'))).toThrow();
    expect(readFileSync(join(destination, '.codex', 'config.toml'), 'utf8'))
      .toBe('model = "test"\n');
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
    writeFileSync(join(source, '.grok', 'auth.json'), '{"token":"never"}\n', {
      mode: 0o600,
    });
    writeFileSync(join(source, '.grok', 'config.toml'), '[plugins]\nenabled=true\n', {
      mode: 0o600,
    });

    expect(projectLocalWorkerProviderHome(source, destination)).toEqual([
      '.claude/.credentials.json',
      '.agent-deck/session-create-catalog.json',
    ]);
    expect(() => readFileSync(join(destination, '.claude', 'settings.json'))).toThrow();
    expect(() => readFileSync(join(destination, '.codex', 'config.toml'))).toThrow();
    expect(() => readFileSync(join(destination, '.grok', 'auth.json'))).toThrow();
    expect(() => readFileSync(join(destination, '.grok', 'config.toml'))).toThrow();
  });

  it('projects Local direct and Plugin Agents/Skills into the Worker catalog', () => {
    const { destination, source } = fixture();
    const files: Array<readonly [string, string]> = [
      ['.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: Review\n---\n'],
      ['.claude/skills/planning/SKILL.md', '---\nname: planning\ndescription: Plan\n---\n'],
      ['.claude/skills/planning/scripts/check.sh', '#!/bin/sh\nexit 0\n'],
      ['.claude/plugins/demo/.claude-plugin/plugin.json', '{"name":"demo"}\n'],
      ['.claude/plugins/demo/skills/audit/SKILL.md', '---\nname: audit\ndescription: Audit\n---\n'],
      ['.codex/agents/builder.toml', 'name = "builder"\ndescription = "Build"\n'],
      ['.codex/plugins/demo/.codex-plugin/plugin.json', '{"name":"codex-demo"}\n'],
      ['.codex/plugins/demo/skills/ship/SKILL.md', '---\nname: ship\ndescription: Ship\n---\n'],
      ['.grok/skills/explore/SKILL.md', '---\nname: explore\ndescription: Explore\n---\n'],
    ];
    for (const [path, content] of files) {
      mkdirSync(join(source, path, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(join(source, path), content, { mode: 0o600 });
    }

    const projected = projectLocalWorkerProviderHome(source, destination);
    expect(projected).toContain('.claude/agents/reviewer.md');
    expect(projected).toContain('.claude/skills/planning/SKILL.md');
    expect(projected).toContain('.claude/skills/planning/scripts/check.sh');
    expect(projected).toContain(
      '.claude/plugins/agent-deck-worker-sync/demo/skills/audit/SKILL.md',
    );
    expect(projected).toContain(
      '.codex/plugins/agent-deck-worker-sync/codex-demo/skills/ship/SKILL.md',
    );
    const snapshot = scanServerCoreUserAssets(destination, {
      maxAssets: 50,
      maxVisitedEntries: 1_000,
    });
    expect(snapshot.assets.map((asset) => [
      asset.adapter,
      asset.kind,
      asset.qualifiedName,
    ])).toEqual(expect.arrayContaining([
      ['claude-code', 'agent', 'reviewer'],
      ['claude-code', 'skill', 'planning'],
      ['claude-code', 'skill', 'plugin:demo/audit'],
      ['codex-cli', 'agent', 'builder'],
      ['codex-cli', 'skill', 'plugin:codex-demo/ship'],
      ['grok-build', 'skill', 'explore'],
    ]));
  });

  it('removes stale synchronized assets when the Worker restarts', () => {
    const { destination, source } = fixture();
    const alpha = join(source, '.claude', 'skills', 'alpha', 'SKILL.md');
    mkdirSync(join(alpha, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(alpha, '---\nname: alpha\n---\n', { mode: 0o600 });
    projectLocalWorkerProviderHome(source, destination);

    unlinkSync(alpha);
    const beta = join(source, '.claude', 'skills', 'beta', 'SKILL.md');
    mkdirSync(join(beta, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(beta, '---\nname: beta\n---\n', { mode: 0o600 });
    syncLocalWorkerProviderHome(source, destination);

    expect(() => readFileSync(join(destination, '.claude', 'skills', 'alpha', 'SKILL.md')))
      .toThrow();
    expect(readFileSync(join(destination, '.claude', 'skills', 'beta', 'SKILL.md'), 'utf8'))
      .toContain('name: beta');
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
