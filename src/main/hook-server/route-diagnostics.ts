import type { RouteOptions } from 'fastify';
import { createHash } from 'node:crypto';

import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import type { AgentEvent } from '@shared/types';

export type HookAdapterId =
  | 'claude-code'
  | 'codex-cli'
  | 'grok-build'
  | 'unknown';
export type HookOrigin = 'sdk' | 'cli';
export type HookFailurePhase = 'validate' | 'preprocess' | 'translate' | 'emit';
export type HookErrorCategory =
  | 'invalid-body'
  | 'invalid-session'
  | 'type-error'
  | 'range-error'
  | 'syntax-error'
  | 'error'
  | 'non-error';

export const INVALID_HOOK_BODY_RESPONSE = {
  ok: false,
  error: 'invalid hook payload',
} as const;

export const HOOK_PROCESSING_FAILED_RESPONSE = {
  ok: false,
  error: 'hook processing failed',
} as const;

const DEFAULT_SUPPRESSION_WINDOW_MS = 10_000;
const DEFAULT_MAX_ACTIVE_ROUTES = 256;
const DEFAULT_MAX_SUPPRESSED_COUNT = 9_999;
const MAX_RECOVERY_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

interface DiagnosticLogger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

export interface HookDiagnosticContext {
  adapter: HookAdapterId;
  route: string;
  event: string;
  origin: HookOrigin;
  sessionId: string | null;
}

export interface HookFailureContext extends HookDiagnosticContext {
  phase: HookFailurePhase;
  error?: unknown;
  errorCategory?: HookErrorCategory;
}

interface FailureState {
  context: SafeFailureContext;
  firstReportedAt: number;
  lastReportedAt: number;
  suppressedCount: number;
  suppressedCountCapped: boolean;
}

interface SafeDiagnosticContext {
  adapter: HookAdapterId;
  route: string;
  event: string;
  origin: HookOrigin;
  session: string;
}

interface SafeFailureContext extends SafeDiagnosticContext {
  phase: HookFailurePhase;
  errorCategory: HookErrorCategory;
}

interface RouteState {
  failures: Map<string, FailureState>;
}

export interface HookRouteDiagnosticsOptions {
  logger?: DiagnosticLogger;
  now?: () => number;
  runId?: () => string | null | undefined;
  suppressionWindowMs?: number;
  maxActiveRoutes?: number;
  maxSuppressedCount?: number;
}

function errorCategory(error: unknown): HookErrorCategory {
  try {
    if (error instanceof TypeError) return 'type-error';
    if (error instanceof RangeError) return 'range-error';
    if (error instanceof SyntaxError) return 'syntax-error';
    if (error instanceof Error) return 'error';
    return 'non-error';
  } catch {
    return 'non-error';
  }
}

function boundedStaticLabel(value: string, fallback: string): string {
  const safe = value.replace(/[^a-zA-Z0-9/_-]/g, '?').slice(0, 80);
  return safe || fallback;
}

export function shortHookSessionId(sessionId: string | null): string {
  if (!sessionId) return 'missing';
  const safe = sessionId.trim().slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, '?');
  return safe || 'invalid';
}

function safeContext(context: HookDiagnosticContext): SafeDiagnosticContext {
  return {
    adapter: context.adapter,
    route: boundedStaticLabel(context.route, '/hook/unknown'),
    event: boundedStaticLabel(context.event, 'unknown'),
    origin: context.origin,
    session: shortHookSessionId(context.sessionId),
  };
}

function baseSignature(context: SafeDiagnosticContext): string {
  return [
    context.adapter,
    context.route,
    context.event,
    context.origin,
  ].join('\u0000');
}

