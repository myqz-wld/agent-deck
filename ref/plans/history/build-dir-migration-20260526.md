---
plan_id: "build-dir-migration-20260526"
created_at: "2026-05-26"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/build-dir-migration-20260526"
status: "completed"
base_commit: "5f8dfa407b6f7229daa62e5f12a44abd83498b97"
base_branch: "main"
final_commit: "6a6903e9aa57b3b41cc3a7fb970b6fecbfde9fea"
completed_at: "2026-05-26"
---
# Plan: agent-deck 项目 build 产物全面迁移到 build/ 统一根出口

## 总目标

把 agent-deck 项目所有 build 产物统一收纳到 `build/` 根出口下:
- electron-vite outDir:`out/main` → `build/main` / `out/preload` → `build/preload` / `out/renderer` → `build/renderer`
- electron-builder directories.output:`release/` → `build/dist/`
- 同步 electron-builder `files` glob / .gitignore / src/ 注释 / scripts 内可能 hardcode 路径 / README 等 doc

**Why**:对齐应用打包 CLAUDE.md §src/build 标准目录结构 canonical 标准(本仓库 ref-layout-full-migration plan 刚把 user CLAUDE.md §新项目工程地基 挪到应用打包 CLAUDE.md self-contained,顺势把这个约定也实施到 agent-deck 本项目)。

**例外不适用**:应用 CLAUDE §src/build §例外说「已有项目按工具链默认惯例保留原状,不要 retro 改造;如需迁移走 §复杂 plan 完整流程」— 本 plan 即走 §复杂 plan 完整流程做 retro。

**如何应用**(给下一会话):cold-start `Bash: cat <plan-abs-path>` 全文 → frontmatter 取 worktree_path → `EnterWorktree(path: <worktree_path>)` → 按 §下一会话第一步 接力

## 不变量

1. **electron-vite outDir 3 入口 + electron-builder output 1 出口显式拆分**(共 4 个 `build/<sub>/` 目录,两层归属):
   - electron-vite 3 入口 → `build/main` / `build/preload` / `build/renderer`(显式 outDir,**不**走 default `out/` 隐式 fallback 避工具升级时变更)
   - electron-builder 1 出口 → `build/dist`(directories.output)
2. **electron-builder directories.output:`build/dist`** — canonical 标准(应用 CLAUDE §src/build §落地姿势 直接 reference);**不**用 `build/release/`(虽 release 命名习惯但 canonical 是 dist)
3. **electron-builder files:`["build/**/*", "!build/dist/**", "resources/**/*"]`** — 整 build/ + 排除 dist/ 防自引用;未来加新 build sub 不需同步改 files。**注**:此 files 数组**覆盖** electron-builder 默认 `["**/*"]`,但 `package.json` + 生产依赖 `node_modules/` 是 electron-builder mandatory auto include(不在 files override 控制范围内,spike4 asar 实测含 `/package.json` + `/node_modules/` 均 OK)— 自定义 files 只控**额外** inclusion / 排除范围。
4. **`.gitignore` 整 build/ 忽略**(应用 CLAUDE §新项目工程地基 §.gitignore 必备条目);删 `out / release / dist` 单独 entry
5. **不向后兼容**(hard cutover):老 .app(/Applications/Agent Deck.app)与老 dev mode 全 break;升级前自行 `pnpm dist` 重打包 + 重装 .app
6. **不留任何兼容旧 `out/ release/` 描述 / fallback / migration helper**(user 硬指令 + 应用 CLAUDE §提示词资产维护 约束 2「当前事实」)。**例外**:`resources/claude-config/CLAUDE.md` 整文件是 narrative-only 应用打包模板(L390 + L408 两处描述「Electron 老项目工具链默认 `out/` + `release/`」是事实陈述介绍 electron-vite / electron-builder default 值),不属于本项目自描述要替换的类别 — **整文件保留** + Phase §F.5 grep gate 整文件排除该路径。**Why 整文件不只 line whitelist**:narrative-only file 内任何 historical naming reference 都是合法,line whitelist 易撞新增 narrative 时漏 update。
7. **typecheck + pnpm build + pnpm dist 全 pass** 是收口前置条件;**`pnpm dev` 留 user 收口后自验证**(与 spike5 .app 重装同款 dog-fooding 责任分配 — lead 自杀风险禁主跑,详 §Phase F.6)
8. **每个 fix 必有同步实测** — 改 config 同步跑相应 pnpm 命令 verify 产物 actually 落 build/<sub>/
9. **src/ 注释 + doc 内 `out/ release/` 提及全替换**(同款 hard cutover 不留旧标准描述,与 ref-layout plan 同款 sed 扫策略)。**扫描范围**:`src/ scripts/ README.md CLAUDE.md ref/conventions/ resources/claude-config/CLAUDE.md`(顶层 self-describe 文件)。**不扫**:`ref/changelogs/ ref/reviews/ ref/plans/`(历史归档保持当时事实) + `node_modules/` + `build/` + `.deep-review-cache/`
10. **base_commit 严格在 main 上**(ref-layout-full-migration plan 已收口 commit `eb379b6 + 5f8dfa4`,本 plan base 在其后 `5f8dfa4`)

## 设计决策(不再争论)

### D1: build/ 子目录拆分粒度 — electron-vite outDir × 3 + electron-builder output × 1(RFC Q1 答 = A = canonical 平铺)

electron-vite outDir 3 入口:
- `build/main/`(electron-vite main 入口 build 产物)
- `build/preload/`(electron-vite preload 入口 build 产物)
- `build/renderer/`(electron-vite renderer 入口 build 产物)

electron-builder output 1 出口:
- `build/dist/`(electron-builder 打包产物 .dmg / .app / portable)

**Why**:应用 CLAUDE §src/build §落地姿势 canonical;跨项目可迁移习惯;多人读不需加注释。4 目录两层归属(electron-vite 拆 main/preload/renderer × 3 + electron-builder output × 1)清晰区分。

### D2: electron-builder files = 整 build/ + ! dist/(RFC Q2 答 = B)

`files: ["build/**/*", "!build/dist/**", "resources/**/*"]`(整 build/ 但排除 dist 防自引用)

**Why**:未来加新 build sub(如 build/cli/ 或 build/sdk/)不需同步改 files;比分子目录罗列更简洁。

**注**:此 files 数组**覆盖** electron-builder 默认 `["**/*"]`,但 `package.json` + 生产依赖 `node_modules/` 是 electron-builder mandatory auto include(不在 files override 控制范围内,spike4 asar 实测含 `/package.json` + `/node_modules/` 均 OK)— 自定义 files 只控**额外** inclusion / 排除范围。

