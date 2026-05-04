import { sep } from 'node:path';

/**
 * 跨平台运行时常量与工具。集中收口 `process.platform === '...'` 判断，避免散落
 * 各处。新增/调整平台分支时统一改这里。
 */

export const IS_DARWIN = process.platform === 'darwin';
export const IS_WIN = process.platform === 'win32';
export const IS_LINUX = process.platform === 'linux';

/**
 * Claude Code CLI 把 cwd 编码成 ~/.claude/projects/<encodedDir>/ 的目录名规则：
 * - macOS / Linux：`'-' + cwd.split('/').filter(Boolean).join('-')`
 *   （例：`/Users/apple/Repository/personal/agent-deck` → `-Users-apple-Repository-personal-agent-deck`）
 * - Windows：未官方文档；按推测用 `path.sep`（即反斜杠）split 后 join `-`，与 POSIX 同模式。
 *
 * 该编码用于 `recoverer.defaultResumeJsonlExists` 的 jsonl 预检；预检假阴性时 SDK
 * 仍走「不带 resume 的新建路径」兜底，不强依赖编码规则正确（recoverer.ts 内有
 * try/catch，最差退化到现状的 30s fallback 行为）。所以 Win 端规则若与 CLI 实际不符，
 * 影响仅限 resume 优化路径，不会导致功能崩溃。
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return '-' + cwd.split(sep).filter(Boolean).join('-');
}
