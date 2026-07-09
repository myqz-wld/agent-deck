# CHANGELOG_168

提示词资产 user 家目录依赖搬到项目内自闭环:`~/.claude/{SOPs,templates}/` 13 份移到 `resources/{SOPs,templates}/`,`§决策对抗` 节 inline 到 application CLAUDE.md,18+ 处活资产引用全切项目相对路径。

## 概要

**问题**:项目 4 份活提示词资产(项目根 CLAUDE.md / `resources/claude-config/CLAUDE.md` / `resources/codex-config/CODEX_AGENTS.md` / `agent-deck-plugin/skills/deep-review/SKILL.md`)+ 4 份 plugin 资产(2 份 reviewer agent body / 1 份 SKILL / 1 份 README)共 18+ 处引用 `~/.claude/SOPs/` 与 `~/.claude/templates/` 下的 SOPs 与模板。绑死 user 家目录带来 3 问题:

1. **应用打包断链**:`resources/claude-config/CLAUDE.md` + `CODEX_AGENTS.md` 被打包注入到 SDK system prompt 末尾;最终用户跑 .app 时家目录可能没那些 SOPs/templates → 引用断链
2. **dev clone 断链**:其他 dev `git clone` agent-deck 项目跑 claude 时,家目录如果没有那 13 份文件 → 项目根 `CLAUDE.md` 引用也断链
3. **历史快照漂移风险**:user 家目录是用户私有,与"上次同步到项目"的版本可能差异 → 项目活资产引用的语义脱钩

**目标**:agent-deck 项目内所有提示词资产构成一个自给自足的子系统 — 不依赖也不提到 `~/.claude/` 外部资源(SDK 运行时 `~/.claude/.credentials.json` / `~/.claude/projects/` 等强制凭证/jsonl 路径不算)。user 家目录冗余删,保留 user CLAUDE.md 自身引用的 3 份(`codex-cli-stuck-lessons.md` + `reviewer-{claude,codex}.sh.tmpl`,user 级 + 项目内副本独立维护)。

## 变更内容

### `resources/SOPs/` + `resources/templates/`(新建,13 份)

```
resources/SOPs/
├── file-size-guardrail.md            # 单文件 ≤ 500 行护栏
├── file-level-review-expiry.sh       # 已审文件过期 自检脚本
└── codex-cli-stuck-lessons.md        # codex CLI / claude -p 大任务 stuck 教训

resources/templates/
├── project-claude.template.md
├── changelog-index.template.md
├── changelog.template.md
├── reviews-index.template.md
├── review.template.md
├── conventions-tally.template.md
├── conventions-index.template.md
├── convention-single.template.md
├── reviewer-claude.sh.tmpl
└── reviewer-codex.sh.tmpl
```

13 份均原样 cp 自 `~/.claude/{SOPs,templates}/`,3 个 .sh / .sh.tmpl 加 `+x`。**资产内嵌引用 7 处全改** `~/.claude/CLAUDE.md` → `resources/claude-config/CLAUDE.md`(SOPs/file-level-review-expiry.sh L3 + project-claude.template.md L4/L14/L22 + review.template.md L18 + conventions-tally.template.md L4 + conventions-index.template.md L7)。

### `resources/claude-config/CLAUDE.md`(application CLAUDE.md)

- **新增 §决策对抗 节**:inline user CLAUDE.md §决策对抗 整节(63 行,含 §适用范围 / §场景分流 / §主路径 双 Bash 起异构外部 CLI / §外部 CLI 对抗 Agent 通用姿势 / §反驳轮 + 三态裁决 / §Finding 输出契约 / §reviewer-codex 失败兜底 7 个子节)到 application CLAUDE.md。位置:`## 应用环境特有能力` 节(L16)后、`## 核心流程 / 架构变更必走 plantUML` 节(L54 前移到 L129)前,作为通用方法论基础节。**不加 cross-ref callout**(完全 self-contained,user 与 application 两份 §决策对抗 各自独立维护,符合"不提到外部资源"原意图)。inline 时调整 3 处内部引用从 `~/.claude/{templates,SOPs}/` 改 `resources/{templates,SOPs}/`;§reviewer-codex 失败兜底 末尾 callout 末尾追加一句明示本应用环境合规兜底分支在 §应用环境特有能力 §reviewer-codex 失败 → SKILL 内合规兜底分支 节(双向协调关系,非外部引用)
- **更新 L14 加载范围注释**:self-contained 工程实践 inline 清单从 `(§复杂 plan workflow / §新项目工程地基 / §核心流程架构变更必走 plantUML)` 加 §决策对抗 → `(§决策对抗 / §核心流程架构变更必走 plantUML / §复杂 plan workflow / §新项目工程地基)`
- **6 处路径引用全改**:L50(reviewer-codex.sh.tmpl)+ L207(reviewer-{claude,codex}.sh.tmpl)+ L382(templates/)+ L458(review.template.md)+ L478(file-level-review-expiry.sh)+ L482(file-size-guardrail.md)从 `~/.claude/{SOPs,templates}/X` 改成 `resources/{SOPs,templates}/X`

