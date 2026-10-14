export function formatStatusTokens(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m`
    : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toLocaleString('en-US');
}

export function formatStatusDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return '不到1秒';
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分`;
}
