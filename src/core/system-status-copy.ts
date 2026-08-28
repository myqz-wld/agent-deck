/** Shared copy rules for compact system-status rows in the session timeline. */

const LEADING_STATUS_DECORATION = /^(?:⚠️?|🧭)\s*/u;
const TRAILING_SENTENCE_PUNCTUATION = /[。.!！]+$/u;

export function normalizeSystemStatusDetail(value: string): string {
  return value
    .trim()
    .replace(LEADING_STATUS_DECORATION, '')
    .trim()
    .replace(TRAILING_SENTENCE_PUNCTUATION, '')
    .trim();
}

export function completedSessionCommandText(
  subject: string,
  command: string,
  detail?: string,
): string {
  const suffix = detail ? normalizeSystemStatusDetail(detail) : '';
  return `${subject} /${command.replace(/^\/+/, '')} 已完成${suffix ? `，${suffix}` : ''}`;
}

export function failedSessionCommandText(
  subject: string,
  command: string,
  detail: string,
): string {
  return `${subject} /${command.replace(/^\/+/, '')} 失败：${normalizeSystemStatusDetail(detail)}`;
}
