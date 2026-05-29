---
plan_id: "sdk-spawn-shell-path-20260529"
created_at: "2026-05-29T08:30:00+08:00"
status: "completed"
base_commit: "e1fbc6e75c59b7d8c3943fac9dfb93ff894f14b1"
base_branch: "main"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/sdk-spawn-shell-path-20260529"
final_commit: "e5b023f7d4235ebb4d68de0dcbad5b9d75658cda"
completed_at: "2026-05-29"
---
# SDK Spawn Shell PATH 修复 plan

## 上下文

### 背景

继承自 follow-up task `6aec8cf7-5b84-4e70-a1ac-bf91d29803ed`(归档于 plan `deep-project-review-comprehensive-20260528`)。

User 反馈:reviewer-claude / reviewer-codex teammate spawn 起来后 sandbox 内跑 `pnpm typecheck` 撞 `command not found: pnpm`,但 lead 端 / 直接终端 pnpm 已可用。

RFC 阶段 user 进一步问「这是不是只能解决 pnpm 的问题,有没有更加通用和泛化的解决逻辑」 — 真正问题是 **SDK 子进程 PATH ≠ 用户终端 PATH**。pnpm 只是症状,brew/cargo/nvm/bun/go/任何用户终端 CLI 都受影响。

### Spike1 实证(`<plan-artifact-dir>/spike-reports/spike1-shell-path-actual.md`)

| 维度 | 实测值 |
|---|---|
| SDK 子进程 PATH(当前) | 5 条:`/usr/bin:/bin:/usr/sbin:/sbin:<plugin/bin>` |
| 用户终端 PATH(zsh -ilc) | 22 条:含 brew/nvm/cargo/go/bun/gvm/.claude 等 |
| 缺失 | 17 条 用户自定义 + 系统增强路径 |
| pnpm 实际位置 | `~/.nvm/versions/node/v24.10.0/bin/pnpm` (corepack-managed via nvm) |
| Bug 已知性 | `sdk-runtime.ts:6-9` 注释明文「launchd 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin」(注释描述 launchd 自家 4 条;实际 SDK 子进程多 1 条 `agent-deck-plugin/bin` 是应用安装路径注入,共 5 条 = launchd 4 + plugin 1 = spike1 Finding A) — 应用层已知但未根治 |
| $SHELL -ilc cost | 平均 460ms(可接受,Electron 启动几秒级) |
| 跨 shell 兼容性 | bash/zsh/sh -ilc 都支持;bash 不读 zsh rc 配置 → 修法必须用 user `$SHELL` 不假设 zsh |

## 总目标

主进程启动时一次性实测用户真实终端 PATH 缓存,在 bootstrap 早期 mutate `process.env.PATH = unionUserShellPath(process.env.PATH)`,让所有后续 spawn(SDK 子进程 + 主进程 git 等)在**本轮支持的 shell 集合**(zsh / bash / sh / dash / ksh — 即 `-ilc` 标准兼容 shell,**全部经 spike1 + codex Round 2 现场实测**)上自动 inherit 完整 PATH。修复 reviewer sandbox pnpm 等所有「用户终端 CLI 在 SDK 子进程不可用」问题。

**Non-goal**:tcsh / csh / fish / nu 等不支持 `-ilc` 标志的 shell 不在本轮 scope(详 §已知踩坑 2 + §不变量 11),另开 spike2 + follow-up plan 修法(reviewer-codex Round 2 现场实测 `/bin/tcsh -ilc` 与 `/bin/csh -ilc` 返回 `Unknown option: '-lc'` 失败,推翻 spike1 §G 「`/etc/shells` 默认列表都支持 `-ilc`」断言)。

## 不变量