### D3: changelog X 接起算(RFC Q3 答 = A)

收口时按 §Phase G-manual.2.0 fail-fast 重算 X(`ls ref/changelogs/CHANGELOG_*.md | max + 1`),避免本 plan in_progress 期间被别 plan 撞号。当前最大 X=153(ref-layout 占),预计本 plan X=154 或之后。

### D4: 不向后兼容(hard cutover)

老 .app + 老 dev mode 全 break;升级前自行 `pnpm dist` 重打包 + 重装 /Applications/Agent Deck.app。**不**留兼容旧 `out/ release/` 路径 fallback。

### D5: Step 1.5 deep-review SKILL kind='plan' 评审 plan + Step 5 deep-review kind='mixed' 实施评审 — 与 ref-layout plan 同款两轮编排

### D6: dev mode 兼容性(spike 验证)

`pnpm dev` electron-vite dev 模式默认 main / preload 也 build 然后启动;改 outDir 需 spike 验证 dev mode 是否仍 work(spike1)。如不 work,electron-vite dev mode 可能依赖 `out/` hard-code 位置,需 plan 兜底(typical 仍 work 因为 outDir 由 config 决定)。

### D7: extraResources 独立于 outDir

`extraResources: [{from: 'resources/bin', ...}, ...]` 与 electron-vite outDir 无关(electron-builder 独立 copy resources/ 到 .app);本 plan **不动 extraResources**。

### D8: wrapper / bin 路径独立

`resources/bin/agent-deck` wrapper 是 launch .app,与 build outDir 无关;本 plan **不动 wrapper**。

## 影响面 spike(待 spike 实测)

### A. electron-vite outDir 3 入口配置(`electron.vite.config.ts`)

实测项:
- main.build.outDir: 'build/main' 是否让 `pnpm build` main 产物落 build/main/?(spike1)
- preload.build.outDir: 'build/preload' 同款(spike1)
- renderer.build.outDir: 'build/renderer' 同款(spike1)
- 改后 `pnpm dev` 是否仍 work?(spike2)

### B. electron-builder directories.output + files glob(`package.json`)

实测项:
- `directories.output: 'build/dist'` 让 `pnpm dist` 产物落 build/dist/?(spike3)
- `files: ["build/**/*", "!build/dist/**", ...]` 是否正确 include main/preload/renderer 排除 dist/?(spike3)
- ASAR 打包路径 unpack(`build.asarUnpack`)是否需同步改?(spike3 — `node_modules/...` 或 `out/...` hardcode 路径)

### C. src/ 注释 / scripts / doc 内 hardcode 路径(Phase C/E 完成清单)

`spike pre-check` 已找到:
- `src/main/window.ts:22` 注释 `__dirname 是 out/main/`(需改 `build/main/`)

实测命中(scope 见 §不变量 9 — 不扫 ref/{changelogs,reviews,plans}/ 历史归档):
- `src/main/window.ts:22` 注释(Phase C.2 完成 ✅)
- `README.md:107` cp 命令(Phase E.2 完成 ✅)
- `CLAUDE.md:214` cp 命令 + L210 `rm -rf release`(Phase E.2 完成 ✅)
- `ref/conventions/tally.md:79` P26 entry 内 3 处 `out/main/`(Phase E.2 完成 ✅,reviewer-claude HIGH-1c)
- `resources/claude-config/CLAUDE.md`(整文件描述工具链默认 `out/` + `release/` narrative,L390 + L408 两处 — **整文件故意保留**,详 §不变量 6 例外)

### D. .gitignore(L2-L4 + 新加,**提前到 finding fix 第一件**)

- 删 L2 `out`、L3 `release`、L4 `dist`(单数 dir entry)(Phase D.1 完成 ✅)
- 加 `build/`(应用 CLAUDE §新项目工程地基 §.gitignore 必备条目 canonical)(Phase D.1 完成 ✅)

### E. README.md / CLAUDE.md 内 build 产物位置 narrative(Phase E 同 §C)

## 步骤 checklist

### Phase Spike: spike 实测(在 worktree 内跑)

- [x] **spike1 electron-vite outDir 3 入口**(实测 ✅):改 `electron.vite.config.ts` 加 `main.build.outDir: 'build/main'` 等 → `pnpm build` 验证产物落 `build/main/ build/preload/ build/renderer/`(`ls build/` 确认结构)
  - **结论 ✅**:`build/main/{index.js, transport-http-LPbIuJxi.js}`、`build/preload/index.js`、`build/renderer/{index.html, assets/}` 全部正确;`out/` 0 残留。renderer log 显示 `../../build/renderer/...` 是相对 `src/renderer/` root 路径显示(实际 fs 路径仍为根 `build/renderer/`)。
- [⚠ skipped] **spike2 dev mode**(static reasoning,跳过实测 — **user 收口后必须自验证** §Phase F.6):端口 47821/5173 被 `/Applications/Agent Deck.app` PID 64880 占用(user 在用 + 当前 lead session 跑在该 .app SDK 子进程内)。静态等价证明:① electron-vite dev main/preload 用与 build 同 config 写 outDir(dev = watch mode + build = one-shot,outDir 行为一致);② spike1 已实证 build 产物落 build/main, build/preload;③ renderer dev 走 vite dev server(5173)不写 outDir;④ Electron 进程入口由 `package.json main: "build/main/index.js"` 锁定(已改)。**已知风险**:首次 user 跑 `pnpm dev` 若撞 fail 按 §已知踩坑 spike 失败回滚分支处理。**接力 agent 警告**:本 spike 状态是「未实测」而非「已 verify」,不要默认信任。
- [x] **spike3 electron-builder dist**(实测 ✅):改 `package.json` `directories.output: 'build/dist'` + `files: ["build/**/*", "!build/dist/**", "resources/**/*"]` → `pnpm dist` 验证 .dmg / .app 落 build/dist/(`ls build/dist/`)
  - **结论 ✅**:`build/dist/mac-arm64/Agent Deck.app` + `build/dist/Agent Deck-0.1.0-arm64.dmg` (254.9 MB) + blockmap 全部正常落 `build/dist/`;`release/` 0 残留。
