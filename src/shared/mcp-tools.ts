/**
 * **shared/** category: **policy**（跨进程业务规则 — 图片 MCP 工具识别）。
 *
 * 本地 MCP server 暴露的图片处理工具识别工具函数。
 *
 * Anthropic Claude Code 把 MCP 工具暴露成 `mcp__<server-name>__<tool-name>` 形式，
 * agent-deck 不锁死 server 名（用户的 MCP server 仓库可以叫任意名字），
 * 仅按工具名后缀匹配即可。
 *
 * 协议契约见 plan 文件 / shared/types.ts 的 ImageToolResult。
 *
 * **shared/ 边界约定**（R37 P3-J Step 4.7 — 详 ipc-channels.ts 顶部）：本文件属 **policy**
 * （图片工具名匹配规则；改动会同步影响 main 端 hook + renderer 端图片渲染）。
 */

export const IMAGE_TOOL_SUFFIXES = [
  '__ImageRead',
  '__ImageWrite',
  '__ImageEdit',
  '__ImageMultiEdit',
] as const;

/**
 * 是否是任意一种图片 MCP 工具。
 * 例：'mcp__image-toolkit__ImageEdit' → true；'Edit' / 'Read' → false。
 */
export function isImageTool(toolName: string | undefined | null): boolean {
  if (!toolName) return false;
  return IMAGE_TOOL_SUFFIXES.some((s) => toolName.endsWith(s));
}
