---
plan_id: "remove-aider-generic-pty-adapters-20260520"
created_at: "2026-05-20"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/remove-aider-generic-pty-adapters-20260520"
status: "completed"
base_commit: "84a691051d5c089e81b1c512e4ff2086aa5f49df"
base_branch: "main"
revision: "v4 (post Step 1.5 deep-review Round 3 fix)"
final_commit: "c2ab7ce58e39eb52b84119ed522fb2f5e31bae51"
completed_at: "2026-05-20"
---
# 删除 aider + generic-pty adapter,同时删 ComposerSdk slash 拦截

## 总目标

1. **删除 aider + generic-pty 两个 adapter**(整目录 + 所有引用)。用户实测无任何历史数据(单用户 Mac app,从未用过这两个 adapter 建过 session),直接强删,不做 graceful fallback
2. **删除 ComposerSdk `startsWith('/')` 拦截**(CHANGELOG_6 引入)。用户实测铁证(NewSessionDialog 首条 `/hello-from-deck` 跑通 SKILL):SDK streaming mode **支持** slash 触发 skill,原假设"会撞 `Unknown slash command`"被推翻
3. **卸载 generic-pty 专属 native dep**(`node-pty` 唯一 caller 是 generic-pty;`chokidar` 实测 0 prod 真 import,一并卸载)
4. **DB schema 不动**(无 enum CHECK 约束 adapter 字段,实测 grep 确认;`generic_pty_config` 列保留兼容老 SQLite 文件,新 session **固定写 NULL**;`GenericPtyConfig` TS type 整片删,`SessionRecord.genericPtyConfig: unknown | null` 字段保留作 raw passthrough 占位)

## 不变量

- **N1**:删完后剩 2 个 adapter — `claude-code` + `codex-cli`
- **N2**:**5 处 TS 编译期 SSOT 守门**(全在 `options-builder.ts:262-320` §D2 注释表)keys 严格一致 — `CreateSessionOptions` union arm + `CreateSessionOptionsByAdapter` map + `AdapterIdMap` map(registry.ts)+ `AGENT_IDS` list + `buildCreateSessionOptions` exhaustive switch;由 3 个 `_assert*` 函数(`_assertOptionsByAdapterMatchesUnion` / `_assertAdapterIdMapMatchesOptions` / `_assertAgentIdsListMatchesOptions`)+ `_exhaustive: never` 编译期 enforce。**3 处 runtime 边界**:`adapterRegistry.register` 注册 + MCP zod enum(`schemas.ts` 3 处)+ IPC zod enum(若有)
- **N3**:删除是**单向不可逆**(没历史数据需要兼容);任何 graceful fallback / "see legacy" 兼容代码都是冗余,违反 user CLAUDE.md §提示词资产维护 约束 2
- **N4**:`pnpm typecheck` / `pnpm test` / `pnpm build` 三类命令在每个 **phase 末 checkpoint step** 后必须过(**10 个 ⚑ checkpoint**:`P0.2 / P1.11 / P2.5 / P3.7 / P4.6 / P5.6 / P6.7 / P9.1 / P9.2 / P9.3`),phase **末必须**全绿才允许进下一 phase。**phase 内部 sub-step commit 允许 typecheck 红**(SSOT 链式 enforcement 的预期中间状态,详 §已知踩坑 第 1 条 + N8)
- **N5**:`pnpm test` 在 P5 删测试后必须过(adapter `__tests__/` 整目录走,共享 mock 同步清)
- **N6**:`generic_pty_config` **DB 列**保留不删(SQLite ALTER DROP COLUMN 需 v12+,且 NULL 行不占空间)— 但**TS 层** `GenericPtyConfig` type / `genericPtyConfigSchema` / `parseGenericPtyConfigJson` 函数 / `setGenericPtyConfig` setter 全删(D4 拍板"整片删 type")。`SessionRecord.genericPtyConfig` **保留字段** type 改 `unknown | null`(默认决策,见 D4);`upsert` binding **固定 `null`**(N3 强删 + 无历史数据 = raw write-back 永远写不出来,简化为 NULL);`rowToRecord` 读 column raw `string | null` 直接传(若有老 DB 行残留,UI 不解析使用,不影响其他逻辑)
- **N7**:历史 record(`changelog/CHANGELOG_*.md` / `reviews/REVIEW_*.md` / `plans/<existing>.md` / `docs/<name>-<YYYYMMDD>.md` 带日期 RFC)**不动**;**当前事实**陈述(README.md / `docs/agent-deck-team-protocol.md` 无日期 = 当前协议描述 / `resources/codex-config/CODEX_AGENTS.md`)若提 adapter 列表必改;应用打包 CLAUDE.md / 项目 CLAUDE.md grep 实测 0 hit(无需改,grep 自检兜底)
- **N8**:**commit 粒度政策** — sub-step commit(P1.1-P1.9 / P2.1-P2.4 / ...) 允许 typecheck 红(SSOT 链式 enforce 预期);phase 末 checkpoint step(打 ⚑ 标记)必须 typecheck/test/build 全绿才进下一 phase。回滚约定:撞 typecheck 中间状态时不能 single-step revert(必倒序连撤 ≥ N 个 sub-step 恢复编译);**推荐 phase 末 squash commit** 让 git history 既 phase 完整又保 sub-step 细节(可选)

## 设计决策(不再争论)

### D1: 没有 graceful fallback,看到老数据直接 panic 路径

**Why**: 用户拍板"没用过没有任何历史数据"。任何 `if (adapter === 'aider'|'generic-pty') { ... legacy graceful ... }` 分支都是死代码,违反 user CLAUDE.md §提示词资产维护 约束 2(当前事实不写兼容)。

**How to apply**:
- session-repo 拿到 `agent_id='aider'|'generic-pty'` 的 row → 不加 catch,让 `adapterRegistry.get(id)` 返回 undefined → caller 走原有"adapter cannot create sessions"路径 throw,与未知 adapter 行为一致
- 老 DB 文件如果残留行,UI SessionList 会显示但点开会 throw,与一般 stale data 同款 UX(本场景实测无残留)

### D2: ComposerSdk slash 拦截彻底删除,而不是 plugin namespace 开口子

**Why**: 用户实测 NewSessionDialog 首条 `/hello-from-deck` 跑通,说明 SDK streaming mode **支持** slash 命令触发 skill,CHANGELOG_6 的"会撞 Unknown slash command"假设被推翻。开口子(如允许 `/agent-deck:*`)是基于错误前提的复杂化,不需要。

**How to apply**:
- `src/renderer/components/SessionDetail/ComposerSdk.tsx:109-120` 整段 `if (t.startsWith('/'))` (line 114-120) + 上方 5 行 jsdoc 注释(line 109-113)全删
- 文件顶部 line 20 「关键护栏」bullet「SDK streaming mode 不支持 slash 命令...」整条删
- 不加任何替代提示
- `sendError` setState 路径保留(其他错误仍用),只删 slash 分支

**Trade-off 接受**: 老 CLI builtin slash(`/clear` / `/compact` / `/cost` 等 non-skill SDK 命令)删拦截后行为变化 — **删前**显示中文红条"应用内会话不支持斜杠命令...";**删后**直接走 sendAdapterMessage → SDK 抛 `Unknown slash command` / `only prompt commands are supported in streaming mode` → ComposerSdk catch 块自动 setSendError 显示 SDK 英文原文(`ComposerSdk.tsx:148-156` catch 块本就处理)。UX 从中文友好提示降级为英文 SDK message 可接受 — skill slash 是主流场景(用户实测铁证),builtin slash 是 fallback path;用户报"SDK 错误"反馈时人工引导回终端跑 `claude`。

### D3: `node-pty` + `chokidar` native dep 全部卸载

