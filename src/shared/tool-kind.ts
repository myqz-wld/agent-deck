import type { AgentToolKind } from './types/agent';

const TOOL_KINDS: ReadonlySet<string> = new Set<AgentToolKind>([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

const TOOL_ALIASES: Record<string, AgentToolKind> = {
  read: 'read',
  edit: 'edit',
  write: 'edit',
  multiedit: 'edit',
  delete: 'delete',
  move: 'move',
  glob: 'search',
  grep: 'search',
  bash: 'execute',
  webfetch: 'fetch',
  websearch: 'search',
  read_file: 'read',
  readfile: 'read',
  edit_file: 'edit',
  write_file: 'edit',
  delete_file: 'delete',
  move_file: 'move',
  search: 'search',
  search_tool: 'search',
  run_terminal_command: 'execute',
  terminal: 'execute',
  execute: 'execute',
  web_fetch: 'fetch',
  fetch: 'fetch',
  think: 'think',
  thinking: 'think',
  switch_mode: 'switch_mode',
  send_message: 'other',
};

export function isAgentToolKind(value: unknown): value is AgentToolKind {
  return typeof value === 'string' && TOOL_KINDS.has(value);
}

export function inferAgentToolKind(toolName: string | null | undefined): AgentToolKind | null {
  if (!toolName) return null;
  const normalized = toolName.trim().toLowerCase().replace(/[-\s]+/g, '_');
  return TOOL_ALIASES[normalized] ?? null;
}

export function normalizeAgentToolKind(
  kind: unknown,
  toolName?: string | null,
): AgentToolKind {
  if (isAgentToolKind(kind)) return kind;
  return inferAgentToolKind(toolName) ?? 'other';
}
