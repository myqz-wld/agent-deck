/** Text-only event summaries use emoji; React tool cards use the semantic SVG ToolIcon. */
import { inferAgentToolKind, isAgentToolKind } from '@shared/tool-kind';

const ICON_MAP: Record<string, string> = {
  // 文件
  Read: '📖',
  Edit: '✍️',
  Write: '✍️',
  MultiEdit: '✍️',
  NotebookEdit: '📓',
  // 搜索
  Glob: '🗂',
  Grep: '🔍',
  // Shell
  Bash: '💻',
  // 网络
  WebFetch: '🌐',
  WebSearch: '🌐',
  // 待办（避开 ✅，会撞 finished）
  TodoWrite: '📌',
  // Plan 模式（成对）
  ExitPlanMode: '📋',
  EnterPlanMode: '📋',
  // Subagent / collaboration
  Task: '🤖',
  Agent: '🤖',
  // Claude Code Skill
  Skill: '✨',
  // 询问
  AskUserQuestion: '❓',
  // Agent Teams (CLI builtin)
  SendMessage: '📨',
  TaskCreate: '➕',
  TaskUpdate: '🔄',
  TaskOutput: '📤',
  TaskStop: '🛑',
  TeamCreate: '👥',
  // Task store MCP（agent-deck 自带，CHANGELOG_42-43 + plan task-mcp-merge-into-agent-deck-mcp-20260521 合并入 agent-deck namespace）
  'mcp__agent-deck__task_create': '➕',
  'mcp__agent-deck__task_list': '📋',
  'mcp__agent-deck__task_get': '🔎',
  'mcp__agent-deck__task_update': '🔄',
  'mcp__agent-deck__task_delete': '🗑',
};

const KIND_ICON_MAP: Record<string, string> = {
  read: '📖',
  edit: '✍️',
  delete: '🗑',
  move: '📦',
  search: '🔍',
  execute: '💻',
  think: '🧠',
  fetch: '🌐',
  switch_mode: '🔀',
  other: '🔧',
};

export function toolIcon(tool: string | undefined | null, toolKind?: unknown): string {
  if (!tool) return '🔧';
  if (isAgentToolKind(toolKind) && toolKind !== 'other') return KIND_ICON_MAP[toolKind];
  const inferred = inferAgentToolKind(tool);
  if (inferred) return KIND_ICON_MAP[inferred];
  return ICON_MAP[tool] ?? '🔧';
}
