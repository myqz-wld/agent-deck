import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyClaudeComponentRefresh, type ClaudeRefreshTarget } from './claude';
import { applyCodexComponentRefresh } from './codex';
import { applyGrokComponentRefresh, grokNativeConsumersIdle } from './grok';
import { publishAssetSnapshot } from '@main/runtime-assets/snapshot-store';
import { sessionAssetSelections } from '@main/runtime-assets/session-selection';
import { sessionPluginView } from '@main/runtime-assets/plugin-view';
import type { InternalSession as ClaudeSession } from '../claude-code/sdk-bridge/types';
import type { InternalSession as CodexSession } from '../codex-cli/sdk-bridge/types';
import type { GrokRuntime } from '../grok-build/runtime-types';
import type { CodexAppServerClient } from '../codex-cli/app-server/client';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'refresh-fixture-')); dirs.push(root);
  const source = join(root, 'source'); const destination = join(root, 'plugin');
  fs.mkdirSync(source); fs.writeFileSync(join(source, 'SKILL.md'), 'old');
  const publish = () => publishAssetSnapshot({ source, destination, identity: {} }, fs).path;
  const old = publish(); sessionAssetSelections(destination).select('session', () => [old]);
  const [view] = sessionPluginView(destination, 'session', [old]);
  fs.writeFileSync(join(source, 'SKILL.md'), 'new'); const next = publish();
  return { source, destination, old, next, view: view! };
}
function claude(f: ReturnType<typeof fixture>) {
  const query = {
    mcpServerStatus: vi.fn(async () => []), setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
    reloadPlugins: vi.fn(async () => ({ held: false, plugins: [{ path: f.view }], error_count: 0 })),
    reloadSkills: vi.fn(async () => ({ skills: [] })),
  };
  const session = { applicationSid: 'session', query, componentSelection: { instructions: '', dynamicMcp: {} } } as unknown as ClaudeSession;
  const target: ClaudeRefreshTarget = { instructions: '', plugin: { destination: f.destination, snapshot: f.next, enabled: true },
    mcpEnabled: false, createMcp: vi.fn(async () => null) };
  return { query, session, target };
}

