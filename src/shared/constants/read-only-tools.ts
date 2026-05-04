/**
 * 跨进程共享：只读 / 编辑类工具白名单常量（CHANGELOG_<X> B1）。
 *
 * **抽出理由**：lead canUseTool 与 teammate inbox auto-approve（CHANGELOG_<X>）需要
 * 用同一份白名单，避免双处 hardcode 漂移。
 *
 * 之前 `READ_ONLY_TOOLS` 定义在 `src/main/adapters/claude-code/sdk-bridge/constants.ts`
 * （main 进程）；现在抽到 shared/，sdk-bridge 改 re-export 保持向后兼容。
 *
 * **shared 边界约束**（与 `shared/types.ts` 注释一致）：本文件零 import Node/Electron API，
 * 只用 string Set + 字面量 helper，符合 `shared/` 「跨进程不依赖运行时」的最低要求。
 */
import { IMAGE_TOOL_SUFFIXES } from '../mcp-tools';

/**
 * REVIEW_11 Bug 4：read-only 工具白名单。SDK 0.2.x 注册 canUseTool 后所有工具决策都归应用，
 * 包括只读 / 元数据类工具。应用必须在 canUseTool 顶部主动放行这些工具，否则 default mode
 * 下用户会被 Read / Grep 等无害操作反复弹询问。
 *
 * 加白名单不依赖 permissionMode：plan / acceptEdits / bypass / default 任何模式下，
 * 这些工具语义上都不该被拦（plan mode 本意只拦 mutation；其他 mode 也只该拦危险操作）。
 *
 * **同样适用于 teammate auto-approve**（CHANGELOG_<X>）：teammate 调这些工具时
 * inbox-watcher 直接写 inbox response allow，跳过 UI 弹框。新增白名单条目都改这里。
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set<string>([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'NotebookRead',
]);

/**
 * 编辑类工具集（CHANGELOG_<X> B3）。teammate auto-approve 'follow-lead' 档下，
 * lead 是 acceptEdits 时这些工具也被自动允许（与 lead 自己 acceptEdits 模式语义对齐）。
 *
 * 不含 Bash / Task / 其他 mutation tools — lead acceptEdits 模式下 SDK 仍会弹这些；
 * 与之保持对齐。bypassPermissions 档则在 follow-lead 路径下全放行（不查此集合）。
 */
export const EDIT_TOOLS: ReadonlySet<string> = new Set<string>([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * 是否是 mcp tasks server 暴露的工具（`mcp__tasks__*`）。
 * agent-deck 自有 MCP server，5 个 task_* 工具属于受控应用工具不弹框；teammate 同理。
 */
export function isTaskMcpTool(name: string): boolean {
  return name.startsWith('mcp__tasks__');
}

/**
 * 是否是 image read 类 MCP 工具（`mcp__<server>__ImageRead`）。
 * 复用 mcp-tools.ts 的 `IMAGE_TOOL_SUFFIXES[0]`（'__ImageRead'）避免双处字面量漂移。
 * Image write/edit/multi-edit 不属于 read-only，不在此函数命中。
 */
export function isImageReadTool(name: string): boolean {
  return name.endsWith(IMAGE_TOOL_SUFFIXES[0]);
}
