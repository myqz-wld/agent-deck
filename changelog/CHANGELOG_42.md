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

## 追加：修「Codex SDK 30 秒未发出 thread_id」误导文案

### bug 现象

新建 codex-cli 会话时，无论真实根因是什么（codex 鉴权失败 / 二进制找不到 / spawn ENOENT / 启动卡住），用户都会等满 30 秒看到固定文案 `⚠ Codex SDK 30 秒内未发出 thread_id。可能原因：codex 二进制启动失败 / 鉴权未配置 / 代理超限。请在终端运行 codex auth 验证鉴权，或检查设置面板的「Codex 二进制路径」。`——把上面 SDK 已经透出的真实 stderr（形如 `⚠ Codex turn 异常：Codex Exec exited with code 1: <stderr>`）盖掉，反而误导用户去查鉴权/二进制路径。

### 双对抗 Agent（Claude Explore + Codex `gpt-5.4`）四题一致根因

只读 `src/main/adapters/codex-cli/sdk-bridge.ts` 一个文件，4 题答案完全一致：

- **Q1 catch 是否清 fallback timer？** No —— 30s `setTimeout` 只在 `onFirstId`（拿到 `thread.started`）路径里 `clearTimeout(fallback)`，`runTurnLoop` 的 catch 块不动它
- **Q2 catch emit 真实 stderr 后，30s 后是否仍发固定文案？** Yes —— catch 不改 `resolved` 标志，30s 后 fallback 检查 `resolved === false` 还是会触发那条固定文案
- **Q3 catch 有无任何路径通知 `startNewThreadAndAwaitId` 的外层 promise？** No —— 外层 promise 只有两条 resolve 路径：`firstIdCb(realId)` 和 30s fallback；catch 完全不接触它
- **Q4 fallback 触发后是否产生死会话？** Yes —— `internal.threadId = tempKey` + `claimAsSdk(tempKey)` 后 thread 对象对应的 codex 子进程已死，后续 sendMessage 走到 runStreamed 还会再失败

### 修复（`src/main/adapters/codex-cli/sdk-bridge.ts`）

`startNewThreadAndAwaitId` 改为三态结算：

1. **✅ 成功** `onFirstId` 路径：`thread.started` → `clearTimeout(fallback)` → `resolve(realId)`
2. **❌ 早期失败** 新增 `onEarlyError` 回调：第一个 turn 在拿到 `thread_id` 前抛错时，`runTurnLoop` 的 catch 调 `earlyErrCb(msg)` 通知外层立即结算，把 SDK 的真实 stderr 作为错误消息发出来（不再等 30s）
3. **⏰ 30s 兜底** 仅当 codex 真的 hang 住（既没吐 thread.started 也没 exit）才触发；多走一步 `internal.currentTurn?.abort()` 把子进程打断，避免继续挂着

抽出 `resolveWithFallback(errorText)` 公用函数，三条路径共享同一段 emit 序列：`session-start → user message → error message → finished{ ok: false, subtype: 'error' }`，UI 看到的是一条完整收尾的失败会话。

`runTurnLoop` 加 `onEarlyError` 形参 + `earlyErrCb` 闭包变量；catch 内若 `earlyErrCb` 还在则走 early error 分支（调回调 + 清 firstIdCb/earlyErrCb + `break` 出 while loop，已死的 thread 不再处理后续 pendingMessages）。`firstIdCb` 触发时同步清掉 `earlyErrCb`，保证「拿到 thread_id 之后的失败」走常规 `Codex turn 异常` 路径。

### 行为对比

| 场景 | 改动前用户看到 | 改动后用户看到 |
|---|---|---|
| codex 鉴权失败立即 exit 1 | 5s 时一条 `⚠ Codex turn 异常：Codex Exec exited with code 1: ...` + 30s 时再追一条误导固定文案 | 5s 时一条 `⚠ Codex 启动失败：Codex Exec exited with code 1: <真实 stderr>` + finished |
| codex 二进制 spawn ENOENT | 同上（双消息） | 立即一条 `⚠ Codex 启动失败：spawn codex ENOENT` + finished |
| codex 真的卡 30s | 一条固定文案 | 一条固定文案 + 子进程被 abort 不再挂着 |
| codex 拿到 thread_id 后 turn 中途失败 | `⚠ Codex turn 异常：...` | 同左（不变） |

### 设计取舍

- **死会话 cleanup 不做**：early error 时 break 出 while 后，`internal` 还在 `sessions` map 里，但 thread 对象对应 codex 进程已死。下次 sendMessage 走 runStreamed 会再次抛错走 catch 的常规路径（emit `⚠ Codex turn 异常` + finished）。不会真"无响应"，最多就是每次发都失败一次——可以接受，避免引入 dead 标记 / sendMessage 提前 throw 等额外状态。用户看完错误消息会自然新建会话
- **不缩短 30s 超时**：早期失败已经在 catch 立即结算，30s 只覆盖「真 hang」场景（OAuth 设备码等待 / 网络代理超时），保留较长上限合理
- **fallback 多发 finished**：原代码只 emit message，没 finished，会话状态卡在 streaming；改后统一 emit finished，UI 状态机能正确收尾

## 追加：codex CLI 调用约定默认 reasoning effort 由 low 改 xhigh

### 起因

实测一轮 code review：相同 prompt + 相同文件清单，`low` 跑出 4 条优化点，`xhigh` 再跑（带"已知 5 条不要重复"约束）又挖出 6 条新的（包括 1 条 symlink 逃逸 HIGH + 1 条 settings.json 抹光 HIGH），命中率明显高出一档。原约定写死 `low`、xhigh 仅"留给探索 / 设计"，实际把 code review / 根因核实这种主战场挡在 low 档导致漏判。

### 改动（两份 CLAUDE.md 同步）

`~/.claude/CLAUDE.md` + `resources/claude-config/CLAUDE.md` 第 6 / 12 行 codex 调用约定那条：

- **默认档位** `model_reasoning_effort="low"` → `"xhigh"`，描述改为「默认；探索 / 设计 / code review 用，简单 yes/no 核查可临时降到 `"low"` 省时间，但宁可慢别错」
- **超时改用 Bash 工具参数**：原文 "用 timeout <秒数> 或 Bash 工具 timeout 参数包住 codex exec（核查类 60-90s 足够）" 改为明确写死「**macOS 没有 `timeout` 命令**，统一用 Bash 工具的 `timeout` 参数包住（xhigh 默认 300000 ms / 5 分钟，超大重 review 给 600000 ms / 10 分钟即 Bash 工具上限；low 降级时给 90000 ms 即可）」——上一轮就因为 prompt 里写 `timeout 180 codex exec ...` 直接报 `command not found` 浪费一次调用
- 骨架示例同步把 `low` 改 `xhigh`，并在末尾注明 Bash 工具调用时 `timeout: 300000`

应用打包路径不需要重新打包：用户已经通过设置面板的 ClaudeMdEditor 维护用户副本（写到 `userData/agent-deck-claude.md`），仓库里 `resources/claude-config/CLAUDE.md` 仅作为重置默认值的参考来源；下次有用户主动「恢复默认」时才会读到新版本。
