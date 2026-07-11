/** Pure user-facing recovery message builders. */
export function buildCwdMissingErrorText(badCwd: string): string {
  return (
    `⚠ 此会话的 cwd 已不存在: ${badCwd}\n` +
    `应用尝试启发式 fallback (含 .claude/worktrees/ 路径反推 / 父目录 walk) 但未找到合适的替代目录。\n` +
    `请新建会话;或如确认这条会话不再需要,可右键归档。`
  );
}

export function buildCwdFallbackInfoText(opts: {
  badCwd: string;
  fallbackCwd: string;
  sandboxMode: 'off' | 'workspace-write' | 'strict' | null | undefined;
}): string {
  const { badCwd, fallbackCwd, sandboxMode } = opts;
  return (
    `⚠ 此会话的原 cwd 已不存在: ${badCwd}\n` +
    `应用启发式 fallback 到: ${fallbackCwd}` +
    (sandboxMode === 'workspace-write'
      ? `\n\n⚠ 沙盒边界已变化（workspace-write 档）：\n` +
        `   原写权限范围: ${badCwd}（已不存在）\n` +
        `   新写权限范围: ${fallbackCwd}（fallback 父目录，可能比原 worktree 范围大）\n` +
        `   如安全敏感（怕 agent 写入超出原 worktree 的文件），请右键归档此会话 + 新建会话从干净 cwd 重启。`
      : '')
  );
}

export function buildJsonlMissingContextRestoredText(effectiveCwd: string): string {
  return (
    `⚠ 此会话的 CLI 内部对话历史(jsonl)已丢失: ${effectiveCwd}\n` +
    `应用已自动生成会话续接上下文，Claude 应能续上前情。\n` +
    `如答非所问,请下条消息补充关键背景。`
  );
}

export function buildJsonlMissingInstructionOnlyText(effectiveCwd: string): string {
  return (
    `⚠ 此会话的 CLI 内部对话历史(jsonl)已丢失: ${effectiveCwd}\n` +
    `典型原因: 用户清理 ~/.claude/projects / 跨设备同步未带 jsonl / CLI 自身清理 / 应用重装。\n` +
    `应用 DB 的 SessionDetail 历史完整保留,但本次会话续接上下文只能保留当前指令。` +
    `如要继续之前话题,请在下条消息里补充背景。`
  );
}

export function buildCwdFallbackContextRestoredText(): string {
  return (
    `应用已自动生成会话续接上下文，Claude 应能在新 cwd 续上前情。\n` +
    `如答非所问,请下条消息补充关键背景。`
  );
}

export function buildCwdFallbackInstructionOnlyText(): string {
  return (
    `CLI 内部对话历史(jsonl)将丢失(原 cwd 编码下的 jsonl 在新 cwd 不可用)。\n` +
    `本次会话续接上下文只能保留当前指令;如要继续之前话题,请在下条消息里补充背景。`
  );
}

export function buildRestartJsonlMissingContextRestoredText(label: string, cwd: string): string {
  return (
    `⚠ 此会话的 CLI 内部对话历史(jsonl)已丢失: ${cwd}\n` +
    `应用已自动生成会话续接上下文，Claude 应能续上前情,已切到 ${label}。\n` +
    `如答非所问,请下条消息补充关键背景。`
  );
}

export function buildRestartJsonlMissingInstructionOnlyText(label: string, cwd: string): string {
  return (
    `⚠ 此会话的 CLI 内部对话历史(jsonl)已丢失: ${cwd}\n` +
    `典型原因: 用户清理 ~/.claude/projects / 跨设备同步未带 jsonl / CLI 自身清理 / 应用重装。\n` +
    `本次会话续接上下文只能保留当前指令(已切到 ${label});` +
    `如要继续之前话题,请在下条消息里补充背景。`
  );
}
