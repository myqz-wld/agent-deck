# CHANGELOG_130 — reviewer-codex-cross-adapter-20260519 plan 收口: cross-adapter native pair + 5 处 P0 finding + UI dedup

## 概要

`reviewer-codex-cross-adapter-20260519` plan 收口 — 让 deep-review SKILL 异构对偶 reviewer 编排在双向 lead × adapter 矩阵下都用 native 形态(删 wrapper × 2),codex CLI 用户也能 `/agent-deck:deep-review` 触发同款编排。Phase 0-6 串行推进:Phase 0 dispatch BLOCKER 完整解决(5 处 P0 finding 链落地)+ Phase 1 SKILL 跨 adapter spawn 编排 + Phase 2 删 wrapper agent body(净 -450 行)+ Phase 3 SKILL build-time auto cp SSOT + Phase 4 资产面板 dual-adapter UI dedup + Phase 5 端到端回归 + Phase 6 文档收尾。

9 commit chain 落地 (base `40d7527` 之后):**fix v1** (transport-http stateless mode 旧) → **fix v2** (transport-http per-request fresh transport) → **phantom dep** (@modelcontextprotocol/sdk 转 direct dep) → **8 tool annotations** (spec-compliant ToolAnnotations) → **fix v3** (spawn_session/hand_off_session openWorldHint 由 true 改 false) → **Phase 1** (SKILL 跨 adapter spawn) → **Phase 2** (删 wrapper × 2) → **Phase 3** (build-time cp + .gitignore) → **Phase 4** (资产面板 dedup + ContentViewerModal dual-adapter tab)。

typecheck PASS / 71 file 876 test pass + 76 skip 0 fail / build 全过。`heterogeneous_dual_completed: true`(Phase 0 Step 0.5 双向 cross-adapter spawn pair + same-adapter regression 双双 PASS)。

## 变更内容

### Phase 0 — cross-adapter teammate dispatch BLOCKER fix(5 commit chain)

spike 1+2 实测 reviewer-codex 调 `mcp__agent-deck__send_message` 失败 reply 不注入 lead conversation flow。Phase 0 真起 SDK pair reproducer 4 层 signal 独立断言定位 root cause + iterative fix:

**fix v1** (commit `c67ddde`,旧路径) — `transport-http.ts` `sessionIdGenerator: undefined` stateless 模式,21 tests pass 守 regression(transport-http-extra-auth + spoofing-attack-paths)。Step 0.4 后续 vitest 实测铁证 fix v1 不充分:mcp-sdk webStandardStreamableHttp.js:142-144 throw `Stateless transport cannot be reused across requests`,hono `handleFetchError` 转成 status=500 空 body。

**fix v2** (commit `835aa7c`) — 走 mcp-sdk 1.29 official `simpleStatelessStreamableHttp.js` 标准 pattern:POST /mcp per-request fresh transport + fresh McpServer + connect → handleRequest,reply.raw.on('close') 清理两者;GET / DELETE 走 405。新 test `transport-http-multi-client-init.test.ts` 3 cases PASS(stateful reuse 撞 -32600 / stateless reuse status=500 / per-request fresh 两次都 200)。

**phantom dep fix** (commit `1f70582`) — `@modelcontextprotocol/sdk` 由 transitive dep 转 direct dep。Phase 0 Step 0.4-bis user dev terminal stdout 锁定 dev mode `[agent-deck-mcp] failed to mount HTTP transport Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@modelcontextprotocol/sdk'` — Node ESM 严格 resolve 不走 pnpm hoist fallback,register call 内 dynamicImport mcp-sdk throw 被 line 187 catch 静默 console.error。fix v2 transport 层与此正交,但同样必须解才能跑 dev mode。

**8 tool annotations** (commit `eb65878`) — 给 8 个 write tool 加 spec-compliant `ToolAnnotations` 4 fields(readOnly/destructive/idempotent/openWorld):`spawn_session` / `send_message` / `shutdown_session` / `archive_plan` / `hand_off_session` / `enter_worktree` / `exit_worktree` / `shutdown_baton_teammates`。Step 0.4-tris user 重启 dev 后实证暴露 NEW BLOCKER — 不是 spike 1+2 时 transport 层 stateful init 撞 -32600,**而是** codex CLI 内部 `mcp_tool_call_approval` gate(读 tool annotations + AppConfig 字段决定走审批 gate / 自动放行)。read-only tool(`list_sessions`/`get_session`)自动放行;未标 annotations / `openWorldHint:true` / `destructiveHint:true` 走 approval gate,agent-deck 主进程无 mcp approval callback handler → 自动 cancel "user cancelled MCP tool call"。

**fix v3** (commit `923468e`) — Step 0.5 实测 `send_message` annotation `{rO:F des:F idem:F ow:F}` 在 codex CLI HTTP transport 下放行 ✓,`spawn_session` 标 `{rO:F des:F idem:F ow:T}` (ow:true) 与 send_message 唯一差异是 ow → spawn_session cancel / send_message work,锁定 ow:true 是 cancel 触发器。修法:`spawn_session` / `hand_off_session` `openWorldHint:true → false`(应用内 closed-world,主进程 spawn 应用边界内 SDK CLI 子进程,不是 web search 真正外部 open-world)。

