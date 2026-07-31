/**
 * **shared/** category: **policy**（跨进程业务规则 — 只读 / 编辑类工具白名单 SSOT）。
 *
 * 只读 / 编辑类工具策略集中在 shared 层，让 main 端审批逻辑与 renderer 展示使用同一组工具集。
 * 本文件不得引入 Node / Electron API。
 */

/**
 * REVIEW_11 Bug 4：read-only 工具白名单。SDK 0.2.x 注册 canUseTool 后所有工具决策都归应用，
 * 包括只读 / 元数据类工具。应用必须在 canUseTool 顶部主动放行这些工具，否则 default mode
 * 下用户会被 Read / Grep 等无害操作反复弹询问。
 *
 * 加白名单不依赖 permissionMode：plan / acceptEdits / bypass / default 任何模式下，
 * 这些工具语义上都不该被拦（plan mode 本意只拦 mutation；其他 mode 也只该拦危险操作）。
 *
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set<string>([
  'Read',
  'Grep',
  'Glob',
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
