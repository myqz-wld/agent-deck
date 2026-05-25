# 01-reviewer-claude-oneshot-disallow-exitplanmode: 决策对抗 reviewer-claude oneshot 必须 default mode + 禁 ExitPlanMode

> 项目特定约定（升级自 `conventions/tally.md` 候选 → 用户授权直接升级，跳过 count=3 阈值）。改动相关代码前 `cat conventions/01-reviewer-claude-oneshot-disallow-exitplanmode.md` 确认是否仍生效。

## 触发场景

任何 reviewer-claude 走 `claude -p` 非交互 oneshot 模式（典型：user CLAUDE.md §决策对抗 §主路径双 Bash 起异构外部 CLI）。

模板锚点：`~/.claude/templates/reviewer-claude.sh.tmpl`。

## 约定

reviewer-claude oneshot 调用必须用以下两组 flag：

```
--permission-mode default
--disallowedTools 'Edit,MultiEdit,Write,NotebookEdit,ExitPlanMode'
```

**禁止**：
- 不要用 `--permission-mode plan`
- 不要让 ExitPlanMode 出现在 `--allowedTools`（即使加了也无效，plan mode 的批准走 UI 弹层而非工具 allow 字段）

**写文件 / 改代码 / commit 防护**：靠 `Edit,MultiEdit,Write,NotebookEdit` 一并 disallow 物理保证，不依赖 plan mode 「先 plan 后批准才能写」的语义。

## 为什么（避免后续推翻）

claude CLI `-p` 是非交互 oneshot 模式，只能从 stdout 读 final answer，无 UI 让人批准。`--permission-mode plan` 下 Claude 输出 final answer 前会强制调 ExitPlanMode 工具要求人工批准 → CLI 在 `-p` 模式无人可批 → 拒该工具调用 → finding 正文被吞，stdout 0 byte 或仅一行 stub。

「plan mode 让 reviewer 更稳，不会乱写」是直觉性误判：reviewer-claude 模板已经 `--disallowedTools 'Edit,MultiEdit,Write,NotebookEdit'` 物理禁写，plan mode 在此场景下纯负担。

**违反代价**：reviewer-claude 跑完 exit 0 但 finding 全部丢失 → lead 等于没跑对抗，浪费一次 token + 时间预算。

## 反例 / 已知踩坑

- **首踩**：`reviews/REVIEW_52.md` § 方法节，原文：「reviewer-claude 首轮 `--permission-mode plan + -p` 撞 ExitPlanMode 非交互模式拒绝路径 → finding 正文被吞 → 仅留 404B 一行总结。重试改 `--permission-mode default + --disallowedTools ExitPlanMode` 后正常拿到 17KB 完整 finding」（2026-05-21）
- **再踩**：`reviews/REVIEW_54.md` §双对抗补做 R1 节，user 反问「你没对抗 review 吗」后 lead 补做对抗，沿用 `~/.claude/templates/reviewer-claude.sh.tmpl` 原版 `--permission-mode plan` → reviewer-claude output 0 byte，与 REVIEW_52 同款踩坑（2026-05-25）

## 关联

- 升级自：`conventions/tally.md` 候选（**未** count=3 静默升级，用户授权直接跳阈值升级，2026-05-25）
- 关联 review：`reviews/REVIEW_52.md` § 方法节首踩 + `reviews/REVIEW_54.md` §双对抗补做 R1 再踩
- 关联模板修法：`~/.claude/templates/reviewer-claude.sh.tmpl`（同步本约定改 `--permission-mode default` + `--disallowedTools` 含 `ExitPlanMode`）

## 适用范围 / 例外

**适用**：
- `claude -p` 非交互 oneshot 模式（user CLAUDE.md §决策对抗 §主路径单次决策对抗）
- 任何 lead Bash `run_in_background` 起 reviewer-claude 拿 stdout finding 的场景

**不适用 / 例外**：
- 应用环境内 SDK 编排（如 agent-deck 应用 `mcp__agent-deck__spawn_session({adapter:'claude-code', agent_name:'reviewer-claude'})` 起 reviewer teammate）—— SDK 走 canUseTool 回调通路，不依赖 CLI flag 语义
- 用户主动 `claude` 交互终端（非 `-p`）—— 有 UI 可批准 ExitPlanMode
- claude CLI 走非 reviewer 用途（其他 Bash 自动化场景按各自需求决定 mode）