**Phase 0 Step 0.5 双向 + Step 0.6 same-adapter 双双 PASS**:
- 方向 A (claude-code lead × codex-cli reviewer-codex):reviewer-codex 调 send_message reply queued + 注入 lead conversation flow 完整 wire prefix + reply chain 闭环 ✅
- 方向 B (codex-cli lead × claude-code reviewer-claude):codex temp lead 调 spawn_session(adapter:'claude-code') 不再 1ms cancel + reviewer-claude reply 注入 codex temp lead conversation flow + forward 验证给真 lead 三段链路全过 ✅
- same-adapter regression 1 (claude × claude in-process MCP transport):annotations 修改属 metadata 层与 in-process transport 正交,fix v3 不影响 in-process 路径 ✅
- same-adapter regression 2 (codex × codex same-adapter HTTP transport):reply 注入成功,fix v3 不影响 HTTP transport same-adapter 路径 ✅

### Phase 1 — SKILL.md 跨 adapter spawn 编排 + 失败兜底 native 化(commit `8cb9ec4`)

`resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md`:
- §异构对抗 表 reviewer-codex 列「claude-code adapter wrapper,内部 Bash 跑外部 codex CLI」改为「codex-cli adapter 直起 codex SDK,gpt-5.5」+ 加跨 adapter 直起 callout
- §执行模板 Step 1 spawn args reviewer-codex 的 `adapter:'claude-code'` 改 `adapter:'codex-cli'`,注明「adapter 各异」
- §kind=mixed 失败兜底 节同款 wrapper-style failure modes 改 native
- §失败兜底 表第 1 行 reviewer-codex 失败模板 wrapper 专属语义(「CLI 不可用」/「Bash 卡审批被拒」)删,改 native codex SDK 失败语义(`shell sandbox 拒 / OAuth 过期 / shell tool call timeout / codex thread jsonl 缺失走 fallback`)

同步 `claude-config/CLAUDE.md` §reviewer-codex 失败兜底 + `codex-config/CODEX_AGENTS.md` §reviewer-claude 失败兜底 对偶视角同款 native 化。

### Phase 2 — 删 wrapper agent body × 2 + cleanup wrapper code(commit `da5c0eb`,净 -450 行)

- `git rm resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md`(claude SDK + Bash 起外部 codex CLI wrapper,168 行)
- `git rm resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md`(codex SDK + shell 起外部 claude -p wrapper,192 行)
- 改 2 份 native body description native 化(claude-config/.../reviewer-claude.md + codex-config/.../reviewer-codex.md frontmatter description / callout / 对偶节描述)
- 删 wrapper-specific code(typecheck PASS + 6 tests pass):
  - 删 `src/main/adapters/claude-code/resolve-bundled-claude.ts` 整文件(33 行,grep 0 production caller)
  - 删 `options-builder.ts:182-185` reviewer-claude wrapper `envOverrideExtra: AGENT_DECK_CLAUDE_PATH` 注入分支(12 行)+ 删 import + 改注释 generic 化
  - 改 `types.ts:215-228` envOverrideExtra 字段注释 generic 化(字段保留供未来 caller 重用)
  - 改 codex-cli `sdk-bridge/index.ts` 4 处注释 generic 化 + `spawn.ts:258-261` 注释 generic 化
  - 重写 `teammate-spawn-defaults.test.ts`:删 mock resolveBundledClaudeBinary + 删 TC9(positive wrapper)+ 删 TC11(edge case)+ 6 tests pass
- cleanup dormant wrapper session no-op(实测 0 个 wrapper 形态 dormant session)

### Phase 3 — codex-config 端 SKILL build-time auto cp(commit `5b727e0`)

- 写 `scripts/sync-codex-skills.mjs`(~80 行 Node fs cpSync,先 `rm -rf` 目标再重 cp 避免 stale)+ 加 npm `predev` / `prebuild` hook 自动同步
- bundled-assets.ts dual-root scan 已 work 无需改(line 68-71 spread `scanSkills(claudeRoot, 'claude-code') + scanSkills(codexRoot, 'codex-cli')`)
- `.gitignore` 加 entry `resources/codex-config/agent-deck-plugin/skills/`(cp 产物不入 git, SSOT 单源在 claude-config),`git check-ignore -v` 验证生效
- skills-installer.ts 源单 SSOT 不变(`getBuiltinSkillsSourceDir()` = claude-config),镜像到 `~/.codex/skills/agent-deck/` 让 codex CLI 加载

### Phase 4 — 资产面板 dedup + ContentViewerModal dual-adapter tab(commit `48141ec`)

