import type { AgentEvent } from '@shared/types';

import { withTimeout, type GrokAcpSession } from './acp-process';
import { asRecord, errorText } from './protocol-utils';
import type { GrokRuntime } from './runtime-types';
import { createGrokContextUsageEvent } from './translate';
import {
  NOOP_GROK_BRIDGE_DIAGNOSTICS,
  type GrokBridgeDiagnostics,
} from './bridge-diagnostics-core';

const REQUEST_TIMEOUT_MS = 15_000;

export const GROK_SESSION_INFO_METHOD = '_x.ai/session/info';

interface GrokSessionInfoRequest {
  sessionId: string;
}

interface GrokSessionInfoResponse {
  result?: {
    context?: unknown;
  };
  context?: unknown;
}

export interface GrokContextUsage {
  usedTokens: number;
  windowTokens: number;
}

export interface GrokContextUsageRefreshOptions {
  diagnostics?: GrokBridgeDiagnostics;
  emit: (event: AgentEvent) => void;
  isCurrentRuntime?: (runtime: GrokRuntime) => boolean;
  requestTimeoutMs?: number;
}

interface RefreshState {
  queued: boolean;
  options: GrokContextUsageRefreshOptions;
  process: GrokAcpSession | null;
  nativeSessionId: string | null;
}

const refreshStates = new WeakMap<GrokRuntime, RefreshState>();
const warnedProcesses = new WeakSet<GrokAcpSession>();

export function parseGrokSessionInfoContext(
  response: unknown,
): GrokContextUsage | null {
  const root = asRecord(response);
  const result = asRecord(root.result);
  const context = asRecord(
    Object.prototype.hasOwnProperty.call(result, 'context')
      ? result.context
      : root.context,
  );
  const used = context.used;
  const total = context.total;
  if (
    typeof used !== 'number' ||
    !Number.isFinite(used) ||
    used < 0 ||
    typeof total !== 'number' ||
    !Number.isFinite(total) ||
    total <= 0
  ) return null;
  return {
    usedTokens: Math.trunc(used),
    windowTokens: Math.trunc(total),
  };
}

/** Coalesces best-effort reads so an older response cannot overwrite a newer context snapshot. */
export function scheduleGrokContextUsageRefresh(
  runtime: GrokRuntime,
  options: GrokContextUsageRefreshOptions,
): void {
  const existing = refreshStates.get(runtime);
  if (
    existing
    && existing.process === runtime.process
    && existing.nativeSessionId === runtime.nativeSessionId
  ) {
    existing.queued = true;
    existing.options = options;
    return;
  }
  const state: RefreshState = {
    queued: true,
    options,
    process: runtime.process,
    nativeSessionId: runtime.nativeSessionId,
  };
  refreshStates.set(runtime, state);
  void runRefreshLoop(runtime, state);
}

export async function refreshGrokContextUsage(
  runtime: GrokRuntime,
  options: GrokContextUsageRefreshOptions,
): Promise<boolean> {
  const process = runtime.process;
  const nativeSessionId = runtime.nativeSessionId;
  if (
    !process ||
    !nativeSessionId ||
    !isEligible(runtime, process, nativeSessionId, options)
  ) return false;

  const controller = new AbortController();
  try {
    const response = await withTimeout(
      process.connection.agent.request<
        GrokSessionInfoResponse,
        GrokSessionInfoRequest
      >(
        GROK_SESSION_INFO_METHOD,
        { sessionId: nativeSessionId },
        { cancellationSignal: controller.signal },
      ),
      options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      'Grok ACP session/info',
    );
    const usage = parseGrokSessionInfoContext(response);
    if (!isEligible(runtime, process, nativeSessionId, options)) return false;
    if (!usage) {
      warnOnce(
        process,
        runtime,
        options,
        'Grok ACP session/info 未返回有效的 context.used/total',
      );
      return false;
    }
    options.emit(createGrokContextUsageEvent(
      runtime.applicationSessionId,
      usage,
      runtime.runtimeIdentity,
    ));
    return true;
  } catch (error) {
    if (isEligible(runtime, process, nativeSessionId, options)) {
      warnOnce(
        process,
        runtime,
        options,
        `Grok ACP session/info 刷新失败：${errorText(error)}`,
      );
    }
    return false;
  } finally {
    controller.abort();
  }
}

async function runRefreshLoop(
  runtime: GrokRuntime,
  state: RefreshState,
): Promise<void> {
  while (
    state.queued
    && runtime.process === state.process
    && runtime.nativeSessionId === state.nativeSessionId
  ) {
    state.queued = false;
    await refreshGrokContextUsage(runtime, state.options);
  }
  if (refreshStates.get(runtime) === state) refreshStates.delete(runtime);
}

function isEligible(
  runtime: GrokRuntime,
  process: GrokAcpSession,
  nativeSessionId: string,
  options: GrokContextUsageRefreshOptions,
): boolean {
  return !runtime.closed
    && runtime.process === process
    && runtime.nativeSessionId === nativeSessionId
    && (options.isCurrentRuntime?.(runtime) ?? true);
}

function warnOnce(
  process: GrokAcpSession,
  runtime: GrokRuntime,
  options: GrokContextUsageRefreshOptions,
  message: string,
): void {
  if (warnedProcesses.has(process)) return;
  warnedProcesses.add(process);
  (options.diagnostics ?? NOOP_GROK_BRIDGE_DIAGNOSTICS)
    .scope('grok-runtime')
    .warn('[grok-runtime] context usage refresh unavailable; session preserved', {
    event: 'grok_context_usage_refresh_failed',
    sessionId: runtime.applicationSessionId,
    nativeSessionId: runtime.nativeSessionId,
    message,
    });
}
