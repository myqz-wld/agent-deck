# CHANGELOG_223 — jsonl 在的 restart resume 不再注入 DB 历史

## 变更类型
行为修复（撤回 CHANGELOG_221 的部分行为）

## 背景
CHANGELOG_221 为了解决「沙盒/权限冷重启后模型像丢了历史」，让**正常 jsonl 存在**的 restart resume 路径
也注入应用 DB 的历史摘要 + 最近原始对话。但 jsonl 在时 CLI `--resume`（Claude）/ resumeThread（Codex）
本就会从 thread jsonl 续上**完整**上下文，再额外拼一坨 DB 摘要 + 原始对话只会让模型把整段历史当成
一条新的用户输入 —— 与 221 想避免的「丢历史」是同一类副作用。

排查「容器丢 jsonl」时确认：OS 沙盒（macOS seatbelt / Linux bubblewrap）只包裹**单条 Bash/工具命令**，
不包裹写 jsonl 的宿主 CLI 进程；`~/.claude/projects/<cwd>/<cli>.jsonl` 对所有已追踪的 cli_session_id
（含 workspace-write 档）都真实存在 —— 沙盒并不会吞掉 jsonl。所以 jsonl 在时根本不需要靠 DB 续历史。

## 实现
- Claude `restart-controller.ts`：`restartWithPermissionMode` / `restartWithClaudeCodeSandbox` 的
  `fellBack=false`（jsonl 在）分支，createSession 的 `prompt` 改回原样透传 `handoffPrompt`
  （= `SDK_RESTART_RESUME_PROMPT` 内部恢复指令），删除 `buildRestartPrompt` 私有方法。
- Codex `restart-controller.ts`：`restartWithCodexSandbox` 同款 —— jsonl 在的正常 resume 分支
  `prompt` 改回 `handoffPrompt`。
- 删除已无引用的 `src/main/session/resume-history/restart-prompt.ts`（`buildRestartResumePrompt`）
  及 `resume-history/index.ts` 的对应导出。`injectResumeHistory` 保留 —— 仍由 **jsonl 缺失** 的
  fallback 路径（`maybeJsonlFallback` / `maybeCodexJsonlFallback`）使用。
- 行为边界不变：jsonl **缺失** 的 fallback 路径仍注入「总结段 + 原始对话段 + 当前消息」三段历史；
  冷重启发送的内部恢复指令文案（`SDK_RESTART_RESUME_PROMPT`，CHANGELOG_221 已替换旧硬编码
  「继续之前的会话」）保留不变；Claude restart close 跳过 recentlyDeleted 黑名单保留不变。

## 验证
- `pnpm typecheck` 通过。
- 更新单测：Claude `restart-controller-jsonl-precheck.test.ts` T1-pm/T1-sandbox 改为断言 jsonl 在时
  `createSession.prompt === SDK_RESTART_RESUME_PROMPT` 且**不**含 DB 摘要/原始对话；Codex
  `sdk-bridge.consume-fork.test.ts` restart-jsonl-在 用例同款改断言。
- 回归：`restart-controller-fork-rename` / `exit-plan-hotswitch-and-cancel-resolve` /
  Claude+Codex `sdk-bridge.recovery` / `resume-history/inject-history` 全绿（128 测）。