资产库 Dialog Skills tab 同 kind+name 跨 adapter SKILL 合并为单条双角标(deep-review/hello-from-deck SSOT 镜像两端均可用),ContentViewerModal 加 `[claude]/[codex]/[user]` tab 切换 + adapter narrowing fetch + seq guard:

- `AssetsLibraryDialog.tsx`:加 `dedupBundledByName` group helper(同 kind+name 跨 adapter 合并为单 group;每组按 claude-code 优先 / codex-cli 后 / null 末尾 deterministic 排序)+ AssetsTab bundled render `dedupBundledByName(bundled).map((group) => <AssetCard assets={group} />)` + AssetCard signature `asset → assets[]`(`assets.length > 1` 时显示双角标 chip 一对)+ openViewer 改 group input + viewer modal `onTabSwitch` handler 走 seq guard fetch(closure 每次 render 重建拿最新 viewer state,React 18 batched update 保证一致性)
- `ContentViewerModal.tsx`:`ContentViewerState` schema `asset → assets[] + currentAdapter`(后者 `'claude-code'|'codex-cli'|null`)+ 加 `[claude]/[codex]/[user]` tab UI(仅 `assets.length > 1` 时显示)+ 加 `onTabSwitch?: (adapter) => void` callback prop
- 抽 `AssetCard` + `AdapterBadge` + `dedupBundledByName` 到独立文件 `assets/AssetCard.tsx`(132 行)— 538 行突破阈值后按项目 CLAUDE.md「单文件 ≤500 行护栏」选 1 抽子组件,主文件回 420 行 ≤ 阈值

效果(改造后):
- bundled SKILL deep-review/hello-from-deck 各形成 2-asset group → 单条双角标 [claude]+[codex]
- bundled agents reviewer-claude/reviewer-codex 各 1-asset group → 单条单角标(改造后不再同 name 跨 adapter)
- modal tab 切换 fetch 对应 root 内容(Phase 3 SSOT 镜像 frontmatter 一致,保留 adapter narrowing 字段防未来分叉)

### Phase 5 — 端到端回归

- Step 5.1 cross-adapter spawn pair (claude lead × codex reviewer-codex):Phase 0 Step 0.5 方向 A 已实测 PASS,Phase 5 重 spawn fresh review 再次实证 0 regression
- Step 5.2 codex lead × claude reviewer-claude:Phase 0 Step 0.5 方向 B 已实测 PASS,Phase 5 fresh 再次实证
- Step 5.3 codex CLI interactive `/agent-deck:deep-review` — 委托 user 在 terminal 实操(agent 跨进程跑不了 interactive shell)
- Step 5.4 dormant 唤醒回归(spike 3 audit 结论在 cross-adapter 场景 work)
- Step 5.5 资产面板 UI 视觉回归 — 委托 user 重启 dev mode 后看「📚 资产库」Dialog Skills tab 视觉

### Phase 6 — 收尾文档

- Step 6.1 写本 CHANGELOG_130.md + 同步 changelog/INDEX.md
- Step 6.2 sweep `resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md` 遗漏 wrapper 描述清理(2 处改 native:claude-config/CLAUDE.md L79 「claude lead × codex wrapper teammate」改「claude lead × codex teammate」+ codex-config/CODEX_AGENTS.md L168-172 codex teammate spawn options default 描述改 native)
- Step 6.3 走 `mcp__agent-deck__archive_plan` 归档(含 spike-reports/ 子目录自动归档到 `<main-repo>/plans/<plan_id>/spike-reports/`)

## 关键不变量(改造后)

1. cross-adapter teammate 上行 dispatch work — reviewer-codex(codex-cli adapter)调 `mcp__agent-deck__send_message` 时 reply 通过 universal-message-watcher 自动注入 lead conversation flow,无 manual 转贴
2. 同源化禁令物理保证 — 异构对偶两 reviewer 必须分别跑在两个不同 adapter 的 SDK 子会话(claude SDK + codex SDK),杜绝 wrapper 跨 SDK 拼合的中间形态污染
3. lead adapter 任意性 — 无论 lead 是 claude-code 还是 codex-cli adapter,SKILL.md 编排都起 native reviewer-claude(claude-code adapter)+ native reviewer-codex(codex-cli adapter)一对,不因 lead adapter 差异退回 wrapper
4. SSOT 单写多 build — deep-review / hello-from-deck SKILL.md 内容仓库里维护单份(claude-config),codex-config 端 build-time auto cp 拿镜像
5. mcp tool annotations spec-compliant — 8 个 write tool 各按破坏性 / 幂等性 / open-world 性质准确标 `ToolAnnotations` 4 fields,codex CLI mcp tool approval gate 自动放行(`destructiveHint:false` + `openWorldHint:false` 路径)

## 详情

详 [`plans/reviewer-codex-cross-adapter-20260519.md`](../../plans/history/reviewer-codex-cross-adapter-20260519.md) + spike-reports/ 子目录(spike1+2 cross-adapter teammate dispatch / spike3 codex SDK dormant resume audit / spike4 codex CLI 加载 SKILL)。
