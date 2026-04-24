import type { AgentEvent } from '@shared/types';

/**
 * 消息气泡渲染模式。CHANGELOG_34 把 MD/TXT 切换从「全局共享」改成「每条独立」之后，
 * localStorage 里那个 `agent-deck:message-render-mode` 键再也没人写了
 * （永远只能读到 'plaintext' 默认值），CHANGELOG_35 顺手把整个 render-mode.ts
 * 文件删了，类型 inline 到这里。
 * 默认 plaintext —— 用户主动点 MD/TXT 按钮才切到当前 bubble 的本地 state。
 */
export type RenderMode = 'plaintext' | 'markdown';
export const DEFAULT_RENDER_MODE: RenderMode = 'plaintext';

/**
 * 气泡头部显示的对方短名。adapter.displayName 是长名（'Claude Code' / 'Codex CLI'）
 * 用在 NewSessionDialog 选 adapter 那种地方；message bubble 头部需要更短的人称，
 * 与 SessionDetail.tsx 的 placeholder 文案口径对齐。
 */
export function getAgentShortName(agentId: string): string {
  switch (agentId) {
    case 'codex-cli':
      return 'Codex';
    case 'aider':
      return 'Aider';
    case 'generic-pty':
      return 'Shell';
    default:
      return 'Claude';
  }
}

/** 容器订阅 recentEventsBySession 的稳定空数组兜底，避免每次 new [] 触发选择器假阳性更新。 */
export const EMPTY_EVENTS: AgentEvent[] = [];
