import type { RouteOptions } from 'fastify';
import type { AgentEvent } from '@shared/types';
import {
  type BaseGrokHookPayload,
  translateGrokNotification,
  translateGrokPermissionDenied,
  translateGrokPostCompact,
  translateGrokPostToolUse,
  translateGrokPostToolUseFailure,
  translateGrokPreToolUse,
  translateGrokSessionEnd,
  translateGrokSessionStart,
  translateGrokStop,
  translateGrokStopFailure,
  translateGrokUserPrompt,
} from './hook-translate';

type HookTranslator = (
  body: BaseGrokHookPayload & Record<string, unknown>,
) => AgentEvent | AgentEvent[];

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
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

function makeRoute(
  url: string,
  translate: HookTranslator,
  emit: (event: AgentEvent, origin: 'sdk' | 'cli') => void,
): RouteOptions {
  return {
    method: 'POST',
    url,
    handler: async (request, reply) => {
      try {
        const body = (request.body ?? {}) as BaseGrokHookPayload & Record<string, unknown>;
        if (!body || typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
          reply.code(400).send({ ok: false, error: 'missing sessionId' });
          return;
        }
        const origin =
          firstHeaderValue(request.headers['x-agent-deck-origin']) === 'sdk'
            ? 'sdk'
            : 'cli';
        const pid = parsePidHeader(request.headers['x-agent-deck-parent-pid']);
        const output = translate(body);
        const events = Array.isArray(output) ? output : [output];
        for (const event of events) emit(attachExternalProcessPid(event, pid), origin);
        reply.code(200).send({ ok: true });
      } catch (error) {
        reply.code(500).send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function buildGrokHookRoutes(
  emit: (event: AgentEvent) => void,
): RouteOptions[] {
  const taggedEmit = (event: AgentEvent, origin: 'sdk' | 'cli'): void => {
    emit({ ...event, source: 'hook', hookOrigin: origin });
  };
  const route = (path: string, translate: HookTranslator): RouteOptions =>
    makeRoute(`/hook/grok/${path}`, translate, taggedEmit);

  return [
    route('sessionstart', translateGrokSessionStart),
    route('userpromptsubmit', translateGrokUserPrompt),
    route('pretooluse', translateGrokPreToolUse),
    route('posttooluse', translateGrokPostToolUse),
    route('posttoolusefailure', translateGrokPostToolUseFailure),
    route('permissiondenied', translateGrokPermissionDenied),
    route('postcompact', translateGrokPostCompact),
    route('notification', translateGrokNotification),
    route('stop', translateGrokStop),
    route('stopfailure', translateGrokStopFailure),
    route('sessionend', translateGrokSessionEnd),
  ];
}