**Why**: generic-pty adapter 是 `node-pty` 唯一 caller(实测 grep 确认);`chokidar` 实测 0 prod 真 import(所有真 caller 在 generic-pty/file-watcher.ts:20,P1.2 删整目录后无剩余;codex-config/{agents-md-installer,skills-installer}.ts 内 `chokidar` 字眼只是 jsdoc 注释非 import,不算 caller)。删 adapter 后保留两个 dep = 死依赖,污染 asar pack + postinstall。

**How to apply**:
- `zsh -i -l -c "pnpm remove node-pty chokidar"` (移除 dependencies entry 2 个)
- `package.json scripts.postinstall` 删 `&& node scripts/fix-pty-permissions.mjs` 后缀(变 `electron-builder install-app-deps`)
- `package.json build.asarUnpack` 删 2 条 `node-pty` glob
- 删 `scripts/fix-pty-permissions.mjs` 整文件

### D4: DB schema 不写新 migration,GenericPtyConfig **TS type 整片删**;SessionRecord 字段**保留 type 改 `unknown | null`**;upsert binding **固定 `null`**

**Why DB 不动**: 实测 grep `migrations/` 无 `CHECK (adapter IN ...)` 约束,`adapter` 字段是裸 TEXT。SQLite ALTER DROP COLUMN 需 v12+,且 `generic_pty_config` 列 NULL 不占空间。

**Why TS type 整片删**(N3 强删一致 + Round 1 反驳轮共识): `GenericPtyConfig` schema/type / `parseGenericPtyConfigJson` 函数 / `setGenericPtyConfig` setter 全删。

**Why SessionRecord 字段保留 unknown | null**(Round 2 拍板默认): 比起整删字段更保守 — DB 列 N6 保留,read-back 返字符串 raw 值或 null;`SessionRecord` 字段类型 narrow 到 `unknown | null`(隐藏 raw codec 实现细节给 caller)。**默认走此路径**;若 P9 deep-review grep `\.genericPtyConfig` alive caller 全 0 命中,可 escalate 整删字段(同步删 shared/types/session.ts:160 + rowToRecord 同行;INSERT 列清单 N6 保留写 null)。

**Why upsert binding 固定 null**(Round 2 反驳 codex MED-1 修法): 当前 `core-crud.ts:84` 是 `JSON.stringify(rec.genericPtyConfig)`;若 SessionRecord 字段类型改 `unknown | null` 仍 stringify 会对 `unknown` 二次 JSON.stringify(double-encoded raw string 出错)。N3 强删 + 无历史数据 = raw write-back 永远写不出来,binding **固定 `null`** 最简单;新 session 永远写 NULL,符合 N6 schema。

**How to apply**:
- migration 一个不加
- `v012_sessions_generic_pty_config.sql` 保留(历史 record + 老 DB 兼容)
- `rename.ts` / `core-crud.ts` INSERT/UPDATE 列清单**保留** `generic_pty_config` 列(N6),但 `core-crud.ts:84` upsert binding **改成固定 `null`**(不再 stringify rec.genericPtyConfig)
- `session-repo/types.ts`:删 `GenericPtyConfig` import + 删 `genericPtyConfigSchema` import + 删 `parseGenericPtyConfigJson` 函数;`rowToRecord` 内字段改 `genericPtyConfig: r.generic_pty_config ?? null`(返 string | null,被 SessionRecord type 收进 `unknown | null`)
- `session-repo/core-crud.ts`:删 `GenericPtyConfig` import + 删 `setGenericPtyConfig` setter 函数 + upsert binding 固定 `null`
- `shared/types/session.ts`:**P1.4 sub-step 5** 删 `GenericPtyConfig` import(line 5)+ `SessionRecord.genericPtyConfig` 字段类型(line 160)从 `?: GenericPtyConfig | null` 改 `?: unknown | null`(让 P1.10 ⚑ checkpoint 真可达 — Round 2 HIGH-A 修法)

### D5: 不动 changelog / reviews / plans / 历史 RFC docs

**Why**: 历史 record 反映"这段时间的真实状态",删 / 改会破坏溯源。新写一条 changelog 引用本 plan,plan 归档时 INDEX 加行。

**How to apply**:
- 不 `git mv` / `rm` 任何历史 .md 文件
- 仅新写 `changelog/CHANGELOG_<X>.md` 一条 + `changelog/INDEX.md` 加行
- **当前事实**陈述(README.md / `docs/agent-deck-team-protocol.md` / `resources/codex-config/CODEX_AGENTS.md`)若提 adapter 列表必改(详 D6 表)

### D6: 文档扫描两类 — "当前事实"必改 / "历史 record"不动

| 文件类型 | 处理 |
|---|---|
| `src/**/*.ts*` 代码 + 测试 | **删** import / case / 引用 |
| `package.json` | **删** dep / postinstall / asarUnpack |
| `CLAUDE.md`(项目) | grep 实测 **0 hit** — 无需改(grep 自检兜底) |
| `resources/claude-config/CLAUDE.md`(应用打包) | grep 实测 **0 hit** — 无需改 |
| `resources/codex-config/CODEX_AGENTS.md` | **改** — line 88 含 `aider` 字眼 |
| `README.md` | **改** — 实测含 4 adapter 列表(line 19/23/70/271-272 共 5 处)+ node-pty 介绍 + tree 图 |
| `docs/<name>-<YYYYMMDD>.md`(命名带日期 = 历史 RFC) | **不动**(`docs/adapter-architecture-rfc-20260515.md` 等) |
| `docs/<name>.md`(命名无日期 = 当前协议描述) | **改** — `docs/agent-deck-team-protocol.md`(line 18-19 / 26 / 305 / 357-358 含 aider/generic-pty 列表 / capabilities table) |
| `changelog/CHANGELOG_*.md` | **不动**(历史 record) |
| `reviews/REVIEW_*.md` | **不动**(历史 record) |
| `plans/<existing>.md` | **不动**(历史 record) |
| `conventions/*.md` | 扫一遍;如有 adapter 列举 **改**(当前事实) |

## 步骤 checklist

> **N4 + N8 提醒**:`pnpm X` 命令一律 `zsh -i -l -c "pnpm X"`(详 user CLAUDE.md §运行时);phase 内 sub-step commit 允许 typecheck 红(SSOT 链式 enforce 预期),phase 末 checkpoint step(打 ⚑ 标记)必须 typecheck/test/build 全绿才进下一 phase。

### P0 Composer slash 拦截删除(独立 commit, 5 min)

- [ ] Step 0.1 — `src/renderer/components/SessionDetail/ComposerSdk.tsx` 删 line 114-120(7 行 if 块)+ line 109-113(5 行 jsdoc 注释)+ **顶部 line 20** 「关键护栏」bullet「SDK streaming mode 不支持 slash 命令...」整条删
- [ ] Step 0.2 ⚑ — `zsh -i -l -c "pnpm typecheck"` 必跑(checkpoint)
- [ ] Step 0.3 — git commit (独立 commit message: `fix(composer): remove slash command interception (slash skills work fine in SDK streaming mode)`)

### P1 删 adapter 实现层 + GenericPtyConfig type 整片删 + main register + ipc/adapters.ts(Round 2+3 HIGH-A 修法)

> **关键约束**:Round 2+3 HIGH-A 揭示:P1.11 ⚑ 要可达,必须把 SessionRecord 类型修订(P1.4 sub-step 5)+ main register 删除(P1.7a)+ ipc/adapters.ts(P1.7b,Round 3 新拉)+ upsert binding 改(P1.4 sub-step 4)+ type-narrow.test.ts 整删(P1.8)都拉进 P1。**不要**把 ipc/adapters.ts 推到 P3.4(v3 错误)。SSOT 链式 enforce 凡引用被删字段的 caller 都得同 phase 修干净。

