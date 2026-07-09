# CHANGELOG_164 — UI 文案 Round 2 异构对抗 review × fix(深层一致性 + a11y + corner case)

## 概要

承接 CHANGELOG_163(Round 1)继续走 `agent-deck:deep-review` SKILL Round 2 异构对抗,**修复 R1 fix 引入的标点 / markdown 字面量不一致** + 挖出 9 大类**前次未审到的 corner case** + 全应用「Claude 字面量硬编码」/「外部 CLI 内部术语」深层问题 + a11y(屏幕阅读器 aria-label)+ H8 sandbox 危险档位标签全重写让用户能直接判断后果差异。共 ~22 文件 ~80 处改动,全量 `pnpm typecheck` 0 error。

## Round 2 关键发现

reviewer-claude(claude-code, Opus,9 HIGH + 7 MED + 3 LOW + 2 INFO)+ reviewer-codex(codex-cli, gpt-5.5,1 HIGH + 4 MED + 1 LOW)双方 grep verified 实证。**特别重要**:reviewer-claude 抓住了 R1 fix 引入的关键不一致(我习惯用半角标点 + 误用 markdown 字面量):

- **R1 fix 引入的标点不一致**(本轮重点修):
  - **N4 markdown 字面量在 Electron native dialog 中不渲染**(TeamDetail/index.tsx:97 R1 我加的 `**关闭不可恢复**` 用户看到原文星号)
  - **N7 `确定要 X 吗?` 半角问号 7 处**(项目主流是全角问号,R1 我新加的 6 处全用了半角)
  - **N8 `失败:` 半角冒号 6 处**(项目主流 25+ 处全角,R1 新加的 6 处全半角)
  - **N15 `⚠` 半全角混 2 处**(App.tsx:243 + CodexMcpServersSection.tsx:111)

## 改动清单(按主题)

### N4/N7/N8/N15: R1 fix 引入的标点不一致(7 文件)

- **TeamDetail/index.tsx**: 关闭弹窗删除 `**关闭不可恢复**` markdown 字面量(Electron native dialog 不渲染);3 处中文标点全角化(`,` → `，` / `?` → `？` / `:` → `：`)
- **HistoryPanel.tsx / SessionCard.tsx / AssetEditor.tsx (2 处) / AssetsLibraryDialog.tsx (2 处)**: confirmDialog 半角问号 → 全角(`?` → `？` / `,` → `，` / `。` 句号统一)
- **HandOffPreviewDialog.tsx / NewSessionDialog.tsx / settings/controls.tsx / TeamDetail/index.tsx**: `失败:` → `失败：`(6 处)
- **App.tsx:243 / CodexMcpServersSection.tsx:111**: `⚠` → `⚠️`
- **SessionDetail/composer-sdk/ErrorBanner.tsx**: prefix 分隔符 `:` → `：`

### N2: `Claude` 字面量硬编码 8 处去除(对 codex 会话不准)

跨 5 文件,所有 pending(PermissionRequest / AskUserQuestion / ExitPlanMode)/ cancel toast / activity describe 文案都改成不暴露厂商名:

- **activity-feed/describe.ts**: `Claude 提议了一个执行计划` → `收到一个执行计划`;`Claude 在询问你` → `收到一个问题`
- **SessionDetail/index.tsx**: cancel toast `Claude 取消了一条<X>` → `已取消一条<X>`
- **pending-rows/AskRow.tsx**: `Claude 在询问你` → `收到一个问题`;`Claude 取消了这次提问` → `这次提问已取消`
- **pending-rows/ExitPlanRow.tsx**: `Claude 提议了一个执行计划` → `收到一个执行计划`;`Claude 取消了这次计划批准请求` → `这次计划批准请求已取消`
- **pending-rows/PermissionRow.tsx**: `Claude 取消了这次请求` → `这次请求已取消`

### N3: `外部 CLI` 内部术语 9 处统一(用户不知"CLI"是什么 / 与"应用内创建"对比模糊)

