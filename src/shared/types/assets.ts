/**
 * Agent / Skill 资产元数据（CHANGELOG_57；plan assets-codex-user-and-ui-unify-20260521 §D1-D7
 * 双 adapter user 自定义补齐 + UI sub-tab 统一改造）。
 *
 * 用于 header「📚 资产库」Dialog 展示「内置（agent-deck plugin，双 adapter root）+ 用户自定义」
 * 两类资产。kind/source/adapter 三维度正交：
 *   - kind: 'agent' | 'skill'                —— 文件性质
 *   - source: 'bundled' | 'user'             —— 来源（影响只读/可写）
 *   - adapter: 'claude-code' | 'codex-cli'   —— 所属 adapter scope（user 资产也带,不再 null）
 *     - claude-code user → ~/.claude/{agents,skills}/
 *     - codex-cli  user → ~/.codex/{agents/<name>.toml,skills/<name>/SKILL.md}
 *
 * frontmatter 字段（agents only：tools/model/effort；两类共用：name/description）由
 * main 进程 `src/main/bundled-assets.ts` 与 `src/main/user-assets.ts` 解析。
 *
 * 跨进程共享，遵守 src/shared/types/ 约束：只依赖标准库类型。
 */

export type AssetKind = 'agent' | 'skill';
export type AssetSource = 'bundled' | 'user';
export type AssetAdapter = 'claude-code' | 'codex-cli' | 'grok-build';
export type UserAssetAdapter = Exclude<AssetAdapter, 'grok-build'>;

/**
 * 用户自定义 asset name 的 slug regex（CHANGELOG_57 R1·F8 收口）：
 * - 首字符必须 a-z 或数字（防 `-foo` 被 ls 当 flag、防 `.foo` 隐藏文件）
 * - 后续允许 a-z / 数字 / `-`
 * - 长度 1-64（IPC 边界由 parseAssetName 单独限）
 *
 * 跨进程共享单点真值：ipc/assets.ts 入参校验 + bundled-assets.ts/user-assets.ts 扫描过滤 +
 * AssetEditor.tsx renderer 即时校验都引这一份。
 */
export const ASSET_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 用户自定义 asset 字段长度上限（CHANGELOG_57 R1·F4 收口）：
 * 防恶意 renderer 走 `window.electronIpc.invoke` 兜底通道塞 100MB body 卡死 main 同步 fs。
 * description / tools / model 取严（短文本字段，单行）；body 取宽（markdown 正文允许多段）。
 */
export const ASSET_LIMITS = {
  name: 64,
  description: 4096,
  tools: 512,
  model: 64,
  runtimeModel: 256,
  provider: 128,
  body: 256 * 1024, // 256 KB
} as const;

