import type { McpServerConfig, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { ComponentRefreshResult } from '@shared/session-component-refresh';
import { stagePluginView } from '@main/runtime-assets/plugin-view';
import { sessionAssetSelections } from '@main/runtime-assets/session-selection';
import type { InternalSession } from '../claude-code/sdk-bridge/types';
import type { ApplyRefresh } from './gate';

export interface ClaudeRefreshTarget {
  instructions: string;
  plugin: { destination: string; snapshot: string | null; enabled: boolean };
  mcpEnabled: boolean;
  createMcp(): Promise<McpSdkServerConfigWithInstance | null>;
}
export interface ClaudeComponentSelection {
  instructions: string;
  dynamicMcp: Record<string, McpServerConfig>;
}
const result = (component: ComponentRefreshResult['component'], outcome: ComponentRefreshResult['outcome'], detail: string): ComponentRefreshResult => ({ component, outcome, detail });
const unsupported = (error: unknown): boolean => /not supported|unknown (method|request)|method not found|unrecognized/i.test(String(error));

export function applyClaudeComponentRefresh(session: InternalSession, target: ClaudeRefreshTarget): ApplyRefresh {
  return async assertCurrent => {
    const query = session.query;
    const selected = session.componentSelection;
    const results: ComponentRefreshResult[] = [];
    results.push(result('instructions', selected?.instructions === target.instructions ? 'unchanged' : 'new-session-required',
      '应用指令在会话启动时固定。'));
    let toolCount: number | undefined;
    try {
      assertCurrent();
      const before = await query.mcpServerStatus(); assertCurrent();
      const known = selected?.dynamicMcp ?? {};
      const unknown = before.some(server => !known[server.name]
        && (server.source === 'sdk' || server.source === 'dynamic' || !server.source));
      const owned = before.find(server => server.name === 'agent-deck' && (server.source === 'sdk' || !!known[server.name]));
      if (unknown || (!selected)) {
        results.push(result('mcp', 'new-session-required', '动态 MCP 的完整归属无法确认，保留现状。'));
      } else if (target.mcpEnabled === !!known['agent-deck'] && (!target.mcpEnabled || owned?.status === 'connected')) {
        results.push(result('mcp', 'unchanged', '原生会话状态已确认。'));
      } else {
        if (target.mcpEnabled && known['agent-deck']) {
          await query.reconnectMcpServer('agent-deck');
        } else {
          const next = { ...known };
          if (target.mcpEnabled) {
            const server = await target.createMcp(); assertCurrent();
            if (!server) throw new Error('MCP server unavailable');
            next['agent-deck'] = server;
          } else delete next['agent-deck'];
          const changed = await query.setMcpServers(next); assertCurrent();
          if (Object.keys(changed.errors).length) throw new Error('MCP connection failed');
          selected.dynamicMcp = next;
        }
        assertCurrent();
        const observed = await query.mcpServerStatus(); assertCurrent();
        const app = observed.find(server => server.name === 'agent-deck' && server.source === 'sdk');
        if (target.mcpEnabled ? app?.status !== 'connected' : app && app.status !== 'disabled') {
          throw new Error('MCP effective state unverified');
        }
        results.push(result('mcp', 'updated', '原生会话已确认 MCP 状态。'));
      }
      const observed = await query.mcpServerStatus(); assertCurrent();
      const app = observed.find(server => server.name === 'agent-deck');
      toolCount = app ? app.tools?.length : 0;
    } catch (error) {
      results.push(result('mcp', unsupported(error) ? 'new-session-required' : 'failed',
        '原生 MCP 状态未能确认；保留已知配置，不宣称整体回滚。'));
    }
    assertCurrent();
    const { destination, snapshot, enabled } = target.plugin;
    const selections = sessionAssetSelections(destination);
    if (!selections.getView(session.applicationSid)) {
      const outcome = enabled ? 'new-session-required' : 'unchanged';
      results.push(result('plugins', outcome, '会话启动时未加载可刷新的应用插件入口。'),
        result('skills', outcome, '没有已加载的应用插件入口可供重读。'));
    } else if (!snapshot) {
      results.push(result('plugins', 'failed', '候选插件未能准备，继续保留旧版本。'),
        result('skills', 'failed', '候选 Skills 未能准备。'));
    } else if (typeof query.reloadPlugins !== 'function') {
      results.push(result('plugins', 'new-session-required', '当前运行时不支持原生插件重载。'),
        result('skills', 'new-session-required', '当前运行时不支持原生插件重载。'));
    } else {
      const view = stagePluginView(destination, session.applicationSid, snapshot)!;
      let invoked = false;
      try {
        assertCurrent(); invoked = true;
        const response = await query.reloadPlugins({ holdOnCacheImpact: true }); assertCurrent();
        if (response.held === true) {
          view.restore();
          results.push(result('plugins', 'cache-deferred', '原生重载报告缓存影响，已恢复旧插件视图。'),
            result('skills', 'cache-deferred', '跟随插件重载暂缓，旧版本继续可读。'));
        } else {
          view.commit();
          const verified = response.error_count === 0 && response.plugins.some(plugin => plugin.path === view.path);
          results.push(result('plugins', verified ? (view.changed ? 'updated' : 'unchanged') : 'failed',
            verified ? '已原生重扫已加载的用户、项目和内置插件。' : '原生重载结果不完整，已保留前后版本；有效状态需重新确认。'));
          if (verified && typeof query.reloadSkills === 'function') {
            try {
              const skills = await query.reloadSkills(); assertCurrent();
              results.push(result('skills', Array.isArray(skills.skills) ? (view.changed ? 'updated' : 'unchanged') : 'failed',
                '已请求原生重读并核对 Skills 目录响应。'));
            } catch (error) {
              assertCurrent();
              results.push(result('skills', unsupported(error) ? 'new-session-required' : 'failed',
                '插件重载已确认，但 Skills 独立重读未确认。'));
            }
          } else results.push(result('skills', 'new-session-required', '未获得独立的 Skills 重读确认。'));
        }
      } catch (error) {
        assertCurrent();
        // Once native code ran, reverting files cannot prove provider rollback. Retain both versions.
        if (!invoked || unsupported(error)) view.restore(); else view.commit();
        results.push(result('plugins', unsupported(error) ? 'new-session-required' : 'failed', '原生插件重载未确认；前后版本均保留。'),
          result('skills', unsupported(error) ? 'new-session-required' : 'failed', 'Skills 有效状态未确认。'));
      }
    }
    return { results: [...new Map(results.map(item => [item.component, item])).values()], discovery: { provider: 'claude-code', toolSearch: 'native-default-preserved',
      observedActivation: 'unknown', source: toolCount === undefined ? 'unavailable' : 'native-session',
      ...(toolCount === undefined ? {} : { toolCount }) } };
  };
}
