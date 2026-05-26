# CHANGELOG_17: ~/.claude/CLAUDE.md + 应用注入 CLAUDE.md 骨架优化（节序重排 / 模板瘦身 / 加 CHANGELOG+REVIEW 模板）

## 概要

通用约定 CLAUDE.md（用户全局 `~/.claude/CLAUDE.md` + 应用打包注入 `resources/claude-config/CLAUDE.md`）骨架优化：节序重排（外部 CLI 从「附录」降级为「决策对抗」子节，模板独立成最后一节）、合并冗余（原「项目工程规范 / 项目根目录骨架 / 初始模板」三处合一为「新项目工程地基」+「模板」两节）、模板瘦身（CLAUDE.md 模板的「改动后必做」改名「项目特定触发」避免与通用约定指引重复，tally 两段「按 count 倒序」合一到顶部 + 表头）、标题去冗词（「附录：」「（新建项目时应用）」「具体姿势」）。新增 CHANGELOG_X.md + REVIEW_X.md 两份模板（按本项目 CHANGELOG_16 / REVIEW_1 实际范式抽取，含三表副标题 + HIGH/MED/LOW 修复分组 + Agent 踩坑沉淀指引）。两文件保持完全同步（resources 顶部 7 行 HTML 注释外）。

## 变更内容

### `~/.claude/CLAUDE.md` + `resources/claude-config/CLAUDE.md`

- 「附录：外部 CLI 对抗 Agent 调用通用姿势」从顶级 `##` 节降级为「## 决策对抗」的 `###` 子节，标题简化为「外部 CLI 对抗 Agent 通用姿势」（去掉「附录：」「调用」）；codex CLI 子小节标题「具体姿势」→「模板」
- 「外部 Agent 不可用时」从独立段落 → 并入「决策对抗」操作清单末尾 bullet
- 「项目工程规范（新建项目时应用）」改名「新项目工程地基」；目录骨架挪到节首（先看结构再讲规则）；原「项目根目录骨架」与「项目 CLAUDE.md / 各 INDEX.md 初始模板」两节并入「新项目工程地基」+ 独立「模板」节
- 「## 模板」节独立到最后；引导句区分「前 4 份新项目第一次提交时建」vs「后 2 份第一次有变更 / review 时按模板新建」
- 4 份原模板瘦身：CLAUDE.md 模板的「## 改动后必做」改名「## 项目特定触发」（避免与通用约定指引重复，仅留项目特定触发示例）；tally 模板顶部声明合并 + 两段「按 count 倒序」分散到表头
- 新增 CHANGELOG_X.md 模板（按本项目实际范式：标题 + `## 概要`（2-3 行）+ `## 变更内容`（`### <模块/层（路径）>` 分组 bullet）+ `## 备注`（可选））
- 新增 REVIEW_X.md 模板（按 REVIEW_1 实际范式：`## 触发场景` + `## 方法`（双对抗配对 + 范围 + 约束）+ `## 三态裁决结果`（✅/❌/⚠️ 三表，带 REVIEW_1 副标题）+ `## 修复（CHANGELOG_<Y> 落地）` 按 HIGH/MED/LOW 分组 + `## 关联 changelog` + `## Agent 踩坑沉淀（如有）`）

### 文件大小

- `~/.claude/CLAUDE.md`：266 → 334 行（净增 +68 行 = 新增 CHANGELOG/REVIEW 模板 ~85 行 - 骨架瘦身 ~17 行）
- `resources/claude-config/CLAUDE.md`：274 → 342 行（含顶部 7 行 HTML 注释 + 1 空行）

## 备注

- 两文件保持完全同步：HTML 注释明确要求「内容必须与 ~/.claude/CLAUDE.md 保持一致；改一处必须同步另一处」，已用 `diff <(tail -n +9 resources/claude-config/CLAUDE.md) ~/.claude/CLAUDE.md` 验证一致
- 应用不需要重新打包就能让用户拿到新文本：用户已经通过设置面板 ClaudeMdEditor 维护用户副本（写到 `userData/agent-deck-claude.md`），仓库里 `resources/claude-config/CLAUDE.md` 仅作重置默认值的参考来源；下次主动「恢复默认」时才会读到新版本
- `~/.claude/CLAUDE.md` 不在 repo tracking 范围（用户全局生效），仅作信息记录
- 未走「决策对抗」三态裁决：本次改动属于「约定升级」适用范围，但内容主要是 CHANGELOG_16 / REVIEW_1 已落地的实证范式抽取与结构梳理（非凭空提议），双对抗收益小；如需补审视措辞 / 边界 / 与已有约定的冲突可后续单独走
