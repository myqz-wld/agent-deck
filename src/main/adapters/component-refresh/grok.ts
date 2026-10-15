import type { McpServer } from '@agentclientprotocol/sdk';
import type { ComponentRefreshResult } from '@shared/session-component-refresh';
import type { GrokRuntime } from '../grok-build/runtime-types';
import type { ApplyRefresh } from './gate';

interface McpInventory {
  sessionMcpResolved?: boolean;
  servers: Array<{ name: string; session?: { enabled: boolean; status?: string; tools?: Array<{ name: string }> } }>;
}
interface ExtensionResult<T> { result?: T | null; error?: unknown }

/** Source-verified ACP extensions. Each request still verifies support and effective session state. */
export function applyGrokComponentRefresh(runtime: GrokRuntime, servers: McpServer[]): ApplyRefresh {
  const process = runtime.process;
  const nativeSessionId = runtime.nativeSessionId;
  const previous = runtime.componentMcp;
  return async assertCurrent => {
    const results: ComponentRefreshResult[] = [
      { component: 'skills', outcome: 'new-session-required', detail: '原生 Skills 刷新会向进程内所有会话广播，返回值不确认目标会话已加载，当前不调用。' },
      { component: 'plugins', outcome: 'new-session-required', detail: '原生插件重载会重建共享插件缓存并广播到其他原生会话，超出当前会话刷新边界。' },
      { component: 'instructions', outcome: 'new-session-required', detail: '恢复原生会话会保留其已有应用指令。' },
    ];
    let toolCount: number | undefined;
    if (!process || !nativeSessionId || !previous?.allowed) {
      results.unshift({ component: 'mcp', outcome: 'new-session-required', detail: '当前宿主未允许会话级 MCP 注入；不使用其他主机回退。' });
    } else {
      const request = async <T>(method: string, params: object): Promise<T> => {
        assertCurrent();
        if (runtime.process !== process || runtime.nativeSessionId !== nativeSessionId || process.isStopping) {
          throw new Error('Grok runtime changed');
        }
        const response = await process.connection.agent.request<ExtensionResult<T>, object>(method, params,
          { cancellationSignal: AbortSignal.timeout(15_000) });
        assertCurrent();
        if (response.error || !response.result) throw new Error('Grok extension did not confirm completion');
        return response.result;
      };
      try {
        const changed = JSON.stringify(previous.servers) !== JSON.stringify(servers);
        if (changed) {
          const response = await request<{ ok: boolean }>('_x.ai/session/update_mcp_servers', { sessionId: nativeSessionId, mcpServers: servers });
          if (response.ok !== true) throw new Error('MCP mutation unacknowledged');
          previous.servers = servers;
        }
        const observed = await request<McpInventory>('_x.ai/mcp/list', { sessionId: nativeSessionId, cache: true });
        const app = observed.servers?.find(server => server.name === 'agent-deck');
        const enabled = servers.some(server => server.name === 'agent-deck');
        if (observed.sessionMcpResolved !== true || (enabled
          ? app?.session?.enabled !== true || app.session.status !== 'ready' || !app.session.tools?.length
          : app?.session?.enabled === true)) throw new Error('MCP inventory unverified');
        toolCount = app?.session?.tools?.length ?? 0;
        results.unshift({ component: 'mcp', outcome: changed ? 'updated' : 'unchanged',
          detail: '已核对原生目标会话的 MCP 加载状态和工具目录；未修改用户或项目配置。' });
      } catch (error) {
        results.unshift({ component: 'mcp', outcome: /method not found|unknown method|not supported/i.test(String(error)) ? 'new-session-required' : 'failed',
          detail: '未取得目标会话的完整 MCP 加载确认；不把磁盘检查或连通性当作刷新成功。' });
      }
    }
    return { results, discovery: { provider: 'grok-build', toolSearch: 'native-default-preserved', observedActivation: 'unknown',
      source: toolCount === undefined ? 'unavailable' : 'native-session', ...(toolCount === undefined ? {} : { toolCount }) } };
  };
}

/** Read only while an explicit refresh is queued; never poll a model turn or a tool catalog. */
export async function grokNativeConsumersIdle(runtime: GrokRuntime, signal: AbortSignal): Promise<boolean> {
  if (!runtime.componentMcp?.allowed) return true;
  const process = runtime.process; const sessionId = runtime.nativeSessionId;
  if (!process || !sessionId || process.isStopping) throw new Error('Native session unavailable');
  const request = <T>(method: string) => process.connection.agent.request<ExtensionResult<T>, { sessionId: string }>(
    method, { sessionId }, { cancellationSignal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  const [tasks, children] = await Promise.all([
    request<{ tasks: Array<{ completed: boolean }> }>('_x.ai/task/list'),
    request<{ subagents: unknown[] }>('_x.ai/subagent/list_running'),
  ]);
  if (signal.aborted || runtime.process !== process || runtime.nativeSessionId !== sessionId || tasks.error || children.error
    || !Array.isArray(tasks.result?.tasks) || !Array.isArray(children.result?.subagents)) throw new Error('Native idle state unverified');
  return tasks.result.tasks.every(task => task.completed === true) && children.result.subagents.length === 0;
}