- [ ] Step 1.1 — `rm -rf src/main/adapters/aider/` (单文件 `index.ts`;aider 走 generic-pty 内置 preset,无独立测试)
- [ ] Step 1.2 — `rm -rf src/main/adapters/generic-pty/` (含 `__tests__/` + `pty-bridge/` + `ansi-parser.ts` + `file-watcher.ts`)
- [ ] Step 1.3 — `src/main/adapters/types.ts` 删 `PtyCreateOpts` interface + `CreateSessionOptions` union 2 arm (`'aider' | 'generic-pty'`) + `CreateSessionOptionsRaw.genericPtyConfig` 字段
- [ ] Step 1.4(D4 整片删 type 子集 — session-repo + shared types 链):
  - **sub-step 1**:`src/main/store/session-repo/types.ts` 删 `GenericPtyConfig` import(line 10)+ `genericPtyConfigSchema` import(line 16)+ 删 `parseGenericPtyConfigJson` 函数(line 93+)
  - **sub-step 2**:`session-repo/types.ts` `rowToRecord` 内 `genericPtyConfig: parseGenericPtyConfigJson(...)` 改 `genericPtyConfig: r.generic_pty_config ?? null`(返 string | null;靠 SessionRecord 类型 unknown|null 收纳)
  - **sub-step 3**:`src/main/store/session-repo/core-crud.ts` 删 `GenericPtyConfig` import(line 9)+ 删 `setGenericPtyConfig` 函数(line 215+)
  - **sub-step 4**:`session-repo/core-crud.ts` upsert binding(line 84) 改 `generic_pty_config: rec.genericPtyConfig ? JSON.stringify(rec.genericPtyConfig) : null` → **`generic_pty_config: null`** (固定写 NULL,N6 + N3 决策;raw write-back 不需要,无历史数据)
  - **sub-step 5**(Round 2 HIGH-A 修法):`src/shared/types/session.ts:5` 删 `import type { GenericPtyConfig } from './generic-pty'` + `SessionRecord.genericPtyConfig` 字段类型(line 160)从 `?: GenericPtyConfig | null` 改 `?: unknown | null`
  - **sub-step 6**:`session-repo/index.ts` / `rename.ts` 内含 `generic_pty_config` 字段的 INSERT/UPDATE 列清单**保留**(N6),仅 `aider / generic-pty` 字眼注释更新
- [ ] Step 1.5 — `src/main/adapters/registry.ts` 删 `AiderAdapter` / `GenericPtyAdapter` 2 import + `AdapterIdMap` 2 entry
- [ ] Step 1.6 — `src/main/adapters/options-builder.ts`:① `CreateSessionOptionsByAdapter` 2 entry 删 ② `AGENT_IDS` list(line 55)`'aider', 'generic-pty'` 2 字面量删 ③ `buildCreateSessionOptions` switch 2 case 删 ④ `narrowToPtyOpts` 函数整删 ⑤ error message 文案改"expected: claude-code | codex-cli"
- [ ] Step 1.7a(Round 2 HIGH-1 修法 — main register 删除拉进 P1):`src/main/index.ts` 删 `aiderAdapter` / `genericPtyAdapter` 2 import(line 18-19)+ 2 `adapterRegistry.register(...)` 行(line 117-118)+ `aider 阻塞 stdin` 注释更新(line 540 附近)
- [ ] Step 1.7b(Round 3 HIGH-1 修法 — ipc/adapters.ts 从 P3.4 拉进 P1):`src/main/ipc/adapters.ts` 删 `GenericPtyConfig` import(line 34)+ 删 `parseGenericPtyConfig` import(line 38)+ 删 `genericPtyConfig` parse 路径(line 151-161,R4·F2 整段)+ 删 `buildCreateSessionOptions` 调用末 `...(genericPtyConfig !== null ? { genericPtyConfig } : {})` spread(line 190 附近);`canAcceptAttachments` gate 保留(generic 兜底)
- [ ] Step 1.8(Round 3 HIGH-1 修法 — type-narrow.test.ts 整删):`rm src/main/adapters/__tests__/adapter-create-options.type-narrow.test.ts` 整文件删(D2 编译期约束守门由 5 处 SSOT + `_assert*` + `_exhaustive: never` 已覆盖,本测试是 redundant 双重保险删了不影响 SSOT 守门;且 file 内 7 个 it() 块都 spread `genericPtyConfig` 进 `CreateSessionOptionsRaw`,P1.3 删字段后整文件全 excess-property 报错,精确删 PTY 行不闭合)
- [ ] Step 1.9 — `src/main/__tests__/_shared/mocks/session-repo.ts` 删 generic-pty / aider mock 行(原 P5.1 拉前,跟 P1 类型修订一起 typecheck-driven)
- [ ] Step 1.10 — `grep -rn "aider\|generic-pty\|GenericPty\|genericPtyConfig" src/main/ src/renderer/ --include="*.ts" --include="*.tsx" | grep -v "__tests__\|/shared/types/generic-pty.ts\|/shared/wire-prefix.ts"` 兜底自检:剩余命中应只在 P2 UI / P3 注释剩余 / P4 shared 待删类型;若 P1 内本应改的位置仍有命中 → 回 P1 改完
- [ ] Step 1.11 ⚑ — `zsh -i -l -c "pnpm typecheck"` (checkpoint;P1.1-P1.10 累计删完后才该过 — 5 处 SSOT 守门 + main register + ipc/adapters.ts + SessionRecord 类型 + upsert binding + type-narrow.test.ts 整删 全 P1 内闭环。**不过 = blocker,不允许进 P2**)

### P2 删 UI

- [ ] Step 2.1 — `src/renderer/components/NewSessionDialog.tsx` 删 select option(`'aider'` + `'generic-pty'` 2 行)+ `showGenericPtyConfig` 路径 + `GenericPtyConfigForm` import + `genericPtyConfig` state + `submit()` 内 generic-pty 校验
- [ ] Step 2.2 — `rm src/renderer/components/GenericPtyConfigForm.tsx`
- [ ] Step 2.3 — `src/renderer/components/SessionDetail/ComposerSdk.tsx` 注释段提到 `generic-pty / aider` 改 / 删(REVIEW_35 注释保留历史 attribution 但事实陈述更新);`canAcceptAttachments = agentId === 'claude-code' || agentId === 'codex-cli'` 已 OK(剩 2 adapter 都 true,可简化为 `true` const)
- [ ] Step 2.4 — `src/renderer/components/activity-feed/shared.ts` 删 case `'aider'` / `'generic-pty'`(默认 case 自动兜底)
- [ ] Step 2.5 ⚑ — `zsh -i -l -c "pnpm typecheck"` (checkpoint)

### P3 删 IPC / MCP schema + 注释清扫(Round 2 MED-A + Round 3 MED-1 修法)

- [ ] Step 3.1 — `src/main/agent-deck-mcp/tools/schemas.ts` 删 3 处 `z.enum([..., 'aider', 'generic-pty'])` 项(SPAWN_SESSION:20 + LIST_SESSIONS adapter_filter:145 + HAND_OFF_SESSION adapter:308)+ HAND_OFF 描述文案删 `aider`
- [ ] Step 3.2 — `src/main/agent-deck-mcp/tools/index.ts` `spawn_session` description 文案删 `aider / generic-pty`
- [ ] Step 3.3 — `src/main/agent-deck-mcp/tools/handlers/spawn.ts` / `hand-off-session.ts` 内如有 adapter 分支扫一遍
- [ ] Step 3.4 — (`src/main/ipc/adapters.ts` 已在 P1.7b 处理 — noop 兜底自检 `grep -n "aider\|generic-pty\|GenericPty\|parseGenericPtyConfig" src/main/ipc/adapters.ts` 应 0 hit)
- [ ] Step 3.5 — `src/main/ipc/sessions.ts` 注释段 `aider / generic-pty` 删
- [ ] Step 3.6(Round 2 MED-A 修法 — 4 个纯注释级文件清扫):
  - `src/main/store/event-repo.ts:60` 注释删/改 `aider / generic-pty` 字眼(改成"剩 2 adapter")
  - `src/main/store/message-delivery-state.ts:55` 注释同步
  - `src/main/session/summarizer/index.ts:219` 注释同步(原文"其他 adapter(aider / generic-pty)未实装" → 改成"剩 2 adapter 都实装")
  - `src/main/adapters/claude-code/sdk-bridge/constants.ts:22` 注释同步