### 项目根 `CLAUDE.md`

L5 callout + L24 §改动后必做 第 4 条 2 处 `~/.claude/SOPs/file-size-guardrail.md` → `resources/SOPs/file-size-guardrail.md`。

### `resources/codex-config/CODEX_AGENTS.md`

L63 §reviewer-claude 失败 → SKILL 内合规兜底分支(对称 claude 视角)1 处 `~/.claude/templates/reviewer-claude.sh.tmpl` + "按 user 全局模板..." → `resources/templates/reviewer-claude.sh.tmpl` + "按项目内模板..."。

### `resources/claude-config/agent-deck-plugin/`(SKILL + agents + README)

- `skills/deep-review/SKILL.md` 6 处:
  - L39 sandbox 限制反例 `~/.claude/CLAUDE.md` → "user 家目录配置文件"(抽象化,避免出现外部资源字面)
  - L112 / L189 SSOT 完整契约引用 `~/.claude/CLAUDE.md` → `resources/claude-config/CLAUDE.md`
  - L195 / L196 reviewer-{codex,claude} 失败兜底 `~/.claude/templates/reviewer-{codex,claude}.sh.tmpl` + "按 user 全局模板..." → `resources/templates/...` + "按项目内模板..."
  - L209 与 .sh.tmpl 关系叙述 `~/.claude/templates/reviewer-{claude,codex}.sh.tmpl` + "user 全局 §决策对抗" → `resources/templates/...` + "项目内 §决策对抗"
- `agents/reviewer-claude.md` L83 + `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md` L80(agents/ 两端独立 SSOT,各自维护):严重度枚举 5 档表述 `与 ~/.claude/CLAUDE.md §Finding 输出契约 节一致` → `与 resources/claude-config/CLAUDE.md §Finding 输出契约 节一致`
- `claude-config/README.md` L33:`走 user 全局 ~/.claude/CLAUDE.md §决策对抗` → `走 resources/claude-config/CLAUDE.md §决策对抗`

注:`resources/codex-config/agent-deck-plugin/skills/` 是 build-time `scripts/sync-codex-skills.mjs` 从 claude-config SSOT cp 出来的,本次只改 SSOT,下次 `pnpm predev/prebuild/predist` 自动同步。

### `package.json` extraResources

在 `resources/sounds → sounds` 之后追加 2 条:

```json
{ "from": "resources/SOPs",      "to": "SOPs",      "filter": ["**/*"] },
{ "from": "resources/templates", "to": "templates", "filter": ["**/*"] }
```

让 `pnpm dist` 打包 .app 时把 `resources/SOPs/` `resources/templates/` 拷贝到 `Contents/Resources/`,SDK 注入的 prompt 引用相对路径在 dev 跑 agent-deck / 应用启动 .app 两种场景都能解析。

### 删除 user 级冗余(10 份)

`rm` 项目已自有的 10 份(`~/.claude/SOPs/file-{size-guardrail.md,level-review-expiry.sh}` + 8 份 templates 除 reviewer-{claude,codex}.sh.tmpl)。**保留 user 级 3 份**:
- `~/.claude/SOPs/codex-cli-stuck-lessons.md`(user CLAUDE.md L57 引用)
- `~/.claude/templates/reviewer-claude.sh.tmpl`(user CLAUDE.md L37 引用)
- `~/.claude/templates/reviewer-codex.sh.tmpl`(user CLAUDE.md L38 引用)

后 3 份 + 项目内 `resources/{SOPs,templates}/` 的同名副本独立维护(双副本策略,user 级随 user CLAUDE.md 演进,项目内随 agent-deck 演进)。

## 备注