1. **不引入新依赖** — 只用 node:child_process / 现有 helper(spike1 §X1 实测 `$SHELL -ilc` 用 execSync 字符串拼 cmd 够用,**实施按 reviewer-codex Round 1 MED-3 hardening 演化用 `execFileSync` argv API 替代**,避免 `$SHELL` 含 quote / space 时命令注入面)
2. **失败不破坏现状** — `$SHELL` 未设走 /bin/zsh 兜底跑成功(可能拿到 user PATH);shell 跑挂 / 输出空 → console.warn + `captureUserShellPath` 返 null,`unionUserShellPath` fallback 原 process.env.PATH(行为与现在一致,不退化)
3. **PATH 只补不替** — union 优先用户 PATH,原 process.env.PATH 保留(避免丢 Electron bundle 路径 `.app/Contents/MacOS` `Resources/bin` 等)
4. **dedupe 保留优先序** — Set 顺序去重避免 PATH 含重复条目(用户 PATH 末尾 vs 原 process.env.PATH 末尾会撞 `agent-deck-plugin/bin`)
5. **process.env 其他字段不动** — 只改 PATH 字段(避免污染 ANTHROPIC_API_KEY / NODE_OPTIONS 等其他 env)
6. **修法 idempotent** — `captureUserShellPath()` 用独立 sentinel(`captured: boolean` + `cached: string | null`)区分「未初始化」vs「已捕获含 null」,**失败路径也命中 memo**(避免每次调用都重跑 execFileSync + 重复 warn + 重复 3s timeout 风险);`unionUserShellPath()` 同输入返同输出(纯函数 + dedupe 保序)
7. **fail loud 范围** — 用 console.warn 而非 silent(让 user 在主进程 log 看到 fix 是否生效),但**不**抛错阻塞启动
8. **不暴露 setting** — 不加 enableShellPathInjection 配置项(符合 macOS 应用约定「环境变更 重启应用 生效」)
9. **预热入口在 Phase 0 末尾** — bootstrap-infra.ts Phase 0 `applyClaudeSettingsEnv()` 之后,在 initDb / settings.getAll / adapter init 等所有后续 phase 之前
10. **测试矩阵覆盖 4 case** — corepack pnpm via nvm(spike 实测 base case) / brew pnpm(mock PATH) / standalone ~/Library/pnpm(mock PATH) / 未装 pnpm 底线(mock PATH + verify raw `command not found` 错误 message clear,**不依赖 reviewer body fallback**)
11. **本轮支持 shell 集合 explicit** — zsh / bash / sh / dash / ksh(即 `-ilc` 标准兼容 shell,**全部经 spike1 + codex Round 2 现场实测**:zsh/bash/sh 走 spike1 Finding G L155-181 + dash/ksh 走 codex Round 2 verification `/bin/dash|ksh -ilc 'echo ok'` 返回 code 0);**tcsh / csh / fish / nu** 是 explicit non-goal — codex Round 2 现场实测 `/bin/tcsh -ilc` 与 `/bin/csh -ilc` 返回 `Unknown option: '-lc'` 失败(spike1 §G 「`/etc/shells` 默认列表都支持 `-ilc`」断言被推翻),fish 不支持 `-i` flag 同款 fail。`captureUserShellPath` 失败 → fallback 原 process.env.PATH,这些 shell 用户应用启动后 SDK 子进程 PATH 仍是 launchd minimal — plan 文档化此限制 + follow-up spike2 修法

## 设计决策(不再争论)

