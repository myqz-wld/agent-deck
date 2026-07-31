import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildHookRoutes } from '../hook-routes';
import { HookInstaller } from '../hook-installer';
import { translatePostCompact } from '../translate';

describe('Claude PostCompact hook support', () => {
  it('translates PostCompact payload into a first-class lifecycle event with summary', () => {
    const event = translatePostCompact({
      session_id: 'sid-post-compact',
      cwd: '/tmp/project',
      trigger: 'manual',
      compact_summary: 'Kept the current bug, files, and validation plan.',
    });

    expect(event.kind).toBe('context-compaction-end');
    expect(event.payload).toMatchObject({
      cwd: '/tmp/project',
      trigger: 'manual',
      summary: 'Kept the current bug, files, and validation plan.',
    });
    const text = (event.payload as { text: string }).text;
    expect(text).toContain('上下文已压缩');
    expect(text).toContain('触发：手动');
    expect(text).toContain('Kept the current bug, files, and validation plan.');
  });

  it('registers a /hook/postcompact route', () => {
    const routes = buildHookRoutes(vi.fn());
    expect(routes.map((route) => route.url)).toContain('/hook/postcompact');
  });

  it('installs the PostCompact command into project Claude settings', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-postcompact-'));
    try {
      const relayRoot = join(cwd, 'user-data', 'hook-relay');
      const status = new HookInstaller(
        47_821,
        'a'.repeat(64),
        relayRoot,
      ).install({ scope: 'project', cwd });
      expect(status.installedHooks).toContain('PostCompact');

      const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')) as {
        hooks?: Record<string, { hooks: { command: string }[] }[]>;
      };
      const postCompact = settings.hooks?.PostCompact;
      expect(postCompact).toBeDefined();
      expect(postCompact?.[0]?.hooks[0]?.command).toContain(
        `--config '${join(relayRoot, 'claude-code-postcompact.curlrc')}'`,
      );
      expect(postCompact?.[0]?.hooks[0]?.command).toContain('GROK_HOOK_EVENT');
      expect(postCompact?.[0]?.hooks[0]?.command).toContain(
        '# agent-deck-hook-v2-claude-code-postcompact',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