/** App-owned runtime deltas for one immutable bundled Agent. */
export interface BundledAgentRuntimeOverride {
  model?: string;
  thinking?: string;
  /** Claude Gateway profile id or Codex native `model_provider`. */
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

export interface CodexModelProviderOption {
  id: string;
  name?: string;
  /** True only for the top-level `model_provider`; profile layering remains Codex-owned. */
  configuredAsTopLevelDefault: boolean;
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
   *
   * 用途：
   * 1. spawn_session(adapter, agentName) 路由到对应 adapter scope 取 native agent config（同名 agent
   *    跨 adapter 内容不同，如 reviewer assets 在 claude 视角 / codex 视角实现不同）
   * 2. `getBundledAssetContent(kind, name, adapter)` / `getBundledAssetPath(kind, name, adapter)`
   *    `getUserAssetContent(kind, name, adapter)` / `getUserAssetPath(kind, name, adapter)`
   *    `saveUserAsset(input)` / `deleteUserAsset(kind, name, adapter)` 都必须的 narrowing key
   * 3. UI 渲染分组（资产库 dialog Skills/Agents/应用约定 三 tab 全 sub-tab 切换）
   */
  adapter: AssetAdapter;
  /** skills: 子目录名；agents: 文件名去后缀。slug 见 `ASSET_NAME_REGEX`。 */
  name: string;
  /**
   * 内置：`agent-deck:<adapter>:<name>`（如 `agent-deck:claude-code:reviewer-claude` /
   * `agent-deck:codex-cli:reviewer-claude`，加 adapter 段防双 root 同名 agent 冲突）；
   * 用户：`<name>`（不变）。
   *
   * UI 直接展示用，让用户清楚该资产来自哪个 adapter root；React key 用此字段时跨 adapter
   * 同名 agent 仍唯一。**plan §P3 Step 3.3 由 `agent-deck:<name>` 升级**——caller 通过
   * `agentName: 'reviewer-claude'` (不带 prefix) 引用 SDK，qualifiedName 仅 UI 展示，无 runtime
   * 影响。
   */
  qualifiedName: string;
  description: string;
  /** agent only。逗号分隔的 tool 列表，如 `Read, Grep, Glob, Bash`。 */
  tools?: string;
  /** agent only。`fable` / `opus` / `sonnet` / `haiku` alias 之一，或 SDK 接受的具体 model id。 */
  model?: string;
  /** agent only。Claude `effort` / Codex `model_reasoning_effort` 的统一展示值。 */
  thinking?: string;
  /** agent only。Claude 映射到 Gateway profile；Codex 映射到 native `model_provider`。 */
  provider?: string;
  /** bundled agent only。让 UI 展示 effective 值并能删除差异记录恢复 packaged 默认。 */
  bundledAgentRuntime?: BundledAgentRuntimeMeta;
  /** 主进程绝对路径。renderer 显示前可截短，「在 Finder/资源管理器中显示」用。 */
  absPath: string;
}

/**
 * 用户自定义资产保存入参。main 端拼装 frontmatter（手写 YAML）+ body 写盘：
 *   - claude-code skills → `~/.claude/skills/<name>/SKILL.md`
 *   - claude-code agents → `~/.claude/agents/<name>.md`
 *   - codex-cli  agents → `~/.codex/agents/<name>.toml`
 *   - codex-cli  skills → `~/.codex/skills/<name>/SKILL.md`
 * 走原子写（write tmp + rename），与 saveUserAgentDeckClaudeMd 同模式。
 */
export interface UserAssetInput {
  kind: AssetKind;
  /**
   * 资产所属 adapter scope（plan §D5：新建 / 编辑 时随当前 sub-tab 锁定）。
   */
  adapter: UserAssetAdapter;
  /** slug 见 `ASSET_NAME_REGEX`，长度受 `ASSET_LIMITS.name` 约束。 */
  name: string;
  description: string;
  /** agent 必填；skill 忽略。 */
  tools?: string;
  /** agent 必填；skill 忽略。 */
  model?: string;
  /** Claude Gateway profile id or Codex native model_provider; skills ignore it. */
  provider?: string;
  /** markdown 正文（不含 frontmatter）。 */
  body: string;
}

/**
 * adapter + kind 组合是否合法。Codex custom agents are native TOML files under
 * `~/.codex/agents/`, so every current adapter/kind combination is valid.
 *
 * 跨进程共享 helper（plan §改动文件清单 reviewer-claude LOW-3 修订）：
 * - ipc/assets.ts 入参校验调一次（IPC 层硬拒，防 renderer 走 `window.electronIpc` 兜底通道绕过 UI 直写）
 * - main/user-assets.ts saveUserAsset / getUserAssetContent / deleteUserAsset / getUserAssetPath
 *   各调一次（main 层 defense in depth，万一 IPC 校验漏改不至于真把 codex agent 写到不存在路径）
 *
 * 不依赖 Node / Electron API，纯静态判断，放 shared/types 安全。
 */
export function validateAdapterKind(
  adapter: UserAssetAdapter,
  kind: AssetKind,
): { ok: true } | { ok: false; reason: string } {
  void adapter;
  void kind;
  return { ok: true };
}

export interface BundledAssetsSnapshot {
  agents: AssetMeta[];
  skills: AssetMeta[];
}

export interface UserAssetsSnapshot {
  agents: AssetMeta[];
  skills: AssetMeta[];
}

/** 「查看完整内容」/ AssetEditor 编辑时拉的完整文件文本（含 frontmatter + body）。 */
export interface AssetContentResult {
  ok: boolean;
  /** 完整文件文本。失败为空串。 */
  content: string;
  /** 失败原因（找不到 / 读盘失败 / 路径越权）。 */
  reason?: string;
}