- [x] **spike4 asar / extraResources / wrapper 链路完整性**(实测 ✅):验证打包后 .app 内部 path(`asar list build/dist/mac-arm64/*.app/Contents/Resources/app.asar` + wrapper `resources/bin/agent-deck` 启动)
  - **结论 ✅**:asar 内 `/build/main/{index.js, transport-http-*.js}` + `/build/preload/index.js` + `/build/renderer/{index.html, assets/...}` 路径正确;asar `package.json main: "build/main/index.js"` 字段正确(extract 实证);extraResources `bin/{agent-deck, agent-deck.cmd}` + `claude-config/` + `codex-config/agent-deck-plugin/skills/{deep-review, flow-arch-plantuml, hello-from-deck}` + `sounds/` 全 copy;asar.unpacked 含 @openai/codex + @anthropic-ai/claude-agent-sdk-darwin-arm64(native binary)正常 unpack;asar 内 `/package.json` + `/node_modules/` 也含(electron-builder mandatory auto include,不在 files override 控制范围内,与 §不变量 3 / §D2 加注一致)。
- [⚠ skipped] **spike5 .app 安装重启**(跳过实测 — **user 收口后必须自验证** §Phase F.6):`/Applications/Agent Deck.app` 正在运行(user 在用 + 当前 lead session 跑在内),改 /Applications/ 会 kill 当前 session = 自杀 + 干扰 user。静态等价:spike4 asar 内部完整,与现行 .app 唯一差异是 outDir 路径名(`out/main → build/main`)。**user 收口前必须自验证步骤**(详 §Phase F.6 同步引用此 6 步):① `pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" && pkill -f "Agent Deck Helper"`;② `rm -rf "/Applications/Agent Deck.app"`;③ `cp -R "build/dist/mac-arm64/Agent Deck.app" /Applications/`;④ `codesign --force --deep --sign - "/Applications/Agent Deck.app"`;⑤ `xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"`;⑥ `unset ELECTRON_RUN_AS_NODE && "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" new --cwd "$PWD" --prompt ping`。**接力 agent 警告**:本 spike 状态是「未实测」而非「已 verify」,接力 agent **严禁自跑** 步骤 ① `pkill "Agent Deck"`(dog-fooding 自杀:lead session = .app SDK 子进程会被 SIGTERM cascade kill)。

spike 结论 inline 到 §设计决策 + §已知踩坑;残留风险列表入 §已知踩坑。

**spike 综合结论**:Phase A-D config 改动 hot-spot 已全部 verify(electron-vite outDir / electron-builder dist / asar 内部 / extraResources),剩 spike2 dev mode + spike5 .app 重启走 static reasoning + user 收口前自验证。spike1+3+4 都 0 残留 0 异常,plan §不变量 1-3 + §设计决策 D1-D2 全部成立 — Phase A-D 可直接实施。

**Phase Spike checklist 实际改动覆盖**:本 spike 已 inline 完成 Phase A (electron.vite.config.ts outDir 3 入口) + Phase B (package.json directories.output + files glob + main 字段) 的代码改动。**Phase C-E 已在 §Step 1.5 finding fix 全部完成**(R1 finding fix commit 7bc4c07 — 详 §当前进度 R1 完成 entry + §Phase C/D/E 全 [x] 打勾 trace)。

### Phase A: electron-vite outDir 改造(已在 §Phase Spike spike1 完成 — checklist for trace)

- [x] A.1 改 `electron.vite.config.ts` main / preload / renderer 三入口加 `build.outDir: 'build/<sub>'`(spike1 完成 ✅)
- [x] A.2 `pnpm build` verify 产物落 build/<sub>/ + 0 残留 `out/` 出现(spike1 实测 ✅;改名旧 A.3 → A.2 — typecheck 单独走 Phase F.1 不算 Phase A 强制 sub-step,避免 Phase 间重复)

### Phase B: electron-builder directories.output + files 改造(已在 §Phase Spike spike3+4 完成 — checklist for trace)

- [x] B.1 改 `package.json` `directories.output: 'build/dist'`(spike3 完成 ✅)
- [x] B.2 改 `files: ["build/**/*", "!build/dist/**", "resources/**/*"]`(spike3 完成 ✅)
- [x] B.3 改 `main: "build/main/index.js"`(spike1 完成 ✅;原 plan 漏列此 substep — package.json L5 main 字段也指 outDir)
- [x] B.4 verify extraResources `from: resources/bin / claude-config / codex-config / sounds` 不需改(spike4 asar list 实证 ✅;extraResources 独立于 outDir)
- [x] B.5 `pnpm dist` verify .dmg / .app 落 build/dist/(spike3 实测 ✅)

### Phase C: src/ 注释 + scripts 内 hardcode 路径同步(Step 1.5 finding fix 完成 — checklist for trace)

- [x] C.1 grep 扫 `out/main|out/preload|out/renderer|release/` 在 `src/ scripts/`(Step 1.5 grep 实测 ✅;命中 `src/main/window.ts:22` 注释 1 处)
- [x] C.2 sed 改 `src/main/window.ts:22` 注释 `out/main/` → `build/main/`(Step 1.5 完成 ✅)
- [x] C.3 grep 0 残留 verify(Step 1.5 实测 ✅)

### Phase D: .gitignore 改造(Step 1.5 reviewer-codex MED-2x 修法,**提前到 finding fix 第一件**避免 build/ 误 commit)

- [x] D.1 改 .gitignore L2-L4 删 `out / release / dist` 单数 entry + 加 `build/`(Step 1.5 完成 ✅)
- [x] D.2 `git check-ignore -v build/test.txt` 实测 negation 生效(Step 1.5 实测 `.gitignore:2:build/` 命中 ✅;`git status --short` 干净无 `?? build/`)

### Phase E: 项目根 docs / active convention 更新(Step 1.5 finding fix 完成 — checklist for trace)

- [x] E.1 grep `out/main|out/preload|out/renderer|release/` 在 `README.md + CLAUDE.md + ref/conventions/ + resources/claude-config/CLAUDE.md`(Step 1.5 实测 ✅;不扫 ref/{changelogs,reviews,plans}/ 历史归档,详 §不变量 9)。命中:① `README.md:107` `cp -R "release/mac-arm64/..."` ② `CLAUDE.md:214` 同款 ③ `ref/conventions/tally.md:79` P26 entry 内 3 处 `out/main/`(reviewer-claude HIGH-1c)④ `resources/claude-config/CLAUDE.md` L390 + L408 两处 narrative(整文件故意保留,详 §不变量 6 例外)
- [x] E.2 sed 改 ①-③(Step 1.5 完成 ✅;④ 保留)
- [x] E.3 grep 0 残留 verify(Step 1.5 实测 ✅,scope = §不变量 9 列定的 7 个 path,resources/claude-config/CLAUDE.md 整文件 narrative-only 属合法残留 — Phase §F.5 grep gate 整文件排除该路径,详 §不变量 6 例外)

