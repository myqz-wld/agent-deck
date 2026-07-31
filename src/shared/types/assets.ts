/**
 * Agent / Skill 资产元数据（CHANGELOG_57；plan assets-codex-user-and-ui-unify-20260521 §D1-D7
 * 三 adapter 原生资产发现 + UI sub-tab 统一改造）。
 *
 * 用于 header「📚 资产库」Dialog 展示「内置（agent-deck plugin，多 adapter root）+ 用户直系/Plugin」
 * 两类资产。kind/source/adapter 三维度正交：
 *   - kind: 'agent' | 'skill'                —— 文件性质
 *   - source: 'bundled' | 'user'             —— 来源（用户与 Plugin 资产统一只读）
 *   - adapter: 'claude-code' | 'codex-cli' | 'grok-build'   —— 所属 adapter scope（user 资产也带,不再 null）
 *     - claude-code user → ~/.claude/{agents,skills}/
 *     - codex-cli  user → ~/.codex/{agents/<name>.toml,skills/<name>/SKILL.md}
 *     - grok-build user → ~/.grok/{agents,skills}/
 *
 * frontmatter 字段（agents only：tools/model/effort；两类共用：name/description）由
 * main 进程 `src/main/bundled-assets.ts` 与 `src/main/user-assets.ts` 解析。
 *
 * 跨进程共享，遵守 src/shared/types/ 约束：只依赖标准库类型。
 */

export type AssetKind = 'agent' | 'skill';
export type AssetSource = 'bundled' | 'user';
export type AssetAdapter = 'claude-code' | 'codex-cli' | 'grok-build';

/**
 * Agent Deck bundled asset slug regex（CHANGELOG_57 R1·F8 收口）：
 * - 首字符必须 a-z 或数字（防 `-foo` 被 ls 当 flag、防 `.foo` 隐藏文件）
 * - 后续允许 a-z / 数字 / `-`
 * - 长度 1-64（IPC 边界由 `ASSET_LIMITS.name` 单独限）
 */
export const ASSET_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;
/** Native user/plugin asset names may include uppercase letters, dots, and underscores. */
export const NATIVE_ASSET_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Asset IPC / runtime override field limits.
 */
export const ASSET_LIMITS = {
  name: 64,
  nativeName: 128,
  runtimeModel: 256,
  provider: 128,
} as const;

export function isNativeAssetName(name: string): boolean {
  return name.length <= ASSET_LIMITS.nativeName && NATIVE_ASSET_NAME_REGEX.test(name);
}

/** App-owned runtime deltas for one immutable bundled Agent. */
export interface BundledAgentRuntimeOverride {
  model?: string;
  thinking?: string;
  /** Claude Gateway profile id or Codex native independent config profile id. */
  provider?: string;
}

/** Persisted by `adapter:name`; missing fields continue to use the bundled asset default. */
export type BundledAgentRuntimeOverrideMap = Record<string, BundledAgentRuntimeOverride>;

export interface BundledAgentRuntimeMeta {
  /** Values parsed from the packaged Agent asset before applying app-owned overrides. */
  defaults: BundledAgentRuntimeOverride;
  /** Only fields that differ from the packaged defaults. Empty means no override. */
  override: BundledAgentRuntimeOverride;
}

export interface CodexConfigProfileOption {
  id: string;
  /** Absolute native `$CODEX_HOME/<id>.config.toml` path; Agent Deck never rewrites it. */
  configPath: string;
}

export interface ClaudeGatewayProfileOption {
  id: string;
  name?: string;
  /** Absolute settings file passed only to this Claude SDK child through `options.settings`. */
  settingsPath: string;
}

export interface AssetMeta {
  kind: AssetKind;
  source: AssetSource;
  /**
   * 资产所属 adapter（plan assets-codex-user-and-ui-unify-20260521 §D7：user 资产也带 adapter
   * 标识，null 完全删除）：
   * - `'claude-code'`：
   *   - bundled：扫自 `resources/claude-config/agent-deck-plugin/`
   *   - user   ：扫自 `~/.claude/{agents,skills}/`
   * - `'codex-cli'`：
   *   - bundled：扫自 `resources/codex-config/agent-deck-plugin/`
   *   - user   ：扫自 `~/.codex/{agents,skills}/`
   * - `'grok-build'`：
   *   - bundled：扫自 `resources/grok-config/agent-deck-plugin/`
   *   - user   ：扫自 `~/.grok/{agents,skills}/` 与可发现 Plugin
   *
   * 用途：
   * 1. spawn_session(adapter, agentName) 路由到对应 adapter scope 取 native agent config（同名 agent
   *    跨 adapter 内容不同，如 reviewer assets 在 claude 视角 / codex 视角实现不同）
   * 2. `getBundledAssetContent(kind, name, adapter)` / `getBundledAssetPath(kind, name, adapter)`
   *    `getUserAssetContent(kind, name, adapter)` / `getUserAssetPath(kind, name, adapter)`
   * 3. UI 渲染分组（资产库 dialog Skills/Agents/应用约定 三 tab 全 sub-tab 切换）
   */
  adapter: AssetAdapter;
  /** skills: 子目录名；agents: 文件名去后缀。 */
  name: string;
  /**
   * 内置：`agent-deck:<adapter>:<name>`（如 `agent-deck:claude-code:reviewer-claude` /
   * `agent-deck:codex-cli:reviewer-claude`，加 adapter 段防双 root 同名 agent 冲突）；
   * 用户直系：`<name>`；Plugin：`plugin:<plugin>/<name>`。
   *
   * UI 直接展示用，让用户清楚该资产来自哪个 adapter root；React key 用此字段时跨 adapter
   * 同名 agent 仍唯一。`qualifiedName` 仅用于 UI；Plugin Agent 的原生启动名放在
   * `runtimeName`（`<plugin>:<agent>`）。
   */
  qualifiedName: string;
  description: string;
  /** agent only。逗号分隔的 tool 列表，如 `Read, Grep, Glob, Bash`。 */
  tools?: string;
  /** agent only。`fable` / `opus` / `sonnet` / `haiku` alias 之一，或 SDK 接受的具体 model id。 */
  model?: string;
  /** agent only。Claude `effort` / Codex `model_reasoning_effort` 的统一展示值。 */
  thinking?: string;
  /** agent only。Claude 映射到 Gateway profile；Codex bundled override 映射到 config profile。 */
  provider?: string;
  /** bundled agent only。让 UI 展示 effective 值并能删除差异记录恢复 packaged 默认。 */
  bundledAgentRuntime?: BundledAgentRuntimeMeta;
  /** Distinguishes direct user roots from plugin-owned components in the read-only library. */
  origin?: 'direct' | 'plugin';
  /** Native plugin name for source badges and qualified display. */
  pluginName?: string;
  /** Adapter-native qualified invocation name when it differs from the asset filename/name. */
  runtimeName?: string;
  /** 主进程绝对路径。renderer 显示前可截短，「在 Finder/资源管理器中显示」用。 */
  absPath: string;
}

export interface BundledAssetsSnapshot {
  agents: AssetMeta[];
  skills: AssetMeta[];
}

export interface UserAssetsSnapshot {
  agents: AssetMeta[];
  skills: AssetMeta[];
}

/** 「查看完整内容」拉取的完整文件文本。 */
export interface AssetContentResult {
  ok: boolean;
  /** 完整文件文本。失败为空串。 */
  content: string;
  /** 失败原因（找不到 / 读盘失败 / 路径越权）。 */
  reason?: string;
}
