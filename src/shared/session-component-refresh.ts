export type ComponentRefreshPhase = 'idle' | 'queued' | 'applying' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type ComponentRefreshOutcome = 'updated' | 'unchanged' | 'new-session-required' | 'cache-deferred' | 'failed';
export interface ComponentRefreshResult {
  component: 'mcp' | 'skills' | 'plugins' | 'instructions';
  outcome: ComponentRefreshOutcome;
  detail: string;
}
export interface ComponentDiscoveryEvidence {
  provider: 'claude-code' | 'codex-cli' | 'grok-build';
  toolSearch: 'native-default-preserved';
  observedActivation: 'unknown';
  toolCount?: number;
  catalogCharacters?: number;
  skillCount?: number;
  source: 'native-session' | 'startup-only' | 'unavailable';
  // Measurements are absent until the provider actually supplies them; never infer savings.
  inputTokens?: number;
  cacheTokens?: number;
  firstToolLatencyMs?: number;
}
export interface SessionComponentRefreshStatus {
  phase: ComponentRefreshPhase;
  revision: number;
  results: ComponentRefreshResult[];
  detail?: string;
  discovery?: ComponentDiscoveryEvidence;
}
export type SessionComponentAction = 'refresh' | 'cancel';

export function componentRefreshText(status: SessionComponentRefreshStatus): string {
  const phases: Record<ComponentRefreshPhase, string> = {
    idle: '当前没有排队中的扩展刷新。',
    queued: '扩展刷新已排队，将在当前任务、后台任务、工具和审批结束后应用。',
    applying: '正在刷新当前会话扩展，后续消息将按原顺序等待。刷新开始后不能撤销。',
    cancelled: '已撤销排队中的扩展刷新，任务和普通消息队列继续运行。',
    completed: '当前会话扩展检查完成。',
    partial: '当前会话扩展检查完成，部分组件需要后续操作。',
    failed: '当前会话扩展刷新失败。',
  };
  const labels = { mcp: 'MCP', skills: 'Skills', plugins: '插件 / Agents', instructions: '应用指令' };
  const outcomes: Record<ComponentRefreshOutcome, string> = {
    updated: '已更新', unchanged: '未变化', 'new-session-required': '新会话生效',
    'cache-deferred': '因缓存影响暂缓', failed: '失败',
  };
  return [phases[status.phase], status.detail,
    ...status.results.map(r => `${labels[r.component]}：${outcomes[r.outcome]}。${r.detail}`),
    ...(status.discovery?.toolCount === undefined ? [] : [`原生有效清单：Agent Deck MCP ${status.discovery.toolCount} 个工具。`]),
    ...(status.discovery?.skillCount === undefined ? [] : [`原生有效清单：共 ${status.discovery.skillCount} 个 Skills。`]),
    ...(status.discovery?.catalogCharacters === undefined ? [] : [`MCP 工具目录 ${status.discovery.catalogCharacters} 字符；不代表实际输入 token。`]),
    ...(status.discovery ? ['Tool Search：保留原生默认值和用户设置；当前会话是否启用及净 token 节省尚未测得。'] : []),
  ].filter(Boolean).join('\n');
}
