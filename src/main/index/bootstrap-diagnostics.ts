import { createHash } from 'node:crypto';
import { toSafeErrorDetails } from '@main/utils/safe-diagnostic';

export type MainBootstrapStage =
  | 'electron-ready'
  | 'infrastructure'
  | 'wiring'
  | 'complete';

export interface MainBootstrapErrorDiagnostic {
  name: string;
  message: string;
  fingerprint: string;
  code?: string;
}

/** Retains an actionable error class/message while removing paths, secrets, URLs, and stack data. */
export function mainBootstrapErrorDiagnostic(error: unknown): MainBootstrapErrorDiagnostic {
  const details = toSafeErrorDetails(error);
  const code = safeErrorCode(error);
  const message = redactBootstrapMessage(details.message);
  const fingerprint = createHash('sha256')
    .update(details.name)
    .update('\0')
    .update(code ?? '')
    .update('\0')
    .update(message)
    .digest('hex')
    .slice(0, 12);
  return {
    name: details.name,
    message,
    fingerprint,
    ...(code ? { code } : {}),
  };
}

function safeErrorCode(error: unknown): string | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  try {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      return Number.isSafeInteger(code) ? String(code) : undefined;
    }
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,79}$/.test(code)) {
      return undefined;
    }
    return code;
  } catch {
    return undefined;
  }
}

function redactBootstrapMessage(value: string): string {
  return value
    .replace(
      /\btoken\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      (_match, separator: string) => `token${separator}[REDACTED]`,
    )
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '<url>');
}