| 决策 | 选项 | 理由 / 来源 |
|---|---|---|
| **修法方案** | X1:`$SHELL -ilc 'echo $PATH'` 实测 + 缓存 + bootstrap 早期 mutate process.env.PATH | RFC Round 3 user 选定 X1(否决「只 patch pnpm 路径」的 D 方案 — 「只能解决 pnpm 不通用」)。spike1 §结论 §H1-H6 全部 6 假设实证 |
| **PATH 合并策略** | B union 用户 PATH 优先(`USER_TERMINAL_PATH + ':' + process.env.PATH`) | RFC Round 4 Q1 user 选 B。brew/nvm/cargo 等用户 CLI 优先 lookup;Electron bundle 路径仍保留兜底 |
| **PATH dedupe** | Set 保留优先序去重 | RFC Round 5 Q1 user 选 dedupe。echo $PATH 看起来干净;OS lookup 不撞重复 IO |
| **失败兜底** | 静默降级用 process.env.PATH + console.warn | RFC Round 4 Q2 user 选静默降级。loud dialog 是 Mac 边界场景(fish/nu)用户会全新启动体验脱发 |
| **修复 scope** | 所有 SDK spawn(含 lead) + 主进程 process.env.PATH | RFC Round 2 Q2 user 选最广;Round 5 Q4 user 选「主进程 process.env.PATH 也 union」。一次性根治 — 主进程 spawn git / 其他子进程都受益 |
| **预热入口** | bootstrap-infra.ts Phase 0 `applyClaudeSettingsEnv()` 之后 | RFC Round 5 Q2 user 选启动早期。460ms cost 与 Electron 启动并行,user 不感知 |
| **暴露 setting** | 不暴露 | RFC Round 5 Q3 user 选不暴露。符合 macOS 应用约定 |
| **shell 选择** | 用 user `$SHELL`(env 变量)不 hardcode zsh | spike1 Finding G 实证 bash 不读 zsh rc → 必须 user $SHELL 才能复现 user 终端 PATH。失败 fallback /bin/zsh |
| **execFileSync timeout** | 3000ms(防 oh-my-zsh 慢 init 死锁) | spike1 §残留风险 5 |
| **stderr 抑制** | `stdio: ['ignore', 'pipe', 'pipe']`(stderr 走 pipe 不 inherit,实施时便于 catch 块读 stderr 调试,与 §Step 3.1 实施指令一致;`['ignore', 'pipe', 'ignore']` 等价不污染主进程 log) | spike1 Finding G bash -ilc warn "no job control",抑制避免污染主进程 log |
| **输出解析** | 取最后一行非空(避免 rc 文件 echo 干扰) | spike1 §X1 修法实施细节 helper 实现 |
| **修法落点** | 1 新 helper + 1 个 bootstrap 调用点 | spike1 §inform Step 1 plan 决策 **已被 RFC Round 5 Q4「主进程 process.env.PATH 也 union」决策替代**:新建 `src/main/utils/user-shell-path.ts`(captureUserShellPath / dedupePath / unionUserShellPath)+ 改 `src/main/index/bootstrap-infra.ts` Phase 0 mutate process.env.PATH(单点改 2-3 行)。**不**改 sdk-runtime.ts / codex-cli/sdk-bridge/index.ts —— 两 adapter 函数内 spread `process.env`(`getSdkRuntimeOptions()` / `snapshotProcessEnv()` 都是函数内构造非 module-level cache,spike1 §残留待 Step 1 plan 写作时决策的点 §4 + 已知踩坑 4 实证)→ bootstrap mutate 后下次调 spread 自动拿到新 PATH。**与 spike1 §X1 §2 §3 原方案差异**:spike1 提议 adapter 两处也加 union 调用(共 3 处改),plan 简化为单点 bootstrap mutate — 避免「`unionUserShellPath(已 union 的 PATH)` 重复 union」(虽 dedupe 幂等不出错但易引 reviewer 困惑 + 多余 mock test 覆盖) |

## 步骤 Checklist

### Step 0. RFC ✅
- [x] RFC Round 1 fix strategy(A/B/C/D) — user 反问「通用化」推翻 D
- [x] RFC Round 2 scope(只 reviewer / 所有 teammate / 含 lead)— user 选含 lead
- [x] RFC Round 3 通用方案(X1/X2/X3)— user 选 X1
- [x] RFC Round 4 PATH 合并策略 + 失败兜底 — user 选 B + 静默降级
- [x] RFC Round 5 4 个 plan 细节(dedupe / 预热 / setting / 主进程 PATH)— user 选 dedupe + 早期预热 + 不暴露 + 主进程 union