function sessionSignature(sessionId: string | null): string {
  if (!sessionId) return 'missing';
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

function failureSignature(context: SafeFailureContext): string {
  return `${context.phase}\u0000${context.errorCategory}`;
}

export class HookRouteDiagnostics {
  private readonly logger: DiagnosticLogger;
  private readonly now: () => number;
  private readonly runId: () => string | null | undefined;
  private readonly suppressionWindowMs: number;
  private readonly maxActiveRoutes: number;
  private readonly maxSuppressedCount: number;
  private readonly active = new Map<string, RouteState>();

  constructor(options: HookRouteDiagnosticsOptions = {}) {
    this.logger = options.logger ?? log.scope('hook-routes');
    this.now = options.now ?? Date.now;
    this.runId = options.runId ?? getProcessRunId;
    this.suppressionWindowMs = Math.max(
      0,
      options.suppressionWindowMs ?? DEFAULT_SUPPRESSION_WINDOW_MS,
    );
    this.maxActiveRoutes = Math.max(
      1,
      options.maxActiveRoutes ?? DEFAULT_MAX_ACTIVE_ROUTES,
    );
    this.maxSuppressedCount = Math.max(
      1,
      options.maxSuppressedCount ?? DEFAULT_MAX_SUPPRESSED_COUNT,
    );
  }

  reportFailure(input: HookFailureContext): void {
    const context: SafeFailureContext = {
      ...safeContext(input),
      phase: input.phase,
      errorCategory: input.errorCategory ?? errorCategory(input.error),
    };
    const routeKey = `${baseSignature(context)}\u0000${sessionSignature(input.sessionId)}`;
    let routeState = this.active.get(routeKey);
    if (!routeState) {
      if (this.active.size >= this.maxActiveRoutes) {
        const oldest = this.active.keys().next().value as string | undefined;
        if (oldest) this.active.delete(oldest);
      }
      routeState = { failures: new Map() };
      this.active.set(routeKey, routeState);
    }

    const signature = failureSignature(context);
    const current = this.currentTime();
    const state = routeState.failures.get(signature);
    if (!state) {
      routeState.failures.set(signature, {
        context,
        firstReportedAt: current,
        lastReportedAt: current,
        suppressedCount: 0,
        suppressedCountCapped: false,
      });
      this.write('error', '[hook-route] processing failed', {
        ...context,
        state: 'failed',
        ...this.runCorrelation(),
      });
      return;
    }

    if (current - state.lastReportedAt < this.suppressionWindowMs) {
      if (state.suppressedCount < this.maxSuppressedCount) {
        state.suppressedCount += 1;
      } else {
        state.suppressedCountCapped = true;
      }
      return;
    }

    this.write('warn', '[hook-route] repeated failures suppressed', {
      ...state.context,
      state: 'degraded',
      suppressedCount: state.suppressedCount,
      suppressedCountCapped: state.suppressedCountCapped,
      ...this.runCorrelation(),
    });
    state.lastReportedAt = current;
    state.suppressedCount = 0;
    state.suppressedCountCapped = false;
  }

  reportRecovery(input: HookDiagnosticContext): void {
    const context = safeContext(input);
    const routeKey = `${baseSignature(context)}\u0000${sessionSignature(input.sessionId)}`;
    const routeState = this.active.get(routeKey);
    if (!routeState) return;

    const current = this.currentTime();
    for (const state of routeState.failures.values()) {
      this.write('info', '[hook-route] recovered', {
        ...state.context,
        state: 'recovered',
        suppressedCount: state.suppressedCount,
        suppressedCountCapped: state.suppressedCountCapped,
        failureDurationMs: Math.min(
          MAX_RECOVERY_DURATION_MS,
          Math.max(0, current - state.firstReportedAt),
        ),
        ...this.runCorrelation(),
      });
    }
    this.active.delete(routeKey);
  }

  private runCorrelation(): { runId?: string } {
    let value: string | null | undefined;
    try {
      value = this.runId();
    } catch {
      return {};
    }
    if (!value || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) return {};
    return { runId: value };
  }

  private currentTime(): number {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  private write(
    level: keyof DiagnosticLogger,
    message: string,
    context: Record<string, unknown>,
  ): void {
    try {
      this.logger[level](message, context);
    } catch {
      // Diagnostics must never turn a safely handled hook failure into another route failure.
    }
  }
}

export const hookRouteDiagnostics = new HookRouteDiagnostics();

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export function hookOriginFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): HookOrigin {
  return firstHeaderValue(headers['x-agent-deck-origin']) === 'sdk' ? 'sdk' : 'cli';
}

function parsePidHeader(value: string | string[] | undefined): number | null {
  const raw = firstHeaderValue(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function attachExternalProcessPid(event: AgentEvent, pid: number | null): AgentEvent {
  if (pid === null) return event;
  const payload =
    event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? { ...(event.payload as Record<string, unknown>), externalProcessPid: pid }
      : { value: event.payload, externalProcessPid: pid };
  return { ...event, payload };
}

export interface HookRoutePreprocessContext<Body> {
  body: Body;
  origin: HookOrigin;
  externalProcessPid: number | null;
}

export interface CreateHookRouteOptions<Body> {
  adapter: HookAdapterId;
  event: string;
  url: string;
  extractSessionId: (body: unknown) => string | null;
  translate: (body: Body) => AgentEvent | AgentEvent[];
  emit: (event: AgentEvent, origin: HookOrigin) => void;
  preprocess?: (
    context: HookRoutePreprocessContext<Body>,
  ) => boolean | Promise<boolean>;
  preprocessFailureMode?: 'reject' | 'continue';
  diagnostics?: HookRouteDiagnostics;
}

export function createHookRoute<Body>(
  options: CreateHookRouteOptions<Body>,
): RouteOptions {
  const diagnostics = options.diagnostics ?? hookRouteDiagnostics;
  return {
    method: 'POST',
    url: options.url,
    config: {
      hookDiagnostics: {
        adapter: options.adapter,
        event: options.event,
      },
    },
    handler: async (request, reply) => {
      const headers = request.headers as Record<
        string,
        string | string[] | undefined
      >;
      const origin = hookOriginFromHeaders(headers);
      const body = request.body as Body;
      let sessionId: string | null = null;
      try {
        sessionId = options.extractSessionId(request.body);
      } catch {
        // A payload extractor is part of validation and must not expose its raw exception.
      }
      const diagnosticContext: HookDiagnosticContext = {
        adapter: options.adapter,
        route: options.url,
        event: options.event,
        origin,
        sessionId,
      };
      if (!sessionId) {
        diagnostics.reportFailure({
          ...diagnosticContext,
          phase: 'validate',
          errorCategory: 'invalid-session',
        });
        reply.code(400).send(INVALID_HOOK_BODY_RESPONSE);
        return;
      }

      const externalProcessPid = parsePidHeader(
        headers['x-agent-deck-parent-pid'],
      );
      if (options.preprocess) {
        let ignored = false;
        try {
          ignored = await options.preprocess({
            body,
            origin,
            externalProcessPid,
          });
        } catch (error) {
          if (options.preprocessFailureMode === 'continue') {
            ignored = false;
          } else {
            diagnostics.reportFailure({
              ...diagnosticContext,
              phase: 'preprocess',
              error,
            });
            reply.code(500).send(HOOK_PROCESSING_FAILED_RESPONSE);
            return;
          }
        }
        if (ignored) {
          diagnostics.reportRecovery(diagnosticContext);
          reply.code(200).send({ ok: true, ignored: true });
          return;
        }
      }

      let output: AgentEvent | AgentEvent[];
      try {
        output = options.translate(body);
      } catch (error) {
        diagnostics.reportFailure({
          ...diagnosticContext,
          phase: 'translate',
          error,
        });
        reply.code(500).send(HOOK_PROCESSING_FAILED_RESPONSE);
        return;
      }

      try {
        const events = Array.isArray(output) ? output : [output];
        for (const event of events) {
          options.emit(attachExternalProcessPid(event, externalProcessPid), origin);
        }
      } catch (error) {
        diagnostics.reportFailure({
          ...diagnosticContext,
          phase: 'emit',
          error,
        });
        reply.code(500).send(HOOK_PROCESSING_FAILED_RESPONSE);
        return;
      }

      diagnostics.reportRecovery(diagnosticContext);
      reply.code(200).send({ ok: true });
    },
  };
}
