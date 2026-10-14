import type { JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { AlertTriangleIcon, TerminalIcon } from '../../icons';
import { getAgentShortName } from '../shared';
import { StatusRow } from './status-row';

interface SessionCommandStatus {
  command: string;
  status: 'completed' | 'failed';
  text: string;
}

/** Classify persisted command feedback by its marker, never by conversation text. */
export function readSessionCommandStatus(event: AgentEvent): SessionCommandStatus | null {
  if (event.kind !== 'message' || !event.payload || typeof event.payload !== 'object') return null;
  const payload = event.payload as Record<string, unknown>;
  if (payload.role !== 'system') return null;
  const marker = payload.sessionCommandStatus;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const { command, status } = marker as Record<string, unknown>;
  if (typeof command !== 'string'
    || (status !== 'completed' && status !== 'failed')) return null;
  const name = command.trim().replace(/^\/+/, '');
  if (!name) return null;
  return { command: name, status,
    text: typeof payload.text === 'string' ? payload.text.trim() : '' };
}

export function CommandStatusRow({ event, outcome }: {
  event: AgentEvent;
  outcome: SessionCommandStatus;
}): JSX.Element {
  const failed = outcome.status === 'failed';
  const Icon = failed ? AlertTriangleIcon : TerminalIcon;
  const title = `${getAgentShortName(event.agentId)} /${outcome.command} ${failed ? '失败' : '已完成'}`;
  const long = outcome.text.length > 120 || outcome.text.includes('\n');
  return <StatusRow title={long ? title : outcome.text || title} ts={event.ts}
    tone={failed ? 'error' : 'neutral'}
    icon={<Icon className={`h-3.5 w-3.5 shrink-0 ${failed ? 'text-status-error/80' : 'text-deck-muted/70'}`} />}>
    {long ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">{outcome.text}</pre> : null}
  </StatusRow>;
}
