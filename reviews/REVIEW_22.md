---
review_id: 22
reviewed_at: 2026-05-06
expired: false
skipped_expired: []
---

# REVIEW_22: CHANGELOG_57 资产库 + 平台分流 + 文案统一 — 三轮异构对抗

## 触发场景

CHANGELOG_57 一次落地大量改动（设置面板拆 9 sections + Header 新增「📚 资产库」Dialog 含用户自定义 agents/skills CRUD + 平台分流 4 处 + 全局术语收口 + 6 个新 IPC channel + 新 main 模块 bundled-assets/user-assets/ipc/assets），合计 ~22 文件代码改动 + ~2000 行新增/重构。属 CLAUDE.md「关键路径 + 跨多模块 + ≥ 200 行 + ≥ 5 文件」边界，落地后用户主动触发 `/agent-deck:deep-code-review` 走完整对抗 review 闭环（teammate 模式 in-process backend，3 轮 + 1 反驳轮）。

## 方法

**双对抗配对**（默认 Agent Teams 模式 in-process teammate，不退 Fallback subagent）：
- reviewer-claude（Opus 4.7 xhigh）— 同 message spawn，team_name=`deep-review-cl57`
- reviewer-codex（claude-code wrapper，内部 Bash 跑外部 codex CLI gpt-5.5 xhigh）— 同 message spawn

3 轮（`R_1` / `R_2` / `R_3`）+ 1 反驳轮（`B_1_1`，单方独有 HIGH F1 强制触发）。同一对 teammate 全程复用 context，sendMessage 复用上轮 mental model + 上轮 finding 推理链。

**范围**：22 文件全审，~2000 行改动 + 新建。

```text
新建 (10):
- src/renderer/lib/platform.ts
- src/renderer/components/AssetsLibraryDialog.tsx
- src/renderer/components/assets/AssetEditor.tsx
- src/renderer/components/settings/sections/{Hook,Notify,Lifecycle,Summary,Window,HookServer,ExternalTools,ClaudeMd,PluginAssets,Experimental}Section.tsx (10 个)
- src/main/bundled-assets.ts
- src/main/user-assets.ts
- src/main/ipc/assets.ts
- src/shared/types/assets.ts
- src/main/utils/frontmatter.ts (R2 fix 期间新建)
- src/main/utils/__tests__/frontmatter.test.ts (R2 fix 期间新建)

修改 (12):
- src/preload/index.ts
- src/shared/ipc-channels.ts
- src/shared/types.ts
- src/main/index.ts
- src/main/ipc/index.ts
- src/renderer/components/SettingsDialog.tsx (532→200 行 + R1 F1 fix)
- src/renderer/components/StatusBadge.tsx (B4 术语)
- src/renderer/components/SummaryView.tsx (B4 术语)
- src/renderer/App.tsx
- README.md, changelog/INDEX.md, .claude/conventions-tally.md
```

**机器可读范围**（File-level Review Expiry 用；一行一个相对路径，按字典序、去重；禁止目录 / glob / brace expansion）：

```review-scope
src/main/bundled-assets.ts
src/main/index.ts
src/main/ipc/assets.ts
src/main/ipc/index.ts
src/main/user-assets.ts
src/main/utils/frontmatter.ts
src/preload/index.ts
src/renderer/App.tsx
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/StatusBadge.tsx
src/renderer/components/SummaryView.tsx
src/renderer/components/assets/AssetEditor.tsx
src/renderer/components/settings/sections/ClaudeMdSection.tsx
src/renderer/components/settings/sections/ExperimentalSection.tsx
src/renderer/components/settings/sections/ExternalToolsSection.tsx
src/renderer/components/settings/sections/HookSection.tsx
src/renderer/components/settings/sections/HookServerSection.tsx
src/renderer/components/settings/sections/LifecycleSection.tsx
src/renderer/components/settings/sections/NotifySection.tsx
src/renderer/components/settings/sections/PluginAssetsSection.tsx
src/renderer/components/settings/sections/SummarySection.tsx
src/renderer/components/settings/sections/WindowSection.tsx
src/renderer/lib/platform.ts
src/shared/ipc-channels.ts
src/shared/types.ts
src/shared/types/assets.ts
```