- [ ] Step 3.7 ⚑ — `zsh -i -l -c "pnpm typecheck"` (checkpoint;P3 phase 末 typecheck 全绿)。**注**:Round 3 MED-1 修法 — "src 全文 grep 无剩余" 自检挪到 **P4.5 之后**(P4.6),因 shared/types/generic-pty.ts 和 wire-prefix.ts 残留要等 P4 删干净才能 grep 通过

### P4 删 shared types + wire-prefix 注释

- [ ] Step 4.1 — `src/shared/types.ts` 删 `export * from './types/generic-pty'` 一行
- [ ] Step 4.2 — `rm src/shared/types/generic-pty.ts` + `rm src/shared/types/__tests__/generic-pty.test.ts`(如存在)
- [ ] Step 4.3 — `src/shared/wire-prefix.ts` **jsdoc 注释**段(line 27 `adapterId(claude-code / codex-cli / aider / generic-pty)`)删字面量 2 项;`WirePrefixParse.adapter` 字段实际类型是 `string` 非 union,**无 typecheck 影响**(纯文档维护)
- [ ] Step 4.4 — (P1.4 sub-step 5 已落 SessionRecord 类型修订 — 此处仅交叉引用,无新改动)
- [ ] Step 4.5 ⚑ — `zsh -i -l -c "pnpm typecheck"` (checkpoint)
- [ ] Step 4.6(Round 3 MED-1 修法 — 全 src grep 自检从 P3.7 挪到此):`grep -rn "aider\|generic-pty\|GenericPty" src/ --include="*.ts" --include="*.tsx" | grep -v "__tests__"` 兜底自检无剩余;若有命中按 D6 规则改/删 — 此时 P1-P4 已删完所有 import + type,grep 应只命中 P2 UI 历史注释 / 已知保留位 / 误删点回流补改

### P5 删 测试 / mock(测试 case 拆 3 sub-step)

- [ ] Step 5.1 — `src/main/__tests__/_shared/mocks/session-repo.ts` 删 generic-pty / aider mock 行 — **P1.9 已落,此处 noop 兜底自检**
- [ ] Step 5.2 — `src/main/store/session-repo/__tests__/_setup.ts` `v012 generic_pty_config` import 保留(migration 文件本身保留 — D4 决策)
- [ ] Step 5.3a — `src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts` TC7 (line 404-421) + TC7b (line 423-436) **整删两个 test case**(原本测 "PTY adapter + agent_name reject" 路径,adapter 删后路径不存在),同步删顶部矩阵注释 "PTY adapter + agent_name" 负例
- [ ] Step 5.3b — `src/main/agent-deck-mcp/__tests__/tools.test.ts:691-703` 改用 **schema-valid adapter**(如 `'codex-cli'`)+ 局部 mock 让 `adapterRegistry.get('codex-cli')` **返回 `undefined`**(走 spawn.ts:49 第一段 if `!adapter || !adapter.createSession` → error "cannot create sessions" 命中原测试断言),保留 "cannot create sessions" handler path 测试。**不要**改 fake `'unknown-fake-adapter'` 因 zod enum 会先 reject 改变错误路径(reviewer 反驳轮共识);**不要**走 alternative 返 adapter 但 `canCreateSession=false` 路径 — 那会命中 spawn.ts:55 第二段 if 走 "does not support session creation" error message,与原断言 `/cannot create sessions/` 不 match(Round 3 MED-B 修法,实测 `spawn.ts:48-60` 两段不同 check)
- [ ] Step 5.3c — 不需额外补 "schema invalid adapter" 测试(zod 自带 enum 测试覆盖)
- [ ] Step 5.4 — `src/main/agent-deck-mcp/__tests__/hand-off-session.handler-cwd-generic.test.ts` 文件名含 "generic" 但语义是 "generic mode" 非 generic-pty adapter,**保留**(rename 不必要)
- [ ] Step 5.5 — `src/main/ipc/__tests__/sessions.test.ts` 删 adapter 相关 case
- [ ] Step 5.6 ⚑ — `zsh -i -l -c "pnpm test"` 全跑确认绿(checkpoint)

### P6 卸载 native dep(node-pty + chokidar 一起卸,Round 2 MED-2 修法)

- [ ] Step 6.1 — **import-only grep 自检**(精确排注释)兜底 0 真 caller:
  ```bash
  grep -RInE "from ['\"]chokidar['\"]|require\\(['\"]chokidar" src --include='*.ts' --include='*.tsx' | grep -v "__tests__"
  ```
  实测应 0 hit(generic-pty/file-watcher.ts:20 已 P1.2 删,codex-config/{agents-md-installer,skills-installer}.ts 仅 jsdoc 注释非 import 不算)。若 ≥1 真 import → 跑 §已知踩坑 第 4 条 fallback(仅卸 node-pty,记 follow-up)
- [ ] Step 6.2 — `zsh -i -l -c "pnpm remove node-pty chokidar"`(2 个一起卸)
- [ ] Step 6.3 — `package.json` 手改 `scripts.postinstall` 删 `&& node scripts/fix-pty-permissions.mjs` 后缀(变 `electron-builder install-app-deps`)
- [ ] Step 6.4 — `package.json` 手改 `build.asarUnpack` 删 `node_modules/node-pty/**/*` 和 `node_modules/.pnpm/node-pty@*/node_modules/node-pty/**/*` 2 行
- [ ] Step 6.5 — `rm scripts/fix-pty-permissions.mjs`
- [ ] Step 6.6 — `zsh -i -l -c "pnpm install"` (重 resolve 依赖图;确认 lockfile clean)— **顺序关键**:先改 `scripts.postinstall`(Step 6.3)再 install,避免 install 时跑老 postinstall 撞 missing `fix-pty-permissions.mjs`(已 Step 6.5 删)
- [ ] Step 6.7 ⚑ — `zsh -i -l -c "pnpm typecheck && pnpm build"` 必跑(checkpoint;build 不报 missing node-pty asarUnpack)

### P7 DB schema 兜底自检

- [ ] Step 7.1 — `grep -RInE "agent_id.*CHECK|CHECK.*agent_id|agent_id IN" src/main/store/migrations/`(Round 2 LOW-1 修法 — `-E` 用裸 `|` alternation,**不要**用 `\|` BRE 转义)确认无 adapter enum 约束
- [ ] Step 7.2 — 无变更跳过(本 phase 仅自检确认 D4 假设)

### P8 文档扫描 + changelog

- [ ] Step 8.1 — `grep -rn "aider\|generic-pty" CLAUDE.md README.md resources/ docs/ conventions/ --include="*.md"` 列出所有命中
- [ ] Step 8.2 — 按 D6 规则区分"当前事实"vs"历史 record":
  - **README.md 必改**(D6 修订):line 19 Universal Team Backend 节列 → 删 `/ aider / generic-pty`;line 23 多 Adapter 节 → 删 `+ Aider / Generic PTY (R4 起,node-pty 包装...)`;line 70 整段 70 行 Aider/Generic PTY 介绍 → 删;line 271-272 tree 图 → 删 2 条;同步重新写一句"剩 2 adapter:Claude Code + Codex CLI"
  - **`docs/agent-deck-team-protocol.md` 必改**:line 18-19 删 `/ aider / generic-pty`;line 26 例 team 列表删 aider-session-C;line 305 capability 占位说明删 aider/generic-pty 视实现而定;line 357-358 capabilities table 删 2 行
  - **`resources/codex-config/CODEX_AGENTS.md`** 必改:line 88 含 `aider` 字眼 — 删
  - **应用打包 CLAUDE.md (`resources/claude-config/CLAUDE.md`) / 项目 CLAUDE.md** Round 2 实测 0 hit — Step 8.1 grep 自检兜底,无改动(grep 命令本身就是 ground truth,不依赖本文档列举)
