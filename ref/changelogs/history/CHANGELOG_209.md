# CHANGELOG_209

## Codex review workflow turn boundary

### 概要

Codex SDK 是 turn-based，不能像 claude SDK 那样在同一 turn 里持续等待 stream input 打断。本次把 Codex 侧 review workflow 改为：派出 reviewer / 反驳轮 / Round 2 后立刻说明状态并结束当前 turn；teammate reply 作为下一轮 user input 注入后再继续裁决。

### 变更内容

- `AGENTS.md`：Codex 操作要点新增 turn-based 等待规则，禁止用 `sleep` / `get_session` 循环在同一 turn 等 teammate reply。
- `resources/codex-config/CODEX_AGENTS.md`：新增 `codex turn boundary` 节，明确 Codex lead 等 reviewer / teammate reply 时必须结束 turn；只在用户下一轮询问状态或达到 SKILL 卡住阈值时查 `lastEventAt`。
- `resources/codex-config/agent-deck-plugin/skills/simple-review/SKILL.md`：Step 2 / Step 4 / Step 5 改为发出请求后结束 turn，下一轮收到 reviewer reply 后继续裁决。
- `resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md`：同款更新多轮 review、反驳轮、Round 2 fix 与卡住处理流程。

### 验证

- prompt asset 自检：Codex 侧新增规则使用强制动作措辞，未新增旧事实 / 过渡期 / 建议式表述。