- **pending-rows/{Ask,Permission,ExitPlan}Row.tsx**: `外部 CLI 会话无法在此回应` → `这是终端启动的只读会话，请回到原终端窗口<动作>`(操作动词分场景:回答/授权/批准)
- **activity-feed/rows/tool-row.tsx**: `外部 CLI 提议执行计划` → `收到一个执行计划`
- **PendingTab.tsx**: `外部 CLI 会话无法在此响应` → `这是终端启动的只读会话，请回到原终端窗口操作`;`外部终端 CLI 会话(只读)` → `终端启动 · 只读`
- **SessionCard.tsx / HistoryPanel.tsx / SessionDetail/SourceBadge.tsx**: `外部终端启动的会话` → `终端启动的会话`(删冗余「外部」前缀)
- **SessionDetail/CliFooter.tsx**: `外部 CLI 会话 · 只读视图` → `终端启动 · 只读视图`

### N9: SettingsDialog tab 大小写不统一

- **SettingsDialog.tsx:172-173**: `claude code` / `codex cli` 全小写 → `Claude Code` / `Codex CLI`(与项目主体 SectionGroup `Claude Code` / `Codex CLI` 对齐)

### N5: 内部术语第二轮清理

- **AssetsLibraryDialog.tsx**: `IPC 调用失败:` → `加载失败：`
- **TeamHub.tsx**: `让 AI 在会话中调用 MCP 工具创建团队后,会显示在这里` → `让 AI 在会话中创建团队后，会显示在这里`(删 MCP 工具名)

### N12: CodexMcpServersSection markdown 字面量 + 协议字段

- 标题 `Codex MCP Servers` → `Codex 外部工具服务`
- 主说明 `[mcp_servers.X]` / `marker 包裹` / `**不破坏**` / `stdio` / `http` 等 → 「在这里配置 Codex 可调用的外部 MCP 服务」+ disclosure 折叠技术细节
- 保存成功提示 `✓ 已写入 ~/.codex/config.toml(marker 段)` → `✓ 已保存到 ~/.codex/config.toml`
- 错误提示 `JSON 解析失败` → `JSON 格式错误`;`含非法字符(仅允许 [\w-/])` → `只能用字母、数字、下划线、横线、斜杠`
- `⚠` → `⚠️`

### N16: 「仅对新建会话生效」5 种变体统一

- **InjectionToggleBar.tsx**: 3 处 `;不受影响` / `;已加载,不会回收` → 统一为「⚠️ 仅对新建会话生效。已运行的会话不受影响。」(claude-md tab 用「已加载，不会回收」结尾说明已加载场景)
- **AgentDeckMcpSection.tsx**: `⚠️ 仅对新建会话生效 · 修改总开关后需要重启应用。` → `⚠️ 仅对新建会话生效。修改总开关后需要重启应用。`(`·` → `。`)

### N6/N20: AssetEditor pkill + 半角标点

- **AssetEditor.tsx**: codex skill 删除提示 `运行中的 Codex 需重启(pkill -f codex 后重启)才能看到生效` → `已经在跑的 Codex 会话需重启后才能加载新内容`(删 shell 命令)
- 校验消息全面标点全角化(`,` → `，` / `(` → `（` / `)` → `）` / `"---"` → `「---」`):name / description / model / tools / body 错误共 ~10 处

### N10: PermissionsView.tsx 内部字段名

- `cwd:` → `当前目录：`
- 来源标签:`User / User Local / Project / Local` → `全局设置 / 本机设置 / 项目设置 / 当前目录设置`
- 来源徽章 `U / UL / P / L` → `全局 / 本机 / 项目 / 目录`(中文用户辨识度高)
- `生效合并 · user → user-local → project → local` → `当前生效规则（按 全局 → 本机 → 项目 → 当前目录 顺序合并）`
- `defaultMode:` → `默认权限模式：`
- `三层均未配置任何 permissions` → `尚未配置任何权限规则`
- `allow / deny / ask` → `允许 / 拒绝 / 每次询问`
- `additionalDirectories` → `额外可访问目录`
- 同款目录 notice 文案中 `Home / User / User Local` → 中文

### N11: PendingTab 漏接 R1 术语统一

- 团队 hover title `Agent Teams (N):` → `所在团队 (N):`;`[lead/teammate]` → `[负责人/协作者]`
- `👑 lead` / `↳ teammate` chip → `👑 负责人` / `↳ 协作者`(与 SessionCard 对齐)
- title `本会话在 team「X」是 lead` → `本会话在团队「X」中是负责人`
- targetModeLabel `默认 / 自动接受 / 保持 Plan` → `每次询问 / 自动接受编辑 / 继续计划模式`(与 SandboxSelects 对齐)
- 批量批准 select title 改通俗