- [ ] Step 8.3 — 写 `changelog/CHANGELOG_<X>.md`(X = max +1):删除 aider/generic-pty + slash 拦截删除 + node-pty + chokidar 卸载 + GenericPtyConfig type 整片删,引用本 plan
- [ ] Step 8.4 — 同步 `changelog/INDEX.md` 加行

### P9 验证 + code-review deep-review

- [ ] Step 9.1 ⚑ — `zsh -i -l -c "pnpm typecheck"` 必跑(checkpoint;全绿)
- [ ] Step 9.2 ⚑ — `zsh -i -l -c "pnpm build"` 必跑(checkpoint;asar pack 不报 missing node-pty)
- [ ] Step 9.3 ⚑ — `zsh -i -l -c "pnpm test"` 必跑(checkpoint;全绿)
- [ ] Step 9.4 — invoke `/agent-deck:deep-review` SKILL,typed scope = `{kind: 'code', paths: <all changed files>}`,focus = "完整删除 2 adapter 的 5 处 SSOT 守门 + 3 处 runtime 是否漏点 / 老 import 是否漏删 / 历史文件是否误改 / DB schema 兼容(GenericPtyConfig type 整片删后老 SQLite 行兼容)/ slash 拦截删除是否影响其他路径 / chokidar 卸载是否打破未发现 caller / SessionRecord.genericPtyConfig 字段保留 vs 整删 escalate"
- [ ] Step 9.5 — fix deep-review HIGH/MED finding 直到 reviewer 共识可合(0 HIGH 0 真 MED)

### P10 归档

- [ ] Step 10.1 — `ExitWorktree(action: "keep")` 切回主仓库
- [ ] Step 10.2 — `mcp__agent-deck__archive_plan({plan_id, worktree_path, base_branch: 'main', changelog_id: '<X>'})` 原子完成 ff-merge + plan mv + INDEX 同步 + commit + worktree remove + branch -D + caller archive。**期望 return**:`{archived_path: '<main-repo>/plans/remove-aider-generic-pty-adapters-20260520.md', commit_hash: <sha>, branch_deleted: true, worktree_removed: true, plans_index_action: 'appended', final_status: 'completed', spike_reports_archived: null (skip,本 plan 不含 spike), archived: 'ok', warnings: []}`

## 当前进度

(初次写作 + Step 1.5 deep-review v2 + v3 + v4 修订 + P0+P1 实施完成)

- ✅ Step 1 plan 文件 hand off — 本文件写就
- ✅ Step 1.5 Deep-Review plan Round 1 — 完成(5 HIGH + 7 MED + 3 LOW 全 fix 进 v2)
- ✅ Step 1.5 Deep-Review plan Round 2 — 完成(1 HIGH + 4 MED + 3 LOW 全 fix 进 v3)
- ✅ Step 1.5 Deep-Review plan Round 3 — 完成(1 HIGH + 3 MED + 0 LOW 全 fix 进 v4)
- ✅ Step 1.5 Deep-Review plan Round 4 — 双 reviewer ✅ 可合(0 HIGH + 0 真 MED + 6 LOW 不阻)
- ✅ Step 2 EnterWorktree — worktree 建成 base_commit 84a6910
- ✅ **P0 ComposerSdk slash 拦截删除** — commit 6a9ac67 (Step 0.1+0.2+0.3)
- ✅ **P1 删 adapter 实现层 + GenericPtyConfig type 整片删 + main register + ipc/adapters.ts** — 8 commits aa8d477 → d2cd39b,P1.11 ⚑ pnpm typecheck **GREEN**
  - aa8d477: P1.1+1.2 rm aider/ + generic-pty/ (-2800 lines)
  - (incl 1.4): P1.3 types.ts del PtyCreateOpts + union 2 arm + Raw.genericPtyConfig
  - (incl 1.4): P1.4 session-repo + shared types GenericPtyConfig 整片删 + upsert binding 固定 null
  - cb3b721: P1.5 registry.ts del imports + AdapterIdMap 2 entry
  - 7339505: P1.6 options-builder.ts 5 处改(map/list/switch/narrowToPtyOpts/error msg)
  - cf08d6b: P1.7a main/index.ts del register + imports
  - 9d4c5c1: P1.7b ipc/adapters.ts del GenericPtyConfig parse + spread
  - 615cad1: P1.8 rm type-narrow.test.ts 整文件
  - d2cd39b: P1.9 _shared/mocks/session-repo.ts del setGenericPtyConfig
- ✅ **P2 删 UI** — 4 commits c5b770f → 0ca745a,P2.5 ⚑ pnpm typecheck **GREEN**
  - c5b770f: P2.1 NewSessionDialog.tsx 删 GenericPtyConfig imports + state + showGenericPtyConfig + submit 校验/spread + JSX block (-27 lines)
  - d3ca3f0: P2.2 rm GenericPtyConfigForm.tsx 整文件 (-238 lines)
  - b527b78: P2.3 ComposerSdk.tsx 注释清扫(保留 REVIEW_35 attribution + canAcceptAttachments expression 白名单)
  - 0ca745a: P2.4 activity-feed/shared.ts getAgentShortName 删 case 2 entry
- ✅ **P3 删 IPC / MCP schema + 注释清扫** — 5 commits 56c8005 → 66fad0f,P3.7 ⚑ pnpm typecheck **GREEN**
  - 56c8005: P3.1 schemas.ts 删 3 处 z.enum aider/generic-pty + HAND_OFF describe
  - 3108731: P3.2 tools/index.ts spawn_session description 删 aider/generic-pty
  - 5cb080c: P3.3 handlers/spawn.ts 删 aider/generic-pty 字眼 3 处(error message + 注释)
  - (P3.4 noop verified — ipc/adapters.ts 已 P1.7b 处理)
  - 408a110: P3.5 ipc/sessions.ts hand-off summariseEvents 注释 future-proof 改写
  - 66fad0f: P3.6 4 个注释级文件清扫(event-repo / message-delivery-state / summarizer/index / sdk-bridge/constants)
- ✅ **P4 删 shared types + wire-prefix 注释 + jsdoc 残留清扫** — 7 commits 81afabb → 8fd4dc6,P4.5/P4.6 ⚑ pnpm typecheck **GREEN**
  - 81afabb: P4.1 shared/types.ts del export * generic-pty
  - 0ea023e: P4.2 rm shared/types/generic-pty.ts + its test (-257 lines)
  - bcf389b: P4.3 wire-prefix.ts jsdoc 字面量删
  - ee42912: P4.6.A shared/types/session.ts jsdoc × 6 处
  - 16f9de7: P4.6.B main/adapters/types.ts capability docs × 5 处
  - 8fd4dc6: P4.6.C ipc/adapters.ts + core-crud.ts × 4 + rename.ts + session-repo/index.ts (4 files × 7 处)
  - **P4.6 grep 残留 4 处全为 plan name reference / historical attribution(`parseGenericPtyConfigJson 已 P1.4 删`)**,作为溯源信息保留