**约束**：CHANGELOG_50/51/52 拆分轮已审过的文件不再重复审；reviewer agent body 已固化「能验证优先实践验证 / 弱断言降级 / 不写文件 / 不 commit」纪律。

## 三态裁决结果

> 本节遵循全局「决策对抗」节的验证纪律：每条 ✅ 必须带验证手段（grep / 写小 test / 跑命令 / 读真实代码），未验证的 finding 强制降级 ❓ + 非 HIGH。弱断言关键词只允许出现在 *未验证* 条目里。

### Round 1 — 浅层 + 5 focus 维度（reviewer-claude 14 ✅ + 3 ❓ / reviewer-codex 5 ✅ + 1 ❓ + 7 主动反驳）

#### ✅ 真问题

| # | 严重度 | 文件:行号 | 问题 | 双方/单方 | 验证手段 |
|---|---|---|---|---|---|
| F1 | HIGH | SettingsDialog.tsx + ClaudeMdSection + PluginAssetsSection + ClaudeMdEditor + App.tsx | 「在资产库中查看 ↗」按钮静默丢 CLAUDE.md 草稿（绕过 guardedClose）—— SettingsDialog return null → ClaudeMdEditor unmount → cleanup `onDirtyChange?.(false)` 重置 ref → 草稿无确认丢失 | claude 独有 → **反驳轮 B_1_1 → codex 同意 ✅ HIGH** | claude 跨 4 文件 chain trace；codex 反驳轮 4 步逐一在真实代码 verify |
| F2 | MED | user-assets.ts:90,179 (stringifyFrontmatter) | description 含换行 round-trip 数据丢失（`description: line1\nline2` 写盘后 parseFrontmatter 单行 regex 静默丢 line2） | 双方 ✅ | 双方独立 node 实测复现 |
| F3 | MED | user-assets.ts + ipc/assets.ts | description/tools/model 字段能注入 `\n---\n` 串成嵌套 frontmatter 块 | claude 独有 ✅ | claude node 实测：`description: 'x\n---\nname: hijacked'` → 落盘文件出现两个 frontmatter block |
| F4 | MED | ipc/assets.ts:52-64 (parseUserAssetInput) | IPC 层无 size/charset 校验：description/body/tools/model 仅 typeof 检查，无 length cap，body 可塞 100MB 阻塞 main 同步 fs | claude 独有 ✅ | claude grep 该文件确认无 length cap，对照 _helpers.ts:39-47 parseStringId 模板 |
| F5 | MED | AssetsLibraryDialog.tsx:70-76 (openViewer) | viewer 切换 race—— `setViewer({asset, content:null})` 后 await getAssetContent，then 闭包用旧 asset；A 慢响应到达后覆盖 B 视图 | 双方 ✅ | 双方读代码直证 closure 捕获，无 abort flag / seq guard |
| F6 | MED | AssetsLibraryDialog.tsx:42-46,78 | 关闭 dialog 后 viewer/editor state 残留（`if (!open) return null` 只是不 render，state 不重置） | claude MED + codex LOW，取严 ✅ | 双方读代码 |
| F7 | MED | AssetsLibraryDialog.tsx:48-64,66-68 | mount fetch + refreshUser fetch 无 abort/seq guard（保存→关闭→重开期间慢响应覆盖刚保存列表） | claude MED + codex LOW，取严 ✅ | 双方读代码，对照 SummaryView aborted flag 模板 |
| F8 | MED | AssetEditor.tsx:57 vs bundled-assets.ts:179 | renderer ↔ main name regex 不一致：renderer `^[a-z0-9-]+$`（接受 `-foo`）vs main isSafeName `^[a-z0-9][a-z0-9-]*$`（拒绝） | claude 独有 ✅ | claude grep 双侧 regex 字面量比对 |
| F9 | LOW | ipc/assets.ts:48 + user-assets.ts:70 + types/assets.ts:23,47 + bundled-assets.ts:177 | 错误消息 / 注释里的 regex 与代码不一致（4 处都说 `^[a-z0-9-]+$`，实际 isSafeName 是 `^[a-z0-9][a-z0-9-]*$`） | claude 独有 ✅ | claude grep 4 处 |
| F10 | LOW | user-assets.ts:93-101 | saveUserAsset 原子写失败时残留 `.tmp.PID`（renameSync 抛错后无 try/finally 删 tmp） | claude 独有 ✅ | claude 读 line 95-99 |
| F11 | LOW | bundled-assets.ts:21-32 | bundled cache 永不失效（dev 改 plugin md 后必须重启 main 才能在「资产库」里看到新 frontmatter） | claude 独有 ✅ | claude 读模块级 cached 变量 |
| F12 | LOW | user-assets.ts:167-177 + bundled-assets.ts:146-156 | parseFrontmatter 重复实现两份（已抽 __metaBuilders 共享 buildAgentMeta/buildSkillMeta，parseFrontmatter 没顺手抽） | 双方 ✅ | 双方 grep |
| F13 | LOW | AssetEditor.tsx:41-55 | AssetEditor 编辑模式 mount fetch 无 abort（strict mode dev 双跑可能踩） | claude 独有 ✅ | claude 读 useEffect 无 cleanup return |
| F14 | LOW | AssetEditor.tsx:73-97,99-126 | save/remove 后 finally 写孤儿组件（成功路径 onSaved+onClose 让父级 unmount，finally setBusy 是无效写） | claude 独有 ✅ | claude 读 try/finally |

