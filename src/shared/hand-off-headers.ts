/**
 * plan handoff-render-and-image-batch-20260521 R1 reviewer-claude LOW-1 修法:hand-off cold-start
 * prompt 2 种 marker 字面量 SSOT 抽常量。3 处共享:
 *
 * 1. `src/main/agent-deck-mcp/tools/handlers/lead-context-block.ts` — spawn 路径装配 lead context
 *    block 时用 `HAND_OFF_SPAWN_HEADER` 作 block 标题首行
 * 2. `src/main/agent-deck-mcp/tools/handlers/adopted-teams-context-block.ts` — adopt 路径装配
 *    adoptedBlock 时用 `HAND_OFF_ADOPT_HEADER` 作 block 标题首行
 * 3. `src/renderer/components/activity-feed/rows/message-row.tsx` — `parseHandOffContext` 用
 *    `HAND_OFF_HEADERS = [SPAWN, ADOPT]` 数组 identify marker,index 0=spawn / index 1=adopt
 *
 * **修法动机**(R1 reviewer-claude LOW-1):3 处 textual 对偶 — 任一方将来改文案不同步另一方,
 * marker fallback 链(payload.handOff 缺失时的回退路径)会失效。SSOT 单点修改让 future 改文案
 * 强制同步 + TS import 编译期守门(漏 import 即 TS error)。
 *
 * **不变量**:HAND_OFF_HEADERS 顺序约束 — `[SPAWN, ADOPT]` index 0 必须是 spawn / index 1 必须是
 * adopt(message-row.tsx parseHandOffContext 用 `i === 0 ? 'spawn' : 'adopt'` 由 index 决定 kind)。
 */

export const HAND_OFF_SPAWN_HEADER = '## Hand-off context (auto-injected by Agent Deck MCP)';
export const HAND_OFF_ADOPT_HEADER =
  "## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)";