- ✅ **P5 删测试 / mock** — 2 commits 19555b5 → 1131b41
  - P5.1 noop ✅(P1.9 已处理 _shared/mocks/session-repo.ts)
  - P5.2 noop ✅(D4 决策保留 v012 import)
  - 19555b5: P5.3a spawn-agent-name-routing.test.ts 删 TC7+TC7b + 顶部矩阵注释
  - 1131b41: P5.3b tools.test.ts 改 schema-valid 'codex-cli' + vi.spyOn 局部 mock
  - P5.4 noop ✅(handler-cwd-generic 文件名是 generic mode 非 generic-pty)
  - P5.5 noop ✅(ipc/__tests__/sessions.test.ts 已 clean)
  - **P5.6 ⚑ 移到 P6 之后跑**(电梯环境问题 — node-pty rebuild 撞 distutils 阻塞 pnpm install pipeline)
- ✅ **P6 卸载 native dep** — 1 commit 197859b,P6.7 ⚑ pnpm typecheck + build 全 GREEN
  - 197859b: pnpm remove node-pty + chokidar (-15 packages) + package.json postinstall/asarUnpack + scripts/fix-pty-permissions.mjs 整删 (-187 lines)
  - **环境修复**:electron@33 binary 自带 install.js 需手动 trigger(pnpm rebuild 不触发):`zsh -i -l -c "cd <abs-path>/node_modules/.pnpm/electron@33.4.11/node_modules/electron && node install.js"` — 本会话已 trigger,dist/ + path.txt 就位
- ✅ **P9.3 ⚑ pnpm test 全跑提前 unblock** — 64/64 files passed | 762/838 tests passed(76 skipped 全是 better-sqlite3 binding ABI v130 vs v137 守门 skip,符合 CHANGELOG_42 教训)
- ✅ **P7 DB schema 兜底自检** — 0 hit,D4 假设确认(`agent_id` TEXT 无 enum CHECK 约束),无变更
- ✅ **P8 文档扫描 + changelog** — 2 commits
  - `edb56b8`: docs scan 3 文件清扫 aider/generic-pty(README.md 5 处 + docs/agent-deck-team-protocol.md 5 处 + CODEX_AGENTS.md 1 处);D5/D6 决策保护历史文件不动
  - `fc351ab`: 写 CHANGELOG_131.md + 同步 changelog/INDEX.md