### Step 0.5. Spike1 ✅
- [x] 跑实测 6 命令(SDK PATH / shell PATH / pnpm 位置 / spawn options.env / timing / 跨 shell 兼容)
- [x] 写 spike1 report 落 `<plan-artifact-dir>/spike-reports/spike1-shell-path-actual.md`(8 finding 全 ✅ 假设验证)

### Step 1. 写 plan ✅
- [x] 写 `<main-repo>/.claude/plans/sdk-spawn-shell-path-20260529.md`(本文件)

### Step 1.5. Deep-Review plan(下一步)
- [ ] invoke `agent-deck:deep-review` SKILL kind='plan' 评审本文件
- [ ] HIGH 必修 / MED 现场验证 → fix 直到 0 HIGH/MED 共识可合
- [ ] 0 HIGH 0 真 MED → 进 Step 2 EnterWorktree

### Step 2. EnterWorktree
- [ ] user 显式 confirm 进 worktree 实施
- [ ] `git -C <main-repo> worktree add -b worktree-sdk-spawn-shell-path-20260529 <main-repo>/.claude/worktrees/sdk-spawn-shell-path-20260529`
- [ ] `EnterWorktree(path: <worktree-abs-path>)` 进入(用 path 不 name,避开 v2.1.112 stale base bug)
- [ ] 进 worktree 第一件事 `Bash: pwd` 自检 + `git log --oneline -3` 验证 HEAD = base_commit

### Step 3. 实施

#### Step 3.1 — 写 helper(`src/main/utils/user-shell-path.ts`)
- [ ] 写 `captureUserShellPath(): string | null` — **`execFileSync(shell, ['-ilc', 'printf "%s\\n" "$PATH"'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })` argv API**(禁用 string-form execSync 拼 cmd,避免命令注入面 — reviewer-codex Round 1 MED-3 hardening)+ 取最后一行非空(避免 rc 文件 echo 干扰)+ `captured: boolean` + `cached: string | null` sentinel 二分 memo(失败路径也命中)
- [ ] 写 `dedupePath(path: string): string` — split ':' + Set 保留优先序去重 + join ':'
- [ ] 写 `unionUserShellPath(originalPath: string | undefined): string` — `dedupePath(${userPath}:${originalPath})` 用户 PATH 优先;失败 fallback originalPath
- [ ] typecheck verify

#### Step 3.2 — 改 bootstrap-infra.ts Phase 0 加调用
- [ ] `bootstrap-infra.ts:initInfra` 在 **L71 `applyClaudeSettingsEnv()` 调用之后、L78 `initDb()` 调用之前** 加 2-3 行(L73-75 browser-window-created listener 注册前 / 后均可,**优先放 listener 之后** 让 Phase 0 概念整段「app metadata + env 注入」连续):
  ```ts
  // mutate process.env.PATH = union(user shell PATH, process.env.PATH)
  // 让所有后续 spawn 自动 inherit 完整 PATH (修 .app launchd 启动 minimal PATH 问题)
  const newPath = unionUserShellPath(process.env.PATH);
  if (newPath !== process.env.PATH) {
    process.env.PATH = newPath;
  }
  ```
- [ ] typecheck verify
- [ ] **预期效果**: 后续 `getSdkRuntimeOptions()` (spawn-time 函数内 spread process.env) 与 `snapshotProcessEnv()` (spawn-time 函数内 spread process.env) 自动拿到新 PATH

