/**
 * 跨进程共享：AppSettings + Hook 安装状态 + 权限设置扫描结果类型。
 */

export interface AppSettings {
  hookServerPort: number;
  /**
   * HookServer Bearer 鉴权 token：本机任何进程都能 curl 127.0.0.1:port，
   * 没有 token 校验就能伪造 AgentEvent 污染 SQLite / 注入假会话。
   * 首次启动由 settings-store 自动生成 32 字节随机 hex 并持久化，
   * 后续保持稳定（让已安装的 hook 命令不会因 token 变动失效）。
   * 用户**不应**在 UI 上修改此值；仅在被泄漏需要轮换时手动清掉持久化文件让它重生成。
   */
  hookServerToken: string | null;
  enableSound: boolean;
  enableSystemNotification: boolean;
  silentWhenFocused: boolean;
  /** waiting 提示音文件绝对路径（mp3/wav/aiff/m4a）；null = 用 resources/sounds 默认或系统声音 */
  waitingSoundPath: string | null;
  /** finished 提示音文件绝对路径；null = 同上 */
  finishedSoundPath: string | null;
  activeWindowMs: number; // active → dormant 阈值
  closeAfterMs: number; // dormant → closed 阈值
  summaryIntervalMs: number; // 总结时间触发
  summaryEventCount: number; // 总结事件数触发
  summaryMaxConcurrent: number; // 同时跑 LLM 总结的会话上限
  /**
   * 单个 LLM oneshot 总结的超时阈值（毫秒）。0 = 永不超时。
   * SDK 一旦因代理超时 / 鉴权死锁 / API 限流卡在等 result，循环就永远不会退出，
   * inFlight 槽永不释放，maxConcurrent 个卡死后整个 Summarizer 不再产新总结。
   */
  summaryTimeoutMs: number;
  /** 权限请求未响应自动 abort 的阈值（毫秒）。0 = 不超时。 */
  permissionTimeoutMs: number;
  alwaysOnTop: boolean;
  /**
   * pin（始终置顶）时是否同步关闭系统 vibrancy（macOS 「under-window」毛玻璃）让 CSS 主导通透。
   * - true（默认，与历史行为一致）：pin 时去掉浅灰玻璃基底，肉眼能透到下层桌面 / 其它 app；
   *   配合 startInvalidateLoop + setBackgroundThrottling(false) 持续刷新下层像素。
   * - false：pin 时仍保留 'under-window' 实玻璃，看不到下层。
   * 改动即时生效（不需要重启 / 重建窗口）。
   */
  transparentWhenPinned: boolean;
  startOnLogin: boolean;
  /**
   * 历史会话自动清理保留天数（基于 lastEventAt）。
   * - 正数：超过该天数的「历史会话」（lifecycle = closed 或 archived_at IS NOT NULL）
   *   将被 LifecycleScheduler 在每次扫描时批量删除（事件 / 文件改动 / 总结一并 CASCADE）。
   * - 0：禁用自动清理（永远保留历史）。
   * 不影响 active / dormant：那些先由生命周期阈值推到 closed 后才进入清理候选。
   */
  historyRetentionDays: number;
  /**
   * Codex CLI 二进制绝对路径（@openai/codex-sdk 的 codexPathOverride）。
   * - null：用 SDK 自带的 vendored 二进制（@openai/codex 跟随 npm 装上，已打包进 .app）
   * - 绝对路径：覆盖为外部 codex（例如用户自装的更新版 `which codex` 给的路径）
   * agent-deck 不读不写 codex 鉴权（`~/.codex/config.toml` / 环境变量），全由用户终端配置。
   */
  codexCliPath: string | null;
  /**
   * 是否把 agent-deck 自带的 CLAUDE.md（`resources/claude-config/CLAUDE.md` 或用户副本
   * `userData/agent-deck-claude.md`）注入到 SDK 会话 system prompt 末尾。
   * - true（默认）：注入，让会话遵循 agent-deck 项目内通用约定
   * - false：不注入，会话只受 user/project/local CLAUDE.md 控制
   *
   * 改这个开关只影响**下次新建**的会话；已运行的 SDK 会话已经把 system prompt
   * 固化进 LLM 上下文，关掉不会回收。
   */
  injectAgentDeckClaudeMd: boolean;
  /**
   * 是否把 agent-deck 自带的 plugin（`resources/claude-config/agent-deck-plugin/`）
   * 注入到 SDK 会话。**plugin 整体注入或整体不注入**——一个 toggle 同时控制两类内容：
   *
   * - **skills**：以 `agent-deck:<skill-name>` 命名空间注册（如 `agent-deck:deep-code-review`，
   *   多轮异构 review × fix 收口工作流）
   * - **agents**：以 `agent-deck:<agent-name>` 命名空间注册（如 `agent-deck:reviewer-claude`、
   *   `agent-deck:reviewer-codex`，异构对抗 reviewer subagent）
   *
   * SDK plugin 协议自动扫描 `<plugin>/skills/` 与 `<plugin>/agents/` 子目录，应用层只传
   * plugin path 即可。与用户 `~/.claude/skills/` + `~/.claude/agents/` + project
   * `.claude/skills/` + `.claude/agents/` 都不冲突（plugin 强制命名空间前缀）。
   *
   * 改这个开关只影响**下次新建**的会话；已运行的 SDK 会话已经在启动时拿到 plugin 列表，
   * 关掉不会撤销。
   */
  injectAgentDeckPlugin: boolean;
  /**
   * Agent Teams 实验特性总开关（默认 OFF）。开启后 NewSessionDialog 暴露 teamName 输入框；
   * 用户填了 teamName 的 SDK 会话在 spawn 时注入 env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，
   * 让 Claude 内部启用 agent teams（lead spawn teammates、共享 task list、3 个新 hook 事件）。
   *
   * 兼容性：需 Claude Code CLI ≥ v2.1.32（应用启动时 `claude --version` 自检；< 2.1.32
   * 自动跳过 hook 注入并在 SettingsDialog 显示版本不足提示）。Opus 4.6+ 推荐。
   *
   * 已知限制（Anthropic 官方）：no `/resume` 与 `/rewind`；no nested teams；one team per
   * session；lead 终身固定。**关闭开关只影响下次新建会话**——CLI 子进程已按 team 模式启动，
   * env 是 spawn 时一次性传入，不会被撤销。
   */
  agentTeamsEnabled: boolean;
  /**
   * SDK Task Manager 总开关（默认 OFF / CHANGELOG_43）。开启后 SDK 会话 `query()`
   * 注入 5 个 in-process MCP tools（mcp__tasks__task_create / list / get / update /
   * delete），让 Claude 能跨 SDK Agent 协作管理结构化任务（与 ~/.claude/tasks/<team>/
   * <list>.md 自然语言任务并行；本工具是结构化、可被 tool 精确调用的另一套）。
   *
   * 与 injectAgentDeckPlugin / agentTeamsEnabled 同模式：spawn-time 注入，关掉**只影响
   * 下次新建会话**——已起的 CLI 子进程已按这个 flag 启动 mcpServers / allowedTools，
   * 撤不掉。summarizer 走自己的 query() 不受本开关影响（设计与 sandbox 同隔离）。
   *
   * Closure 自动注入 team_name：每个 SDK 会话的 task_create / task_update / task_delete
   * 强制用当前 session.team_name（agent 不必也不能瞎传），避免任务漂到别的 team；
   * task_list / task_get 是只读，允许 args 显式跨 team 查询协调。
   */
  enableTaskManager: boolean;
  /**
   * Claude Code SDK 子进程的 OS 级沙盒档位（默认 'off'）。SDK 0.2.118 内置 sandbox 能力
   * （macOS Seatbelt / Linux bubblewrap），让用户在 UI 主动开启文件系统 + 网络 OS 级隔离。
   *
   * 三档语义：
   * - `'off'`：不启用沙盒，行为同现状（仅应用层 canUseTool 弹框决策）
   * - `'workspace-write'`：cwd 可写、用户敏感目录（~/.ssh / ~/.aws / ~/.config）只读、
   *   网络默认 deny；保留 `dangerouslyDisableSandbox` 逃逸路径（model fallback 时弹给用户审批）
   * - `'strict'`：cwd 只读、网络默认 deny + `failIfUnavailable: true`（沙盒不可用直接报错退出）
   *   + `allowUnsandboxedCommands: false`（封死 dangerouslyDisableSandbox 逃逸）
   *
   * 与 codex-cli 已默认的 `sandboxMode: 'workspace-write'` 对齐策略：默认 off 让用户主动开
   * （REVIEW_14 推荐路径阶段 2），观察 1-2 周用户反馈无异常后阶段 3 再考虑切默认 on。
   *
   * **关闭开关只影响下次新建会话**——已在跑的 SDK 子进程已按当前档位 spawn，sandbox 是
   * spawn-time options，不会被撤销（与 agentTeamsEnabled 同模式）。
   *
   * **summarizer 不被污染**：summarizer 走 `settingSources: []` + 自己 query() 调用，
   * 不读 sandbox 设置（与 agentTeamsEnabled 隔离同模式）。
   */
  claudeCodeSandbox: 'off' | 'workspace-write' | 'strict';
}

