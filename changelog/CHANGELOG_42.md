# CHANGELOG_42: 应用约定（CLAUDE.md）UI 编辑 + 对抗 Agent 约定升级（Claude + Codex 异构）

## 概要

agent-deck 自带的 CLAUDE.md（注入到每个 SDK 会话 system prompt 末尾的应用约定文本）原本只能改源码 + 重新打包，现在通过设置面板新 Section「应用约定（CLAUDE.md）」直接编辑，用户副本写到 `userData/agent-deck-claude.md` 覆盖内置；保存 / 重置主动清主进程注入缓存，下次新建会话生效（已运行的 SDK 会话已经把 system prompt 固化进 LLM 上下文，不会热改）。同时把内置 CLAUDE.md（`resources/claude-config/CLAUDE.md`）和用户全局 `~/.claude/CLAUDE.md` 中「对抗 Agent」那条约定改为「默认一个 Claude（Explore/general-purpose subagent）+ 一个 Codex（codex-custom:rescue/codex-rescue agent），异构对抗最大化降低同模型偏见；codex 不可用时降级两个独立 Claude Agent」。

## 变更内容

### main 进程 / SDK 注入（`src/main/adapters/claude-code/sdk-injection.ts`）

- 新增 `getActiveAgentDeckClaudeMd()` —— 给 IPC `get` 用，返回 `{ content, isCustom }`（用户副本优先 → 内置回落）
- 新增 `getBuiltinAgentDeckClaudeMd()` —— 永远读 resources 内置，给「恢复默认」按钮用
- 新增 `saveUserAgentDeckClaudeMd(content)` —— 写 `userData/agent-deck-claude.md` + 清缓存
- 新增 `resetUserAgentDeckClaudeMd()` —— 删用户副本（如果存在）+ 清缓存
- 新增 `invalidateAgentDeckSystemPromptAppend()` —— 内部用，把 `cachedClaudeMdAppend` 置 null
- `getAgentDeckSystemPromptAppend()` 加载顺序改为：cache → 用户副本 → 内置 → 空字符串；保留原有 lazy 缓存语义
- 抽 `readActiveClaudeMdRaw()` helper 共用「按优先级读原文」逻辑；模块顶部新增 `USER_CLAUDE_MD_FILENAME = 'agent-deck-claude.md'` 与 `APPEND_HEADER` 常量

### IPC 层（`src/shared/ipc-channels.ts` + `src/main/ipc.ts`）

- `IpcInvoke` 新增 3 条：`ClaudeMdGet = 'claude-md:get'` / `ClaudeMdSave = 'claude-md:save'` / `ClaudeMdReset = 'claude-md:reset'`
- `ipc.ts` 注册 3 个 handler：`get` 调 `getActiveAgentDeckClaudeMd()`；`save` 调 `saveUserAgentDeckClaudeMd()` 返回 `{ ok: true }`；`reset` 调 `resetUserAgentDeckClaudeMd()` 后顺便返回新的内置内容供 UI 同步刷新
- 不动 `settings-store` / `AppSettings` —— 用户副本走独立文件，不和其他 settings 字段耦合

### preload facade（`src/preload/index.ts`）

- 新增 `getClaudeMd()` / `saveClaudeMd(content)` / `resetClaudeMd()` 强类型 facade，类型自动推导进 `AgentDeckApi`，无需手改 `index.d.ts`

### 设置面板 UI（`src/renderer/components/SettingsDialog.tsx`）

- 末尾新增 `<Section title="应用约定（CLAUDE.md）">` 段
- 新增 `ClaudeMdEditor` 组件（同文件内）：
  - mount 时拉「当前生效」内容 + isCustom 标记
  - `<textarea>` + 等宽字体（`ui-monospace, SFMono-Regular, Menlo, monospace`）+ 默认 256px 高度可纵向 resize；不引入 monaco / react-simple-code-editor，与现有面板控件风格统一
  - 三按钮：保存（无 dirty 时 disabled）/ 撤销（仅 dirty 时显示）/ 恢复默认（仅 isCustom 时显示，destructive 二次确认走 `confirmDialog`）
  - 顶部状态文字「当前为用户自定义副本（覆盖内置）/ 应用内置默认」+ 注入位置说明 + 「下次新建会话生效」提示
  - 错误显示在底部 hint 行（catch IPC reject）

### 应用约定文本（`resources/claude-config/CLAUDE.md` + `~/.claude/CLAUDE.md`）

两份「对抗 Agent」那条约定同步改为：

> 给代码下结论（bug / 优化 / code review / 安全 / 架构 / 根因）前，必须并发两个独立对抗 Agent 各自读真实代码核实：默认一个 Claude（Explore / general-purpose subagent）+ 一个 Codex（Bash 直接调 codex CLI，例如 `zsh -i -l -c "codex exec '<prompt>'"`，不走 codex-custom subagent 包装），异构对抗最大化降低同模型偏见；codex CLI 不可用时降级两个独立 Claude Agent。三态裁决（✅ 确认 / ❌ 反驳 / ⚠️ 部分），证据须带 `文件:行号` + 代码片段，不准复述。最终清单标注被反驳 / 升降级条目。trivial 改动（typo / 样式数值）除外

项目根 `/Users/apple/Repository/personal/agent-deck/CLAUDE.md` 不含此条，**未改动**。