#### Step 3.3 — 单元测试 `src/main/utils/__tests__/user-shell-path.test.ts`
- [ ] test: captureUserShellPath 用 mock execFileSync 返回示例 PATH → 拿到字符串
- [ ] test: captureUserShellPath execFileSync throw → 返 null + console.warn
- [ ] test: captureUserShellPath execFileSync 返空白输出 → 返 null + console.warn
- [ ] test: captureUserShellPath success memo cache(连调 2 次 execFileSync 只跑 1 次)
- [ ] test: **captureUserShellPath failure memo cache** (execFileSync throw 后连调 2 次 execFileSync 只跑 1 次 + console.warn 只 1 次) — 验证 §不变量 6 sentinel 设计「失败路径也命中 memo」
- [ ] test: **captureUserShellPath empty-output memo cache** (execFileSync 返空白后连调 2 次只跑 1 次) — 同 §不变量 6
- [ ] test: dedupePath 输入含重复路径 → 返保序去重结果
- [ ] test: dedupePath 输入空 → 返空
- [ ] test: unionUserShellPath user PATH + originalPath → 拼接 user 在前 + dedupe
- [ ] test: unionUserShellPath captureUserShellPath 失败 → 返 originalPath
- [ ] test: unionUserShellPath originalPath undefined → 返 user PATH
- [ ] `pnpm vitest run src/main/utils/__tests__/user-shell-path.test.ts` 全过

#### Step 3.4 — 测试矩阵实测(4 case)
> ⚠ 4 case 在 user 本机不全可复现(user 是 corepack via nvm = case 1)。其他 case 可 mock 验证 + 留 follow-up 文档说明,本 plan 不强求实机覆盖全 4 case
- [ ] case 1 实证(user 本机):应用启动后 reviewer-* teammate 跑 `which pnpm` → 返 `~/.nvm/.../pnpm`
- [ ] case 2 mock 验证:userPath 含 `/opt/homebrew/bin` → union 后 SDK 子进程 PATH 含 brew
- [ ] case 3 mock 验证:userPath 含 `~/Library/pnpm` → union 后 SDK 子进程 PATH 含 standalone
- [ ] case 4 fail loud 验证(mock 路径):mock `vi.mock('node:child_process')` 让 `execFileSync` 返 `/usr/bin:/bin`(模拟 tcsh/csh/fish/未配置 shell 拿到 minimal PATH)→ unit test 验证 `captureUserShellPath` 返 `/usr/bin:/bin` + `unionUserShellPath` 拼接 process.env.PATH 后,verify `process.env.PATH` mutate 后**仍不含 pnpm 路径** → 调 `child_process.spawnSync('pnpm', ['--version'], { env: { PATH: <mocked PATH> }, shell: true })` 拿 **status === 127** + stderr 含 `command not found` clear 错误 message(**用 `shell:true` 路径** — codex Round 2 现场实测 Node 默认 spawnSync 不走 shell 时返回 `error.code='ENOENT'` 且无 stderr,只有 `shell:true` 才返回 status 127 + `/bin/sh: ... command not found` stderr;**不依赖 reviewer body fallback** — reviewer body fallback 已在 reviewer body review 中**未实现**,不在本 plan scope)

#### Step 3.5 — 临时 commit per step
- [ ] Step 3.1 完成 commit `feat(utils): add user-shell-path helper`
- [ ] Step 3.2 完成 commit `feat(bootstrap): inject user shell PATH at bootstrap Phase 0`
- [ ] Step 3.3 完成 commit `test(utils): user-shell-path unit tests`
- [ ] Step 3.4 完成 commit `docs(plans): record test matrix verification results`

### Step 3.6 — Deep-Review code(实施后)
- [ ] invoke `agent-deck:deep-review` SKILL kind='mixed' 评审 plan + 实施
- [ ] HIGH 必修 / MED 现场验证 → fix 直到 0 HIGH/MED 共识可合

### Step 3.7 — 3 build 必跑
- [ ] `pnpm typecheck` 必跑
- [ ] `pnpm build` 必跑
- [ ] **plan 不强求 `pnpm dist`** — dist 走完整打包 5 min cost,主要验证 electron-builder 整合(本 plan 不动 packaging),可在 Step 4 收口前手动验证一次(或留 commit message 注记)