### Phase F: 全套验证

- [x] F.0 **§不变量 8 enforcement**(接力会话补 fix 时必跑):Phase A-E 任何后续补 fix(改 outDir / files glob / extraResources / src 注释 / doc narrative)→ 改完**立即**跑对应 pnpm 命令实测产物落 build/<sub>/(不要积累多 fix 一次 batch 跑,单点错误难定位);改 electron.vite.config.ts 跑 `pnpm build`;改 package.json directories/files 跑 `pnpm dist`;改 src 注释 / doc 只跑 `pnpm typecheck`(narrative-only 无产物)
- [x] F.1 `pnpm typecheck`(R2 接力会话实测 ✅,clean output 无 error)
- [x] F.2 `pnpm build`(R2 接力会话实测 ✅,3 bundle `build/main/{index.js, transport-http-LPbIuJxi.js}` + `build/preload/index.js` + `build/renderer/{index.html, assets/*}` 全落 build/<sub>/;vite dynamic-import warning 是 pre-existing src/main/store/agent-deck-team-repo/index.ts 既被 dynamic 又被 static import,不阻塞)
- [⚠ partial pass] F.3 `pnpm exec vitest run --exclude '**/task-repo.test.ts'`(R2 接力会话实测:665 passed | 69 failed | 40 skipped。**全部 69 fail 为 pre-existing electron binary 缺失**:`Error: Electron failed to install correctly` getElectronPath node_modules/.pnpm/electron@33.4.11/node_modules/electron/index.js:17(`dist/` + `path.txt` 都缺,`pnpm rebuild electron` 无效因 cache 已有 postinstall 跳过)。failing test 全集中 `src/main/agent-deck-mcp/__tests__/tools.test.ts`(mock electron 直 import 没 stub),与本 plan 改动(electron-vite outDir / electron-builder dist / src/main/window.ts:22 注释 / .gitignore / doc narrative)**0 关系**。**Evidence**:① 错误栈 `getElectronPath node_modules/.pnpm/electron@33.4.11/node_modules/electron/index.js:17:11` 明示 root cause 在 electron binary 装载层(与本 plan 任何改动无关);② lead 自检 `ls node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist` 返回 "No such file or directory" + `cat path.txt` 缺失 confirm binary 不在;③ R3 reviewer-codex 独立复核「定向跑 src/main/agent-deck-mcp/__tests__/tools.test.ts 57/57 均在同一 electron load error 前失败,与本迁移触及文件无关」;④ `git log --oneline src/main/agent-deck-mcp/__tests__/tools.test.ts` 不在本 plan commit 7bc4c07 范围。本 plan §不变量 7 只要求 typecheck + build + dist 全 pass,F.3 vitest 是辅助 sanity check,**不阻塞 plan 收口**;此 pre-existing 问题独立 fix 应走另一份 plan)
- [x] F.4 `pnpm dist` build/dist/ 验证 .dmg / .app(R2 接力会话实测 ✅,`build/dist/Agent Deck-0.1.0-arm64.dmg` 254.9 MB + `build/dist/mac-arm64/Agent Deck.app` + blockmap;Signing skip 是 pre-existing cert expired 不阻塞;better-sqlite3 native deps electron-builder 内部 rebuild 也跑过)
- [x] F.5 grep 0 残留(R2 接力会话实测 ✅,精确扫:`git grep -nE "out/(main|preload|renderer)|release/mac-arm64" -- src scripts README.md CLAUDE.md ref/conventions/ package.json electron.vite.config.ts .gitignore` 输出空;**显式排除**(scan range 之外路径不需重复列):`ref/{changelogs,reviews,plans}/ node_modules/ build/ .deep-review-cache/`;**`resources/claude-config/CLAUDE.md` 整文件不在 scan range** 因为 plan §不变量 6 例外明确该文件 narrative-only(L390 + L408 两处合法 narrative 描述工具链默认 `out/` + `release/` 命名 — 详 §不变量 6 例外);本 plan §不变量 6 例外只 enforce **本仓库自描述**不留旧标准描述,narrative-only 模板内的 historical naming reference 故意保留)。**regex 边界**:`out/(main|preload|renderer)` 精确匹配 outDir 3 入口名,不撞 `stdout/` `layout/` `timeout/` 等普通词;`release/mac-arm64` 精确匹配 electron-builder default mac 子目录,不撞 `release/notes/` 等 out-of-scope token。**R2 lead 自测**:fix 后命令 0 残留,sanity test fake `out/main` + `release/mac-arm64` 仍 catch ✅(R2 reviewer 三方独立 finding + lead 实测验证;R3 reviewer-codex 独立 verify 0 输出)
- [ ] F.6 **user 收口后自验证 dog-fooding 风险路径**(留 user 自跑,**接力 agent 严禁自跑步骤 ① pkill**):**与 `CLAUDE.md §打包与本地安装` 5 步关系**:本 F.6 是 .app dog-fooding verify scope,**假设 F.4 `pnpm dist` 已跑**(scope 限定不重跑);**不含** `ln -sf wrapper → /usr/local/bin/agent-deck`(F.6 只验证 .app 内 SDK 子进程 dog-fooding 不验证 wrapper CLI 入口)。完整「打包 → 安装 → wrapper 软链」一条龙见 `CLAUDE.md §打包与本地安装`(L200-248 区域)。**spike5 .app 重装 6 步**(自验证 .app 实际跑新 build/main/)→ ① `pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" && pkill -f "Agent Deck Helper"`;② `rm -rf "/Applications/Agent Deck.app"`;③ `cp -R "build/dist/mac-arm64/Agent Deck.app" /Applications/`;④ `codesign --force --deep --sign - "/Applications/Agent Deck.app"`;⑤ `xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"`;⑥ `unset ELECTRON_RUN_AS_NODE && "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" new --cwd "$PWD" --prompt ping`(应用启动 / 已运行实例新建一条 session)。**spike2 pnpm dev 实测**:user .app 重装完成后跑 `pnpm dev` 验证 dev mode 仍 work(若 fail 按 §已知踩坑 spike 失败回滚分支处理)

### Phase G: Step 5 deep-review §实施评审

- [ ] G.1 invoke deep-review SKILL `kind='mixed'`,scope = Phase A-E config + doc 改动 + 本 plan 文件(post finding fix 状态)
- [ ] G.2 处理 finding 按三态裁决纪律
- [ ] G.3 必要时复用 Step 1.5 reviewer pair(应用 CLAUDE §dormant ≠ 丢 mental model — send_message 自动 SDK resume,无需重 spawn)

