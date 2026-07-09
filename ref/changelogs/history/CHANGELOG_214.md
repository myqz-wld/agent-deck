# CHANGELOG_214

## bypassPermissions 被 SDK system.init 覆盖修复

### 根因

SDK CLI 内部用 `allowDangerouslySkipPermissions` 布尔 flag 实现 bypass，不把 `bypassPermissions` 当 mode 回传；`system.init` 帧始终携带 `permissionMode='default'` 作为底层模式。`sdk-message-translate.ts` 无差别同步，导致：

1. `internal.permissionMode` 被从 `bypassPermissions` 覆盖成 `default`
2. `canUseTool` bypass 短路（`getPermissionMode() === 'bypassPermissions'`）失效，退回普通权限弹框
3. `sessionRepo.setPermissionMode` 将 `'default'` 写入 DB，会话详情权限下拉始终显示「每次询问」

### 修复

`sdk-message-translate.ts` 处理 `system.init/status` permissionMode 同步时，增加保护：若当前 `internal.permissionMode === 'bypassPermissions'` 且 SDK 回报 `'default'`，跳过覆盖。

用户通过下拉主动切换时，`setPermissionMode` 先 optimistic 写 `s.permissionMode`，SDK `system.status` 到达时 internal 已不是 `bypassPermissions`，不受此保护影响，行为不变。

### 验证

```bash
# 打包安装后：
unset ELECTRON_RUN_AS_NODE
"/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" new --cwd "$PWD" --prompt "ping"
# DB 查询应显示 permission_mode = 'bypassPermissions'
sqlite3 ~/Library/Application\ Support/Agent\ Deck/agent-deck.db \
  "SELECT permission_mode FROM sessions ORDER BY started_at DESC LIMIT 1;"
```
