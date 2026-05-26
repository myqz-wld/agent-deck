# CHANGELOG_16: 引入 reviews/ 双轨机制 + CLAUDE.md 简化对齐 + 反馈升级加 Agent 踩坑

## 概要

把 changelog 边界重新划清：`changelog/` 只放功能变更；新建 `reviews/` 目录放 debug / 性能 / 安全 review 报告。三份 CLAUDE.md 简化对齐，约定升级流程加入双对抗三态裁决。配套首份 `REVIEW_1.md`（main 进程双对抗 review，8 处修复）已落地，详见 [`reviews/REVIEW_1.md`](../reviews/REVIEW_1.md)。

## 变更内容

### 文档机制（agent-deck/CLAUDE.md / .claude/conventions-tally.md / reviews/）

- **新增 `reviews/` 目录**（与 `changelog/` 同级）：放周期性 / 触发性的 debug / code review / 性能 audit / 安全审查报告
- 命名跟 changelog 对齐：`REVIEW_X.md`（X 递增整数）+ `INDEX.md`
- changelog 与 review 边界：功能变更（新功能 / API / 依赖升级）→ changelog；不引入新功能、修问题或加固 → reviews
- CLAUDE.md「项目特定约定」简化合并：3 个相邻小节（主进程模块通信 / 设置变更运行时同步 / renderer 边界）合到一节；新增「资源清理 & TOCTOU 防线」小节沉淀 REVIEW_1 教训
- CLAUDE.md「反复反馈 → 升级约定」节升级：用户反馈 + Agent 踩坑两类候选，同一文件分 section；升级流程加入**双对抗三态裁决**（不再只是用户单向确认）
- `.claude/conventions-tally.md` 同步：加 `# Agent 踩坑候选` section，预录 P1-P8（来自 REVIEW_1 的 8 类模式化 pitfall）

### 通用约定（~/.claude/CLAUDE.md / resources/claude-config/CLAUDE.md）

- 「决策对抗」适用范围扩到 **plan + 约定升级**（之前只覆盖代码下定性判断）
- 当前推荐配对**写明具体模型**：Claude Code subagent（Opus 4.7 xhigh，`Explore` / `general-purpose`）+ Bash 调外部 codex CLI（gpt-5.4 xhigh）
- 外部 Agent 不可用时**不自动降级**到同源双 Agent，提示用户决定（避免悄悄降低对抗强度）
- codex CLI 调用模板移到附录「外部 CLI 对抗 Agent 调用通用姿势」节，抽出通用工程姿势
- ~/.claude/CLAUDE.md 新增「项目工程规范（新建项目时应用）」节：4 套机制（README 三问 + changelog/reviews 双轨 + 反馈/踩坑升级 + 项目根目录骨架）作为新建项目的工程地基

### changelog/INDEX.md

- 概要列重写为每条 ≤80 字（之前部分超过 200 字）
- CHANGELOG_X.md 单文件**保持原样**（不动历史推演细节，只精炼索引）

### 代码（详见 [REVIEW_1.md](../reviews/REVIEW_1.md)）

REVIEW_1 三态裁决后落地的 8 处修复（HIGH 3 / MED 4 / LOW 1）：

| # | 文件 | 修复 |
|---|------|------|
| 1 | `src/main/session/manager.ts` | 删除 `pendingSdkCwds size===1` 模糊匹配（误 claim 外部 CLI hook 会话） |
| 2 | `src/main/adapters/claude-code/sdk-bridge.ts` | `createSession` 整段 await 链包 try/catch，失败也释放 `releasePending` |
| 3 | `src/main/ipc.ts` | `loadImageBlob` 先 `realpath` 再校验白名单 + ext，治 TOCTOU symlink 越权 |
| 4 | `src/main/adapters/claude-code/sdk-bridge.ts` | `maybeEmitImageFileChanged` 顶部统一 `delete toolUseNames`，治长会话 Map 泄漏 |
| 5 | `src/main/adapters/claude-code/sdk-bridge.ts` | query loop catch 补 `emit('message', { error: true })`，UI 不再看到神秘 session-end |
| 6 | `src/main/store/event-repo.ts` + `src/main/ipc.ts` | 新增 `hasToolUseStartWithFilePath`（SQL `json_extract` + `EXISTS LIMIT 1`），ImageRead 白名单去掉 500 限制 |
| 7 | `src/main/index.ts` | `before-quit` 改 `event.preventDefault()` → 异步清理 → `app.exit(0)`；接 `closeDb()` |
| 8 | `src/main/ipc.ts` | `AppGetVersion` 用 `app.getVersion()` 替换 `npm_package_version` env |

## 备注

- 本次开始严格遵守边界：纯加固 / bug 修复 / 性能优化 → reviews/REVIEW_X.md；新功能 / API / 依赖升级 / 机制变更 → changelog/CHANGELOG_X.md。CHANGELOG_16 本身属于「机制变更」（引入 reviews/ 机制），所以记录在 changelog
- review-001.md 已 git mv 重命名为 REVIEW_1.md，所有引用同步更新
- ~/.claude/CLAUDE.md 同步更新（不在仓库 tracking 范围，但用户全局生效）
