export interface ToolStatusView {
  label: string;
  detail: string | null;
  isError: boolean;
}

export function toolStatusView(payload: Record<string, unknown>): ToolStatusView {
  const raw = typeof payload.status === 'string' ? payload.status : '';
  const normalized = raw.replaceAll('_', '').toLowerCase();
  const failedByExitCode =
    typeof payload.exitCode === 'number' && payload.exitCode !== 0;
  const hasError = payload.error != null || failedByExitCode;

  switch (normalized) {
    case '':
    case 'completed':
    case 'success':
    case 'succeeded':
      return hasError
        ? { label: '失败', detail: '失败', isError: true }
        : { label: '完成', detail: null, isError: false };
    case 'failed':
      return { label: '失败', detail: '失败', isError: true };
    case 'denied':
    case 'rejected':
      return { label: '已拒绝', detail: '已拒绝', isError: true };
    case 'cancelled':
    case 'canceled':
      return { label: '已取消', detail: '已取消', isError: false };
    case 'interrupted':
      return { label: '已中断', detail: '已中断', isError: true };
    case 'blocked':
      return { label: '已阻止', detail: '已阻止', isError: true };
    case 'error':
      return { label: '出错', detail: '出错', isError: true };
    case 'inprogress':
    case 'running':
      return { label: '执行中', detail: '执行中', isError: false };
    default:
      return hasError
        ? { label: '失败', detail: '失败', isError: true }
        : { label: '状态未知', detail: '状态未知', isError: false };
  }
}

export function formatToolDuration(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = value / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

export function providerTruncationLabel(payload: Record<string, unknown>): string | null {
  const input = payload.toolInputTruncated === true;
  const result = payload.toolResultTruncated === true;
  if (input && result) return '输入和结果已截断';
  if (input) return '输入已截断';
  if (result) return '结果已截断';
  return null;
}