### Phase H: 收口(G-manual 路径,与 ref-layout 同款;**user 已授权接力会话 lead 全权决定 G-manual 路径**,详 §下一会话第一步 user 授权 callout)

- [ ] H.-1 **commit Phase A-G tracked 累积改动**(electron.vite.config.ts + package.json + .gitignore + src/main/window.ts + ref/conventions/tally.md + README.md + CLAUDE.md)— Phase H.0 worktree clean gate 之前必须把 spike + finding fix 全 commit,否则 H.0 立即 fail。**Plan 文件本身不在 H.-1 commit 范围**:`.claude/plans/` 已被 .gitignore 忽略(`git check-ignore -v .claude/plans/build-dir-migration-20260526.md` 命中);plan 文件入库职责在 H.5 mv plan → `ref/plans/<plan_id>.md` + commit(唯一归档入库位置,避免 H.-1 / H.5 两处分发 plan 文件双 commit 矛盾)。.gitignore 已在 Phase D 提前修保证 build/ 不会被 git add 误纳入(reviewer-codex MED-2x R1 + LOW-2x R2 双修)
- [ ] H.0 worktree clean gate(`git status --short` 空,无 M / ?? / A 任何 entry)
- [ ] H.1 ExitWorktree(action: "keep")
- [ ] H.2.0 算 X(`ls ref/changelogs/CHANGELOG_*.md | max + 1`,fail-fast)
- [ ] H.2/3 写 ref/changelogs/CHANGELOG_<X>.md + sync INDEX + commit
- [ ] H.4 ff-merge worktree branch → base_branch(main)
- [ ] H.5 mv plan + frontmatter update + sync ref/plans/INDEX.md + commit
- [ ] H.6 git worktree remove + branch -D
- [ ] H.7 shutdown_baton_teammates(**mandatory** — §设计决策 D5 起 Step 1.5 + Step 5 两轮 reviewer pair,必有 dormant 残留需清理;G-manual 路径绕过 archive_plan tool baton-cleanup phase 1 → 必须手动调 escape hatch)

### Phase I: Post-archive fs 真验证(同 ref-layout Phase H)

- [ ] I.1 archive 文件真存在(`ls -la /Users/apple/Repository/personal/agent-deck/ref/plans/build-dir-migration-20260526.md`)
- [ ] I.2 git commit 含 archive
- [ ] I.3 INDEX append
- [ ] I.3.5 frontmatter status=completed + final_commit + completed_at
- [ ] I.4 git --follow history
- [ ] I.5 worktree + branch 真删
- [ ] I.6 **通知 user 走 §Phase F.6 dog-fooding 自验证步骤**(spike5 .app 重装 6 步 + spike2 pnpm dev 实测)— **agent 不自跑,告诉 user 收口已完成,请你自验证 .app 重装 + dev 模式**

## 当前进度

- ✅ §Step 0 RFC 第 1 轮完成(3 决策对齐:canonical 平铺 / 整 build/ + ! dist/ / 接起算 X)
- ✅ §Step 1 plan v1 outline 写完(2026-05-26 本会话,base_commit `5f8dfa4`)
- ✅ §Step 0.5 spike 完成(2026-05-26 接力会话):spike1+3+4 pnpm build / pnpm dist / asar 内部验证全 ✅;spike2 dev mode + spike5 .app 重启走 static reasoning 跳过实测(标 [⚠ skipped],user 收口后必走 §Phase F.6)
- ✅ §Step 2 EnterWorktree 完成(MCP enter_worktree + builtin EnterWorktree(path:) 双步,worktree `worktree-build-dir-migration-20260526` base 在 `5f8dfa4`)
- ✅ §Step 1.5 deep-review R1 完成(2026-05-26 接力会话):reviewer-claude(12 finding 2 HIGH/5 MED/4 LOW/1 INFO)+ reviewer-codex(3 finding 0 HIGH/2 MED/1 LOW)双 reply;三态裁决全 ✅;finding fix 全部完成(详 §Step 1.5 finding fix 摘要 callout 下方)+ Phase A-E 同步完成(commit 7bc4c07)
- ✅ §Step 1.5 deep-review R2 完成(2026-05-26 R2 接力会话):reviewer-claude(6 finding 2 HIGH/2 MED/2 LOW)+ reviewer-codex(3 finding 0 HIGH/1 MED/2 LOW)双 reply,R2 invocation `fd973276`,build-dir-r1 team `6e609841-...`;三态裁决:双方独立必修 2 + 单方 MED 必修 2 + 单方 LOW 轻量 fix 2,**0 反驳 100% 真问题**;finding fix 全部完成(详 §Step 1.5 R2 finding fix 摘要 callout)
- ✅ §Phase F 全套验证完成(2026-05-26 R2 接力会话):F.1 typecheck ✅ + F.2 build ✅ (3 bundle 落 build/{main,preload,renderer}) + F.3 vitest ⚠ partial (665 passed / 69 pre-existing electron binary failed,与 plan 0 关系) + F.4 dist ✅ (DMG 254.9 MB + .app 落 build/dist/mac-arm64) + F.5 grep 0 残留 ✅。F.6 dog-fooding 留 user 自验证
- ✅ §Phase G Step 5 deep-review R3 mixed kind 完成(2026-05-26 R3 接力会话,R3 invocation `ec60550b`):reviewer-claude(5 finding 2 HIGH/2 MED/1 LOW + 3 INFO)+ reviewer-codex(2 finding 0 HIGH/0 MED/2 LOW)双 reply;三态裁决:双方独立必修 1 + 单方 HIGH 必修 2 + 单方 MED 必修 2 + 单方 LOW 必修 1,**0 反驳 + 0 新 HIGH 边界条件**;R1+R2 fix 跨文件 INFO-1 verified 全 ✅;R3 finding 全是 plan narrative trace 漂移 + 1 项 cosmetic exclude list 冗余,**代码 + config + src 注释本质完全正确**;finding fix 全部完成(详 §Step 1.5 R3 finding fix 摘要 callout)
- ✅ R4 评估**不需** — R1+R2+R3 跨文件 INFO-1 verified 全 ✅;R3 finding 全是 plan narrative trace 漂移(无新 HIGH 边界条件 / 无 code/config bug);直接 Phase H 收口
- ⏳ §Phase H 收口待跑(commit Phase A-G tracked 改动 + G-manual 路径归档)
- ⏳ §Phase I post-archive 真验证

### §Step 1.5 finding fix 摘要(2026-05-26 接力会话)