- ✅ **P9 验证 + deep-review** — 2 commits 跨 3 round
  - R1 fix `a8a4685`: MED 双方独立 → escalate 整删 `SessionRecord.genericPtyConfig` 字段 + rowToRecord 投影 + test fixture key(plan focus #7 准则触发 + 0 alive caller 验证)+ 4 LOW(narrowToPtyOpts 注释 / chokidar 注释 × 2 / spawn.ts dead-code 加意图注释)
  - R2 fix `c66b4e5`: reviewer-codex 单方 MED + lead 现场验证 → hand-off `SessionHandOffSummarize` Stage 1 加 `if (!adapter?.createSession) throw` early gate(与 Stage 2 line 156 镜像)防老 SQLite row 走 fallback paid Claude oneshot 浪费 LLM quota
  - R3:双方 ✅ 可合 + 0 finding 终态裁决
  - 不修:R1 LOW v019 migration SQL 注释类比失效(D5 决策)/ R1+R2 INFO 缺 regression test(better-sqlite3 binding skip 在 vitest CI path,test infra 限制)
  - reviewer 2 sid:`f1a938f7-28d0-4d0d-9021-7789536a5133` (claude) + `019e4445-a995-7990-ab40-37008a48e880` (codex),P10 archive_plan 自动 baton shutdown
- ⏳ P10 归档 — 下一步

**下一会话接力第一步**(P2 起手):
- `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/remove-aider-generic-pty-adapters-20260520.md` 全文读
- `EnterWorktree(path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/remove-aider-generic-pty-adapters-20260520)`
- `git -C <worktree> log --oneline -10` 确认 HEAD 是 d2cd39b 或之后(不应是 base_commit 84a6910)
- 进 P2.1:`src/renderer/components/NewSessionDialog.tsx` 删 GenericPtyConfigForm import + GenericPtyConfig type import + genericPtyConfig state + showGenericPtyConfig 路径 + submit() 内 校验 + spread + JSX(详 P2.1 + Round 4 LOW-5 reviewer-claude 注:select option 是 `adapters.map` 动态渲染,不需手改)
- 按 plan checklist 走完 P2-P10
- **N4 + N8 提醒**:phase 末 ⚑ checkpoint(P2.5 / P3.7 / P4.6 / P5.6 / P6.7 / P9.1 / P9.2 / P9.3) `zsh -i -l -c "pnpm typecheck/test/build"` 必跑全绿

**reviewer 状态**(P9 deep-review 已失效复用,需重 spawn):
- reviewer-claude · plan-rm-adapter sid=`57fec271-04b7-4833-82d8-b5ef5b208952` ⚠ **已 closed**(被 hand_off_session 默认 keep_teammates=false 自动 shutdown,本会话开启时 SDK live query 已 abort)
- reviewer-codex · plan-rm-adapter sid=`019e438b-994f-7a10-b2c4-73f0d506f9ce` ⚠ **已 closed**(同上)
- **P9 处理**:kind='code' 是新 scope(代码删除 vs plan design 评审),mental model 复用价值不大,**重 spawn 一对新 reviewer pair**(走 deep-review SKILL 一行起);旧 reviewer 的 events / messages 子表已保留,P9 如需 cite 旧 finding 推理链可直接 DB query / SessionDetail 查看,不影响数据可追溯

**(本 plan 不含 spike — D4 假设走 P7.1 grep 二次确认;D2 假设走用户 NewSessionDialog `/hello-from-deck` 实测推翻 CHANGELOG_6 老假设。`spike-reports/` 子目录预期不存在,P10 archive_plan return `spike_reports_archived: null` 为 expected。)**

## 下一会话第一步

> ⚠️ **全局约束**:本 plan 内所有 `pnpm X` / `npm X` / `npx X` 命令必须走 `zsh -i -l -c "..."`(详 user CLAUDE.md §运行时;否则缺 brew / path_helper 注入 PATH 与真实 Terminal 不一致)。

如果是新会话接力:
1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/remove-aider-generic-pty-adapters-20260520.md` 全文读
2. 看 frontmatter `worktree_path` → `EnterWorktree(path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/remove-aider-generic-pty-adapters-20260520)`
3. `git -C /Users/apple/Repository/personal/agent-deck/.claude/worktrees/remove-aider-generic-pty-adapters-20260520 log --oneline -3` 确认 HEAD ≥ base_commit
4. 按 §当前进度 找到上次卡的 step 继续(每步完成后打勾 + 更新 §当前进度)
5. **commit 粒度**(N8):每个 sub-step 完成后**立即** commit(粒度细方便回滚 + reviewer 易看 diff);commit message format: `feat(adapters): remove <X> (P<N> Step <N>.<M> — see plan)`。**sub-step commit 允许 typecheck 红**(SSOT 链式 enforce 预期中间状态,详 §已知踩坑 第 1 条);**phase 末 checkpoint step**(打 ⚑ 标记的 Step,10 个:`P0.2 / P1.11 / P2.5 / P3.7 / P4.6 / P5.6 / P6.7 / P9.1 / P9.2 / P9.3`)**必须 typecheck/test/build 全绿**才允许进下一 phase

## 已知踩坑

- **SSOT 守门多侧链式**:**5 处 TS 编译期 SSOT 守门**(`AdapterIdMap` / `CreateSessionOptionsByAdapter` / `AGENT_IDS` list / `CreateSessionOptions` union / `buildCreateSessionOptions` switch)+ 3 个 `_assert*` 函数 + `_exhaustive: never` 编译期 enforce;**3 处 runtime 边界**(`adapterRegistry.register` / MCP zod enum / IPC zod enum 若有)。**优势**:漏改不可能 silent 通过(`_assert*` 强制);**劣势**:看上去删一个地方就报一堆错,要按 P1 顺序连贯删完所有 5 处 SSOT + main register + ipc/adapters.ts caller + SessionRecord 类型 + upsert binding + type-narrow.test.ts 整删 才能过 typecheck(P1.1-P1.10 中间 commit typecheck **预期红**,P1.11 累计删完后才绿,详 N4 + N8)。Round 2+3 反复揭示:凡有 caller 引用被删字段的位置都必须在 P1 同 phase 内修干净,否则 P1.11 ⚑ 不可达
- **`generic_pty_config` 列保留 / type 整片删 / SessionRecord 字段 unknown|null / upsert 固定 null**:N6 + D4 拍板。DB 层保留(列 + INSERT/UPDATE 列清单不改),新 session 写 NULL;TS 层 `GenericPtyConfig` schema / `parseGenericPtyConfigJson` / `setGenericPtyConfig` setter 全删,`SessionRecord.genericPtyConfig` 字段类型改 `unknown | null`;`rowToRecord` 读 column 直接 cast `string | null`(无 schema parse);`upsert` binding 固定 `null`(N3 强删 + 无历史数据,raw write-back 不走)
- **NewSessionDialog `key={agentId}` remount**:删 GenericPtyConfigForm 后 NewSessionDialog 内 `<GenericPtyConfigForm key={agentId} adapterId={agentId as 'aider' | 'generic-pty'} ...>` 整段 JSX 删,React 不再 render 该组件,key 无影响
- **node-pty postinstall race**:`pnpm remove node-pty` 后 `pnpm install` 重 install 可能仍跑老 `postinstall`(scripts 没改);**操作顺序必须先改 scripts.postinstall(P6.3)再 install(P6.6)**,避免 install 时跑老 postinstall 撞 missing `fix-pty-permissions.mjs`
- **chokidar 实测 0 prod 真 import**:所有真 caller 在 generic-pty/file-watcher.ts:20,P1.2 删整目录后无剩余;codex-config/{agents-md-installer,skills-installer}.ts 内 `chokidar` 字眼**只是 jsdoc 注释非 import**(命令 `grep -RInE "from ['\"]chokidar['\"]|require\(['\"]chokidar" src --include='*.ts'` 实测排除 generic-pty/ 后 0 hit)。P6.1 grep 应得 0 prod alive caller → P6.2 一起卸 chokidar。**fallback**:若 P6.1 grep 意外发现新 caller(如未来代码 push 间引入),仅卸 node-pty 保留 chokidar 并记 follow-up plan
- **测试 mock `_shared/mocks/session-repo.ts`** 已 P1.9 拉前(原 P5.1)— 跟 P1 类型修订一起 typecheck-driven,不再单独 P5.1 改
- **测试 enum reject 路径变化**(Step 5.3 反驳轮共识):`tools.test.ts:691` 老用 `'aider'` 当 unknown adapter 测 `cannot create sessions` 路径,删 zod enum 后 zod parse 先 reject 改变错误路径;TC7+TC7b 老测 PTY adapter + agent_name 失败路径,删后整删 case(adapter narrow 不存在);改 schema-valid adapter + 局部 mock 比 fake 字符串更准确
- **changelog 引用归档**:archive_plan tool 调用时传 `changelog_id`,impl 自动拼 link 到 INDEX 第 3 列;不需 plan 内手工写

## v4 修订记录(Step 1.5 deep-review Round 3 fix 摘要)

| 改动来源 | v3 → v4 影响 |
|---|---|
| reviewer-claude HIGH-1 + reviewer-codex HIGH-1 双方独立(P1.11 仍不可达 — ipc/adapters.ts + type-narrow.test.ts 漏)| **P1 phase 再重排** — ipc/adapters.ts 从 P3.4 拉到 **P1.7b**;type-narrow.test.ts 改 **P1.8 整删整文件**(v3 文案"删 PTY 用例"语义模糊不闭合);P1.10 新增 grep 自检兜底;P1.11 ⚑ checkpoint 真可达;P3.4 改 noop 兜底自检;step 计数:P1.7→P1.7a/b,P1.10→P1.11(共 11 sub-step) |
| reviewer-codex MED-1(P3.7 grep "src 无剩余" 在 P4 前必中残留)| P3.7 全 src grep 自检挪到 **P4.6**(P4 phase 末,shared/types/generic-pty.ts + wire-prefix.ts 都已删完);P3.7 改成只 typecheck checkpoint;step 计数:P3.8 ⚑ → P3.7 ⚑(P3 phase 8 step → 7 step);新增 P4.6 grep |
| reviewer-claude MED-A + reviewer-codex LOW-1 双方独立(N4 "8 个" vs 列 10 个)| N4 文本 "8 个" → "10 个";checkpoint list 行号同步更新(P1.10→P1.11 / P3.8→P3.7 / 加 P4.6);§下一会话第一步 step 5 list 同步 |
| reviewer-claude MED-B(P5.3b alternative `canCreateSession=false` 走错 spawn handler 分支)| P5.3b 删括号内 alternative;加 Round 3 修法注释引用 spawn.ts:48-60 两段不同 check;明确**只走 `returns undefined`** 路径 |

## v3 修订记录(Step 1.5 deep-review Round 2 fix 摘要,保留历史)

| 改动来源 | v2 → v3 影响 |
|---|---|
| reviewer-claude HIGH-A + reviewer-codex HIGH-1 双方独立(P1.8 不可达双角度互补)| **P1 phase 重排** — main register 删除从 P3.6 拉到 P1.7;SessionRecord 类型修订加进 P1.4 sub-step 5;原 _shared/mocks/session-repo.ts 从 P5.1 拉到 P1.9;P1.10 ⚑ checkpoint 真可达 |
| reviewer-codex MED-1(D4 upsert binding double-stringify) | D4 拍板 upsert binding **固定 `null`**;P1.4 sub-step 4 加;§已知踩坑 第 2 条同步 |
| reviewer-claude MED-B + reviewer-codex MED-2 双方独立(chokidar §已知踩坑 事实错误 + grep 命中注释) | §已知踩坑 第 4 条改"chokidar 实测 0 prod caller";P6.1 改 import-only grep pattern;D3 拍板"一起卸 node-pty + chokidar";Step 6.2 改 `pnpm remove node-pty chokidar`(2 个) |
| reviewer-claude MED-A(P1.4 漏 4 注释级文件) | P3.6 加 4 文件注释清扫 sub-step(event-repo / message-delivery-state / summarizer/index / sdk-bridge/constants);P3.7 加 grep 自检兜底 |
| reviewer-claude MED-C(SessionRecord 类型决策 in-flight) | D4 拍板**默认 `unknown \| null` 保留字段**;若 P9 grep 0 caller 再 escalate 整删;P1.4/P4.4/D4 三处文案对齐 |
| reviewer-codex LOW-1(P7.1 grep `\|` BRE 转义错) | P7.1 改 `-E "agent_id.*CHECK\|CHECK.*agent_id\|agent_id IN"` → `-E "agent_id.*CHECK|CHECK.*agent_id|agent_id IN"`(裸 `|` ERE alternation) |
| reviewer-claude LOW-A(应用打包/项目 CLAUDE.md 0 hit) | P8.2 第 4 个 bullet 改"实测 0 hit,grep 自检兜底无改动";D6 表对应行也改 0 hit |
| reviewer-claude LOW-B(P9.2/P9.3 未 ⚑) | N4 改"typecheck/test/build 三类";Checkpoint 清单加 P9.2 + P9.3;P5.6 已是 ⚑(test);8 个 ⚑ → 10 个 ⚑(P0.2/P1.10/P2.5/P3.8/P4.5/P5.6/P6.7/P9.1/P9.2/P9.3) |

## v2 修订记录(Step 1.5 deep-review Round 1 fix 摘要,保留历史)

| 改动来源 | 影响 |
|---|---|
| reviewer-claude H1 + reviewer-codex H1 双方独立 | D4 拍板 type 整片删 + P1.3/P1.4 加 8 文件 sub-step + N6 修订 + §已知踩坑 修订 |
| reviewer-codex H2 + reviewer-claude 反驳同意升级 | N4 改"phase/checkpoint 必过" + 加 N8 commit 粒度政策 + P1.8 加 disclaimer + §下一会话第一步 step 5 加 exception + 8 checkpoint 打 ⚑ |
| reviewer-claude H3 + reviewer-codex 反驳同意收窄 | Step 5.3 拆 3 sub-step (5.3a/b/c) + 用 schema-valid adapter + 局部 mock 而非 fake 字符串 |
| reviewer-claude H2 + reviewer-codex INFO | N2 改"5 处 TS + 3 处 runtime" 列具体 assert 名 + §已知踩坑 同步 |
| reviewer-claude H4 + reviewer-codex M2 双方独立 | D6 表 README 改"必改" + 加 `docs/<无日期>.md` 新行(当前协议) + P8.2 加 README + docs/agent-deck-team-protocol.md 具体改点 |
| reviewer-codex M1 (chokidar) | D3 修订 + P6.1 加 grep 检查 step + §已知踩坑 加 chokidar 可能 alive 条目(v3 已修订为 0 caller) |
| reviewer-claude M3 + reviewer-codex M3 双方独立 | §下一会话第一步 顶部加全局 zsh wrapper 约束 + P6/P9 命令明示包 wrapper |
| reviewer-claude M4 (wire-prefix.ts 实际是 string) | §已知踩坑 删 wire-prefix.ts adapter union 条 + P4.3 改文案"jsdoc 注释段删字面量,无 typecheck 影响" |
| reviewer-claude M5 (D2 trade-off) | D2 末尾加 builtin slash UX 降级 trade-off 说明 |
| reviewer-claude M6 (spike 注脚) | §当前进度 加 spike 注脚 + P10.2 期望 return 加 `spike_reports_archived: null` |
| reviewer-codex L1 (Composer 顶部 bullet) | P0.1 加删 line 20 顶部 bullet |
| reviewer-claude L1 (行号 off-by-1) | P0.1 行号改 109-120 + 5 行注释 |
| reviewer-claude L2 (aider 无 __tests__) | P1.1 文案改 |
| reviewer-codex L2 (P7.1 grep) | P7.1 grep pattern 改(v3 进一步修法 BRE 转义错) |

## Follow-up(本 plan 之外的发现,P10 归档时随 plan 一起入项目 git 留底)

### F1: hand_off_session 增加 teammate 过继(adopt)语义

**Why**(实测触发):本 P2 起手会话由 hand_off_session 接力起,默认 `keep_teammates=false` 自动 shutdown 了 caller 同 team 的两个 reviewer(reviewer-claude sid=`57fec271-04b7-4833-82d8-b5ef5b208952` / reviewer-codex sid=`019e438b-994f-7a10-b2c4-73f0d506f9ce`)。这两个 reviewer Round 1-4 已经积累了 plan design 维度的完整 mental model(SSOT 链式 enforce / 不变量 / DB schema / 设计决策推理链),P9 code review 时虽然 scope 切到 kind='code'(代码删除 vs plan design 评审)mental model 复用价值不高,**但其他长 plan / 多 phase plan**(如多个 phase 都需 review 同款架构改动)mental model 复用价值大。

baton 默认 shutdown teammate 是「caller 会话使命终结 → team 没 lead 后 teammate 应一起收口避免孤儿」语义,合理;但缺一个 opt-in 路径让 caller 显式说「我要把这两个 teammate 过继给新 session」。

**实测 workaround**(本会话用):用户已 mark `keep_teammates=true` 才能跳过 shutdown(本次没 opt-in 故已 shutdown),后续 P9 重 spawn 一对新 reviewer pair。

**Feature request**:
- `hand_off_session` 新增 `adopt_teammates: boolean` 参数(默认 false 与现状一致)。`adopt_teammates=true` 时:
  - 新 session 自动加入 caller 同 team(default 不加 team 的 baton 语义切到「带 team 接管」)
  - caller 同 team 其他 active+dormant teammate **不 shutdown**(隐含 keep_teammates=true 自动 imply)
  - 新 session cold start 后第一条 send_message 直接走 universal-message-watcher 发到 teammate sid → reviewer SDK live query auto-resume(基于现有 dormant resume 机制),mental model 完整保留
- `team_name` 字段语义保持("custom 名给 team 命名")—— `adopt_teammates=true` 隐含从 caller team 继承 team_id,不需 caller 显式传 team_name(handler 内部从 caller sessionRepo 拿 caller 同 team 列表;如多 team 必须显式传 team_id 反查)
- Side note:与现 `keep_teammates: true` 区别 — `keep_teammates=true` 只跳 shutdown phase,不让新 session 加 team(caller 仍是 lead 但已 archive,team 留下"无 lead 但 teammate 仍 active"的 ghost 状态);`adopt_teammates=true` 显式让新 session 接 caller lead 角色,team_member 表新 session 进 team 替代 caller 当 lead,语义更干净

**优先级**:LOW(本 plan 已有 workaround,P9 重 spawn 单次代价可控;本 follow-up 留作独立 feature plan,**不**纳入当前 plan scope)

**归档去向**:本 plan 完成 archive_plan 时,§follow-up F1 内容随 plan 一起入项目 git;后续如要做 feature 实施,新建 `plans/hand-off-session-adopt-teammates-<YYYYMMDD>.md` 走完整 §RFC + §spike + §Deep-Review 流程,本节作为 motivation reference 引用

### F2: 防递归阈值默认值上调(`mcpMaxFanOutPerParent` 5→10 + `mcpSpawnRatePerMinute` 10→20)

**Why**(用户实测触发):用户截图设置面板「防递归阈值(运行时即时生效)」当前默认值仍是:
- `mcpMaxFanOutPerParent` = **5**(单 caller 最大子会话)
- `mcpSpawnRatePerMinute` = **10**(每分钟 spawn 上限)

CHANGELOG_125(`codex-handoff-team-alignment-20260518` plan 收口)末尾文字称已调高,但实际 user-facing 默认值未落地(可能 commit 漏改 settings-store / settings-defaults / 或老 settings 持久化未 migrate)。当前默认值在 deep-review 编排起 4-6 reviewer + plan 完成 baton hand-off 起新 session 等场景下偏紧:并发起 reviewer pair × 多对/批 → 单 caller fan-out 易撞 5 上限 + 多对并发起一波过去秒内撞 10/min spawn-rate 限流。

**Feature request**:
- 升级 `mcpMaxFanOutPerParent` 默认值:**5 → 10**(覆盖 deep-review 多对 reviewer 同 lead spawn / 用户多 session 并行起 helper)
- 升级 `mcpSpawnRatePerMinute` 默认值:**10 → 20**(覆盖 deep-review 同时多对 reviewer + plan 收口 hand-off 起 Phase 2/3 接力 + 用户瞬时多操作场景)
- 验证 settings-defaults 配置文件 + settings-store migrate 逻辑(老用户已持久化 5/10 时是否需要 migration? 还是只改默认值让新用户起家走 10/20)
- 同步设置面板 jsdoc 描述更新
- typecheck / 跑测试覆盖防递归 guard 边界(`spawn-guards.test.ts`)

**优先级**:MED(本 plan 已实测撞 spawn 限流场景多次,但属于 settings UX 微调而非阻断功能,可作独立小 feature plan 收口)

**归档去向**:本 plan 完成 archive_plan 时,§follow-up F2 内容随 plan 一起入项目 git;后续如要做 feature 实施,新建 `plans/raise-mcp-spawn-defaults-<YYYYMMDD>.md` 走完整流程(可能 trivial 不需要 spike,但 deep-review 评审默认值升级是否撞已知 deep-review 编排的同步性约束 — 起 N pair reviewer 同时 spawn 是否需要进一步 throttle / batched spawn 等)