- **不改的项**:历史归档(`ref/plans/` `ref/changelogs/` `ref/reviews/` `ref/conventions/`)19+ 处历史快照引用全不动(写完不动契约);SDK 运行时凭证/jsonl 路径(`~/.claude/.credentials.json` / `~/.claude/projects/` 等)是 SDK 强制依赖不算"文档引用";application CLAUDE.md L11/L341/L442 metadata 描述(配置层级)不是 follow 链接;`reviewer-codex.sh.tmpl` L3 `~/.codex` 是 codex 自家配置依赖。
- **已知双 SSOT 漂移**:application CLAUDE.md §决策对抗 与 user CLAUDE.md §决策对抗 完全独立(不加 cross-ref callout);`reviewer-{claude,codex}.sh.tmpl` 两边并存。用户已接受。
- **应用 build/dist 验证**:`pnpm dist` 后 `ls "build/dist/mac-arm64/Agent Deck.app/Contents/Resources/"` 看到新增 `SOPs/` `templates/` 子目录即通。
- **不走 §决策对抗**:本次属机械搬迁 + 路径替换 + 节 inline,设计大方向已 user 五轮 AskUserQuestion 决策(Q1-Q5),无设计争议。

## Post-review Fix(deep-review SKILL teammate R1 → R2 期间发现)

deep-review SKILL invoke 后 reviewer-codex 与 lead 现场实证发现 HIGH/MED 问题,修正:

### HIGH: `.app` 安装版用户项目 cwd 下 literal `resources/{SOPs,templates}/X` 引用 ENOENT(reviewer-codex 提出 + reviewer-claude 反驳轮确认)

失败链:装好 .app → 用户跑 `agent-deck new --cwd <user-project>` → SDK session cwd=`<user-project>`(用户项目根本无 `resources/` 目录) → agent 看到 application CLAUDE.md 注入的「`bash resources/SOPs/file-level-review-expiry.sh`」字面执行 → ENOENT。**13 处 literal `resources/{SOPs,templates}/X` 引用全部受影响**(CLAUDE.md ×9 / CODEX_AGENTS.md ×1 / SKILL.md ×3)。

修法 user 决策选项 2(placeholder 占位符 + 注入时替换):
- 13 处 literal `resources/{SOPs,templates}/X` 改成 `{{AGENT_DECK_RESOURCES}}/{SOPs,templates}/X` placeholder(sed 全文替换)
- `src/main/adapters/claude-code/sdk-injection.ts` 加 `substituteResourcesPlaceholder` helper + 在 `getAgentDeckSystemPromptAppend()` 注入前替换为绝对路径(dev=`<app.getAppPath()>/resources`,prod=`process.resourcesPath`,extraResources 把 `resources/SOPs → SOPs` `resources/templates → templates` 打到 `Contents/Resources/SOPs/X` `Contents/Resources/templates/X` 与 placeholder resolve 完美对齐)
- `src/main/codex-config/agents-md-installer.ts` 同款 helper + 在 `syncAgentDeckSection()` 写盘 `~/.codex/AGENTS.md` 前替换(codex 端写盘语义,不在 in-memory cache 替换避免 dev/prod build 期间 cache 污染)
- **保留 1 处**:项目根 `CLAUDE.md` L5 `resources/SOPs/file-size-guardrail.md` literal 引用(项目根 CLAUDE.md 只在 agent-deck repo cwd 内被普通 claude CLI 加载,**不**被 .app SDK 注入路径调用,cwd=agent-deck repo 解析正常,改 placeholder 反而引入新问题 — 项目根 CLAUDE.md 加载路径无 placeholder 替换机制)

### MED: `package.json` 缺 `predist*` hook,`pnpm dist*` 不跑 `sync-codex-skills.mjs`(reviewer-codex 提出)

`predev` / `prebuild` 已有,但 4 个 `dist*` 脚本无对应 `pre*` hook → `pnpm dist*` 把 stale codex mirror 打进 packaged bundle。修法:加 4 个 `predist` / `predist:mac` / `predist:win` / `predist:linux` hooks 都跑 `node scripts/sync-codex-skills.mjs`,与 predev/prebuild 模式对称。

### MED (升级 D): `resources/codex-config/agent-deck-plugin/skills/deep-review/SKILL.md` working tree 含 stale `~/.claude/templates/` 引用(双方独立提出,与 MED B 同根因)

修法:跑 `node scripts/sync-codex-skills.mjs` 收敛 mirror(本次 fix 顺带把 placeholder 也同步过去,mirror 现 3 处 `{{AGENT_DECK_RESOURCES}}/templates/...`)。MED B fix 加 predist hooks 后,未来 `pnpm dist*` 自动同步,根除窗口期。

### INFO C: CHANGELOG_168 写「11 份」实际 13 份(reviewer-codex 提出)

`find resources/SOPs resources/templates -maxdepth 1 -type f | wc -l = 13`(3 SOPs + 10 templates,reviewer-codex 实证 + lead 现场复现)。本节 L17 / L38 已修 11 → 13。

