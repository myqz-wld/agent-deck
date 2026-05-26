---
review_id: 21
reviewed_at: 2026-05-04
expired: false
heterogeneous_dual_completed: true
skipped_expired:
  # 本轮 review 是「能否扩到 Win 平台」可行性 + 修复落地，未触发文件级过期复审
---

# REVIEW_21: 跨平台兼容性 — Windows 支持基础设施盘点

## 触发场景

用户主动评估「如果今天就要在 Windows 上跑 / 打包 / 分发，会撞到哪些硬伤、哪些半软伤、哪些其实已经覆盖好了」。两个工程（agent-deck + dev-config-hub）的 CLAUDE.md 都明确「macOS 环境」是设计基线，本轮目的是把所有 Win hard wall 列清楚 + 给出修复优先级，再决定要不要施工。

## 方法

**双对抗配对**（teammate 模式 + lead 三态裁决）：

- **reviewer-claude** (Opus 4.7 xhigh, teammate)：从代码 + 资料出发独立给两份工程 finding，每条 ✅/❌/❓ + HIGH/MED/LOW 标注 + `文件:行号` 证据 + 验证手段。
- **reviewer-codex** (gpt-5.5 xhigh, teammate wrapper)：同上独立路径，但走外部 codex CLI（异源原则）。

**反驳轮 1 次**：reviewer-claude 单方提 A-H3（better-sqlite3 / native binary Win prebuild HIGH）且自承「未实测、packaging 工程经验铁规」→ lead 调 reviewer-codex 反驳。codex 实地核查 5 个 package.json + ls codex-darwin-arm64 vendor 路径，证实 SDK `optionalDependencies` 完整列 win32 子包 + asarUnpack glob 对应 + PLATFORM_BINARY_MAP 含 win32 + better-sqlite3 11.10 prebuild 支持 win32-electron-v130 + sdk-runtime regex `[\\/]` 兼容 Win → 反驳成立 → 降为 LOW（仅 mac 主机交叉编译 Win 包受限，CI 配 win runner 即可，与 Win 运行时无关）。

**范围**：两个工程的所有「平台敏感」文件全审（path 处理 / shell 调用 / symlink / native binary 打包 / WebView 引擎 / macOS 专属 API），共 17 + 17 = 34 文件 / ~3900 行。

```text
(scope 见末尾 review-scope 块)
```

**约束**：
- 严重度判定基线：HIGH = Win 装不上 / 启动崩 / 核心 happy path 死掉；MED = 核心功能不可用但 app 不崩；LOW = 边角行为退化或体验差
- 弱断言关键词只允许出现在 *未验证* 条目里（recoverer.ts Win jsonl 编码规则未官方文档 → 降级 ❓ INFO 或 LOW）

## 三态裁决结果（agent-deck）

> Round 1 收齐 + 反驳轮 1 次后定稿。13 条裁决（含 ❌ 1 条）。

### ✅ 真问题（必修）

| # | 严重度 | 文件:行号 | 问题 | 验证手段 |
|---|---|---|---|---|
| A1 | HIGH | `package.json:11,98-103` | `dist` 写死 `--mac`；只有 `mac` 块（`dmg` target），无 `win` / `nsis` / `portable` / `msi` / `win.icon` / `.ico` | grep `"win":` `"linux":` `win\.icon` `"target": "nsis"` 全仓零命中；`resources/` 只有 `icon.png` 无 `.ico` |
| A2 | HIGH | `resources/bin/agent-deck:1` | wrapper 是纯 POSIX bash 脚本（shebang `#!/usr/bin/env bash` + 硬编码 `/Applications/...Contents/MacOS/Agent Deck`），Win 上 cmd/PowerShell 无法解析 | Read 全文 100 行 |
| A3 | HIGH | `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:258` | `cwd.split('/')` Win 反斜杠路径单元素数组 → `encodedDir` 错误 → claude-code resume jsonl 路径定位失败 → 30s fallback 必踩，断连恢复退化为新建 | grep + Read |
| A4 | MED | `src/main/teams/team-watcher.ts:90-91` | `teamDir + '/'` chokidar Win 反斜杠永不匹配 → team 子文件 add/change/unlink 全静默；renderer team 视图不更新 | Read + chokidar v3 path.normalize 行为 |
| A5 | MED | `src/main/teams/team-coordinator.ts:150,235` | `rest.split('/')` 同 A4 同源；team_name 反向同步到 sessions DB 失效 | Read |
| A6 | MED | `src/main/session/manager-helpers.ts:81` | `cwd.split('/')` `deriveTitle` Win 退化为完整绝对路径显示 | Read |
| A7 | MED | `src/main/window.ts:42-53` | `transparent` / `vibrancy` / `visualEffectState` / `titleBarStyle` 直接传 BrowserWindow，Win 静默 no-op 不崩；setVibrancy / invalidateLoop / setTransparentWhenPinned 三处都已 darwin gate | grep 4 处 darwin gate；by design，列为 MED 提示视觉退化（毛玻璃失效） |
| A8 | MED | `src/main/notify/sound.ts:128-145` | Win 用 `powershell -NoProfile -Command` + `Add-Type PresentationCore` + `MediaPlayer`；启动开销 ~200ms；Win Server Core 缺 PresentationCore（消费者 Win 装机即有） | Read + .NET Framework 文档 |
| A9 | LOW | `src/main/cli.ts:207` | darwin 才 `app.focus({steal:true})`；非 darwin 已有 `win.show()/win.focus()` 兜底，by design | Read |
| A10 | LOW | `src/main/notify/sound.ts:73-77` | `isOurKill` 看 `signal === 'SIGTERM'`，Win 上 `proc.kill()` signal 不可靠；现有 `\|\| err.killed === true` 已兜底，加注释说明 | Read |
| A11 | LOW | `src/main/notify/sound.ts:151-160` | 非 darwin fallback 写 `\\x07` 到 stdout，Win GUI 进程无终端附着听不到 → 改用 PowerShell `[console]::beep` | Read |
| A12 | LOW (❓) | `electron.vite.config.ts:10-11,18,26-28,34` | `resolve('src/...')` 不带 base，依赖 `process.cwd()`；dev/build 都从仓库根跑实际不出 bug；建议 `resolve(__dirname, ...)` | Read + Vite 行为推测，*未验证* 现场跑 |

