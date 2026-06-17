export interface ClaudeCompactMessageInput {
  trigger?: unknown;
  preTokens?: unknown;
  postTokens?: unknown;
  durationMs?: unknown;
  summary?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function triggerLabel(value: unknown): string | null {
  if (value === 'auto') return '自动';
  if (value === 'manual') return '手动';
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

export function buildClaudeCompactMessageText(input: ClaudeCompactMessageInput): string {
  const details: string[] = [];
  const trigger = triggerLabel(input.trigger);
  const preTokens = finiteNumber(input.preTokens);
  const postTokens = finiteNumber(input.postTokens);
  const durationMs = finiteNumber(input.durationMs);
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';

  if (trigger) details.push(`触发：${trigger}`);
  if (preTokens !== null && postTokens !== null) {
    details.push(`Token：${formatNumber(preTokens)} → ${formatNumber(postTokens)}`);
  } else if (preTokens !== null) {
    details.push(`压缩前 token：${formatNumber(preTokens)}`);
  } else if (postTokens !== null) {
    details.push(`压缩后 token：${formatNumber(postTokens)}`);
  }
  if (durationMs !== null) details.push(`耗时：${formatNumber(durationMs)}ms`);

  return ['🧭 上下文已压缩', details.join('\n'), summary].filter(Boolean).join('\n\n');
}
