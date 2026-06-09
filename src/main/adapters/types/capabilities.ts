// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.9 拆分:adapter capabilities boolean flag 集合(纯 declaration)。
// 收纳:AdapterCapabilities。
// ────────────────────────────────────────────────────────────────────────────

export interface AdapterCapabilities {
  canCreateSession: boolean;
  canInterrupt: boolean;
  canSendMessage: boolean;
  canSteerTurn?: boolean;
  canInstallHooks: boolean;
  canRespondPermission: boolean;
  canSetPermissionMode: boolean;
  /**
   * 是否支持「冷切」权限模式：销毁旧子进程 + 用新 mode 重建。bypassPermissions 必须冷切，
   * 因为 SDK 的 `allowDangerouslySkipPermissions` flag 在子进程启动时锁死，运行时
   * setPermissionMode('bypassPermissions') 会被 SDK 静默吞。
   * Claude Code 桥接层支持；codex-cli / hook-only adapter 置 false。
   */
  canRestartWithPermissionMode: boolean;
  /**
   * 是否支持「冷切」codex sandbox 档位（CHANGELOG_<X> A2b）：销毁旧 codex thread + 用新
   * sandboxMode resume 重建。codex SDK 的 sandboxMode 是 startThread/resumeThread 一次性
   * 参数，运行时无法热切，必须冷切。仅 codex-cli adapter 置 true；其他 adapter 置 false。
   *
   * 与 canRestartWithPermissionMode 正交：codex 没有 PermissionMode 概念，
   * 这是 codex 专属的 capability。
   */
  canRestartWithCodexSandbox: boolean;
  /**
   * 是否支持「冷切」claude OS sandbox 档位（CHANGELOG_74）：销毁旧 SDK 子进程 + 用新档位
   * createSession resume 重建。SDK 的 sandbox options 是 query() spawn-time 锁定，无法热切。
   * 与 canRestartWithCodexSandbox 字面镜像。Claude Code 桥接层 adapter 置 true；其他 adapter 置 false。
   */
  canRestartWithClaudeCodeSandbox: boolean;
  /**
   * 删会话时 SessionManager 是否调 closeSession 彻底关闭 SDK 侧 live query/turn 与 pending Maps。
   * 与 canInterrupt 区别：interrupt 允许 resume / 复用 session；close 表示永久关闭。
   * SDK 通道有 internal session 的 adapter 都置 true（claude-code / deepseek-claude-code / codex-cli）；
   * 纯 hook-only adapter 置 false。
   */
  canCloseSession: boolean;
  /**
   * 是否支持作为 team member 接收 cross-adapter 消息（R3.E0 ADR §3.1 / E4 新增）。
   * - claude-code / deepseek-claude-code / codex-cli: true（SDK sendMessage 把外来文字塞进 user turn）
   *
   * UI 据此与 archived/closed 双条件决定 NewTeamMember dialog 是否暴露该 adapter。
   * 取代老 capability `canJoinTeam`（R3.E6 已删，仅 Claude experimental teams flag 触发器）。
   */
  canCollaborate: boolean;
  /**
   * REVIEW_35 HIGH-D2：是否支持图片附件（用户在 Composer 上传 / 粘 / 拖图）。
   * - claude-code / deepseek-claude-code / codex-cli: true（SDK content blocks 接收 image base64）
   *
   * UI 据此 gate Composer 的图片入口（隐藏上传按钮 + 不绑 onPaste/onDrop/onDragOver）+
   * send 入口拦截 attachments-only 请求（避免 imgs.clear 后用户失去 retry 能力）。
   */
  canAcceptAttachments: boolean;
}