describe('native component refresh evidence', () => {
  it('does not downgrade confirmed Claude plugin loading when the separate Skills reload fails', async () => {
    const f = fixture(); const { query, session, target } = claude(f);
    query.reloadSkills.mockRejectedValue(new Error('Skills unavailable'));
    const response = await applyClaudeComponentRefresh(session, target)(() => {});
    expect(response.results.find(r => r.component === 'plugins')?.outcome).toBe('updated');
    expect(response.results.find(r => r.component === 'skills')?.outcome).toBe('failed');
    expect(sessionAssetSelections(f.destination).get('session')).toEqual([f.next]);
  });
  it('holds plugin cache changes without touching the selected version or Skills', async () => {
    const f = fixture(); const { query, session, target } = claude(f);
    query.reloadPlugins.mockResolvedValue({ held: true, plugins: [{ path: f.view }], error_count: 0 });
    const response = await applyClaudeComponentRefresh(session, target)(() => {});
    expect(query.reloadPlugins).toHaveBeenCalledWith({ holdOnCacheImpact: true });
    expect(query.reloadSkills).not.toHaveBeenCalled();
    expect(response.results.filter(r => r.outcome === 'cache-deferred')).toHaveLength(2);
    expect(fs.readFileSync(join(f.view, 'SKILL.md'), 'utf8')).toBe('old');
    expect(sessionAssetSelections(f.destination).get('session')).toEqual([f.old]);
  });
  it('confirms native plugin loading and retains the previous immutable snapshot', async () => {
    const f = fixture(); const { session, target } = claude(f);
    const response = await applyClaudeComponentRefresh(session, target)(() => {});
    expect(response.results.filter(r => r.outcome === 'updated')).toHaveLength(2);
    expect(sessionAssetSelections(f.destination).get('session')).toEqual([f.next]);
    expect(fs.readFileSync(join(f.old, 'SKILL.md'), 'utf8')).toBe('old');
    expect(response.discovery?.observedActivation).toBe('unknown');
  });
  it('does not acquire a missing startup plugin root or replace unowned dynamic MCP', async () => {
    const f = fixture(); const { query, session, target } = claude(f);
    session.applicationSid = 'without-root'; target.mcpEnabled = true;
    query.mcpServerStatus.mockResolvedValue([{ name: 'other', source: 'dynamic', status: 'connected' }] as never);
    const response = await applyClaudeComponentRefresh(session, target)(() => {});
    expect(query.setMcpServers).not.toHaveBeenCalled(); expect(query.reloadPlugins).not.toHaveBeenCalled();
    expect(response.results.filter(r => r.outcome === 'new-session-required')).toHaveLength(3);
  });
  it('clears Codex roots with an empty native payload and verifies removed inventory', async () => {
    const recordSkillExtraRoots = vi.fn(); const commit = vi.fn();
    const requestLive = vi.fn(async method => method === 'skills/list'
      ? { data: [{ cwd: '/workspace', skills: [], errors: [] }] } : { data: [], nextCursor: null });
    const client = { skillExtraRoots: ['/old/skills'], recordSkillExtraRoots, requestLive } as unknown as CodexAppServerClient;
    const response = await applyCodexComponentRefresh({ cwd: '/workspace', threadId: 'thread' } as CodexSession,
      client, { roots: [], commit }, 7)(() => {});
    expect(requestLive).toHaveBeenCalledWith('skills/extraRoots/set', { extraRoots: [] }, 7);
    expect(requestLive).toHaveBeenCalledWith('mcpServerStatus/list', expect.objectContaining({ threadId: 'thread' }), 7);
    expect(recordSkillExtraRoots).toHaveBeenCalledWith([]); expect(commit).toHaveBeenCalledWith([]);
    expect(response.results.find(r => r.component === 'skills')?.outcome).toBe('updated');
    expect(requestLive.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  });
  it('reports partial native mutation instead of claiming rollback when skill verification fails', async () => {
    const commit = vi.fn(); const requestLive = vi.fn(async method => {
      if (method === 'skills/list') throw new Error('catalog unavailable'); return { data: [] };
    });
    const client = { skillExtraRoots: ['/old'], recordSkillExtraRoots: vi.fn(), requestLive } as unknown as CodexAppServerClient;
    const response = await applyCodexComponentRefresh({ cwd: '/workspace', threadId: 'thread' } as CodexSession,
      client, { roots: [], commit }, 1)(() => {});
    expect(commit).toHaveBeenCalledWith([]);
    expect(response.results.find(r => r.component === 'skills')?.outcome).toBe('failed');
  });
  it('uses the Grok session-scoped MCP extension and verifies the actual inventory', async () => {
    const request = vi.fn(async method => ({ result: method === '_x.ai/mcp/list'
      ? { sessionMcpResolved: true, servers: [{ name: 'agent-deck', session: { enabled: true, status: 'ready', tools: [{ name: 'tool' }] } }] }
      : { ok: true } }));
    const runtime = { nativeSessionId: 'native', componentMcp: { allowed: true, servers: [] },
      process: { connection: { agent: { request } }, isStopping: false } } as unknown as GrokRuntime;
    const servers = [{ type: 'http' as const, name: 'agent-deck', url: 'http://fixture/mcp', headers: [] }];
    const response = await applyGrokComponentRefresh(runtime, servers)(() => {});
    expect(request).toHaveBeenCalledWith('_x.ai/session/update_mcp_servers', { sessionId: 'native', mcpServers: servers }, expect.any(Object));
    expect(response.results.find(r => r.component === 'mcp')?.outcome).toBe('updated');
    expect(response.results.filter(r => r.component !== 'mcp').every(r => r.outcome === 'new-session-required')).toBe(true);
    expect(request.mock.calls.some(([method]) => method === 'session/prompt')).toBe(false);
  });
  it('does not treat a Grok agent-level catalog as proof of session loading', async () => {
    const request = vi.fn(async () => ({ result: { servers: [] } }));
    const runtime = { nativeSessionId: 'native', componentMcp: { allowed: true, servers: [] },
      process: { connection: { agent: { request } } } } as unknown as GrokRuntime;
    const response = await applyGrokComponentRefresh(runtime, [])(() => {});
    expect(response.results.find(r => r.component === 'mcp')?.outcome).toBe('failed');
  });
  it('falls back truthfully when the installed Grok runtime lacks the source-verified extension', async () => {
    const request = vi.fn(async () => { throw new Error('Method not found'); });
    const runtime = { nativeSessionId: 'native', componentMcp: { allowed: true, servers: [] },
      process: { connection: { agent: { request } } } } as unknown as GrokRuntime;
    const servers = [{ type: 'http' as const, name: 'agent-deck', url: 'http://fixture/mcp', headers: [] }];
    const response = await applyGrokComponentRefresh(runtime, servers)(() => {});
    expect(response.results.find(r => r.component === 'mcp')?.outcome).toBe('new-session-required');
    expect(runtime.componentMcp?.servers).toEqual([]);
    expect(request).toHaveBeenCalledOnce();
  });
  it('requires both Grok background tasks and native child agents to finish', async () => {
    let tasks = [{ completed: false }]; let children: object[] = [];
    const request = vi.fn(async method => ({ result: method === '_x.ai/task/list' ? { tasks } : { subagents: children } }));
    const runtime = { nativeSessionId: 'native', componentMcp: { allowed: true, servers: [] },
      process: { connection: { agent: { request } } } } as unknown as GrokRuntime;
    const signal = new AbortController().signal;
    expect(await grokNativeConsumersIdle(runtime, signal)).toBe(false);
    tasks = [{ completed: true }]; children = [{}];
    expect(await grokNativeConsumersIdle(runtime, signal)).toBe(false);
    children = []; expect(await grokNativeConsumersIdle(runtime, signal)).toBe(true);
    expect(request.mock.calls.every(([method]) => ['_x.ai/task/list', '_x.ai/subagent/list_running'].includes(method))).toBe(true);
  });
});
