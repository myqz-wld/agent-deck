/** Side-effect-free bounded readers for Codex `$CODEX_HOME/config.toml`. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isCodexThinkingLevel,
  type CodexThinkingLevel,
} from '@shared/session-metadata';
import { getCodexHome } from './codex-home';

/** `$CODEX_HOME/config.toml` 绝对路径（不依赖 Electron app.getPath，便于单测）。 */
export function getCodexConfigPath(): string {
  return join(getCodexHome(), 'config.toml');
}

/**
 * 读 `$CODEX_HOME/config.toml` 顶层 `model = "..."`（plan model-token-stats-and-dashboard-20260602
 * §Phase 1 A4c / deep-review R2 G1 双方独立 + R3 LOW-1）。
 *
 * codex 不显式传 model 时走 config.toml 默认；token 统计需要 effective model 才能按模型拆分，
 * 否则全折进 'codex-default' bucket（plan §已知踩坑 1）。
 *
 * This bounded base-config reader intentionally remains a line scanner so a partially edited
 * `config.toml` can still yield its leading scalar defaults. Selected Gateway files use the full
 * TOML parser in `gateway-profiles-core.ts` and fail closed as complete config documents.
 * - **section-aware**：遇第一个 `[section]` header 立即停（顶层 key 必在任何 table header 之前；
 *   不停会误读 `[model_providers.*]` 等段内的 `model = ...`）
 * - **精确锚 `model` 后紧跟 `=`/空格**：排除 `model_provider` / `model_providers` 误命中
 * - **正则直接捕获首个引号 token**（basic `"..."` / literal `'...'`）：尾部 inline comment
 *   `model = "x" # primary` 自然忽略；basic 走 parseTomlString（含转义）、literal 无转义剥引号
 *
 * 读不到（无文件 / 无顶层 model / 值非引号形态）→ 返 null（caller 链 `?? 'codex-default'` 兜底）。
 */
export function readTopLevelModelFromCodexConfig(
  configPath: string = getCodexConfigPath(),
): string | null {
  return readTopLevelQuotedStringFromCodexConfig('model', configPath);
}

/** Parse the top-level model from an already-authorized config snapshot. */
export function readTopLevelModelFromCodexConfigText(content: string): string | null {
  return readTopLevelQuotedStringFromCodexConfigText('model', content);
}

/**
 * Read the top-level Codex `model_reasoning_effort` when it is one of the levels Agent Deck can
 * safely pass to app-server. Unknown future values stay provider-owned and are not persisted as a
 * session override.
 */
export function readTopLevelModelReasoningEffortFromCodexConfig(
  configPath: string = getCodexConfigPath(),
): CodexThinkingLevel | null {
  const value = readTopLevelQuotedStringFromCodexConfig(
    'model_reasoning_effort',
    configPath,
  );
  return isCodexThinkingLevel(value) ? value : null;
}

/**
 * Minimal section-aware reader for a quoted top-level string in Codex config.toml.
 *
 * It intentionally stops at the first table header so a provider-local key cannot be
 * mistaken for a global default. Reads are side-effect free; unsupported bare or multiline TOML
 * values return null and remain Codex-owned.
 */
function readTopLevelQuotedStringFromCodexConfig(
  key: string,
  configPath: string,
): string | null {
  if (!existsSync(configPath)) return null;
  let content = '';
  try {
    content = readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  return readTopLevelQuotedStringFromCodexConfigText(key, content);
}

function readTopLevelQuotedStringFromCodexConfigText(
  key: string,
  content: string,
): string | null {
  const escapedKey = escapeRegex(key);
  const assignmentRe = new RegExp(
    `^${escapedKey}[ \\t]*=[ \\t]*("(?:[^"\\\\]|\\\\.)*"|'[^']*')`,
  );
  const keyRe = new RegExp(`^${escapedKey}[ \\t]*=`);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    // 遇 section header → 顶层扫描结束（顶层 key 不可能在 table header 之后）
    if (line.startsWith('[')) break;
    const m = assignmentRe.exec(line);
    if (m) {
      const tok = m[1];
      return tok[0] === '"' ? parseTomlString(tok) : tok.slice(1, -1);
    }
    // key= 在但值非引号形态（裸值 / multi-line）→ 这是目标顶层行，无法解析则停
    if (keyRe.test(line)) return null;
  }
  return null;
}

function parseTomlString(s: string): string | null {
  // 仅支持 "..." basic string；其他形态（literal '...' / multi-line）返回 null
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (!m) return null;
  // JSON.parse 处理 \", \\, \n, \t, \uXXXX 与 codex/TOML 兼容（codex CLI 用 toml-rs，
  // basic string 转义集与 JSON 一致）
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}
