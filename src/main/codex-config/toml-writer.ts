/**
 * Codex `~/.codex/config.toml` 的 mcp_servers 段管理（CHANGELOG_<X> A4a）。
 *
 * 设计目标：让 Agent Deck 能管理自己写入的 mcp_servers 段，**保留**用户手写的其他段
 * （含用户自己手写的 [mcp_servers.X] / [model_providers.*] / 顶层 model="..." 等）。
 *
 * 实现策略：**marker 包裹 + 整段替换**。Agent Deck 写入的 mcp_servers 都包在：
 *
 *   # === Agent Deck MCP Servers START - DO NOT EDIT THIS BLOCK ===
 *   # （Agent Deck 自动写入；用户在设置面板编辑 + 应用启动时同步）
 *   # （手动改不会生效，下次同步会被覆盖）
 *   [mcp_servers.my-server]
 *   command = "node"
 *   args = ["..."]
 *   ...
 *   # === Agent Deck MCP Servers END ===
 *
 * - 用户手写的 [mcp_servers.OTHER] 段（marker 之外）严格保留
 * - 用户手写的 server 名跟 Agent Deck 名撞了由 codex CLI 自己处理（取最后定义的）
 *   —— 推荐 Agent Deck server 名加 `agent-deck/` 前缀避免冲突
 *
 * **不解析整个 config.toml**：避免 TOML 解析依赖（@iarna/toml ~120 KB / smol-toml ~5 KB
 * 都是新引入），简化 D6 packaging。我们只做「按 marker 边界字符串替换」+「mcp_servers
 * 段的简单 TOML 序列化」（codex 文档约束 server config 只含 string / number / bool /
 * string array / 字符串 map env，全部能手序列化）。
 *
 * **atomic write**：write tmp + rename，与 sdk-injection.saveUserAgentDeckClaudeMd 同模式
 * （REVIEW_2 教训：进程崩溃 / 磁盘满会留半截 config.toml，下次 codex 启动 parse 失败）。
 *
 * 不在此处实现：
 * - Settings UI（A4b 任务）
 * - Agent Deck 自己的 MCP server 配置注入（A5 任务，复用 stringify 函数）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CodexMcpServerConfigShared } from '@shared/types';
import {
  isCodexThinkingLevel,
  type CodexThinkingLevel,
} from '@shared/session-metadata';
import log from '@main/utils/logger';

const logger = log.scope('codex-toml-writer');

const MARKER_START = '# === Agent Deck MCP Servers START - DO NOT EDIT THIS BLOCK ===';
const MARKER_END = '# === Agent Deck MCP Servers END ===';
const MARKER_BANNER = `# (Agent Deck 自动写入；用户在设置面板编辑 + 应用启动时同步)
# (手动改不会生效，下次同步会被覆盖)`;

/**
 * 单条 codex MCP server 配置（CHANGELOG_<X> A4b 起改为 shared 类型 alias，
 * 避免 main / shared / renderer 跨层 type drift）。codex CLI 接受 stdio 或
 * http transport（mutual exclusive）。
 */
export type CodexMcpServerConfig = CodexMcpServerConfigShared;

/** ~/.codex/config.toml 绝对路径（不依赖 Electron app.getPath，便于单测）。 */
export function getCodexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

/**
 * 序列化一组 server 为 TOML mcp_servers 段（含 START/END marker）。
 *
 * 输出形如：
 *
 *   # === Agent Deck MCP Servers START ... ===
 *   # banner ...
 *
 *   [mcp_servers.foo]
 *   command = "node"
 *   args = ["a", "b"]
 *
 *   [mcp_servers.foo.env]
 *   KEY = "value"
 *
 *   [mcp_servers.bar]
 *   url = "https://example.com/mcp"
 *   bearer_token_env_var = "BAR_TOKEN"
 *
 *   # === Agent Deck MCP Servers END ===
 *
 * 空 servers 数组 → 仅返回两条 marker 行 + 空内容（让用户能看到 Agent Deck 接管了这块，
 * 即便目前没配任何 server）。
 */
