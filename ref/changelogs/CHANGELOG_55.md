# CHANGELOG_55: 跨平台兼容性 — Windows 支持基础设施

## 概要

REVIEW_21 跨平台兼容性双对抗 review 的修复落地。把应用从「macOS-only」推进到「macOS GA + Windows beta」：补齐 NSIS / portable 打包链路 + Win .cmd wrapper + 5 处硬编码 `/` 改用 `path.sep` / `path.basename`，让 Win 主机能 `pnpm install + pnpm dist:win` 出包并安装运行。Mac 端零回退（180 vitest 全过）。

## 变更内容

### 平台抽象层（新增）

#### `src/main/platform.ts`（新）
- 收口 `IS_DARWIN` / `IS_WIN` / `IS_LINUX` 常量，避免散落 `process.platform === '...'` 判断
- `encodeClaudeProjectDir(cwd)` 函数：把 `~/.claude/projects/<encodedDir>/` 路径编码统一收口（macOS/Linux 用 `/` split + `-` join；Win 推测同模式但用 `\` split）。预检假阴性时 SDK 兜底已有

### 路径分隔符 / 跨平台修复

#### `src/main/adapters/claude-code/sdk-bridge/recoverer.ts`
- `defaultResumeJsonlExists` 走 `encodeClaudeProjectDir` + `path.join`，不再用模板字面量拼 `/.claude/projects/...`
- 修注释说明跨 OS 假设 + recoverer.ts 兜底链路

#### `src/main/teams/team-watcher.ts`
- `dispatchByPath` 的 `teamDir + '/'` → `teamDir + sep`（import sep from 'node:path'），让 Win chokidar 反斜杠事件路径能匹配

#### `src/main/teams/team-coordinator.ts`
- `processConfigFile` + `processConfigUnlink` 的 `rest.split('/')` → `rest.split(sep)`
- `replace(/^\/+/, '')` → `replace(SEP_PREFIX_RE, '')`（自动适配 Win 反斜杠 + POSIX 正斜杠）

#### `src/main/session/manager-helpers.ts`
- `deriveTitle` 改用 `path.basename(cwd)`，跨平台处理尾分隔符 + 平台分隔符
- `normalizeCwd` 兜底分支用 `sep` 化的 RegExp 去尾分隔符

#### `electron.vite.config.ts`
- 5 处 `resolve('src/...')` → `resolve(__dirname, 'src/...')`：alias 不再依赖 `process.cwd()`

### notify Win 优化

#### `src/main/notify/sound.ts`
- `process.platform` 走 `IS_DARWIN` / `IS_LINUX` / `IS_WIN` 常量
- `isOurKill` 加注释说明 Win 上 `signal === 'SIGTERM'` 不可靠（Win32 `TerminateProcess` 不通过 POSIX signal 模型），必须靠 `\|\| err.killed === true` 兜底（现有代码已涵盖，加注释锁住设计）
- `playSystemBeep` 加 Win 分支：用 `powershell -NoProfile -Command [console]::beep(freq,ms)`，waiting 1000Hz/150ms / finished 600Hz/250ms 听感对齐 macOS Glass/Tink；Linux 保留 `\\x07` 兜底
- Win PowerShell PresentationCore 注释加「Win Server Core 缺 PresentationCore」已知限制

#### `src/main/notify/visual.ts`
- `dock.bounce` 走 `IS_DARWIN`，加注释说明 Win/Linux by-design no-op（dock 是 macOS 专属概念）

### Windows wrapper（新）

#### `resources/bin/agent-deck.cmd`（新，60 行）
- 三段 .exe fallback：`%AGENT_DECK_APP%` env > `%LOCALAPPDATA%\Programs\Agent Deck\Agent Deck.exe`（NSIS 默认装路径）> `%PROGRAMFILES%\Agent Deck\Agent Deck.exe`
- 与 macOS bash wrapper 行为对齐：自动补 `new` 子命令 + `--cwd "%CD%"`（无参数 / 首参 `--xxx` 两种触发）
- 找不到 .exe 报错退出 1
- 简化路径 vs cmd.exe quoting 限制：不做相对→绝对路径转换，依赖 `main/cli.ts` 的 `isAbsolute + resolve` 兜底；`--cwd` 缺值校验下放到主进程 `parseFlags` 抛错（已通过 `dialog.showErrorBox`）
- `extraResources` 已 copy `resources/bin/` 整目录，cmd 文件自动随 NSIS 安装包进 `<install_dir>/resources/bin/`，无需额外配置

### Win 打包配置

#### `package.json`
- `scripts.dist` 改默认平台（不写死 `--mac`）；新增 `dist:mac` / `dist:win` / `dist:linux` / `icon:gen`
- `build.win`：NSIS + portable 双 target，`icon: resources/icon.ico`，`artifactName: ${productName}-${version}-${arch}.${ext}`
- `build.nsis`：`oneClick=false` + `allowToChangeInstallationDirectory=true` 让用户能改装路径；`perMachine=false` 装到 `%LOCALAPPDATA%\Programs\Agent Deck`（与 wrapper 默认查路径对齐）；`shortcutName: "Agent Deck"`
- `build.linux`：AppImage target（顺手补，未单独验证）
- 新增 devDep `png-to-ico@^3.0.1`（ESM only，~5 KB；零运行时依赖）

#### `scripts/gen-icon-ico.mjs`（新）
- ESM 脚本，从 `resources/icon.png` 生成 `resources/icon.ico`（多尺寸合一：16/24/32/48/64/96/128/256）
- 跑法：`pnpm icon:gen`
- 生成产物 `resources/icon.ico`（279 KB）已提交进 git，避免 CI 跑生成增加构建时间

### 测试

#### `src/main/session/__tests__/manager-helpers.test.ts`（新，15 case）
- `deriveTitle` 6 case：POSIX 取 basename / 去尾斜杠 / Win 反斜杠（不崩 + 返回非空）/ 空 cwd / 单段路径 / 根路径 fallback
- `extractCwd` 3 case：从 payload 取 / 无 cwd / payload null
- `nextActivityState` 6 case：覆盖 6 个状态机分支

180 vitest case 全过（含新增 15）；26 case skip（task-repo.test 因 better-sqlite3 ABI 与 Node 24 不匹配 skip，与本次改动无关，CHANGELOG_42 已记录恢复方法）。

## 备注

- **Mac 端零回退**：dist:mac 配置不变；macOS dev / DMG / vibrancy / 毛玻璃 / dock / sound 全部按原行为
- **Win 端未端到端实测**：mac 主机受限，所有 Win 修复只保证「设计正确 + typecheck + 已有测试通过」；真实 Win 主机 E2E 留给 CI runner（REVIEW_21 A13 LOW）
- **Claude Code Win jsonl 编码规则推测**：`encodeClaudeProjectDir` 用 `path.sep` 是合理推断；预检失败时 SDK 兜底已有（recoverer.ts 既有 try/catch），不会硬崩
- **关联**：REVIEW_21 修复落地全集；agent-deck 平台支持矩阵更新见 README「## 平台支持矩阵」节