#### ❌ 反驳（reviewer-codex 主动核实无问题，列入 finding 但裁决无问题）

7 项：path traversal（双重校验卡死） / deleteUserAsset TOCTOU（user 自家 home 不跨权限） / preload ↔ handler 签名（4 channel 完整核对对齐） / description 含 `:` 注入（`(.*)$` 贪婪捕获正确） / platform.ts module-eval 崩溃（preload 同步先于 renderer） — 全核实无问题，不算 ❌ 反驳，仅记录主动确认。

#### ❓ 部分 / 未验证（自降级为非 HIGH）

| # | 文件:行号 | 视角 | 是否已验证 | 结论 |
|---|---|---|---|---|
| Q1 | user-assets.ts:111-128 (deleteUserAsset) | rmSync recursive force 在 Win NTFS junction 上 follow 删 target？跨平台行为未实测 | 未跑 fs 实测 | ❓ MED；macOS/Linux 安全；Win **可能**踩坑——R1 fix 加 lstatSync 拒删 symlink 兜底 |
| Q2 | user-assets.ts:179-188 (stringifyFrontmatter) | description 含 `#`，app parser `(.*)$` 正确（已实测），但 SDK 端 YAML lib 读 `description: foo # bar` **应该**当 `foo`（注释）—— app/SDK 不一致 | 未读 SDK 源 | ❓ LOW；R1 改 quoted form 后该问题消失 |
| Q3 | preload/index.ts:41 + lib/platform.ts:14 | `export const PLATFORM = window.api.platform` module top-level；未来加 vitest jsdom 单测不带 preload 即崩 | 未验证有 renderer test | ❓ LOW；R1 fix 加 `globalThis.api?.platform ?? 'darwin'` 防御 |

### Round 2 — fix regression + 架构 + 安全（reviewer-claude 6 ✅ + 2 ❓ / reviewer-codex 1 ✅ + 1 ❓ + 7 反驳）

#### ✅ 真问题