### N18: SessionList 空态命令行不友好

- 空 state 3 行 → 主 CTA 突出 + `<details>` 折叠「进阶:从终端启动」(power user 仍可见命令行,首次用户不再被开发者命令吓到)

### N1/N17: a11y(屏幕阅读器读到符号 vs 动作名)

- **App.tsx IconButton**: 新加 `aria-label={title}`(IconButton 内符号 ＋/📌/▢/📚/⚙ 屏幕阅读器只能读符号);删 `资产库（内置 + 用户自定义 agents/skills/CLAUDE.md）` 长 title → `资产库`
- aria-label 中英混 7 处全改中文:`dismiss` → `关闭`(2 处) / `remove attachment` → `移除附件`(2 处) / `loading image` → `加载图片中` / `image lightbox` → `图片预览` / `close lightbox` → `关闭预览`

### N14: SummarySection + SummarizerErrorsDiagnostic

- **SummarySection.tsx**: ModelRow hint `claude provider 留空走 'haiku' alias;codex provider 留空 fallback ~/.codex/config.toml` → 「Claude 留空使用默认快速模型;Codex 留空使用 Codex 配置里的默认模型」;reasoning select title `codex SDK ThreadOptions.modelReasoningEffort 4 档枚举` → `选择 Codex 总结时使用的推理强度`;handoff hint 删 `default sonnet 保结构精度;想降 haiku 或升 opus/thinking-max 自己填 model id` 中的 model id / fallback 等术语
- **SummarizerErrorsDiagnostic.tsx**: `最近无 LLM 总结错误` → `最近无总结失败记录`;`最近 LLM 总结错误(前 5 条)` → `最近总结失败记录(前 5 条)`;`{ts} · {sid.slice(0, 12)}…` → `{ts} · 会话 {sid.slice(0, 8)}…`(8 位足够辨识 + 加「会话」前缀);**加下一步动作建议**「可检查模型名称、网络或账号权限后重试。」

### N13: diff/renderers/* 开发者词

- **ImageDiffRenderer.tsx**: `NEW` badge → `新增`;`before / after` Pane title → `修改前 / 修改后`;`(无)` → `（无图）`;`滑动对比模式待实现(二期接 react-compare-slider)` → `滑动对比暂不可用`;`图片不可读` → `图片无法显示`
- **TextDiffRenderer.tsx**: `NEW` → `新增`;`加载 Monaco…` → `加载差异视图…`;`文件信息缺失(source: ...)。before/after 均为 null,无法渲染 diff` → `这次改动缺少可显示的差异内容，请直接打开文件查看`;Codex 提示删 `diff 文本内容` 改 `差异内容`
- **PdfDiffRenderer.tsx**: `agent-deck 还未接入 PDF diff 渲染。改动已记录在 file_changes 表里` → `Agent Deck 暂未接入 PDF 差异渲染。改动已记录在历史里`(删内部表名)

### H8(❓1): sandbox 危险档位标签全重写(让用户能直接判断 3 档后果差异)

**SelectRow 组件**:options schema 加 `title?: string` 字段;render 时把 title 同时给 select(显当前选中项 tooltip)+ 每个 option(hover 显档位 tooltip)

**3 处 sandbox 档位文案标签 + tooltip**(SandboxSelects / NewSessionDialog / ExperimentalSection / ExitPlanRow 4 个文件):

| 档位 | 旧 label | 新 label | 新 tooltip |
|---|---|---|---|
| permissionMode `bypassPermissions` | `⚠️ 完全免询问` | `⚠️ 不再询问（仍在系统沙盒内）` | Claude 全程不再询问任何工具调用；OS 沙盒（若启用）仍生效 |
| codex `danger-full-access` | `⚠️ 完全开放` | `⚠️ 完全开放（可改任意文件 / 联网 / 起子进程）` | 没有任何限制：可以读写任意文件、访问网络、运行任意命令 |
| claude `off` | `⚠️ 关闭（无系统沙盒）` | `⚠️ 关闭（无系统沙盒）` | OS 不限制 Claude；只靠应用授权弹窗管控 |