### 接受不修(INFO E / F)

- INFO E (build/dist/ 历史 .app 含旧引用):build product,下次 `pnpm dist*` 自然覆盖(且本 fix 加 predist 后 sync 自动跑)
- INFO F (dual-SSOT drift 无自动监测):用户已显式接受(CHANGELOG L89 声明)

### typecheck

`pnpm typecheck` 0 error(post-fix 验证)。

## R2 → R3 Post-fix(reviewer-codex R2 提出 SKILL.md 加载路径漏 substitute,reviewer-claude R3 提出 codex bundled-assets latent gap)

### R2 HIGH(reviewer-codex 提出): R1 fix 漏 SKILL.md 加载路径

R1 placeholder substitute 只覆盖 `sdk-injection.ts:getAgentDeckSystemPromptAppend`(claude system prompt)+ `agents-md-installer.ts:syncAgentDeckSection`(codex AGENTS.md 写盘),但**SKILL.md 走另一条路径**:claude SDK 自扫 plugin root 下 skills/agents,codex `syncSkills()` 原文 cp 到 `~/.codex/skills/agent-deck/`。两条都没 substitute → agent invoke /agent-deck:deep-review 看到字面 `{{AGENT_DECK_RESOURCES}}` → ENOENT。

修法:
- **Claude 端**:`src/main/adapters/claude-code/sdk-injection.ts` 改 `getClaudeAgentDeckPluginPath()` 从直接返 source path → lazy install plugin mirror 到 `<userData>/agent-deck-plugin/` 后返 mirror path。新加 95 行(`getPluginSourceDir` / `getPluginMirrorDir` / `ensurePluginMirrorInstalled` lazy install + flag / `substituteMdFilesInPlace` 递归 walk + readFile + substitute + writeFile / `invalidatePluginMirror` 给未来 settings UI 用)。每次启动 rm + cpSync + substitute 全量覆盖,**No mtime skip**(substitute 输出依赖 runtime constants,source mtime 不是权威 staleness 判据)
- **Codex 端**:`src/main/codex-config/skills-installer.ts` 改 `syncSkills()` 加 placeholder substitute,删 mtime 跳过(同款 No mtime skip 理由)

### R2 INFO(reviewer-codex 提出): CHANGELOG L3 / L10 残留「11 份」

R1 fix 只改了主清单 L17 / L38,概要 L3 + 问题段 L10 漏改。本节 11 → 13。L115 INFO C section title「写「11 份」实际 13 份」是历史叙述保留(引述 R2 提出问题)。

### R3 MED(reviewer-claude 提出 latent gap): codex bundled-assets read 不对称

claude 端 bundled-assets.ts 通过 `getClaudeAgentDeckPluginPath()` 拿 mirror path(已 substitute);**codex 端**通过 `getCodexAgentDeckPluginPath()` 直接拿 source path(无 mirror / 无 substitute),`getBundledAssetContent()` 读 raw 内容传给 `spawn.ts:108` 拼 codex SDK session prompt prefix。当前 0 placeholder(reviewer-codex.md 干净),**但任何人未来在 `resources/codex-config/agent-deck-plugin/agents/*.md` 写 placeholder → 复发 R1 同款 bug 且更隐蔽**(无 mirror 自检)。defense-in-depth 风险。

修法:
- 抽 shared helper `src/main/utils/resources-placeholder.ts`(export `RESOURCES_PLACEHOLDER` + `resolveAgentDeckResourcesRoot` + `substituteResourcesPlaceholder` 三个 stable helper)
- 3 处原 caller(sdk-injection.ts / agents-md-installer.ts / skills-installer.ts)删本地私有 helper + 改 import shared(同时兑现 reviewer-claude R3 INFO-1 follow-up「多模式共存可抽公共 helper」)
- 4 处新 caller `bundled-assets.ts:getBundledAssetContent` return 前 wrap substitute(adapter agnostic + idempotent,claude 侧已 substituted 走 `text.includes` guard 直接返)

### R3 INFO(reviewer-codex 提出): skills-installer 文件头同步策略注释漂移

文件头 jsdoc 仍写「文件 mtime 对比:仅源文件 mtime > 目标 mtime 才覆盖」但 R2 fix 已删 mtime 跳过逻辑。改成「每次启动覆盖写入(不依赖 mtime 对比;...substitute 输出依赖 runtime constants 不是权威 staleness 判据)」。

### R3 follow-up(reviewer-claude 列 follow-up,本轮不修)