reviewer-claude 12 finding:
- HIGH-1c ✅ fix:`ref/conventions/tally.md:79` P26 entry 内 `out/main/*.js` × 2 处 + `out/main/agents-md-installer-cYcOGELy.js` 全改 `build/main/`(commit pending)
- HIGH-2c ✅ fix:§Phase F.6 加 spike5 .app 重装 6 步 + spike2 pnpm dev user 自验证 + 显式 "agent 不自跑步骤 ① pkill" 警告 + §Phase I.6 user 通知 step
- MED-1c ✅ fix:§不变量 1 "4 入口" → "3 入口 + electron-builder × 1"(electron-vite outDir × 3 + electron-builder output × 1 清晰区分);§D1 标题同步重写
- MED-2c ✅ fix:Phase A.1/A.2 + Phase B.1/B.2/B.3/B.4/B.5 全部 `[x]` 打勾标注 spike 完成 + commit hash pending H.-1
- MED-3c ✅ fix:§不变量 7 "pnpm dev pass" → "pnpm dev 留 user 收口后自验证";§Phase F 加 F.6 dog-fooding 验证 user 责任分配
- MED-4c ✅ fix:§Phase H.-1 加 commit Phase A-G 累积改动 step(在 H.0 worktree clean gate 之前);Phase D 已经 finding fix 第一件提前修(reviewer-codex MED-2x 双方独立提同款方向)
- LOW-1c ✅ fix:spike2 + spike5 `[x]` → `[⚠ skipped]` + 加 "user 收口后必须自验证" + "接力 agent 警告:本 spike 状态是『未实测』不要默认信任" 显式标签
- LOW-2c ✅ fix:§当前进度 + §下一会话第一步 已 reconcile(本 callout 即 fix);§下一会话第一步 改成「按 §当前进度 找最近 ⏳ 接力」
- LOW-3c ✅ fix:§影响面 spike C grep range 改成 Phase C/E 完成清单 + 与 §不变量 9 / §Phase E 一致
- LOW-4c ✅ fix:§Phase H.7 "若" → "mandatory"(D5 起 Step 1.5 + Step 5 两轮 reviewer pair 必有 dormant 残留)
- INFO-1c ✅ fix:§不变量 3 加注 package.json + node_modules auto include 不在 files override 控制范围内;§D2 同步加注

reviewer-codex 3 finding:
- MED-1x ✅ fix:与 claude MED-2c 双方独立同款(Phase A/B 已落地但 checklist 未打勾 + 下一会话仍说重跑 spike),已 fix
- MED-2x ✅ fix:.gitignore 未先改风险,Phase D 提前到 finding fix 第一件已修(`.gitignore:2:build/` enforce 实测)
- LOW-1x ✅ fix:与 claude LOW-3c 双方独立同款(F.5 grep gate 不可执行),已 fix 改为精确 git grep 命令 + 显式 exclude 范围

### §Step 1.5 R2 finding fix 摘要(2026-05-26 R2 接力会话)

R2 双方独立 ✅ 必修(双方独立异构强冗余即算验证):
- **HIGH-1 (claude) + MED-1x (codex) + lead 自检** ✅ fix:§F.5 grep gate false positive(regex `out/(main|preload|renderer)?|release/` 中 `?` quantifier 让 `out/` 单独命中 `stdout/` `layout/repaint` `Network timeout/` 5 处 false positive + `resources/claude-config/CLAUDE.md` L390 漏标合法残留)→ 改 regex `out/(main|preload|renderer)|release/mac-arm64` 严格 token 匹配 + grep 路径整文件排除 `resources/claude-config/CLAUDE.md`(narrative-only 应用打包模板,L390+L408 两处合法 narrative 整文件保留)+ §不变量 6 同步改成整文件例外 + §影响面 spike C / §Phase E.1 / E.3 narrative reference 同步;lead 实测 fix 后命令 0 残留 + sanity test fake `out/main` + `release/mac-arm64` 仍 catch ✅
- **HIGH-2 (claude) + LOW-1x (codex)** ✅ fix:plan §影响面 spike A 标题 L86 + spike1 标题 L116 仍写 "electron-vite outDir 4 入口" 与 §不变量 1 fix「3 入口 + electron-builder × 1」漂移 → L86 / L116 改成 "outDir 3 入口"

R2 单方 MED ✅ 必修(lead 验证后确认):
- **MED-1 (claude)** ✅ fix:R2 prompt template L317 `reply_to_message_id` 错误指令(让 reviewer reply 挂 R1 自己 reply chain 上会让 conversation 看 R2 reply 挂错位置变 self-replied loop)→ 改成 "reply_to_message_id 用本 R2 prompt 自己的 messageId(从 wire prefix [msg <id>] 提取)" + 删除 R1 hardcode messageId
- **MED-2 (claude)** ✅ fix:§不变量 8 缺 Phase enforcement → Phase F.0 加 enforcement step「接力会话补 fix 必跑对应 pnpm 命令,不积累多 fix」;§不变量 5 (hard cutover 老 .app break) 已在 §F.6 user 自跑 .app 重装 6 步隐式 enforce 不补

R2 单方 LOW ✅ 轻量 fix:
- **LOW-1 (claude)** ✅ fix:R2 prompt template scope L292 placeholder `<新 invocation-id>/<sha8>` → 加注脚说明 "**不**走 deep-review SKILL 自动 cp,接力会话 lead 手动 cp + manifest"(本 plan R2 invocation `fd973276` 是手动 cp 模式,与 R1 invocation `3ec322b2` 同款)
- **LOW-2 (claude)** ✅ fix:cold-start ⏳ trace 不及时(没区分 R2 待启动 vs 已发 prompt 等 reply)→ §当前进度 把当前 ⏳ entry 改成 🔄 in flight + 显式标 "R2 prompt 已发 + R2 reply 已收双方 + R2 三态裁决进行中"

R2 整体:6+1 finding(claude 6 + codex 3 - 2 overlap + lead 自检 1),100% 真问题(0 反驳)。R3 评估:R2 finding 全 ✅ fix + 0 反驳 + 0 新 HIGH 边界条件 → **不需 R3**,直接进 Phase F 全套验证 + Phase G mixed deep-review 一并 sanity check 任何遗留。

### §Step 1.5 R3 mixed finding fix 摘要(2026-05-26 R3 接力会话,Phase G Step 5)

R3 invocation `ec60550b`,kind='mixed'(scope = Phase A-E config + doc 改动 post R1+R2 fix + 本 plan 跨文件一致性 final sanity)。

