import { createHmac } from 'node:crypto';
import { getProcessRunId } from './run-context';

/** Creates a content-free identifier that is stable only within the current application run. */
export function runScopedCorrelationId(namespace: string, value: string): string {
  try {
    const label = namespace.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 24) || 'runtime';
    const digest = createHmac('sha256', getProcessRunId())
      .update(label)
      .update('\0')
      .update(value)
      .digest('hex')
      .slice(0, 12);
    return `${label}-${digest}`;
  } catch {
    return 'runtime-unavailable';
  }
}
