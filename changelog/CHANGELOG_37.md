# CHANGELOG_37: NewSessionDialog teamName → prompt 模板自动回填（M1+）

## 概要

Agent Teams M1（CHANGELOG_35）的体验补强。Claude Code agent teams 必须用户在首条消息里**用自然语言**告诉 Claude 用什么 team 名 + 角色分工（SDK 没有 teamName options 字段，agent-deck 只能注入 env），如果用户只填了 team 名输入框、首条消息没说，会出现「env 注入了但 Claude 不知道要建队 / 不知道分工」的体感事故。M1 当时只在 hint 里贴了模板让用户自己抄；M1+ 升级为**自动回填可编辑模板到 prompt 输入框**，用户改占位符即可。

## 变更内容

### `src/renderer/components/NewSessionDialog.tsx`

- 新增 `makeTeamPromptTemplate(teamName)` helper：生成首条 prompt 引导模板（含 3 个 teammate 占位符 `<teammate-1>` / `<role / focus 1>` 等 + "shared task list 协调 + 综合反馈" 收尾）
- 新增 `lastInjectedTemplateRef: useRef<string>('')`：记录上次自动回填的模板字符串
- 新增 useEffect 监听 `[open, agentTeamsEnabled, agentId, adapters, teamName, prompt]`：
  - 仅当 dialog 打开 + showTeamName 双条件成立 + teamName 非空时回填
  - 仅当 `prompt === ''` 或 `prompt === lastInjectedTemplateRef.current` 时覆盖（用户改过就尊重，不再覆盖）
  - 回填后更新 ref，让下次 teamName 变化能正确判断「是否该覆盖」
- 简化 Field hint 文案：从「请在首条消息中告诉 Claude 创建/加入这个 team，例如：…」改为说明「prompt 输入框会自动回填可编辑模板，按需改占位符；改过的内容不会被后续 teamName 改动覆盖」

### 行为矩阵

| 场景 | 行为 |
|---|---|
| 打开 dialog + 填 teamName=`t1`（prompt 空） | prompt 自动回填 t1 模板 |
| 用户改 teamName 为 `t2`，prompt 仍是 t1 模板 | prompt 覆盖为 t2 模板 |
| 用户改 teamName 为 `t2`，prompt 已被用户编辑 | prompt 不动（尊重用户编辑） |
| 用户清空 teamName | prompt 不回退（用户可能已基于模板写了内容） |
| 切到 codex-cli adapter（canJoinTeam=false） | prompt 不回退 |
| 关 agentTeamsEnabled toggle | prompt 不回退 |
| 提交后 prompt 被 setPrompt('') 重置 | 下次开 dialog + 填 teamName 触发新模板回填 |

## 备注

- **不在 submit 时清 lastInjectedTemplateRef**：submit 已经 `setPrompt('')`，下次回填时 prompt === '' 直接覆盖即可，ref 旧值不影响判断
- **不动用户输入的边界**：teamName 清空 / 切 adapter / 关 toggle 都不回退 prompt——「自动回填」是一次性引导，不是双向绑定；用户基于模板编辑后，模板/teamName 的后续变化不应抹掉用户工作
- **占位符约定**：模板里 `<teammate-N>` / `<role / focus N>` 用尖括号包，让用户一眼看出哪里要改；不带 placeholder 标记（例如直接给 "developer"）容易让用户以为是 agent-deck 的硬约定
- 配套 verify 路线：用户重启 dev 后开 NewSessionDialog → 开 agentTeamsEnabled → 填 `test-team` → 看 prompt 输入框是否出现 `Create an agent team named "test-team" with 3 teammates...`，编辑后改 team 名应不覆盖编辑