export function stringifyMcpServersSection(servers: CodexMcpServerConfig[]): string {
  const lines: string[] = [MARKER_START, MARKER_BANNER, ''];
  for (const s of servers) {
    if (!s.name || !/^[\w-/]+$/.test(s.name)) {
      // 非法 server 名跳过 + 提示（典型：含点号 / 空格会破坏 TOML 段名）
      lines.push(`# (skipped invalid server name: ${JSON.stringify(s.name)})`);
      continue;
    }
    lines.push(`[mcp_servers.${quoteTableKey(s.name)}]`);
    if (s.command !== undefined) {
      lines.push(`command = ${tomlString(s.command)}`);
    }
    if (s.args && s.args.length > 0) {
      lines.push(`args = ${tomlStringArray(s.args)}`);
    }
    if (s.url !== undefined) {
      lines.push(`url = ${tomlString(s.url)}`);
    }
    if (s.bearerTokenEnvVar !== undefined) {
      lines.push(`bearer_token_env_var = ${tomlString(s.bearerTokenEnvVar)}`);
    }
    if (s.env && Object.keys(s.env).length > 0) {
      lines.push('');
      lines.push(`[mcp_servers.${quoteTableKey(s.name)}.env]`);
      for (const [k, v] of Object.entries(s.env)) {
        lines.push(`${quoteTableKey(k)} = ${tomlString(v)}`);
      }
    }
    lines.push('');
  }
  lines.push(MARKER_END);
  return lines.join('\n');
}

/**
 * 把 mcp_servers 段写入 ~/.codex/config.toml。保留现有用户内容，只替换 marker 之间的段。
 * marker 不存在 → 追加到文件末尾。文件不存在 → 新建（仅含我们的段）。
 *
 * @returns 写入后的完整文件内容（用于测试 / 调试）
 */
export function writeMcpServersToCodexConfig(
  servers: CodexMcpServerConfig[],
  configPath: string = getCodexConfigPath(),
): string {
  const newSection = stringifyMcpServersSection(servers);
  let existing = '';
  if (existsSync(configPath)) {
    try {
      existing = readFileSync(configPath, 'utf8');
    } catch (err) {
      logger.warn(`[codex-config] 读 ${configPath} 失败，将从空文件重建`, err);
      existing = '';
    }
  }
  const next = replaceMarkerSection(existing, newSection);
  atomicWrite(configPath, next);
  return next;
}

/**
 * 从 config.toml 读出 Agent Deck 段内的 server 配置（marker 之间的内容反向解析）。
 *
 * **不实现完整 TOML parser**：仅做行级正则解析（key=value / [mcp_servers.name] 段头），
 * 因为 Agent Deck 段是 stringifyMcpServersSection 自己写的，格式可控，简单解析够用。
 * 用户在 marker 之外手写的 server 不会被读出（也不应被 Agent Deck 管理）。
 *
 * @returns marker 之间解析出的 server 列表；marker 不存在 / 段为空 → 空数组
 */
export function readMcpServersFromCodexConfig(
  configPath: string = getCodexConfigPath(),
): CodexMcpServerConfig[] {
  if (!existsSync(configPath)) return [];
  let content = '';
  try {
    content = readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }
  const sectionRe = new RegExp(
    `${escapeRegex(MARKER_START)}([\\s\\S]*?)${escapeRegex(MARKER_END)}`,
    'm',
  );
  const m = sectionRe.exec(content);
  if (!m) return [];
  return parseMcpServersSection(m[1]);
}

/**
 * 读 `~/.codex/config.toml` 顶层 `model = "..."`（plan model-token-stats-and-dashboard-20260602
 * §Phase 1 A4c / deep-review R2 G1 双方独立 + R3 LOW-1）。
 *
 * codex 不显式传 model 时走 config.toml 默认；token 统计需要 effective model 才能按模型拆分，
 * 否则全折进 'codex-default' bucket（plan §已知踩坑 1）。
 *
 * **不引 TOML parser 依赖**（toml-writer.ts:22 + REVIEW_2 约定：@iarna/toml ~120KB / 半截
 * config.toml 解析失败教训）—— 行级扫描：
 * - **section-aware**：遇第一个 `[section]` header 立即停（顶层 key 必在任何 table header 之前；
 *   不停会误读 `[profiles.foo]` / `[model_providers.*]` 段内的 `model = ...`）
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

/** Read the base Codex provider selection without resolving profile layering. */
export function readTopLevelModelProviderFromCodexConfig(
  configPath: string = getCodexConfigPath(),
): string | null {
  return readTopLevelQuotedStringFromCodexConfig('model_provider', configPath);
}

/**
 * Read the top-level Codex `model_reasoning_effort` when it is one of the levels Agent Deck can
 * safely pass to app-server. Unknown future values stay provider-owned and are not persisted as a
 * session override.
 */
