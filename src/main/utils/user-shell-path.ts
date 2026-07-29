import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import log from '@main/utils/logger';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import { getProcessRunId } from '@main/utils/run-context';

type CaptureFailureState = 'missing-marker' | 'capture-failed';

function createUserShellLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('utils-user-shell');
  } catch {
    return null;
  }
}

const logger = createUserShellLogger();

function warnCaptureFailure(state: CaptureFailureState): void {
  try {
    logger?.warn(
      'user shell path capture unavailable',
      safeDiagnostic({
        event: 'user-shell-path',
        runId: getProcessRunId(),
        state,
        fallback: 'process-env',
      }),
    );
  } catch {
    // Diagnostics cannot alter the cached process-environment fallback.
  }
}

/**
 * A per-module random marker isolates the requested PATH from login-shell startup and shutdown
 * output. The same marker brackets both sides so parsing needs no assumptions about line order.
 */
export const NONCE_MARKER = `__AD_PATH_${randomUUID()}__`;

let captured = false;
let cached: string | null = null;

/**
 * Capture the login-shell PATH once per process. The captured flag is set before execution so
 * every failure is memoized and later callers use the process environment without another exec.
 *
 * execFileSync keeps the shell executable separate from argv. The `-ilc` contract intentionally
 * targets compatible zsh/bash/sh/dash/ksh shells; unsupported shells use the null fallback.
 */
export function captureUserShellPath(): string | null {
  if (captured) return cached;
  captured = true;

  const shell = process.env.SHELL || '/bin/zsh';

  try {
    const out = execFileSync(
      shell,
      ['-ilc', `printf "${NONCE_MARKER}%s${NONCE_MARKER}\\n" "$PATH"`],
      {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const lines = out.split('\n');
    let pathValue: string | null = null;
    for (const line of lines) {
      const beginIdx = line.indexOf(NONCE_MARKER);
      if (beginIdx === -1) continue;
      const start = beginIdx + NONCE_MARKER.length;
      const endIdx = line.indexOf(NONCE_MARKER, start);
      if (endIdx === -1) continue;
      pathValue = line.slice(start, endIdx);
      break;
    }

    cached = pathValue;
    if (cached === null) warnCaptureFailure('missing-marker');
    return cached;
  } catch {
    cached = null;
    warnCaptureFailure('capture-failed');
    return null;
  }
}

/** Deduplicate PATH segments while preserving their first occurrence and empty-segment behavior. */
export function dedupePath(path: string | undefined): string {
  if (!path) return '';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of path.split(':')) {
    if (!seen.has(seg)) {
      seen.add(seg);
      out.push(seg);
    }
  }
  return out.join(':');
}

/**
 * Prefer the captured user PATH, retain the original process PATH as a fallback tail, and preserve
 * the original value unchanged when capture is unavailable.
 */
export function unionUserShellPath(originalPath: string | undefined): string {
  const userPath = captureUserShellPath();
  if (!userPath) return originalPath ?? '';
  if (!originalPath) return userPath;
  return dedupePath(`${userPath}:${originalPath}`);
}