R3 双方独立 ✅ 必修(双方独立异构强冗余即算验证):
- **claude LOW-1 + codex LOW-2x** ✅ fix:§下一会话第一步 ⏳ entry stale + R2 prompt template 60 行 inline + 接力起点 L274 仍写 R2(R2 已完成 R3 进行中)→ §当前接力起点 全部 update 反映 R3 进行中 → Phase H 收口路径;R2 prompt template 移到 §历史 prompt template 节(`<details>` collapse,不再 reuse,作 future plan 流程 reference)

R3 单方 HIGH ✅ lead 验证后必修(2 个):
- **claude HIGH-1** ✅ fix:§当前进度 prematurely 写 "R3 评估**不需**" 与 R3 进行中自相矛盾(我刚 fix R2 时下了判断又转头跑 R3)→ §当前进度 R2 完成 entry 删 "R3 评估不需",改成 R3 in_progress + R3 完成后续 R4 评估不需 / Phase H 收口
- **claude HIGH-2** ✅ fix:§Phase F.6 6 步 vs CLAUDE.md §打包与本地安装 5 步差异未注明(F.6 不含 `ln -sf wrapper` 不含 `pnpm dist` — 因 F.6 是 .app dog-fooding scope 假设 F.4 已跑,不验证 wrapper CLI 入口)→ §F.6 顶部加 cross-reference 注释明示「与 CLAUDE.md §打包与本地安装 5 步关系」+ 明示 scope 差异理由

R3 单方 MED ✅ 必修(2 个):
- **claude MED-1** ✅ fix:§Phase F.5 grep `--exclude` 列含冗余项 `resources/claude-config/CLAUDE.md`(scan paths 本不含该文件,exclude 列冗余)→ 删冗余 + 加注 "`resources/claude-config/CLAUDE.md` 整文件不在 scan range 因为 plan §不变量 6 例外明确该文件 narrative-only"
- **claude MED-2 *未验证* 自降 LOW** ✅ fix:§Phase F.3 vitest 69 fail "全部 pre-existing electron binary 缺失" claim 未在 plan 内提供 evidence link → §F.3 加 4 条 evidence:① 错误栈 root cause 路径 ② lead 自检 binary 实测 ls + cat ③ R3 reviewer-codex 独立复核 ④ git log 该文件无本 plan commit

R3 单方 LOW ✅ 必修(1 个):
- **codex LOW-1x** ✅ fix:§Phase Spike 综合结论 L137 "Phase C-E 仍未做(留作后续实施)" 与 L213 "Phase A-E 同步完成(commit 7bc4c07)" 跨段矛盾 → 改成 "Phase C-E 已在 §Step 1.5 finding fix 全部完成"

R3 INFO 验证(无需 fix):
- **claude INFO-1** ✅ verified:R1 + R2 fix 跨文件全 ✅ 真落地(scope 8 文件全部对齐 plan 不变量 1-10,无 typo / 漂移 / 字符差异)
- **claude INFO-2** ✅ verified:tally.md P26 chunk hash narrative 是 REVIEW_25 frozen-in-time 历史 incident 记录,不需更新(vite chunk hash 每次 build 变化是预期行为)
- **claude INFO-3** ✅ verified:electron-builder files glob 与 mandatory auto include 边界 OK(整 build/ + 排除 build/dist + resources/ + 默认 package.json + node_modules/ 覆盖完整)
- **codex 非 finding 验证** ✅:electron.vite.config.ts 3 outDir 正确;package.json main/directories/files 与不变量一致;F.5 命令实测无输出;asar 内部含 /build/{main,preload,renderer} 不含 /build/dist;F.3 vitest 69 fail 独立复核确认 pre-existing electron binary 与本 plan 0 关系;tally.md P26 chunk hash 历史 incident 示例不构成 stale

R3 整体:7 finding(claude 5 + codex 2 — 2 双方独立 overlap = LOW-1/LOW-2x 同款),100% 真问题(0 反驳)。**R4 评估不需**:R1+R2+R3 跨文件 INFO-1 verified 全 ✅;R3 finding 全是 plan narrative trace 漂移(无新 HIGH 边界条件 / 无 code/config bug);**直接进 Phase H 收口** + Phase I post-archive。

## 下一会话第一步(cold-start 接力指令)

> ⚠️ 本 plan 由首会话(已耗 context ≥ 60% 跑完 ref-layout 17 commit + R1+R2 deep-review)写出。新会话 cold-start 时按 §当前进度 接力 — **找最近一个 ⏳ entry 就是接力起点**(不要从头跑)。

> 📜 **2026-05-26 接力会话 user 授权**（context: spike 完成 + Step 1.5 R1 已 spawn 两 reviewer 等 reply 时 user 说「你一路推进,自己决定 hand off 时机」）:
> - **接力会话 lead 全权决定 hand off 时机**(不需逐 phase 请求 user 确认)
> - **隐含 G-manual 路径授权**(user 之前已确认避开 dog-fooding 死锁;若 archive_plan tool 撞 precheck fail 走 §Step 4 5 步手工归档兜底,而非 plan in-place dog-fooding)
> - **隐含 spike5 .app 重启 + Phase F.6 .app verify 留 user 自验证**(收口前 lead 不主动 kill 当前 .app)
> - hand off 后下一会话 cold-start 第一步仍按下面 cold-start 步骤走

