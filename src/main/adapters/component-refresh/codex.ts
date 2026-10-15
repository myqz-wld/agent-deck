import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { SNAPSHOT_MANIFEST } from '@main/runtime-assets/snapshot-store';
import type { ComponentRefreshResult } from '@shared/session-component-refresh';
import type { CodexAppServerClient } from '../codex-cli/app-server/client';
import type { InternalSession } from '../codex-cli/sdk-bridge/types';
import type { ApplyRefresh } from './gate';

export interface CodexRefreshTarget { roots: string[]; commit(roots: string[]): void }
interface SkillsCatalog { data: Array<{ cwd: string; skills: Array<{ path: string; enabled: boolean }>; errors: unknown[] }> }
interface McpCatalog { data: Array<{ tools: Record<string, unknown>; toolsError?: string | null; runtimeStatus?: string | null }>; nextCursor?: string | null }
const under = (path: string, root: string): boolean => resolve(path).startsWith(`${resolve(root)}${sep}`);

export function applyCodexComponentRefresh(
  session: InternalSession, client: CodexAppServerClient, target: CodexRefreshTarget, generation: number,
): ApplyRefresh {
  return async assertCurrent => {
    const results: ComponentRefreshResult[] = [
      { component: 'mcp', outcome: 'new-session-required', detail: '注入的 MCP 配置只在新会话替换；原生 Tool Search 设置保持不变。' },
      { component: 'plugins', outcome: 'new-session-required', detail: '保留当前插件与 Agent 的原生启动解析规则。' },
      { component: 'instructions', outcome: 'new-session-required', detail: '应用指令在会话启动时固定。' },
    ];
    const previous = [...client.skillExtraRoots];
    const changed = JSON.stringify(previous) !== JSON.stringify(target.roots);
    let skillCount: number | undefined;
    let toolCount: number | undefined;
    let catalogCharacters: number | undefined;
    const request = async <T>(method: string, params: unknown): Promise<T> => {
      assertCurrent(); const response = await client.requestLive<T>(method, params, generation); assertCurrent(); return response;
    };
    try {
      if (changed) {
        await request('skills/extraRoots/set', { extraRoots: target.roots });
        // Native set acknowledged. Keep that state on a subsequent catalog failure; no fake rollback.
        client.recordSkillExtraRoots(target.roots); target.commit(target.roots);
      }
      const catalog = await request<SkillsCatalog>('skills/list', { cwds: [session.cwd], forceReload: true });
      const entry = catalog.data?.find(row => resolve(row.cwd) === resolve(session.cwd));
      if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors) || entry.errors.length) {
        throw new Error('Skill catalog is incomplete');
      }
      const paths = new Set(entry.skills.map(skill => resolve(skill.path)));
      for (const root of target.roots) {
        const manifest = JSON.parse(readFileSync(join(root, SNAPSHOT_MANIFEST), 'utf8')) as { entries: Array<{ path: string }> };
        for (const file of manifest.entries.filter(file => /^[^/]+\/SKILL\.md$/.test(file.path))) {
          if (!paths.has(resolve(root, file.path))) throw new Error('Prepared skill missing from effective inventory');
        }
      }
      const removed = previous.filter(root => !target.roots.includes(root));
      if ([...paths].some(path => removed.some(root => under(path, root)))) throw new Error('Old skill root remains loaded');
      skillCount = entry.skills.length;
      results.push({ component: 'skills', outcome: changed ? 'updated' : 'unchanged', detail: '原生 Skills 目录已重读，所选路径与有效清单一致。' });
    } catch (error) {
      results.push({ component: 'skills', outcome: /method not found|unknown method|not supported/i.test(String(error)) ? 'new-session-required' : 'failed',
        detail: '未获得完整的原生加载确认；已确认的原生设置保留，旧版本仍可读。' });
    }
    assertCurrent();
    try {
      if (!session.threadId) throw new Error('Missing live thread');
      const catalog = await request<McpCatalog>('mcpServerStatus/list', {
        threadId: session.threadId, serverName: 'agent-deck', detail: 'toolsAndAuthOnly', limit: 100,
      });
      if (Array.isArray(catalog.data) && !catalog.nextCursor && catalog.data.every(server => !server.toolsError && server.tools)) {
        toolCount = catalog.data.reduce((sum, server) => sum + Object.keys(server.tools).length, 0);
        catalogCharacters = JSON.stringify(catalog.data.map(server => server.tools)).length;
      }
    } catch { /* Discovery failure is unknown evidence, never a claim of successful activation. */ }
    return { results, discovery: { provider: 'codex-cli', toolSearch: 'native-default-preserved', observedActivation: 'unknown',
      source: toolCount === undefined ? 'unavailable' : 'native-session',
      ...(skillCount === undefined ? {} : { skillCount }), ...(toolCount === undefined ? {} : { toolCount, catalogCharacters }) } };
  };
}
