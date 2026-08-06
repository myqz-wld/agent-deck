export const REDACTED_VALUE = '[REDACTED]';

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated:${value.length - maxLength}]`;
}

function redactInlineSecrets(value: string): string {
  let redacted = value;
  redacted = redacted.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    `$1 ${REDACTED_VALUE}`,
  );
  redacted = redacted.replace(
    /\b(auth|authentication|authorization|proxy-authorization|credential|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|client[_-]?secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED_VALUE}`,
  );
  redacted = redacted.replace(
    /\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi,
    REDACTED_VALUE,
  );
  return redacted;
}

function redactLocalPaths(value: string): string {
  return value
    .replace(
      /(?:file:\/\/)?\/(?:Users|home)\/[^/\s"'`),;}\]]+(?:\/[^\s"'`),;}\]]*)?/g,
      '<home-path>',
    )
    .replace(
      /[A-Za-z]:\\Users\\[^\\\s"'`),;}\]]+(?:\\[^\s"'`),;}\]]*)?/g,
      '<home-path>',
    )
    .replace(
      /(?:file:\/\/)?\/(?:private\/tmp|tmp|var\/tmp|private\/var\/folders|var\/folders)(?:\/[^\s"'`),;}\]]*)?/g,
      '<temp-path>',
    )
    .replace(
      /(?:file:\/\/)?\/(?:workspace|workspaces|repo|Volumes)(?:\/[^\s"'`),;}\]]*)?/g,
      '<local-path>',
    )
    .replace(
      /[A-Za-z]:\\(?!Users\\)[^\\\s"'`),;}\]]+(?:\\[^\s"'`),;}\]]*)?/g,
      '<local-path>',
    );
}

export function safeDiagnosticString(value: string, maxLength: number): string {
  return truncate(redactLocalPaths(redactInlineSecrets(value)), maxLength);
}

export function safeDisplayText(value: string): string {
  return safeDiagnosticString(value, 3_072);
}