export const DEFAULT_SETTINGS: AppSettings = {
  hookServerPort: 47821,
  hookServerToken: null,
  enableSound: true,
  enableSystemNotification: true,
  silentWhenFocused: true,
  waitingSoundPath: null,
  finishedSoundPath: null,
  activeWindowMs: 30 * 60 * 1000,
  closeAfterMs: 24 * 60 * 60 * 1000,
  summaryIntervalMs: 5 * 60 * 1000,
  summaryEventCount: 10,
  summaryMaxConcurrent: 2,
  summaryTimeoutMs: 60 * 1000,
  permissionTimeoutMs: 5 * 60 * 1000,
  alwaysOnTop: true,
  transparentWhenPinned: true,
  startOnLogin: false,
  historyRetentionDays: 30,
  codexCliPath: null,
  injectAgentDeckClaudeMd: true,
  injectAgentDeckPlugin: true,
  agentTeamsEnabled: false,
  enableTaskManager: false,
  claudeCodeSandbox: 'off',
};

// ───────────────────────────────────────────────────────── Hook Status

export interface HookInstallStatus {
  installed: boolean;
  scope: 'user' | 'project' | null;
  settingsPath: string | null;
  installedHooks: string[];
}

// ───────────────────────────────────────────────────────── Permission Settings Scan

