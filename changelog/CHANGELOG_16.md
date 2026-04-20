# CHANGELOG_16: 打包配置修复 + 安装流程文档化

## 概要

第一次跑 `pnpm dist` 踩了两个坑：dmg 打不出来、wrapper 没进 .app。修了 `package.json` 的 `build` 字段，并把"打包 + 安装到 /Applications + 清 quarantine + 软链 wrapper"的完整流程写进 CLAUDE.md 与 README.md，避免下次重蹈覆辙。顺带去掉 CLAUDE.md 里残留的 `~/Repository/personal/agent-deck` 个人绝对路径。

## 变更内容

### package.json（build 字段）
- `build.mac.icon` 加 `"resources/icon.png"`：之前没指定时 electron-builder 默认查 `resources/icons/` 下多分辨率 png 集，我们只有单文件 → 报 `icon directory /.../resources/icons doesn't contain icons` 然后整个 dmg 失败
- 新增 `build.extraResources` 把 `resources/bin → bin`：`directories.buildResources: "resources"` 让 resources/ 整体被当成构建资源目录而**不会**打进 .app；wrapper 必须靠 extraResources 显式 copy 到 `Agent Deck.app/Contents/Resources/bin/agent-deck`，否则 README 里教的软链路径不存在
- 修了之后 dmg 132M 正常产出，wrapper 也在 .app 里

### CLAUDE.md
- 第 161 行 `cd ~/Repository/personal/agent-deck && pnpm dev` 改成单行 `pnpm dev`（个人绝对路径不应在公开仓库的硬性约定里出现）
- 在「验证流程」节后新增「打包与本地安装（macOS）」节：
  - 完整 4 步：dist / 覆盖 cp / xattr / ln 软链
  - 「打包配置已踩的坑」子节列出 mac.icon 与 extraResources 的两个必备设定 + 没签名时 quarantine 的处理
  - 「验证」子节用 wrapper 跑一条 `agent-deck new --cwd "$PWD" --prompt "ping"` 确认链路通

### README.md
- 「类型检查 / 构建 / 打包」代码块的 dist 注释补 `+ release/mac-arm64/Agent Deck.app`，让人知道两个产物
- 新增「安装到本机（macOS，非签名）」节，与 CLAUDE.md 的步骤一致但更面向"使用者"，并显式指向 CHANGELOG_16 说明 mac.icon / extraResources 这两条不能回退

### .gitignore
- 加 `*.tsbuildinfo`：tsc 增量编译缓存不该入库（首次 git add 时被误纳入，本次一并修）
