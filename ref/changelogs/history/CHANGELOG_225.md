# CHANGELOG_225 — CLI wrapper payload 修复权限 flag 再次丢失

## 概要

修复 `agent-deck new` 通过 macOS CLI wrapper 新建 Claude 会话时，又回到每次询问权限的问题。

现场日志确认：Electron `second-instance` 入口的 `additionalData` 为 `null`，同时 `commandLine` 被 Chromium 重排为 `--cwd --prompt --permission-mode ... new <cwd> <prompt> <mode>`。旧解析器只读取 `new` 后的 token，导致 wrapper 自动补的 `--permission-mode bypassPermissions` 丢失，SDK 按 `default` 启动。

## 变更

- `resources/bin/agent-deck`：对 `new` 子命令把归一化后的 argv 用 NUL 分隔后 base64 成单个非 `--flag` payload，调用 `.app` 时只传 `new <payload>`，避开 Electron switch 重排。
- `src/main/cli-argv-payload.ts`：新增 payload 解码 helper，只接受紧跟 `new` 后的内部 token，避免误把普通 prompt 当 payload。
- `src/main/cli.ts`：`handleCliArgv` 在 `parseCliInvocation` 前先 unwrap payload，后续创建会话逻辑保持不变。
- 清理 `src/main/index/lifecycle-hooks.ts` 里的临时 `[DEBUG-perm]` 排查日志。

## 验证

- `pnpm exec vitest run src/main/__tests__/cli-argv-payload.test.ts`
- `bash -n resources/bin/agent-deck`
- `pnpm typecheck`
