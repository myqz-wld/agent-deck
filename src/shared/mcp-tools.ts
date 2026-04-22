/**
 * 本地 MCP server 暴露的图片处理工具识别工具函数。
 *
 * Anthropic Claude Code 把 MCP 工具暴露成 `mcp__<server-name>__<tool-name>` 形式，
 * agent-deck 不锁死 server 名（用户的 MCP server 仓库可以叫任意名字），
 * 仅按工具名后缀匹配即可。
 *
 * 协议契约见 plan 文件 / shared/types.ts 的 ImageToolResult。
 */

export const IMAGE_TOOL_SUFFIXES = [
  '__ImageRead',
  '__ImageWrite',
  '__ImageEdit',
  '__ImageMultiEdit',
] as const;

export type ImageToolSuffix = (typeof IMAGE_TOOL_SUFFIXES)[number];

/**
 * 是否是任意一种图片 MCP 工具。
 * 例：'mcp__image-toolkit__ImageEdit' → true；'Edit' / 'Read' → false。
 */
export function isImageTool(toolName: string | undefined | null): boolean {
  if (!toolName) return false;
  return IMAGE_TOOL_SUFFIXES.some((s) => toolName.endsWith(s));
}

/** 返回工具名匹配到的 suffix（用来分支判断 read / write / edit / multi-edit），没匹配返回 null */
export function imageToolSuffix(toolName: string | undefined | null): ImageToolSuffix | null {
  if (!toolName) return null;
  return IMAGE_TOOL_SUFFIXES.find((s) => toolName.endsWith(s)) ?? null;
}