| # | 严重度 | 文件:行号 | 问题 | 双方/单方 | 验证手段 |
|---|---|---|---|---|---|
| R2-F1 | MED | utils/frontmatter.ts:75-86 (unquoteValue) | escape 反向顺序错——字面 `\n`/`\r`/`\t`/`\"` 在用户描述里被误解码为 newline/CR/tab/quote。多次 sequential `String.prototype.replace` 因「中间态再匹配」错位：用户写 Windows 路径 `C:\new`（字面反斜杠+n）→ quoteValue 写 `\\n` → unquoteValue 第一步 `\\n → \n` 把后两字符吃成换行 | 双方 ✅ MED | 双方独立 node 实测复现：claude `'see C:\new folder'` 17 chars / codex `'foo\nbar'` 8 chars，均 `original !== roundtripped` |
| R2-F2a | MED | AssetEditor.tsx:114-116 (bodyError) vs ipc/assets.ts:96 | renderer body 校验不查首行 `---`，main 端查——校验链不一致；用户 body 起首写 `---\n# Title` → renderer 校验过 → IPC 拒收 UX 不一致 | claude 独有 ✅ MED | claude 双侧 line-by-line 读对照 |
| R2-F2b | LOW | AssetEditor.tsx:98-104 (modelError) | renderer model 校验不查 `\r\n`/`---`，main 端查；当前 select 防住，但若未来改 input 即回归 | claude 独有 ✅ LOW | claude 读对照 |
| R2-F4 | LOW | ipc/assets.ts:96 (parseAssetBody) | `value.split('\n').slice(0, 1).join('')` 写法迂回（等价 `value.split('\n', 1)[0]`） | claude 独有 ✅ LOW | claude 读 |
| R2-F6 | LOW❓ | utils/frontmatter.ts + ipc/assets.ts + AssetEditor.tsx | vitest 覆盖欠缺——R1 fix 引入 frontmatter.ts + parseSingleLineString + parseAssetBody + ASSET_NAME_REGEX 共享常量，全无 unit test。R2-F1 这种 escape 顺序 bug 写 round-trip test 即可暴露 | claude 独有 ✅ LOW | claude grep `*.test.*` 0 个覆盖 assets/* |

#### ❌ 反驳（reviewer-codex 7 项主动反驳全 ✅，全实测/代码检查证伪）

1. closeInFlightRef 并发：第二个操作被 ref guard return ✅
2. ASSET_NAME_REGEX 三 bundle 漂移：同一源文件编译，常量 inline 非运行时漂移 ✅
3. fetchSeqRef StrictMode 双调：seq guard 正确丢弃第一次 mount 响应 ✅
4. lstatSync dangling symlink 抛错：实测 existsSync=false → 提前 ok:true，lstatSync 不被调用 ✅
5. bundled-assets dev 模式 stale path：getBundledAssetPath 每次 fresh getAgentDeckPluginPath() ✅
6. F1 fix ClaudeMdSection/PluginAssetsSection 未走 guarded 路径：SettingsDialog.tsx:241/246 明确传 `() => void guardedOpenAssetsLibrary()` ✅
7. IpcInputError 序列化：extends Error，message 字段正常 IPC 序列化 ✅

#### ❓ 部分 / 未验证

| # | 文件:行号 | 视角 | 结论 |
|---|---|---|---|
| R2-F3 | utils/frontmatter.ts:75-86 (unquoteValue) | bundled 文件若 description 字面以 `"` 开头**且**以 `"` 结尾会被误识别 quoted form 剥引号；当前 bundled 4 文件全无此模式 | ❓ LOW；不修，留备忘 |
| R2-F5 | bundled-assets.ts:34-43 | dev/prod 缓存策略发散——cache invalidation 相关 bug 在 dev 永远测不到；建议 dev 也走缓存 + 手动 reload 按钮 | ❓ LOW；不修（设计取舍：dev 重扫 ms 级保开发体验） |
| R2-CDX-Q1 | user-assets.ts | dangling symlink 提前返回 ok:true（existsSync=false）—— UI 列表已过滤不可见，轻微 UX 误报 | ❓ LOW；不修（合理设计取舍） |

### Round 3 — 收敛验证（reviewer-claude 0 ✅ + 0 ❌ + 0 ❓ / reviewer-codex 0 ✅ + 0 ❌ + 0 ❓）

**双方均给「✅ 可合 - 0 阻塞 finding」**：

- reviewer-claude：mental trace 复盘 R2 fix 全部正确落地；state machine 与 R1 sequential replace 等价性核验；vitest 15 case 全分支命中
- reviewer-codex：node 实测 14+ case 全 PASS（state machine 5 R2 case + vitest 全 case + bare form + 单边引号 + trailing backslash guard）；OLD vs NEW parseAssetBody 实测 10 case 9 一致（仅 leading-spaces edge case intentional diff 收紧）

## 修复（CHANGELOG_57 落地）

按严重度排序，分 5 段做（每段后跑 typecheck）。最终 typecheck + build + 204 vitest（含新 15 frontmatter case）全过。

### HIGH (R1)

1. **SettingsDialog.tsx + 2 sections** — `guardedOpenAssetsLibrary` 复用 `closeInFlightRef` 锁 + dirty 拦截 + confirmDialog；ClaudeMdSection/PluginAssetsSection 透传 `() => void guardedOpenAssetsLibrary()` 替代裸 prop（F1）

### MED (R1+R2)

2. **shared/types/assets.ts** — 新加 ASSET_NAME_REGEX `/^[a-z0-9][a-z0-9-]*$/` 共享常量 + ASSET_LIMITS 长度上限（F8 + F4）
3. **ipc/assets.ts:parseSingleLineString + parseAssetBody** — description/tools/model 禁 `\n`/`\r`/`---`；body 限 256KB + 起首禁 `---`（F3 + F4）
4. **utils/frontmatter.ts**（新建）— parse + stringify 抽共享单点真值；stringify 一律双引号 wrap value + escape；unquote 用 char-by-char state machine（F2 + F3 + F12 + R2-F1）
5. **AssetsLibraryDialog.tsx** — fetchSeqRef + viewerSeqRef seq guard；`!open` 主动 reset viewer/editor state；refreshUser 共用 fetchSeqRef（F5 + F6 + F7）
6. **AssetEditor.tsx** — 校验 regex 改用共享 ASSET_NAME_REGEX；body/model/tools 加 `\r\n`/`---`/length 检查与 main 对齐；mount fetch 加 cancelled flag；mountedRef 防 finally 写孤儿（F8 + R2-F2a/F2b + F13 + F14）

### LOW (R1+R2)

7. **user-assets.ts** — saveUserAsset try/finally 兜底删 .tmp.PID；deleteUserAsset 加 lstatSync 检查 symlink/junction 拒删（F10 + Q1）
8. **bundled-assets.ts** — dev 模式（`!app.isPackaged`）跳过 cache；prod 永久缓存；统一错误消息 regex 字面量（F11 + F9）
9. **lib/platform.ts** — `globalThis.api?.platform ?? 'darwin'` 防御性 fallback（Q3）
10. **utils/__tests__/frontmatter.test.ts**（新建）— 15 vitest case 守门 R2-F1 + 各种 escape 边角 + 向后兼容 bundled bare form + unknown escape 默认分支（R2-F6）

### 不修（明确决定）

- **R2-F3** LOW（bundled 字面引号歧义）— bundled 4 文件无此模式，留备忘
- **R2-F5** LOW（dev/prod 缓存策略发散）— 设计取舍
- **R2-Q1** LOW❓（UTF-8 BOM / 全角冒号）— 罕见
- **R2-Q2** ❓（SDK YAML 解码顺序对比）— R2-F1 已修不再相关
- **R2-CDX-Q1** ❓（dangling symlink ok:true）— 合理设计取舍

## 关联 changelog

- [CHANGELOG_57.md](../changelog/CHANGELOG_57.md)：本次 fix 落地的功能变更（设置面板文案统一 + 平台分流 + 资产库）
- 「备注」段补一行 `reviewer 双对抗 3 轮 review 闭环：见 reviews/REVIEW_22.md`

## Agent 踩坑沉淀（追加 `.claude/conventions-tally.md`）

本次 review 提炼出 4 条 agent-pitfall 候选：

1. **手写 YAML frontmatter writer 不转义会被多行 / 特殊字符注入**（R1·F2+F3 实测）
2. **新增「跳到另一个 dialog」按钮必须经过当前 dialog 的 dirty 拦截链路**（R1·F1，CHANGELOG_57 新模式）
3. **Renderer 与 main 双端校验 regex / 长度限制必须共享同一份常量**（R1·F8+F9，已有 read-only-tools.ts / SANDBOX_MODE_VALUES 同模式参照）
4. **多 escape 字符串解码必须按 quote 反序处理（或 char-by-char 走状态机）**（R2·R2-F1 双方实测复现的 unquoteValue 顺序 bug）—— 多 sequential global replace 会因中间态再匹配而出错；典型坏模式 `text.replace(/\\n/g, '\n').replace(/\\\\/g, '\\')` 字面 `\n` 被误解码

每条同主题再撞 2 次会触发升级到 CLAUDE.md 项目约定。