3 档差异从 label 就能看明白:
- `bypassPermissions` = 不再询问但 OS 沙盒还在
- claude `off` = OS 沙盒关掉,只靠应用授权弹窗
- codex `danger-full-access` = 完全开放,没任何限制

PERMISSION_MODE_OPTIONS / CODEX_SANDBOX_OPTIONS / CLAUDE_CODE_SANDBOX_OPTIONS 每个 option 都加详细 tooltip,SelectRow 自动透传 `option.title` 给原生 `<option title="...">` 与外层 `<select title="...">`(SelectRow 找当前 value 对应 option 给 select)。

ExitPlanRow targetMode select 同款重写。

### ❓2: LOW 半全角括号批改(中文上下文 `(...)` → `（...）`)

约 15 处用户可见短文案改全角括号:thinking-row `（暂无思考内容）` / `（X 字）`(2 处);message-row `（空消息）` / `（X 字）`;tool-row `（无输出 · 状态: X · 退出码: N）`;HistoryPanel `已归档（进行中）`;MessagesSection `（仅显示最近 30 条）`;EventsSection `（无法显示）`;AssetsLibraryDialog `（无）` / `用户自定义（{userPathHint}）`;AssetEditor `工具（逗号分隔，可留空）` / `正文（Markdown）`;AskRow placeholder `其他（可选）`;WindowSection `详见「快捷键」section` 中的 `（）`;AgentDeckMcpSection 4 处标题/placeholder

(注:本节主要改用户可见 UI 短文案;长说明段落中的「，」「。」中文上下文标点未做全量批改,工作量大效果细)

### 反驳轮 + 三态裁决

- **双方共识**(直接 ✅):8 大主题(N4/N7/N8/N15 + N3/N12 部分双方提)
- **claude 单方 + 现场 grep verify**(直接 ✅):N1/N2/N3/N5/N6/N9/N11/N16/N17/H8(共 ~16 处)
- **❓ 让 user 定夺**:2 条 → user 选「全改」(H8 全重写 + LOW 半全角括号批改)
- **❌ 不改**:I1/I2 范围外(未来路线:重启按钮 + confirmDialog 模板抽常量)
- 0 反驳(双方 finding 高度一致 + grep 实证可靠)

### Round 2 流程曲折(SKILL 学习点)

第一次 R2 spawn 时 prompt framing 用了「Round 2 continuation」+ skip 字段(声称「Round 1 已 ✅ fix 摘要」)。reviewer-codex 立刻报 **FRESH SESSION**:它指出 SKILL Step 5 明确「**复用同一对** teammate 调 send_message 发 Round 2」,但我 R1 收口时 shutdown 了上一对,这次 spawn 是全新的 reviewer-codex 没有 R1 mental model — 「Round N+1」标签隐含「我跑过 Round N」的前提不成立。

**修法**: 按 SKILL §失败兜底 「FRESH SESSION recipe」shutdown + 重 spawn,**去掉 Round 2 标签**,改 framing 为「Round 1 with prior fix context」(skip 字段保留作为「以下位置已被前次 review 改过,跳过不要重提」的前置上下文,而非声称是 Round 2 continuation)。reviewer-codex 接受新 framing 跑出 6 条 finding。

**经验**:SKILL teammate review 多轮挖深必须**复用同一对** teammate(SKILL Step 5 invariant);如果 R1 收口已 shutdown,R2 必须 framing 为「fresh review with prior context」而非「Round N+1 continuation」。

## 验证

- `pnpm typecheck` 全量 0 error
- 组件 props 类型契约 0 改动(只改文案 + SelectRow options schema 加 optional `title` 字段)
- SelectRow 接 `option.title` 字段后,所有 `<select>` 自动获得当前选中项的 tooltip + 每个 option 的 hover tooltip
- 22 个 renderer 文件改动,~80 处文案修订

## 后续

- Round 3 视使用反馈再启动(R2 已基本覆盖 R1 fix 引入的新问题 + 未审 corner case + 跨文件深查 + a11y 深层 + H8 sandbox 全重写)
- INFO 路线建议(`pkill` 改重启按钮 / confirmDialog 模板抽常量)留 follow-up,不在本轮范围
