/** Shared user-facing labels for session lists and detail panels. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts)) return '';
  const elapsed = Math.max(0, now - ts);
  if (elapsed < 5_000) return '刚刚';
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)} 秒前`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return `${Math.floor(elapsed / 86_400_000)} 天前`;
}

export function lifecycleLabel(lifecycle: string | null | undefined): string {
  switch (lifecycle) {
    case 'active':
      return '进行中';
    case 'dormant':
      return '已休眠';
    case 'closed':
      return '已结束';
    default:
      return lifecycle ?? '?';
  }
}

export function agentIdLabel(agentId: string | null | undefined): string {
  switch (agentId) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex-cli':
      return 'Codex CLI';
    case 'grok-build':
      return 'Grok Build';
    default:
      return agentId ?? '未知';
  }
}
