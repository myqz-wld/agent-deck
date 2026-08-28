import type { SessionCommandDescriptor } from './types';

const MAX_COMMANDS = 256;
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_ARGUMENT_HINT_LENGTH = 256;
const MAX_ALIASES = 16;
const COMMAND_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u;

export interface SessionCommandCandidate {
  name?: unknown;
  description?: unknown;
  argumentHint?: unknown;
  aliases?: unknown;
}

/** Bound provider-owned command metadata before it crosses IPC or a Remote transport. */
export function normalizeSessionCommands(
  candidates: readonly SessionCommandCandidate[],
): SessionCommandDescriptor[] {
  const commands: SessionCommandDescriptor[] = [];
  const names = new Set<string>();
  for (const candidate of candidates) {
    if (commands.length >= MAX_COMMANDS) break;
    const name = normalizeCommandName(candidate.name);
    if (!name || names.has(name)) continue;
    names.add(name);
    const aliases = Array.isArray(candidate.aliases)
      ? candidate.aliases
        .map(normalizeCommandName)
        .filter((alias): alias is string => Boolean(alias) && alias !== name)
        .filter((alias, index, values) => values.indexOf(alias) === index)
        .slice(0, MAX_ALIASES)
      : [];
    commands.push({
      name,
      description: boundedString(candidate.description, MAX_DESCRIPTION_LENGTH),
      argumentHint: boundedString(candidate.argumentHint, MAX_ARGUMENT_HINT_LENGTH),
      aliases,
    });
  }
  return commands;
}

/** Merge catalogs by canonical name while preserving provider presentation order. */
export function mergeSessionCommands(
  primary: readonly SessionCommandDescriptor[],
  fallback: readonly SessionCommandDescriptor[],
): SessionCommandDescriptor[] {
  return normalizeSessionCommands([...primary, ...fallback]);
}

export function sessionCommandToken(text: string): string | null {
  if (!text.startsWith('/') || text.includes('\n')) return null;
  const token = text.slice(1).split(/\s/, 1)[0]?.toLocaleLowerCase() ?? '';
  return token || '';
}

export function matchingSessionCommands(
  commands: readonly SessionCommandDescriptor[],
  text: string,
  limit = 8,
): SessionCommandDescriptor[] {
  const token = sessionCommandToken(text);
  if (token === null) return [];
  return commands.filter((command) =>
    command.name.toLocaleLowerCase().startsWith(token) ||
    command.aliases.some((alias) => alias.toLocaleLowerCase().startsWith(token)))
    .slice(0, Math.max(0, limit));
}

export function exactSessionCommand(
  commands: readonly SessionCommandDescriptor[],
  text: string,
): SessionCommandDescriptor | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/') || /\s/.test(trimmed)) return null;
  const name = trimmed.slice(1).toLocaleLowerCase();
  return commands.find((command) =>
    command.name.toLocaleLowerCase() === name ||
    command.aliases.some((alias) => alias.toLocaleLowerCase() === name)) ?? null;
}

function normalizeCommandName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^\/+/, '');
  if (!name || name.length > MAX_NAME_LENGTH || !COMMAND_NAME.test(name)) return null;
  return name;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}