### ❌ 反驳（不修）

| # | 严重度 | 文件:行号 | 问题 | 反驳依据 |
|---|---|---|---|---|
| A13 | HIGH→LOW | `package.json:24,89-97` | reviewer-claude 单提：better-sqlite3 / SDK win32 子包 prebuild + ABI 是否在 Win 真能跑 | reviewer-codex 反驳轮实地核查 5 个 package.json + ls vendor 路径 → SDK optionalDependencies 完整列 win32 + asarUnpack glob 对应 + PLATFORM_BINARY_MAP 覆盖 + better-sqlite3 11.10 prebuild 支持 win32-electron-v130；mac 主机看不到 win32 子包**是 optional deps 正确行为**，不是 bug。reviewer-claude 混淆「Win 原生构建」(✅ 正确) 与「mac 交叉编译 Win 包」(✗ 预期不可行)。降为 LOW，作为 CI 配置提示 |

### ❓ 部分 / 未验证

无（A12 已自降；A13 已被反驳）。

## 修复（CHANGELOG_55 落地）

按 phase 拆 5 commit：

### HIGH
1. **A3 (recoverer.ts:258)** + A4-A6 + A12 — Phase A0/A1：新增 `src/main/platform.ts` 收口 `IS_DARWIN/IS_WIN/IS_LINUX` + `encodeClaudeProjectDir`，5 处硬编码 `/` 改 `path.sep` / `path.basename` + `electron.vite.config.ts` 5 处 `resolve(__dirname, ...)` + 新增 `manager-helpers.test.ts` 15 case
2. **A2 (wrapper)** — Phase A3：新增 `resources/bin/agent-deck.cmd` Win wrapper，三段 .exe fallback + 自动补 `new` + `--cwd "%CD%"`
3. **A1 (packaging)** — Phase A4：`package.json` 加 `win` (NSIS+portable) / `nsis` / `linux` 块；`scripts.dist` 拆 `dist:mac/dist:win/dist:linux`；新增 `scripts/gen-icon-ico.mjs` + `pnpm icon:gen` 用 `png-to-ico` 从 `icon.png` 生成 `icon.ico`（279 KB，提交进 git）

### MED
4. **A7-A8** — Phase A2：sound.ts 走 `IS_DARWIN/IS_LINUX/IS_WIN` 常量；PresentationCore 加 Win Server Core 限制注释；window.ts 已 darwin gate by design 不动主体
5. **A10-A11** — Phase A2：`isOurKill` 加注释说明 Win SIGTERM 不可靠靠 `killed` 兜底；`playSystemBeep` 加 Win 分支用 PowerShell `[console]::beep`

### LOW
- **A12** 已合到 Phase A0/A1
- **A13** 不修，留作 CI 配置提示

### Linux 顺带（仅注释）
- `notify/sound.ts:111` paplay → aplay 链路 Wayland 无 PulseAudio 时脆弱（已有 fallback）
- `transparent: true` 在无合成器的老 X11 WM 必崩；现代 GNOME/KDE 都有

## 关联 changelog

- [CHANGELOG_55.md](../changelogs/CHANGELOG_55.md)：本轮修复落地

## 风险与已知限制

1. **Mac 主机无法端到端验证 Win**：所有 Win 修复只能保证「设计正确 + typecheck 过 + 已有测试通过」（180 vitest case 全过）；真实 Win 主机 E2E 留给 CI runner（A13 LOW，未来加 Win github-actions runner）
2. **Claude Code Win jsonl 编码规则未知**：`encodeClaudeProjectDir` 用 `path.sep` split 是合理推断，Anthropic SDK 实际是否同模式没官方文档；预检失败时 SDK 兜底已有（recoverer.ts 既有 try/catch），不会硬崩，最坏退化到「30s fallback」与现状无差
3. **png-to-ico devDep 引入**：~5 KB，零运行时依赖；作为 build-time tool 风险极低

## Agent 踩坑沉淀

无新增 agent-pitfall 候选（本轮是「跨平台基底」类工程性 review，没新发现 SDK / API 行为陷阱）。

```review-scope
package.json
electron.vite.config.ts
resources/bin/agent-deck
src/main/index.ts
src/main/window.ts
src/main/cli.ts
src/main/ipc/settings.ts
src/main/notify/sound.ts
src/main/notify/visual.ts
src/main/adapters/claude-code/sdk-runtime.ts
src/main/adapters/claude-code/settings-env.ts
src/main/adapters/codex-cli/sdk-bridge/codex-binary.ts
src/main/teams/team-fs.ts
src/main/teams/team-watcher.ts
src/main/teams/inbox-watcher.ts
src/main/session/manager-helpers.ts
src/main/adapters/claude-code/sdk-bridge/recoverer.ts
```