### Step 4. 收口 + Phase 经验沉淀

#### Step 4.1 — 经验沉淀
- [ ] 候选放 `<main-repo>/ref/conventions/tally.md`(若适用):「主进程 PATH ≠ 用户终端 PATH(macOS launchd minimal PATH)— 任何 Electron 应用 spawn 子进程都撞」
- [ ] count ≥ 3 走升级流程(走「双对抗三态裁决」评审 → 新建 ref/conventions/<X>-electron-path-injection.md)
- [ ] count < 3 静默更新

#### Step 4.2 — 写 CHANGELOG
- [ ] 新建 `<main-repo>/ref/changelogs/CHANGELOG_X.md`(X 递增;`ls ref/changelogs/` 找最大)
- [ ] 引用本 plan 归档路径 `ref/plans/sdk-spawn-shell-path-20260529.md`
- [ ] 同步 `<main-repo>/ref/changelogs/INDEX.md` 加一行

#### Step 4.3 — archive_plan mcp tool 5 步收口
- [ ] `ExitWorktree(action: "keep")` 把 cwd 切出 worktree
- [ ] `mcp__agent-deck__archive_plan({plan_id: "sdk-spawn-shell-path-20260529", worktree_path: "...", base_branch: "main", changelog_id: "<X>"})` 自动:
  - ff-merge worktree branch → main
  - frontmatter 改 status=completed + final_commit + completed_at
  - mv plan → `<main-repo>/ref/plans/sdk-spawn-shell-path-20260529.md`
  - mv `<plan-artifact-dir>/spike-reports/` → `<main-repo>/ref/plans/sdk-spawn-shell-path-20260529/spike-reports/`
  - 同步 `<main-repo>/ref/plans/INDEX.md`
  - git commit
  - git worktree remove + branch -D
  - caller 自动归档(default baton 语义)

## 当前进度

**已完成**:
- Step 0 RFC ✅ (5 轮 RFC 对齐 design 大方向)
- Step 0.5 spike1 ✅ (6 假设全实证)
- Step 1 plan 文件写完 ✅
- Step 1.5 Deep-Review plan ✅ (3 round 共识 0 HIGH/MED 可合,16 finding fix 落地)
- Step 2 EnterWorktree ✅ (HEAD = base_commit `e1fbc6e` 无 stale base bug)
- Step 3.1 helper user-shell-path.ts ✅ (commit `f474352`)
- Step 3.2 bootstrap-infra.ts Phase 0.5 mutate process.env.PATH ✅ (commit `43315e3`)
- Step 3.3 unit test 14 → 18 passed ✅ (commit `95da518` 初版 + Round 2 fix 加 4 test)
- Step 3.5 临时 commit per step ✅ (3 commit chain)
- Step 3.7 typecheck ✅ / pnpm build ✅ (`pnpm dist` plan 不强求,Step 4 收口前 user 手动 verify)
- Step 3.6 Round 1 mixed review ✅ + Round 2 fix:5 处 fix(2 MED + 1 LOW + 2 INFO):
  - **MED-1** zsh `.zlogout` 污染 PATH:helper 改用 `__AGENT_DECK_PATH_BEGIN__/END__` sentinel 标记包围 PATH 输出,不依赖 last-line(codex Round 1 实测铁证)
  - **MED-2** plan §当前进度 / §下一会话第一步 未同步:本节更新到 Round 2 fix 进度
  - **LOW-1** bootstrap mutate 加 `&& newPath !== ''` 守门防 undefined → '' 退化(claude Round 1)
  - **INFO-2** test 加 `originalPath = ''` 显式覆盖
  - **INFO-3** test 加 `$SHELL` undefined → /bin/zsh fallback 显式覆盖