### Cold-start 5 步(标准接力流程)

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/build-dir-migration-20260526.md`(全文)
2. 读 §当前进度,找最近一个 ⏳ entry — 就是接力起点
3. EnterWorktree(builtin) `path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/build-dir-migration-20260526`(避 v2.1.112 stale base bug,worktree 已存在不要再 git worktree add)
4. `git log --oneline -3` 自检 HEAD 含本 plan 的 commit 历史
5. 按 §当前进度 ⏳ 起点对应 §Phase 章节实施,每完成一 Phase / Step 在本 plan 文件 `- [ ]` 打勾 + commit 进度

### 当前接力起点(2026-05-26 R3 接力会话 R3 fix 完成 + Phase H 开始)

- ✅ §Step 1.5 R3 mixed deep-review 完成:R3 invocation `ec60550b`,reviewer pair 复用同 team `build-dir-r1`;R3 finding 全 ✅ fix(详 §Step 1.5 R3 finding fix 摘要 callout)
- ✅ R4 评估**不需**(R1+R2+R3 跨文件 INFO-1 verified 全 ✅;R3 finding 全是 plan narrative trace 漂移,代码 + config + src 注释本质完全正确)
- ⏳ **§Phase H 收口**:H.-1 commit Phase A-G tracked 改动(不含 plan 文件 .claude/plans/ 被忽略)→ H.0 worktree clean gate → H.1 ExitWorktree(action: "keep")→ H.2.0 算 X → H.2/3 changelog + commit → H.4 ff-merge → H.5 mv plan + frontmatter update + sync INDEX + commit → H.6 worktree remove + branch -D → H.7 shutdown_baton_teammates(escape hatch 补跑 baton-cleanup phase 1)
- ⏳ **§Phase I post-archive 真验证**:I.1-I.5 fs/git verify + I.6 通知 user 走 §Phase F.6 自验证(spike5 .app 重装 + spike2 pnpm dev)

### 历史 prompt template(R1/R2/R3 已 finished — 仅留 reference 不再 reuse)

R1+R2+R3 已 finished(0 反驳 + 0 新 HIGH 边界条件 → 无 R4)。本节保留 R2 prompt template 仅作未来类似 plan 流程参考(reviewer pair 复用 + send_message + reply_to_message_id 语义示范),**本 plan 接力会话不再 reuse 该 template**(R3 finding fix 完即进 Phase H 收口)。

<details>
<summary>R2 prompt template (kind='plan' Round 2 focus,reviewer-claude 与 reviewer-codex 同 prompt 异构)— 已 finished,仅 reference</summary>

接力会话 cold-start 后,**hand_off_session 已 adopt_teammates 接管 build-dir-r1 team** → 直接 send_message R2 prompt(同 team active member,不需 spawn 新 reviewer)。

```
output_mode: full_review (Round 2)

scope (与 R1 同 — 但本轮 review post finding fix 状态):
- /Users/apple/Repository/personal/agent-deck/.claude/worktrees/build-dir-migration-20260526/.deep-review-cache/<新 invocation-id>/<sha8>-build-dir-migration-20260526.md (R2 重 cp 更新版)
- /Users/apple/Repository/personal/agent-deck/.claude/worktrees/build-dir-migration-20260526/electron.vite.config.ts
- /Users/apple/Repository/personal/agent-deck/.claude/worktrees/build-dir-migration-20260526/package.json
- /Users/apple/Repository/personal/agent-deck/.claude/worktrees/build-dir-migration-20260526/.gitignore
- /Users/apple/Repository/personal/agent-deck/.claude/worktrees/build-dir-migration-20260526/src/main/window.ts (Phase C 改后)
- /Users/apple/Repository/personal/agent-deck/.claude/worktrees/build-dir-migration-20260526/ref/conventions/tally.md (Phase E 改后)
- /Users/apple/Repository/personal/agent-deck/.claude/worktrees/build-dir-migration-20260526/README.md (Phase E 改后)
- /Users/apple/Repository/personal/agent-deck/.claude/worktrees/build-dir-migration-20260526/CLAUDE.md (Phase E 改后)

**placeholder 展开**(本 plan **不**走 deep-review SKILL 自动 cp,接力会话 lead 手动 cp + manifest):① 生成 8-char hex `INV=$(openssl rand -hex 4)` ② `mkdir -p .deep-review-cache/$INV` ③ 为每个 scope 文件 `SHA8=$(shasum -a 256 <file> | cut -c1-8)` 后 `cp <file> .deep-review-cache/$INV/${SHA8}-$(basename <file>)` ④ 写 manifest.json `{invocationId, createdAt, files: [{origAbspath, cachePath}]}`(与 R1 invocation 3ec322b2 / R2 invocation fd973276 / R3 invocation ec60550b manifest 结构同款)

context: 
- R1 finding fix 全部 commit (commit 7bc4c07 feat(build-dir): migrate build artifacts to build/ canonical (Phase A-E))
- R1 finding 12+3 全部 ✅ fix (详 plan §当前进度 §Step 1.5 finding fix 摘要 callout)
- 本轮 R2 focus: 验证 R1 finding fix 是否真修好 + 边界条件 / 不变量边界 / 跨 phase 设计漂移挖深

skip (R1 fix 已修): 略,详 R1 finding fix 摘要

focus (R2 重点): 略,详 R2 完成后实际 reply 内容

请按 reviewer body 协议输出 R2 finding (统一 HIGH/MED/LOW/INFO 分组 + *未验证* 标签 + 文件:行号 + 验证手段);reply 走 mcp__agent-deck__send_message + **reply_to_message_id 用本 R2 prompt 自己的 messageId**(从本 message wire prefix `[msg <id>]` 提取,**不**用 R1 自己 reply 的 messageId — Agent Deck send_message 协议 reply_to_message_id 语义是「我这条 reply 针对的是 caller 这条 message」,挂错位置会让 lead conversation 看 R2 reply 挂到 R1 reply chain 下面变 self-replied loop)。
```

</details>

## 已知踩坑 / 风险

- **electron-vite dev mode 与 outDir 关系**:dev 模式 main + preload 内部 build 后 launch,outDir 改后 dev mode 行为变更需 spike2 验证
- **electron-builder ASAR / asarUnpack 路径**:某些 dep(better-sqlite3 binding / claude SDK 子进程二进制)需 asarUnpack 显式标注;改 outDir 后 asarUnpack 配置可能需同步(spike3 / spike4 验证)
- **macOS 已装 .app 重装风险**:`/Applications/Agent Deck.app` 含运行中实例;按 user CLAUDE 项目根 §macOS 5 步打包必做 pkill 旧进程 + ad-hoc 重签
- **better-sqlite3 binding ABI 风险**(已收纳 CLAUDE):`pnpm exec vitest run src/main/store/__tests__/task-repo.test.ts` 触发 prebuild-install 覆盖 Electron 33 ABI 的 binding;本 plan 不动 SQLite 测试,但 F.3 跑全 vitest 时仍需小心
- **spike 失败回滚**:每个 spike 改完 config 跑 pnpm 命令,失败 → revert config 改回 `out/` 默认 + 在 plan §已知踩坑 标注「electron-vite/builder X 行为与预期不符」+ plan 重写设计决策

## 关联

- **触发**:user 指令「build 相关的内容要放到 build/ 目录下」(本会话 ref-layout-full-migration plan 收口后)
- **上轮 plan**:ref-layout-full-migration-20260526(本会话 commit `eb379b6` merge + `5f8dfa4` archive),挪 user CLAUDE §新项目工程地基 §src/build 节到应用打包 CLAUDE.md,顺势本 plan 实施 §src/build canonical
- **changelog 关联**:本 plan 完成后写 `ref/changelogs/CHANGELOG_<X>.md`(X 待定,本 plan §Phase H.2.0 步骤算)
