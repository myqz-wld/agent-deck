# CHANGELOG_9: 打包 / 安装（dmg + codesign + pkill 三连）

## 概要

合并原 CHANGELOG_16（打包配置修复 + 安装流程文档化）+ CHANGELOG_21（ad-hoc codesign）+ CHANGELOG_26（pkill 旧进程避免 chunk hash 错配）。把「打包 + 安装到 /Applications + 清 quarantine + 软链 wrapper」的完整流程演进到当前的 5 步标准（pkill → dist → cp → codesign → xattr → 软链）。

## 变更内容

### 打包配置修复（原 CHANGELOG_16）

第一次跑 `pnpm dist` 踩两个坑：

- **`build.mac.icon` 加 `"resources/icon.png"`**：之前没指定时 electron-builder 默认查 `resources/icons/` 多分辨率 png 集（我们只有单文件 → 报 `icon directory ... doesn't contain icons` 整个 dmg 失败）
- **新增 `build.extraResources` 把 `resources/bin → bin`**：`directories.buildResources: "resources"` 让 resources/ 整体被当成构建资源目录而**不会**打进 .app；wrapper 必须靠 extraResources 显式 copy 到 `Agent Deck.app/Contents/Resources/bin/agent-deck`，否则 README 软链路径不存在
- 修了之后 dmg 132M 正常产出，wrapper 也在 .app 里
- `.gitignore` 加 `*.tsbuildinfo`：tsc 增量编译缓存不该入库

### ad-hoc codesign（原 CHANGELOG_21）

- 装好 .app 后跑 `codesign -dvv` 看到签名 Identifier 是 `Electron`（来自 Electron 二进制 linker 阶段就 ad-hoc 签的，identifier 写死是 'Electron'）。这与 Info.plist 里 `CFBundleIdentifier = com.agentdeck.app` 不一致，会让 macOS 通知中心 / Gatekeeper 在某些场景下按 'Electron' 注册而不是 'com.agentdeck.app'，导致用户在「系统设置 → 通知」里看到的应用名 / 权限设置错位
- dist 后用 `codesign --force --deep --sign - "/Applications/Agent Deck.app"` 给整个 bundle 做 ad-hoc 自签，签名 Identifier 会以 Info.plist 的 CFBundleIdentifier 为准，拉回 `com.agentdeck.app`
- 排查时一起暴露的：用户「测试系统通知」按钮显示「已发送」但 macOS 横幅出不来 —— 是「专注模式 / Do Not Disturb」开着导致系统级 banner 全部静音（与签名 Identifier 是两回事，文档一起就位避免下次再踩）

### pkill 旧进程避免 chunk hash 错配（原 CHANGELOG_26）

- 实测翻车一次：早上 12:11 重新 dist + cp 覆盖到 /Applications，但旧 main 进程从昨天起一直没退（pid 2398，Tue 10AM 启动），后续点 dock 图标 macOS 复用了那个旧实例。旧 renderer 还引用着旧 hash 的 chunk 文件名（`index-OLDHASH.js`），新 .app 里只剩新 hash 的 `index-BSJIHkwr.js`，触发 `TextDiffRenderer.tsx` 里 `import('@monaco-editor/react')` 的 dynamic import 拿到错的内容，整段 monaco-editor/react Editor 组件 minified 源码（`reactExports.useEffect / o.current.editor.create / ...`）被 webview 当 plain text 渲染到窗口里
- 把「重装前 pkill 旧实例」补成 CLAUDE.md「打包与本地安装」流程的第 0 步：`pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck"` + `pkill -f "Agent Deck Helper"`
- 强调不要靠点 dock 红点退出（后台 helper / utility 进程不一定跟着走）

### 当前 5 步流程文档（CLAUDE.md + README.md）

```bash
# 0. pkill 旧进程
pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null
pkill -f "Agent Deck Helper" 2>/dev/null

# 1. 打包
rm -rf release && pnpm dist

# 2. 覆盖安装
rm -rf "/Applications/Agent Deck.app"
cp -R "release/mac-arm64/Agent Deck.app" /Applications/

# 3. ad-hoc 重签
codesign --force --deep --sign - "/Applications/Agent Deck.app"

# 4. 清 quarantine
xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"

# 5. 软链 wrapper
ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck
```

「不能改回去的设定」清单：mac.icon / extraResources / ad-hoc codesign / pkill 旧进程。

## 备注

- 不在 dist 脚本里自动 pkill：`pnpm dist` 只负责打包出 dmg，覆盖安装是后续步骤；脚本化反而让用户绕过踩坑上下文
- 不靠 single-instance lock 让旧进程主动退：`requestSingleInstanceLock` 的语义是「新启动的实例发现自己是第二个就退」，不是「让旧实例自杀让位给新版本」
- Electron Notification 在专注模式下被静音是 macOS 行为，不打算在应用层兜底（用户开了专注模式就是想被打扰得少）
- 后续 SDK / codex native binary 的 `asarUnpack` 配置见 CHANGELOG_14（codex）/ CHANGELOG_15（claude）
