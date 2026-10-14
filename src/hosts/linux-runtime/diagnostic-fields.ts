import { createHmac, randomUUID } from 'node:crypto';

const runId = randomUUID();
const metricKeys = new Set([
  'durationMs', 'maxDurationMs', 'appQueueMs', 'sdkAcceptanceMs', 'elapsedMs', 'timeoutMs',
  'timerLagMs', 'lastReceiveAgeMs', 'lastHeartbeatAgeMs', 'heartbeatTimeoutMs', 'writeDelayMs',
  'queuedBytes', 'pendingBytes', 'queuedFrames', 'activeStreams', 'streamCount', 'clientCount',
  'workerCount', 'generation', 'workerGeneration', 'attempt', 'retryCount', 'processed',
  'revision', 'count', 'size', 'suppressedCount', 'droppedCount', 'maxQueuedBytes',
]);
const booleanKeys = new Set(['midTurn', 'online', 'writeCompleted', 'blocked', 'resumed', 'retryable']);
const identityKeys: Record<string, string> = {
  sessionId: 'sessionRef', applicationSid: 'sessionRef', messageId: 'messageRef',
  connectionId: 'connectionRef', clientId: 'clientRef', workerId: 'workerRef',
  streamId: 'streamRef', profileId: 'profileRef', instanceId: 'instanceRef',
};
const refKeys = new Set(Object.values(identityKeys));
const enumKeys = new Set(['reason', 'code', 'phase', 'state', 'outcome', 'acceptanceFrame', 'adapterId', 'direction']);
const enumValues = new Set([
  'heartbeat_timeout', 'worker_disconnected', 'worker_fenced', 'backpressure', 'protocol_error',
  'resync_required', 'relay_restart', 'disconnect', 'replaced', 'closed', 'running', 'stopped',
  'start', 'stop', 'cleanup', 'failed', 'success', 'error', 'timeout', 'retired', 'recovered',
  'user', 'assistant', 'stream_event', 'result', 'claude-code', 'codex-cli', 'grok-build',
  'client-to-worker', 'worker-to-client', 'transport-write-failed', 'outbound-write-stalled',
  'active-to-dormant', 'dormant-to-closed', 'closed-side-effects', 'history-purge',
  'worker_offline', 'generation_mismatch', 'client_unknown', 'credential_invalid',
  'direction_invalid', 'generation_invalid', 'instance_invalid', 'sequence_invalid', 'stream_invalid',
]);
const errorNames = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError',
  'SshTransportError', 'RelayRouterError', 'McpError', 'RemoteHostPublicError',
]);

export function runtimeDiagnosticRef(value: string): string {
  return `ref-${createHmac('sha256', runId).update(value).digest('hex').slice(0, 16)}`;
}

/** Only operational scalars cross this boundary; arbitrary text and nested payloads never do. */
export function runtimeDiagnosticFields(...inputs: unknown[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const input of inputs.slice(0, 8)) {
    if (!input || typeof input !== 'object') continue;
    try {
      if (input instanceof Error) {
        fields.errorName = errorNames.has(input.name) ? input.name : 'Error';
        const code = (input as NodeJS.ErrnoException).code;
        if (typeof code === 'string' && /^(?:E[A-Z0-9_]{2,48}|ERR_[A-Z0-9_]{1,48})$/.test(code)) {
          fields.errorCode = code;
        }
      }
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input)).slice(0, 64)) {
        if (!('value' in descriptor)) continue;
        const value: unknown = descriptor.value;
        if (metricKeys.has(key) && typeof value === 'number' && Number.isFinite(value)) {
          fields[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
        } else if (booleanKeys.has(key) && typeof value === 'boolean') {
          fields[key] = value;
        } else if (Object.hasOwn(identityKeys, key) && typeof value === 'string') {
          fields[identityKeys[key]!] = runtimeDiagnosticRef(value.slice(0, 4096));
        } else if (refKeys.has(key) && typeof value === 'string' && /^ref-[a-f0-9]{16}$/.test(value)) {
          fields[key] = value;
        } else if (enumKeys.has(key) && typeof value === 'string' && enumValues.has(value)) {
          fields[key] = value;
        } else if (key === 'errorName' && typeof value === 'string' && errorNames.has(value)) {
          fields[key] = value;
        } else if (key === 'errorCode' && typeof value === 'string'
          && /^(?:E[A-Z0-9_]{2,48}|ERR_[A-Z0-9_]{1,48})$/.test(value)) {
          fields[key] = value;
        }
      }
    } catch {
      // Hostile getters/proxies and diagnostics must not interfere with runtime work.
    }
  }
  return fields;
}
