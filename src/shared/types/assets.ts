/**
 * Agent / Skill 资产元数据（CHANGELOG_57）。
 *
 * 用于 header「📚 资产库」Dialog 展示「内置（agent-deck plugin）+ 用户自定义（~/.claude/{agents,skills}/）」
 * 两类资产。kind/source 维度正交：
 *   - kind: 'agent' | 'skill'                —— 文件性质
 *   - source: 'bundled' | 'user'             —— 来源（影响只读/可写）
 *
 * frontmatter 字段（agents only：tools/model；两类共用：name/description）由
 * main 进程 `src/main/bundled-assets.ts` 与 `src/main/user-assets.ts` 解析。
 * triggers 是从 description 文本里 regex 提取的「触发：xxx / /agent-deck:xxx」hint，
 * 给 UI 显示用，不写入 frontmatter。
 *
 * 跨进程共享，遵守 src/shared/types/ 约束：只依赖标准库类型。
 */

export type AssetKind = 'agent' | 'skill';
export type AssetSource = 'bundled' | 'user';

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
  body: 256 * 1024, // 256 KB
} as const;

export interface AssetMeta {
  kind: AssetKind;
  source: AssetSource;
  /**
   * 资产所属 adapter（plan codex-handoff-team-alignment-20260518 §P3 Step 3.3）：
   * - `'claude-code'`：bundled 资产，扫自 `resources/claude-config/agent-deck-plugin/`
   * - `'codex-cli'`：bundled 资产，扫自 `resources/codex-config/agent-deck-plugin/`
   * - `null`：user 资产（`~/.claude/{agents,skills}/`），不属任何 plugin root —— user assets 是
   *   SDK `settingSources: ['user', ...]` 自动加载，与 adapter root scope 无关
   *
   * 用途：
   * 1. spawn_session(adapter, agent_name) 路由到对应 plugin root 取 agent body（同名 agent
   *    跨 adapter 内容不同，如 reviewer-claude wrapper 在 claude 视角 / codex 视角实现完全不同）
   * 2. `getBundledAssetContent(kind, name, adapter)` / `getBundledAssetPath(kind, name, adapter)`
   *    必须的 narrowing key —— 不知 adapter 没法定位 fs 路径
   * 3. UI 渲染分组（资产库 dialog 双 adapter 资产分组显示）
   */
  adapter: 'claude-code' | 'codex-cli' | null;
  /** skills: 子目录名；agents: 文件名去后缀。slug 见 `ASSET_NAME_REGEX`。 */
  name: string;
  /**
   * 内置：`agent-deck:<adapter>:<name>`（如 `agent-deck:claude-code:reviewer-claude` /
   * `agent-deck:codex-cli:reviewer-claude`，加 adapter 段防双 root 同名 agent 冲突）；
   * 用户：`<name>`（不变）。
   *
   * UI 直接展示用，让用户清楚该资产来自哪个 adapter root；React key 用此字段时跨 adapter
   * 同名 agent 仍唯一。**plan §P3 Step 3.3 由 `agent-deck:<name>` 升级**——历史 caller 通过
   * `agent_name: 'reviewer-claude'` (不带 prefix) 引用 SDK，qualifiedName 仅 UI 展示，无 runtime
   * 影响。
   */
  qualifiedName: string;
  description: string;
  /** agent only。逗号分隔的 tool 列表，如 `Read, Grep, Glob, Bash`。 */
  tools?: string;
  /** agent only。`opus` / `sonnet` / `haiku` 三档之一，或 SDK 接受的具体 model id。 */
  model?: string;
  /** UI hint：从 description 里 regex 抽出的「触发：...」/「/agent-deck:...」短语列表。 */
  triggers?: string[];
  /** 主进程绝对路径。renderer 显示前可截短，「在 Finder/资源管理器中显示」用。 */
  absPath: string;
}

/**
 * 用户自定义资产保存入参。main 端拼装 frontmatter（手写 YAML 仅 4 字段）+ body 写盘：
 *   - skills → `~/.claude/skills/<name>/SKILL.md`
 *   - agents → `~/.claude/agents/<name>.md`
 * 走原子写（write tmp + rename），与 saveUserAgentDeckClaudeMd 同模式。
 */
export interface UserAssetInput {
  kind: AssetKind;
  /** slug 见 `ASSET_NAME_REGEX`，长度受 `ASSET_LIMITS.name` 约束。 */
  name: string;
  description: string;
  /** agent 必填；skill 忽略。 */
  tools?: string;
  /** agent 必填；skill 忽略。 */
  model?: string;
  /** markdown 正文（不含 frontmatter）。 */
  body: string;
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