- **MED**(R2 提出): claude/codex 双侧 cache 语义不对称(claude system prompt 是 substitute-then-cache 内存;codex AGENTS.md / codex skills 是 substitute-on-write 文件系统;本 R3 抽 shared helper 后多模式共存维护陷阱缓解,但模式本身未统一)。reviewer-claude R3 INFO-1 评估「不阻塞合并;每处 jsdoc 已解释;follow-up 可抽公共 `mirrorAndSubstituteDir(src, dst)` helper」
- **LOW**(R2 提出): placeholder typo(如 `{{AGENT_DECK_RES}}` / `{{ AGENT_DECK_RESOURCES }}` 多空格)静默 fall-through。当前 0 typo,保护检查属"加固"非"修 bug"。follow-up 选项:substitute 后扫残留 `{{AGENT_DECK_*}}` 模式 warn

### typecheck (R3 收口)

`pnpm typecheck` 0 error(post-R3 fix 验证,2 个 .ts refactor + 1 个 utility 新建 + 1 处 wrap substitute + CHANGELOG)。

### 收口

- reviewer-codex R3 ✅ 0 HIGH / 0 真 MED 共识可合
- reviewer-claude R3 ✅ 0 HIGH + 1 MED(latent,本 R3 已修) + 5 INFO(已修 1 个,follow-up 4 个)
- 双方共识可合 → R3 收口

## Post-R3 Follow-up(用户主动要求处理 R3 列单)

### Follow-up #2 实施(LOW: placeholder typo 静默 fall-through,R2 reviewer-claude 提出)

修法:`src/main/utils/resources-placeholder.ts` 加 `TYPO_DETECTOR` regex(`/\{\{AGENT_DECK_[A-Z_]*\}\}/g`)+ `warnOnUnknownPlaceholders` helper + 在 `substituteResourcesPlaceholder` 内调用。任何 `{{AGENT_DECK_*}}` 形式但不在 `KNOWN_PLACEHOLDERS` Set(当前只 `{{AGENT_DECK_RESOURCES}}` 一条)的 literal 触发**一次** `console.warn` 列出 offenders + 不抛错。

dev-time 防御性 catch typo:
- `{{AGENT_DECK_RES}}` 单方少写 OURCES → 警告
- `{{AGENT_DECK_RESOURCE}}` 单数漏 S → 警告
- 未来扩展新 placeholder(如 `{{AGENT_DECK_USER_DATA}}`)直接加进 `KNOWN_PLACEHOLDERS` Set 不触发 warn

故意**不**匹配 `{{ AGENT_DECK_RESOURCES }}`(带空格)的 typo — regex 严格无空格避免对 Mustache-like 不相关 `{{ ... }}` 语法误报。生产 0 typo,warning 完全 dev-only。

### Follow-up #1 重新评估 + 文档钉死(MED: cache pattern asymmetry,R2 reviewer-claude 提出)

reviewer-claude R3 INFO-1 建议「follow-up 可抽公共 `mirrorAndSubstituteDir(src, dst)` helper」。**重新评估发现 mirror 模式只 plugin-mirror 一处使用**:
- `sdk-injection.ts:ensurePluginMirrorInstalled` 是「rm + cp 整个目录 + walk substitute .md」 mirror 模式
- `skills-installer.ts:syncSkills` 是「逐个 SKILL.md 处理 + 保留用户 ~/.codex/skills/ 兄弟目录」**非** mirror 模式(语义不同)
- 其他 3 处(claude system prompt / codex AGENTS.md / codex bundled-assets)是单文件 read/write 不涉及目录 mirror

抽 helper 只 1 处用违反 §提示词资产维护 约束 2「不写预测未来用例代码」+ Don't add abstractions beyond what the task requires 原则。**改用 jsdoc design rationale 钉死**:在 `resources-placeholder.ts` 顶部 jsdoc 加段「The 5 callers and why their cache strategies are deliberately different」(R3 reviewer-claude MED follow-up close):
- 列举 5 处 caller 的 cache 策略 + 各自的 why
- 末尾段「Why the 5 strategies should NOT be unified」明示「unifying them would force unnatural caching (e.g. caching disk mirror output in-memory adds nothing because SDK reads disk anyway, but adds an invalidation footgun). Keep substitute logic shared via this module; let each caller's caching layer stay bespoke」

封死未来维护者「我来统一一下 cache 策略」冲动。**substitute 逻辑** 已通过 R3 抽 shared module 统一(5 处都 import 同一份 `substituteResourcesPlaceholder`),**cache 策略** 各自独立按设计需要保持。

### typecheck

`pnpm typecheck` 0 error(post-follow-up 验证)。
