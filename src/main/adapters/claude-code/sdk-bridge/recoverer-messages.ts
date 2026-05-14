/**
 * REVIEW_37 P1-B: recoverer.ts emit `payload.text` 文案 builder（6 个纯函数）。
 *
 * **抽离动机**：recoverer.ts recoverAndSend 内 6 个 emit 分支文案占 100+ 行，文案修订与
 * 控制流交织（哪个分支走哪个 emit 哪段文案）让 recoverer.ts 主路径阅读体验差。把文案
 * 拆出后 recoverer.ts 只剩 emit struct + 单调用 builder，复审「分支控制流」「文案措辞」
 * 解耦，降 recoverer.ts ~80-120 LOC。
 *
 * **形态**：module-level pure function，**不依赖** recoverer class state — 让单测可以
 * 直接 input/output 验证文案，不用起 facade / TestBridge。emit 时机 / payload 结构
 * （sessionId / agentId / kind / source / ts / error 字段）由 caller 在 recoverer.ts 内组装。
 *
 * **6 个分支对应**（recoverer.ts L222-272 outer + L370-455 inner 4 路）：
 * 1. `buildCwdMissingErrorText` — cwd 不存在且 fallback 全 miss（emit error: true，throw 前）
 * 2. `buildCwdFallbackInfoText` — cwd 不存在但 fallback 找到（emit info，附带可选 sandbox 警告）
 * 3. `buildJsonlMissingSummaryUsedText` — jsonl missing fallback + LLM 摘要成功
 * 4. `buildJsonlMissingSummarySkippedText` — jsonl missing fallback + LLM 摘要跳过/失败
 * 5. `buildCwdFallbackSummaryUsedText` — cwdFellBack=true fallback + LLM 摘要成功
 * 6. `buildCwdFallbackSummarySkippedText` — cwdFellBack=true fallback + LLM 摘要跳过/失败
 *
 * **不变量**：
 * - 纯函数，无副作用，输入决定输出
 * - 不引入新文案（行为零变化），仅平移 + 参数化
 * - 长文案用 template literal + `\n` 显式分行（便于 diff 审阅）
 *
 * **不抽** 的 emit：
 * - `⚠ SDK 通道已断开，正在自动恢复…` 单行字面量，没有参数化空间，留 recoverer.ts 内
 * - `⚠ 自动恢复失败：${err}` 单行 + err.message 内联，留 recoverer.ts 内
 */

/**
 * 1. cwd 不存在且 fallback 全 miss：emit error: true 然后 throw。
 *
 * 用于 recoverer.ts L222-235 分支。caller emit 时 `error: true`。
 */
export function buildCwdMissingErrorText(badCwd: string): string {
  return (
    `⚠ 此会话的 cwd 已不存在: ${badCwd}\n` +
    `应用尝试启发式 fallback (含 .claude/worktrees/ 路径反推 / 父目录 walk) 但未找到合适的替代目录。\n` +
    `请新建会话;或如确认这条会话不再需要,可右键归档。`
  );
}

/**
 * 2. cwd 不存在但 fallback 找到：emit info，附带可选 sandbox 边界变化警告。
 *
 * 用于 recoverer.ts L255-272 分支。caller emit 时不带 error: true（info 性质）。
 *
 * **sandboxMode 仅 'workspace-write' 触发警告**：off 档无 sandbox / strict 档完全只读
 * 没扩大风险，调用方传 rec.claudeCodeSandbox 进来本函数自己判定。
 *
 * REVIEW_36 R2 HIGH-B 修法的文案：fallback 后 SDK 子进程 chdir effectiveCwd，
 * sandbox.allowWrite 自动跟着切到 fallback 目录 → workspace-write 档下写权限边界**可能扩大**。
 * 透明告知用户决策（如安全敏感请右键归档新建会话）。
 */
