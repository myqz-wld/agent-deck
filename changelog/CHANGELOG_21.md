# CHANGELOG_21: 安装流程加 ad-hoc codesign

## 概要

第一次装好 .app 后跑 `codesign -dvv` 看到签名 Identifier 是 `Electron`（来自 Electron 二进制 linker 阶段就 ad-hoc 签的，identifier 写死是 'Electron'）。这与 Info.plist 里 `CFBundleIdentifier = com.agentdeck.app` 不一致，会让 macOS 通知中心 / Gatekeeper 等系统服务在某些场景下按 'Electron' 注册而不是 'com.agentdeck.app'，导致用户在「系统设置 → 通知」里看到的应用名 / 权限设置错位。

修法：dist 后用 `codesign --force --deep --sign - "/Applications/Agent Deck.app"` 给整个 bundle 做 ad-hoc 自签，签名 Identifier 会以 Info.plist 的 CFBundleIdentifier 为准，拉回 `com.agentdeck.app`。

排查现象：用户「测试系统通知」按钮点了显示「已发送」，但 macOS 横幅出不来；用 osascript 直接发横幅也看不到，定位到是「专注模式 / Do Not Disturb」开着导致系统级 banner 全部静音。这和签名 Identifier 是两回事，但都是排查时一起暴露出来的问题，文档一起就位避免下次再踩。

## 变更内容

### CLAUDE.md「打包与本地安装」节
- 4 步流程改 5 步：在 `cp -R` 与 `xattr` 之间插入 `codesign --force --deep --sign -`
- 「打包配置已踩的坑」子节多一条：解释 codesign Identifier vs CFBundleIdentifier 不一致的影响，以及为什么必须重签

### README.md「安装到本机」节
- 同样把 4 步改 5 步（步号也对应 6.验证），加 ad-hoc codesign
- 末尾「不能改回去的设定」清单从 2 条扩到 3 条，把 codesign 列入

## 不在这次改动范围内
- Electron Notification 在专注模式下被静音是 macOS 行为，不打算在应用层兜底（用户开了专注模式就是想被打扰得少；强行旁路也违反用户意图）
- 之后若要做"专注模式下用其他通道兜底"（例如 dock badge / window flash），属于产品决策，新开 changelog
