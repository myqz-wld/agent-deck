/**
 * 工具名 → emoji 图标映射。
 *
 * 风格约束：保持纯 emoji，与现有视觉语言一致（ExitPlanMode 📋 / Task 🤖 / ImageRead 🖼 /
 * file-changed 📝 / finished ✅ / waiting ⚠ 等）。不引入 lucide-react —— renderer 当前没有
 * 这个 dep，加进来纯增 bundle 体积。
 *
 * 高频白名单基于本仓库 7 天 transcript jq 频次实证（截止 2026-05-01）：
 *   Bash 1889 / Read 1650 / Edit 774 / TodoWrite 340 / Grep 235 / Write 176 /
 *   AskUserQuestion 80 / Agent 78 / TaskOutput 48 / Glob 41 / WebFetch 27 /
 *   WebSearch 22 / SendMessage 21 / ExitPlanMode 15 / TaskStop 10 /
 *   Skill 7 / EnterPlanMode 7 / TeamCreate 6 / Task 3
 * 后续按主题加 case 即可；其他 mcp__*（含 mcp 图片工具）走 🔧 兜底。
 *
 * REVIEW_17 R1 / L10：本应用自带 task-manager MCP server (CHANGELOG_42-43)，
 * 5 个工具真名 `mcp__tasks__task_*`，作为应用核心新模块需 UI 可识别，单独列。
 *
 * 避撞约束：
 *  - ✅ 已被「一轮完成」状态用 → TodoWrite 不能用 ✅，改 📌
 *  - 📝 已被 file-changed 用 → 不复用
 *  - 📋 ExitPlanMode 已用，EnterPlanMode 配对，复用 OK
 *  - 🤖 Task 已用，Agent 是 Task 的别名（新版 Claude Code SDK），复用 OK
 *  - mcp__tasks__task_create 与 CLI builtin TaskCreate 同 ➕（语义对齐）
 */
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
  // Subagent（Task = 老名，Agent = 新名，同义）
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
  // Task Manager MCP（agent-deck 自带，CHANGELOG_42-43）
  mcp__tasks__task_create: '➕',
  mcp__tasks__task_list: '📋',
  mcp__tasks__task_get: '🔎',
  mcp__tasks__task_update: '🔄',
  mcp__tasks__task_delete: '🗑',
};

export function toolIcon(tool: string | undefined | null): string {
  if (!tool) return '🔧';
  return ICON_MAP[tool] ?? '🔧';
}
