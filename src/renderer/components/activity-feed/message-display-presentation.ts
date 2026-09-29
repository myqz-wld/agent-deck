import type { AgentEvent } from '@shared/types';
import { activityEventIdentity } from './viewers/activity-event-identity';

interface Context {
  owner: string;
  promptId: string;
  turnId: string;
  boundary?: string;
}

interface DisplayGroup {
  key: string;
  context: Context;
  events: AgentEvent[];
  text: string;
  startsAtBeginning: boolean;
  complete: boolean;
}

/** A view-only projection: persisted hook events remain available to history and diagnostics. */
export function presentMessageDisplays(events: readonly AgentEvent[]): readonly AgentEvent[] {
  if (!events.some(isDisplay)) return events;
  const chronological = events.map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.ts - b.event.ts || storedId(a.event) - storedId(b.event) || b.index - a.index);
  const boundaries = new Map<string, string>();
  const contexts = new Map<AgentEvent, Context>();
  const groups = new Map<string, DisplayGroup>();
  const finals: AgentEvent[] = [];

  for (const { event } of chronological) {
    const payload = record(event.payload);
    const metadata = record(payload.metadata);
    const owner = JSON.stringify([event.sessionId, event.agentId, text(payload.agentId ?? metadata.agentId)]);
    if (event.kind === 'session-start' || event.kind === 'session-end') boundaries.delete(owner);
    if (event.kind === 'message' && payload.role === 'user') {
      boundaries.set(owner, activityEventIdentity(event));
    }
    const context = {
      owner,
      promptId: text(payload.promptId ?? metadata.promptId),
      turnId: text(payload.turnId ?? metadata.turnId),
      boundary: boundaries.get(owner),
    };
    contexts.set(event, context);
    if (isDisplay(event)) {
      const key = JSON.stringify([owner, context.promptId || context.boundary, context.turnId,
        text(payload.messageId) || activityEventIdentity(event)]);
      const group = groups.get(key) ?? { key, context, events: [], text: '', startsAtBeginning: false, complete: false };
      group.events.push(event);
      group.complete ||= payload.final === true;
      groups.set(key, group);
    } else if (event.agentId === 'claude-code' && event.kind === 'message' && payload.role === 'assistant'
      && (metadata.final === true || metadata.hookEventName === 'Stop' || metadata.hookEventName === 'StopFailure')) {
      finals.push(event);
    }
  }

  const hidden = new Set<AgentEvent>();
  const replacements = new Map<AgentEvent, AgentEvent>();
  for (const group of groups.values()) {
    const chunks = new Map<number, string>();
    group.events.forEach((event, index) => {
      const payload = record(event.payload);
      const sequence = typeof payload.index === 'number' && Number.isInteger(payload.index) && payload.index >= 0
        ? payload.index : index;
      chunks.set(sequence, text(payload.delta));
    });
    const ordered = [...chunks].sort(([a], [b]) => a - b);
    group.text = ordered.map(([, delta]) => delta).join('');
    group.startsAtBeginning = ordered.every(([index], position) => index === position);
    for (const event of group.events) hidden.add(event);
    const anchor = group.events.at(-1)!;
    if (group.text.trim()) {
      hidden.delete(anchor);
      replacements.set(anchor, {
        ...anchor,
        kind: 'message',
        payload: { role: 'assistant', text: group.text, displayMessageId: group.key },
      });
    }
  }

  const available = [...groups.values()].reverse();
  for (const final of finals.reverse()) {
    const finalText = text(record(final.payload).text).trim();
    if (!finalText) continue;
    const match = available.find((group) => {
      if (!sameTurn(group.context, contexts.get(final)!)) return false;
      const shown = group.text.trim();
      return shown.length > 0 && (shown === finalText || (!group.complete && group.startsAtBeginning && finalText.startsWith(shown)));
    });
    if (!match) continue;
    available.splice(available.indexOf(match), 1);
    for (const event of match.events) hidden.add(event);
    replacements.set(final, {
      ...final, payload: { ...record(final.payload), displayMessageId: match.key },
    });
  }
  return events.flatMap((event) => hidden.has(event) ? [] : [replacements.get(event) ?? event]);
}

function sameTurn(a: Context, b: Context): boolean {
  if (a.owner !== b.owner) return false;
  if (a.promptId && b.promptId && a.promptId !== b.promptId) return false;
  if (a.turnId && b.turnId && a.turnId !== b.turnId) return false;
  return Boolean((a.promptId && a.promptId === b.promptId) || (a.turnId && a.turnId === b.turnId)
    || (a.boundary && a.boundary === b.boundary));
}

function isDisplay(event: AgentEvent): boolean {
  return event.agentId === 'claude-code' && event.kind === 'message-display';
}

function storedId(event: AgentEvent): number {
  const id = (event as AgentEvent & { id?: number }).id;
  return typeof id === 'number' ? id : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