> 微调记录：本条最初写作「Codex（codex-custom:rescue / codex-rescue agent）」走 plugin 包装的 subagent，但 codex-custom plugin 启动慢、依赖项目侧装好且要走 Task tool，不如直接 Bash 调 codex CLI 来得稳。改为「Bash 直接调 codex CLI」更直接，复用现有 `zsh -i -l -c` 登录式 PATH 约定。

> 二次微调：实测 `codex exec` 后发现，stdout 是「banner + reasoning + final message」三段混合（其中 final 还会被打印两次），Claude 直接解析很痛苦；正确做法是 `-o <FILE>` 把最终消息单独写到文件再 cat。配合 `--sandbox read-only`（review 不让改文件）/ `--skip-git-repo-check`（cwd 不在 git repo 也能跑）/ `-C <REPO>`（让 codex 看真实代码）/ stdin 传长 prompt（避免引号转义）一组 flag 才是工程上靠谱的姿势。把这套完整模板浓缩成一条独立 bullet「codex CLI 调用模板」追加到两份 CLAUDE.md（user global + 应用注入），让对抗 Agent 之外其他需要让 codex 干活的场景也能直接复用。

### 文档

- `README.md` 设置面板章节末尾追加「应用约定（CLAUDE.md）」一行，说明用户副本覆盖内置 + 下次新建会话生效语义
- `changelog/INDEX.md` 表格末尾追加本条目

## 设计决策记录

- **覆盖策略**：用户副本（`userData/agent-deck-claude.md`）覆盖内置（`resources/claude-config/CLAUDE.md`）。理由：应用升级时内置文本可能演进，不能冲掉用户改动；同时不污染 `agent-deck-settings.json`，便于以后单独 git ignore / 备份
- **缓存策略**：保存时 invalidate cache，仅下次新建会话生效。已运行的 SDK 会话已经把 system prompt 固化进上下文，热改无意义；强行 interrupt 重启会打断用户工作，得不偿失
- **不做 schema 校验**：CLAUDE.md 是给 LLM 看的自由文本，没有 schema 可言；用户全责
- **对抗约定改异构**：原约定要求「两个独立 Agent」但默认都是 Claude，存在同模型偏见风险；Codex（GPT-5/codex-cli）作为另一族模型，与 Claude 形成异构对抗，对「LLM 误判 / 幻觉 / 同源固定模式」抵抗力更强；codex 不可用时退回两个独立 Claude 保留语义
- **Codex 走 CLI 不走 subagent 包装**：codex-custom plugin 的 subagent 多一层 Task 包装 + 启动慢 + 依赖项目侧 plugin 装好；直接 Bash 调 `codex exec` 更直接，且 codex CLI 已经在 `~/.codex` 自带 OAuth 状态，开箱即用
- **codex stdout 不可解析 → 必须 `-o`**：实测 codex exec 的 stdout 是「banner + reasoning + final（且 final 重复一次）」三段混合，从 stdout 抓干净结果会很脆；`-o <FILE>` 单独写 final message 到文件，加上 `--sandbox read-only` / `--skip-git-repo-check` / `-C <REPO>` / stdin 传 prompt，构成工程上靠谱的固定姿势，浓缩成「codex CLI 调用模板」bullet 写进两份 CLAUDE.md

## 追加：修「在会话详情页时点击『待处理』tab 无法跳转」

### bug 现象

进入任一会话详情页后，点击 header 的「待处理」tab，badge 高亮切到 active，但 main 区域仍保留 SessionDetail，PendingTab 完全不显示，用户感知"点了没反应"。

### 双对抗 Agent（Claude Explore + Codex `gpt-5.4`）一致根因

`src/renderer/App.tsx:99` `detailSession = view === 'history' ? historySession : (selectedFromMap ?? stickySelected)` —— 当 `view !== 'history'` 时，detailSession 仍从 `selectedSessionId` 派生；`App.tsx:206` 渲染分支 `{detailSession ? <SessionDetail/> : ... view === 'pending' ? <PendingTab/> : ...}` 中 detailSession 优先级永远高于 view 分支。

`App.tsx:178` 的「待处理」TabButton onClick 只调 `setView('pending')`，没清 `selectedSessionId` → 详情页里 selectedId 仍非空 → detailSession 仍非空 → SessionDetail 把 PendingTab 完全盖掉。

最强证据：同文件 `App.tsx:129-135` 的 `jumpToPending()`（左上角 `⚠ N 待处理` chip 触发）已经做对了，作者自己在 132 行注释里写明「不清就被 SessionDetail 盖住看不到 PendingTab」——同一需求两条入口（chip vs tab）实现不一致，tab 路径漏了 `select(null)`。

### 修复（`src/renderer/App.tsx:176-188`）

「待处理」TabButton onClick 由 `() => setView('pending')` 改为内联：

```tsx
onClick={() => {
  setView('pending');
  // 与 jumpToPending 同因：不清 selectedSessionId,
  // App.tsx:99 的 detailSession 仍非空 → main 区域优先渲 SessionDetail
  // 把 PendingTab 盖掉，详情页里点这个 tab 看起来"无反应"。
  select(null);
}}
```

不直接复用 `jumpToPending()`，因为它带 `if (pending === 0) return;` 早退，而 tab 即使 pending=0 也应该能切到 PendingTab 显示空状态（与 chip 是「跳到第一个待处理」的提醒入口语义不同）。

`view === 'live'` / `'history'` tab 不需要同样修：`history` 在 detailSession 计算里有专用分支（用 historySession 而非 selectedFromMap）所以本就不受影响；`live` 在详情页里 active 的语义是「我在实时列表的某个会话里」，保留 SessionDetail 是符合预期的。