**当前位置**:worktree branch `worktree-sdk-spawn-shell-path-20260529`,4 commits through `f69e7a9` (Step 3.6 R1 fix 完成),等待 Round 2 reviewer 裁决

**未完成**:
- Step 3.6 Round 2 reviewer-{claude,codex} verify fix 是否到位(本步骤进行中)
- Step 3.4 case 1 实证(.app 启动后 reviewer-* spawn 跑 `which pnpm` 返 `~/.nvm/.../pnpm`)— cost 高,可推到 Step 4 收口前 user 手动 verify
- Step 4 收口(经验沉淀 + CHANGELOG_X + archive_plan mcp tool 5 步)

## 下一会话第一步

按本 plan **Step 3.6 Round 2 verify**:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/sdk-spawn-shell-path-20260529.md` 全文读 plan(本节更新到 Round 2 fix)
2. 等 reviewer-{claude,codex} Round 2 reply 自动注入 lead conversation flow(SKILL §Step 2 等 reply 模式;reviewer 已知 Round 1 fix 摘要 + 新 sentinel design + bootstrap '' 守门)
3. 收 reply 后做三态裁决:
   - 0 HIGH/MED 共识可合 → Step 3.6 ✅ → 进 Step 4 收口
   - 仍有 HIGH/MED → Round 3 fix loop
4. Step 4 收口:
   - 经验沉淀:`<main-repo>/ref/conventions/tally.md` 加候选「主进程 PATH ≠ 用户终端 PATH(macOS launchd minimal)— 任何 Electron 应用 spawn 子进程都撞」(count ≥ 3 升级到 ref/conventions/)
   - 新建 `<main-repo>/ref/changelogs/CHANGELOG_X.md`(X 递增,`ls ref/changelogs/` 找最大)+ 同步 `<main-repo>/ref/changelogs/INDEX.md`
   - `ExitWorktree(action: "keep")` 切 cwd 出 worktree
   - `mcp__agent-deck__archive_plan({plan_id, worktree_path, base_branch:"main", changelog_id})` 自动 5 步收口

## 已知踩坑(写作过程发现)

1. **bash -ilc 'no job control' warning** — 不要让此 stderr 进主进程 log,用 `stdio: ['ignore', 'pipe', 'ignore']` 抑制(spike1 Finding G)
2. **tcsh/csh/fish/nu shell 用户 explicit non-goal(§不变量 11)** — 这些 shell 都不支持 `-ilc` 复合标志(tcsh/csh:`Unknown option: '-lc'`;fish:`-i: unknown flag`)→ `captureUserShellPath()` execFileSync throw → catch + console.warn → return null → `unionUserShellPath` fallback 原 process.env.PATH(tcsh/csh/fish 用户 SDK 子进程 PATH 仍是 launchd minimal,pnpm/cargo/brew 仍找不到)。本 plan **不解决**(reviewer-codex Round 2 现场实测推翻 spike1 §G 默认列表全兼容断言;无 spike 不能纳入 fish/tcsh/csh 修法 — 各 shell 的 PATH 来源、login/interactive config 加载、nvm/fnm/asdf 初始化链都需先 spike2 实测),留 follow-up plan `sdk-spawn-shell-path-other-shells-<YYYYMMDD>`:`spike2-other-shell-path-behavior.md`(tcsh/csh `-l + -c` PATH 等价性 / fish `-l -c` PATH 等价性 / 各 shell rc 文件加载 / nvm/fnm/asdf 跨 shell 初始化链)+ helper 内加 shell-specific detect。**这些 shell 用户当前 workaround**:切回 zsh/bash(`chsh -s /bin/zsh`)或在 shell rc 文件设 `set -gx PATH /opt/homebrew/bin /Users/<user>/.nvm/versions/node/v<ver>/bin $PATH`(fish 语法)/ `setenv PATH "/opt/homebrew/bin:..."`(tcsh/csh 语法)后启动应用
3. **bash 不读 zsh rc** — spike1 Finding G,修法必须用 user `$SHELL` 不假设 zsh
4. **bootstrap import 时序** — `bootstrap-infra.ts` 顶层已 static import `claudeCodeAdapter` / `codexCliAdapter`(L34-36),import 在 `initInfra()` 函数体执行前完成 — 所以"Phase 0 必须在 sdk-runtime / codex sdk-bridge 被 import 之前 mutate"**表述错误,无法满足**。**实际成立条件**:Phase 0 mutate process.env.PATH 必须在**首次调** `getSdkRuntimeOptions()` / `snapshotProcessEnv()` 之前(即首次 createSession / ensureCodex 之前)。**实证**:`src/main/adapters/claude-code/sdk-runtime.ts:40-57` `getSdkRuntimeOptions()` 是 spawn-time 函数(`create-session-sdk-query.ts:72` 才调),`src/main/adapters/codex-cli/sdk-bridge/index.ts:57-63` `snapshotProcessEnv()` 也是函数内构造(`index.ts:261` spawn 前才取快照)— 两者都不是 module-level cache,Phase 0 mutate 之后 Phase 4-5 adapter initAll / Phase 7 scheduler / 首次 spawn 时调 spread 自动拿到新 PATH ✅。轻量 order test 验证:mock `unionUserShellPath` 断言在 `adapterRegistry.initAll` 前完成 PATH mutation
5. **execFileSync timeout 3000ms 选取理由** — spike1 实测 460ms 平均,3000ms 给慢 ~/.zshrc(oh-my-zsh + nvm + starship)留 6x 安全余量;超 3s 用 process.env.PATH 兜底
6. **PATH 测试用 mock execFileSync** — `vi.mock('node:child_process')` 让单元测试不依赖真实用户 shell;集成测试可 spike 命令实测(本 plan 不强求 e2e 测真实 spawn)
7. **zsh `.zlogout` 输出污染 last-line(Step 3.6 reviewer-codex Round 1 MED-1)** — zsh login shell 在 `-c` 命令结束后会读 `~/.zlogout`,如果用户配置了输出文本 helper 取 last-line 拿到 logout 文本而非 PATH。**修法**:helper 用 `__AGENT_DECK_PATH_BEGIN__<PATH>__AGENT_DECK_PATH_END__` sentinel marker 包围 PATH 输出,parse 时找 sentinel 而非依赖 last-line。test 加 `extracts sentinel-marked PATH even when zsh .zlogout writes after` 覆盖。
8. **bootstrap 加 `&& newPath !== ''` 守门(Step 3.6 reviewer-claude Round 1 LOW-1)** — 极端 dev 情景下 process.env.PATH undefined + captureUserShellPath 失败时 unionUserShellPath 返 ''(`originalPath ?? ''` 分支),mutate '' 比 undefined 严格更差(`Object.entries(process.env)` skip undefined keys 让 child 走 Node 默认查找;'' 是 string 进 entries 让 child 拿空 PATH 全部 lookup fail)。production .app 不触发(launchd 总设 minimal `/usr/bin:/bin:/usr/sbin:/sbin`)。
9. **console.warn 在 .app launchd 环境无回显(Step 3.6 reviewer-claude Round 1 LOW-2)— 与 follow-up #3 重叠** — macOS launchd 启动的 .app 进程 stderr 不挂 terminal,helper 的 console.warn 输出落 `~/Library/Logs` 或被丢。tcsh/csh/fish 用户 capture 失败时看不到 warn,只感觉 SDK 子进程「command not found」而无法溯源。**本 plan 不修** — 与 follow-up task `e1493ecd-7600-451f-97a5-24d8c3f0ca2e`(运行时日志落盘 + 应用内查看按钮,electron-log 选型)重叠;那个 follow-up 实施后本 plan 的 console.warn 自动落 log file 可见,无需独立修法。
