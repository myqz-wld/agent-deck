/**
 * **shared/** category: **policy**（跨进程业务规则 — 只读 / 编辑类工具白名单 SSOT）。
 *
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
  // REVIEW_35 LOW-C-claude: 'LS' 工具在 SDK 0.2.118 已删除（strings claude binary 验证 21 个内置
  // 工具不含 LS；用 Glob / Bash `ls` 替代）。dead constant 删除。
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'NotebookRead',
  // REVIEW_35 MED-C-claude: TaskOutput 是只读工具（读 background task 输出，本质 read-only，与 Read
  // 同性质）。SDK 0.2.118 已暴露但白名单缺失 → 每次读 background task 输出都弹 PendingTab 审批，
  // deep-code-review SKILL / 任何 background task 流程 UX 噪声严重。TaskStop / Agent / Task 是 mutation
  // 保持默认审批不加入。
  'TaskOutput',
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
 * 是否是 agent-deck mcp server 暴露的 5 个 task tool（`mcp__agent-deck__task_*`）。
 *
 * **plan task-mcp-merge-into-agent-deck-mcp-20260521 §不变量 8 + R1 F5 + R3-codex-LOW-1**：
 * 当前是 **dead helper**（`grep -rln isTaskMcpTool src/` 全仓只命中本文件定义，
 * **无生产 import**；`can-use-tool.ts` 走 `READ_ONLY_TOOLS.has(toolName) || toolName.endsWith('__ImageRead')`
 * 不调本 helper；agent-deck in-process 工具放行靠 `allowedTools: [AGENT_DECK_MCP_TOOL_PATTERN]`
 * 通配，与本 helper 无关）。teammate auto-approve 路径同款不调本 helper。
 *
 * **保留删除决策溯源**（R2-claude-LOW-1）：R1 reviewer-codex 用 grep 反证 dead helper，
 * 避免未来 reviewer 翻出来再 propose 同款 hardcode 5-tuple 替代 prefix 匹配方案。
 *
 * **前缀切换**（plan task-mcp-merge-into-agent-deck-mcp-20260521 §Step 14）：
 * 旧 `mcp__` + `tasks__` 前缀 → `mcp__agent-deck__task_`（5 task tool 合并入 agent-deck
 * namespace 后切前缀；字面量拆开写避免本 jsdoc 自循环 grep 命中 — R2-codex-LOW 修法）。
 * 保留兼容历史 grep；未来若 inbox-watcher / auto-approve 路径接入此 helper 不需要再改前缀。
 *
 * **实施末验证命令**（R3-codex-LOW-1 + R1-mixed-codex-LOW-C + R2-codex-LOW 修订）：
 *
 * 跑 `grep -Rns 'mcp__' + 'tasks__' src/`（拆字面量正则避免 jsdoc 自循环；shell 实际跑
 * `grep -Rns 'mcp__tasks__' src/`），输出应**仅**命中以下 4 处合规 historical breaking-change
 * 注释，**0 quoted literal 调用**（任何额外命中尤其是 `toolName: '...'` quoted literal
 * 或 codex event input `server: '...'` 旧 server name 都是 live 漏改信号必须 root-cause）：
 *
 * - `src/shared/types/settings.ts:~290` jsdoc 「breaking from」
 * - `src/main/agent-deck-mcp/tools/index.ts:~345` 注释 「工具名从 ... 切到 ..., breaking change」
 * - `src/main/agent-deck-mcp/types.ts:~102` 同款 breaking change 注释
 * - `src/main/adapters/claude-code/sdk-bridge/mcp-server-init.ts:~14` 同款 breaking change 注释
 *
 * 加上本文件 jsdoc 自身的 1 处「切前缀」描述 (line 72) 共 5 处合规 historical 命中。
 *
 * `grep -Rns 'isTaskMcpTool' src/` 应**仅命中本文件**（默认走修法 (a) 保留 helper 切前缀；
 * 其他 src/ 路径任何 import 都是 root-cause 信号）。
 */
export function isTaskMcpTool(name: string): boolean {
  return name.startsWith('mcp__agent-deck__task_');
}

/**
 * 是否是 image read 类 MCP 工具（`mcp__<server>__ImageRead`）。
 * 复用 mcp-tools.ts 的 `IMAGE_TOOL_SUFFIXES[0]`（'__ImageRead'）避免双处字面量漂移。
 * Image write/edit/multi-edit 不属于 read-only，不在此函数命中。
 */
export function isImageReadTool(name: string): boolean {
  return name.endsWith(IMAGE_TOOL_SUFFIXES[0]);
}
