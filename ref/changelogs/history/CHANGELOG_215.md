# CHANGELOG_215

## second-instance argv 解析修复（Chromium 重排问题）

### 根因

Electron `second-instance` 事件传递的 `commandLine` 经过 Chromium 处理：所有 `--flag` token 前置、所有值后置，且混入 Chromium 内部 flag（如 `--allow-file-access-from-files`）。`parseCliInvocation` 依赖 key-value 相邻假设，结果所有字段解析为 `undefined`，导致 `permissionMode`、`cwd`、`prompt` 全部丢失。

### 修法

- `index.ts`：`app.requestSingleInstanceLock({ argv: process.argv })` — 把原始未重排的 `process.argv` 通过 `additionalData` 传给第一个实例。
- `lifecycle-hooks.ts`：`second-instance` handler 优先读 `additionalData.argv`（原始 argv），不可用时 fallback `commandLine`（兼容不传 additionalData 的旧实例）。

### 影响

修复前所有通过 `agent-deck new` CLI wrapper 触发的 second-instance 会话：
- `--permission-mode` 不生效（包含 wrapper 自动注入的 `bypassPermissions`）
- `--cwd` 不生效（退化到 homedir）
- `--prompt` 不生效（退化到 `'你好'` 默认值）

### 验证

```bash
unset ELECTRON_RUN_AS_NODE
"/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" new --cwd "$PWD" --prompt "ping"
sqlite3 ~/Library/Application\ Support/Agent\ Deck/agent-deck.db \
  "SELECT permission_mode, cwd FROM sessions ORDER BY started_at DESC LIMIT 1;"
# 应显示 bypassPermissions | /Users/.../repo-dir
```