/**
 * Claude Code 的 settings 四层来源（与 SDK 实际读取行为对齐）。
 * 优先级低 → 高（高覆盖低）：
 * - user:       ~/.claude/settings.json
 * - user-local: ~/.claude/settings.local.json   ← 官方文档未明示，但 SDK / CLI 实际会读
 * - project:    <cwd>/.claude/settings.json
 * - local:      <cwd>/.claude/settings.local.json
 */
export type SettingsSource = 'user' | 'user-local' | 'project' | 'local';

/** 每层 settings.json 解析出的 permissions 字段（按 SDK schema 抽取，未知字段忽略）。 */
export interface SettingsPermissionsBlock {
  allow: string[];
  deny: string[];
  ask: string[];
  additionalDirectories: string[];
  defaultMode: string | null;
}

/** 单层 settings 文件的扫描结果。文件不存在也会返回（exists=false + raw=null）。 */
export interface SettingsLayer {
  source: SettingsSource;
  /** 推断出的绝对路径，无论是否存在 */
  path: string;
  exists: boolean;
  /** 原文（pretty-print 后），文件不存在为 null */
  raw: string | null;
  /** JSON.parse 结果，解析失败 / 文件不存在为 null */
  parsed: unknown | null;
  /** 解析失败时记错误消息 */
  parseError: string | null;
  /** 提取出的 permissions 块；不存在 / 解析失败时为 null */
  permissions: SettingsPermissionsBlock | null;
}

/** 合并视图：去重后每条规则带来源层标签。 */
export interface MergedRule {
  rule: string;
  sources: SettingsSource[];
}

export interface MergedDirectory {
  dir: string;
  sources: SettingsSource[];
}

export interface MergedPermissions {
  allow: MergedRule[];
  deny: MergedRule[];
  ask: MergedRule[];
  additionalDirectories: MergedDirectory[];
  /** 倒序找第一个非 null：local > project > user-local > user */
  defaultMode: { value: string; source: SettingsSource } | null;
}

export interface PermissionScanResult {
  /** 入参 cwd 原值（trim 后；为空时 main 进程会替换成 homedir，并在 cwdResolved 标记） */
  cwd: string;
  /** 实际用于解析 project / local 的 cwd（兜底为 homedir） */
  cwdResolved: string;
  user: SettingsLayer;
  /** ~/.claude/settings.local.json，user 级个人覆盖 */
  userLocal: SettingsLayer;
  project: SettingsLayer;
  local: SettingsLayer;
  merged: MergedPermissions;
}
