# CHANGELOG_57: 设置面板文案统一与平台分流；Header 新增「📚 资产库」

## 概要

设置面板文案中英不统一、Mac/Win 描述混在一起、自带 agents/skills/CLAUDE.md 藏在
toggle 描述里硬讲技术细节——这次一次收口：

- **文案**：Section 标题与字段 label 统一中文（必要时括号注英文术语），全 renderer
  的术语与设置面板对齐（StatusBadge / SummaryView / Teammate 大小写）
- **平台分流**：preload 暴露 `process.platform` 静态字段 → renderer 用
  `IS_DARWIN/IS_WIN/IS_LINUX` 条件渲染；4 处明显「混 Mac/Win」描述按当前平台只显示对应版本
- **资产库**：Header 新增「📚 资产库」按钮 → 独立 Dialog 集中展示「内置（agent-deck plugin）+
  用户自定义（~/.claude/{agents,skills}/）」两类资产，并支持新建 / 编辑 / 删除用户
  agent / skill；设置面板里两个 toggle 描述瘦身，「详情见资产库」一句话带过

附加：SettingsDialog 532 行 → 拆 9 个 sections 子文件 + 主文件 ≤ 200 行（CLAUDE.md
软上限 ≤ 500 行）。

## 变更内容

### `src/preload/`

- `index.ts:25` 加静态字段 `platform: process.platform as NodeJS.Platform`
  （preload 进程能直接读 `process.platform` 全局，常量值零成本，不必走 invoke）
- 加 6 个 assets IPC facade：`listBundledAssets / listUserAssets / getAssetContent /
  saveUserAsset / deleteUserAsset / revealAssetInFolder`

### `src/shared/`

- `ipc-channels.ts` 加 6 个 `Assets*` channel 常量
- `types/assets.ts`（新建）：`AssetKind / AssetSource / AssetMeta / UserAssetInput /
  BundledAssetsSnapshot / UserAssetsSnapshot / AssetContentResult`
- `types.ts` barrel re-export 增 `./types/assets`

### `src/main/`

- `bundled-assets.ts`（新建）：启动时一次性扫 `getAgentDeckPluginPath()` 下
  `agents/*.md` + `skills/*/SKILL.md`，手写正则解析 frontmatter 4 字段缓存到模块级
  variable；`getBundledAssets / getBundledAssetContent / getBundledAssetPath` 三 API
- `user-assets.ts`（新建）：扫 `~/.claude/{agents,skills}/` + `saveUserAsset` 原子写
  （write tmp + rename，复用 `sdk-injection.ts:151-159` `saveUserAgentDeckClaudeMd` 模式）+
  `deleteUserAsset`（skill 子目录 rmSync recursive，agent unlinkSync）
- `ipc/assets.ts`（新建）：注册 6 个 handler，入参 `parseKind / parseSource /
  parseAssetName / parseUserAssetInput` 严格校验（slug `[a-z0-9-]+` 长度 1-64，防越权）
- `ipc/index.ts`：register 列表加 `registerAssetsIpc`
- `index.ts:134` `bootstrapIpc()` 之后调 `loadBundledAssets()` 预热缓存

### `src/renderer/`

- `lib/platform.ts`（新建）：导出 `PLATFORM / IS_DARWIN / IS_WIN / IS_LINUX`，与
  `src/main/platform.ts:8-10` 命名对齐，跨进程心智一致
- `components/SettingsDialog.tsx`：从 532 行瘦身到 ~200 行（外壳 + dirty guard +
  IPC + section 编排），新增 `onOpenAssetsLibrary` prop