export function readTopLevelModelReasoningEffortFromCodexConfig(
  configPath: string = getCodexConfigPath(),
): CodexThinkingLevel | null {
  // An active profile may override the top-level effort. Without a full layered TOML resolver,
  // reporting the base value as effective would be worse than keeping the session display unset.
  if (readTopLevelQuotedStringFromCodexConfig('profile', configPath)) return null;
  const value = readTopLevelQuotedStringFromCodexConfig(
    'model_reasoning_effort',
    configPath,
  );
  return isCodexThinkingLevel(value) ? value : null;
}

/**
 * Minimal section-aware reader for a quoted top-level string in Codex config.toml.
 *
 * It intentionally stops at the first table header so a profile/provider-local key cannot be
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

// ────────────────────────────────────────────────────────── helpers

function replaceMarkerSection(existing: string, newSection: string): string {
  if (!existing.trim()) return newSection + '\n';
  const sectionRe = new RegExp(
    `${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`,
    'm',
  );
  if (sectionRe.test(existing)) {
    return existing.replace(sectionRe, newSection);
  }
  // 没有 marker → 追加到末尾，前面隔一空行
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + newSection + '\n';
}

function parseMcpServersSection(section: string): CodexMcpServerConfig[] {
  const lines = section.split(/\r?\n/);
  const servers: CodexMcpServerConfig[] = [];
  let current: CodexMcpServerConfig | null = null;
  let inEnvSubtable = false;
  // [mcp_servers.NAME] 段头（不含 .env）→ 新 server；[mcp_servers.NAME.env] → env 子段
  const headerRe = /^\[mcp_servers\.([^\].]+|"[^"]+")(\.env)?\]\s*$/;
  const kvRe = /^([\w-]+|"[^"]+")\s*=\s*(.+?)\s*$/;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const headerMatch = headerRe.exec(line);
    if (headerMatch) {
      const name = unquoteTableKey(headerMatch[1]);
      const isEnvSub = !!headerMatch[2];
      if (isEnvSub) {
        // [mcp_servers.NAME.env] —— 必须是当前 server 的子表
        if (current && current.name === name) {
          inEnvSubtable = true;
          current.env = current.env ?? {};
        } else {
          inEnvSubtable = false;
        }
      } else {
        if (current) servers.push(current);
        current = { name };
        inEnvSubtable = false;
      }
      continue;
    }
    const kv = kvRe.exec(line);
    if (!kv || !current) continue;
    const key = unquoteTableKey(kv[1]);
    const valStr = kv[2];
    if (inEnvSubtable) {
      const v = parseTomlString(valStr);
      if (v != null) (current.env ??= {})[key] = v;
      continue;
    }
    switch (key) {
      case 'command': {
        const v = parseTomlString(valStr);
        if (v != null) current.command = v;
        break;
      }
      case 'args': {
        current.args = parseTomlStringArray(valStr) ?? [];
        break;
      }
      case 'url': {
        const v = parseTomlString(valStr);
        if (v != null) current.url = v;
        break;
      }
      case 'bearer_token_env_var': {
        const v = parseTomlString(valStr);
        if (v != null) current.bearerTokenEnvVar = v;
        break;
      }
      default:
        // 忽略未知字段（前向兼容用户在 marker 内手改的字段会被下次写回时清掉）
        break;
    }
  }
  if (current) servers.push(current);
  return servers;
}

function tomlString(s: string): string {
  // codex config 只用 basic string（双引号）。需要转义 \ " 与控制符。
  return JSON.stringify(s);
}

function tomlStringArray(arr: string[]): string {
  return '[' + arr.map(tomlString).join(', ') + ']';
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

function parseTomlStringArray(s: string): string[] | null {
  const m = /^\[(.*)\]$/s.exec(s.trim());
  if (!m) return null;
  const inner = m[1].trim();
  if (!inner) return [];
  // 简单 split：按逗号分但要避开引号内的逗号
  const parts: string[] = [];
  let buf = '';
  let inStr = false;
  let escape = false;
  for (const ch of inner) {
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      buf += ch;
      continue;
    }
    if (ch === ',' && !inStr) {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  const out: string[] = [];
  for (const p of parts) {
    const v = parseTomlString(p);
    if (v != null) out.push(v);
  }
  return out;
}

function quoteTableKey(k: string): string {
  // bare key 允许 [A-Za-z0-9_-]，其他字符必须 quoted
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

function unquoteTableKey(k: string): string {
  if (k.startsWith('"') && k.endsWith('"')) {
    try {
      return JSON.parse(k) as string;
    } catch {
      return k.slice(1, -1);
    }
  }
  return k;
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}
