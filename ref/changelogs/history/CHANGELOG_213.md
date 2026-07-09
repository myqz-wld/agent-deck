# CHANGELOG_213

## CLI wrapper 默认 bypassPermissions

### 概要

`agent-deck new` 不带 `--permission-mode` 时，wrapper 自动注入 `--permission-mode bypassPermissions`，与 Dialog 新建会话的默认行为对齐。

### 变更内容

- `resources/bin/agent-deck`：新增 `HAS_PERMISSION_MODE` 检测；`new` 子命令且未传 `--permission-mode` 时，自动追加 `--permission-mode bypassPermissions`。
- 用户仍可显式传 `--permission-mode default|acceptEdits|plan` 覆盖。
- resume / recoverAndSend 路径不受影响（已从 sessionRepo 读回 `permissionMode`，本改动仅影响首次建会话写入 DB 的值）。

### 验证

```bash
unset ELECTRON_RUN_AS_NODE
"/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" new --cwd "$PWD" --prompt "ping"
# 新建会话应以 bypassPermissions 启动，无权限询问弹框
```