- `components/settings/sections/`（新建目录，9 个文件）：`HookSection / NotifySection /
  LifecycleSection / SummarySection / WindowSection / HookServerSection /
  ExternalToolsSection / ClaudeMdSection / PluginAssetsSection / ExperimentalSection`
  - **WindowSection**：B3 #1 透明窗口描述按 `IS_DARWIN` 分流（mac 显示 `vibrancy` 详情，
    其他平台显示「无 vibrancy 效果」）
  - **ExperimentalSection**：B3 #2/#3 Claude 沙盒按 `IS_DARWIN || IS_LINUX` 分流（mac/linux
    显示 Seatbelt/bubblewrap + 敏感目录例；Win 显示「不支持 OS 级沙盒」短句）
  - **ClaudeMdSection / PluginAssetsSection**：B5 描述瘦身——删大段技术罗列，加
    「在资产库中查看 ↗ / 查看内置资产 ↗」按钮
- `components/AssetsLibraryDialog.tsx`（新建）：三 Tab（Skills / Agents / 应用约定）+
  内嵌 `ContentViewerModal`（查看完整 md 文本只读）+ 内嵌 `AssetCard / AssetsTab /
  ClaudeMdTab` sub-component
- `components/assets/AssetEditor.tsx`（新建）：用户自定义 agent / skill 编辑器
  modal，name / description / model（agent only，opus/sonnet/haiku 下拉）/ tools
  （agent only）/ body 字段，含 dirty + slug 校验
- `components/StatusBadge.tsx`：B4 术语收口——`closed` → `关闭`、`休眠中` → `休眠`，
  顶部加术语注释引用 CHANGELOG_57
- `components/SummaryView.tsx`：B4 术语收口——`Summarizer` → `间歇总结`，加术语注释
- `App.tsx`：增 `assetsLibraryOpen` state + Header 加 `📚 资产库` IconButton + 挂载
  `<AssetsLibraryDialog />`，`<SettingsDialog />` 加 `onOpenAssetsLibrary` prop

## 备注

- **改 preload 必须重启 dev**（HMR 不能 reload preload）。`window.api.platform` 字段
  在 dev 模式下首次启动后才生效；renderer console 输入应见 `'darwin' | 'win32' | 'linux'`
- **用户自定义 agent/skill 文件路径**与 Claude Code SDK `settingSources: ['user', ...]`
  自动加载约定一致，无额外注入逻辑——文件落盘后下次新建 SDK 会话自动可见
- **术语统一表**（B4.2，详见 plan：mac-mac-win-win-agent-deck-agents-skill-purring-sifakis.md）
  作为新约定 candidate 写入 `.claude/conventions-tally.md` 用户反馈候选 count=1，
  下次同主题反馈再 +1，count ≥ 3 时升级到项目 CLAUDE.md「项目特定约定」节
- **reviewer 双对抗 3 轮 review 闭环**：见 `reviews/REVIEW_22.md`。teammate 模式
  in-process backend 全程（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 wrapper），
  3 轮 + 1 反驳轮挖出 1 HIGH（dirty 契约绕过）+ 7 MED（含 frontmatter 多行 round-trip 数据丢失 +
  YAML 注入嵌套 frontmatter + race / lifecycle）+ 6 LOW，全修；R2 fix 引入 unquoteValue
  顺序 bug（双方独立 node 实测复现），改 char-by-char state machine + 加 15 vitest case
  守门；R3 双方 ✅ 可合 0 阻塞收敛收口
- **后续未做项**：
  - 内置资产「复制为我的副本」按钮（点击把 agent-deck plugin 内置 agent / skill 复制
    到 `~/.claude/<kind>/<name>/` 让用户在副本上改）
  - 用户自定义资产 frontmatter 高级字段（如 skill 的 `allowed-tools`）
  - 资产库列表搜索 / 过滤
  - dev/prod bundled cache 策略发散（REVIEW_22 R2-F5 LOW 设计取舍，dev 重扫 ms 级）
  - bundled 字面引号歧义（REVIEW_22 R2-F3 LOW，bundled 4 文件无此模式留备忘）
  - UTF-8 BOM / 全角冒号兼容（REVIEW_22 R2-Q1 LOW❓，罕见）