export function buildCwdFallbackInfoText(opts: {
  badCwd: string;
  fallbackCwd: string;
  sandboxMode: 'off' | 'workspace-write' | 'strict' | null | undefined;
}): string {
  const { badCwd, fallbackCwd, sandboxMode } = opts;
  const needSandboxWarn = sandboxMode === 'workspace-write';
  return (
    `⚠ 此会话的原 cwd 已不存在: ${badCwd}\n` +
    `应用启发式 fallback 到: ${fallbackCwd}` +
    (needSandboxWarn
      ? `\n\n⚠ 沙盒边界已变化（workspace-write 档）：\n` +
        `   原写权限范围: ${badCwd}（已不存在）\n` +
        `   新写权限范围: ${fallbackCwd}（fallback 父目录，可能比原 worktree 范围大）\n` +
        `   如安全敏感（怕 agent 写入超出原 worktree 的文件），请右键归档此会话 + 新建会话从干净 cwd 重启。`
      : '')
  );
}

/**
 * 3. jsonl missing fallback + LLM 摘要成功：emit info（不带 error: true）。
 *
 * 用于 recoverer.ts L378-389 分支（cwdFellBack=false && summaryResult.used=true）。
 *
 * 文案告知用户：jsonl 已丢失但 LLM 摘要自动注入历史上下文，Claude 应能续上前情；
 * 如答非所问请下条消息补充关键背景。
 */
export function buildJsonlMissingSummaryUsedText(effectiveCwd: string): string {
  return (
    `⚠ 此会话的 CLI 内部对话历史(jsonl)已丢失: ${effectiveCwd}\n` +
    `应用通过 LLM 摘要自动注入了历史上下文(自 DB events 表),Claude 应能续上前情。\n` +
    `如答非所问,请下条消息补充关键背景。`
  );
}

/**
 * 4. jsonl missing fallback + LLM 摘要跳过 / 失败：emit info（不带 error: true）。
 *
 * 用于 recoverer.ts L399-412 分支（cwdFellBack=false && summaryResult.used=false）。
 *
 * 文案保留 CHANGELOG_106 原文案：典型原因 + 应用 DB 历史保留 + 请下条消息补充背景。
 */
export function buildJsonlMissingSummarySkippedText(effectiveCwd: string): string {
  return (
    `⚠ 此会话的 CLI 内部对话历史(jsonl)已丢失: ${effectiveCwd}\n` +
    `典型原因: 用户清理 ~/.claude/projects / 跨设备同步未带 jsonl / CLI 自身清理 / 应用重装。\n` +
    `应用 DB 的 SessionDetail 历史完整保留(本面板看到的对话仍在),但 Claude 这条新启动的 CLI ` +
    `不知前情。如要继续之前话题,请在下条消息里把背景再告诉它一次。`
  );
}

/**
 * 5. cwdFellBack=true fallback + LLM 摘要成功：emit info（不带 error: true）。
 *
 * 用于 recoverer.ts L423-434 分支（cwdFellBack=true && summaryResult.used=true）。
 *
 * **outer L255-272 已 emit cwd 切换 fact**，本分支补 emit「成功续上」详情。文案不再
 * 重复 cwd 信息，只补摘要注入结果（caller 已经独立 emit cwd 切换 message）。
 */
export function buildCwdFallbackSummaryUsedText(): string {
  return (
    `应用通过 LLM 摘要自动注入了历史上下文(自 DB events 表),Claude 应能在新 cwd 续上前情。\n` +
    `如答非所问,请下条消息补充关键背景。`
  );
}

/**
 * 6. cwdFellBack=true fallback + LLM 摘要跳过 / 失败：emit info（不带 error: true）。
 *
 * 用于 recoverer.ts L442-454 分支（cwdFellBack=true && summaryResult.used=false）。
 *
 * 与 #5 同样不重复 cwd 信息（caller 已 emit cwd 切换 message），只补摘要失败语义：
 * jsonl 在新 cwd 不可用 + 应用 DB 历史保留 + 请补背景。
 */
export function buildCwdFallbackSummarySkippedText(): string {
  return (
    `CLI 内部对话历史(jsonl)将丢失(原 cwd 编码下的 jsonl 在新 cwd 不可用)。\n` +
    `应用 DB 的 SessionDetail 历史完整保留,但 Claude 这条新启动的 CLI 不知前情。\n` +
    `如要继续之前话题,请在下条消息里把背景再告诉它一次。`
  );
}
