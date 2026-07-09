# CHANGELOG_154: build-dir-migration-20260526 plan 收口

## 概要

把 agent-deck 项目所有 build 产物统一收纳到 `build/` 根出口下(electron-vite outDir 3 入口 → `build/main` + `build/preload` + `build/renderer`;electron-builder output → `build/dist`),对齐应用打包 CLAUDE.md §src/build canonical 标准(ref-layout-full-migration plan CHANGELOG_153 把 §新项目工程地基 挪到应用打包 CLAUDE.md 后顺势 retro 落地本项目)。impl 硬切 `build/`(不留任何 `out/ release/` fallback / migration helper),同步改 3 config + 4 doc/src 自描述文件 + `.gitignore` 加 `build/` 删 `out/release/dist` 单数 entry。

deep-review × 3 轮(reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 异构对抗)共 22 finding fix loop 收敛:R1 12+3 (Phase A-E 落地 + 同步 doc) / R2 6+3 (R1 fix 验证 + plan narrative 边界) / R3 5+2 mixed (跨文件 INFO-1 verified 全 ✅ + plan trace 漂移收口 + cosmetic exclude list 冗余)。**0 反驳 + 0 新 HIGH 边界条件** — 代码 + config + src 注释本质完全正确,所有 finding 都是 plan narrative trace 漂移 / cosmetic 项。

Phase F 全套验证:typecheck ✅ + build ✅ (3 bundle 落 `build/{main,preload,renderer}/`) + vitest ⚠ partial (665 passed,69 pre-existing electron binary 缺失 fail 与本 plan 0 关系) + dist ✅ (DMG 254.9 MB + `.app` 落 `build/dist/mac-arm64/`) + grep 0 残留 ✅。dog-fooding spike5 .app 重装 + spike2 `pnpm dev` 留 user 自验证(lead 严禁自跑步骤 ① pkill 避 .app SDK 子进程 cascade kill)。

**MCP 协议无 breaking** — 本 plan 改的是 build artifact 落地路径,不影响 MCP tool 接口 / fallback 链 / archive_plan / hand_off_session 任何字段。

## 变更内容

### Phase A — electron-vite outDir 3 入口(`electron.vite.config.ts`)

- `main.build.outDir: 'build/main'` / `preload.build.outDir: 'build/preload'` / `renderer.build.outDir: 'build/renderer'` 3 入口显式 outDir(不依赖工具默认 `out/`,避工具升级时 default 值变更影响产物落点)
- spike1 实测 `pnpm build` 产物落 `build/{main,preload,renderer}/`,0 残留 `out/`;renderer log 显示 `../../build/renderer/...` 是相对 `src/renderer/` 路径展示(实际 fs 落根 `build/renderer/`)
- spike2 dev mode 走 static reasoning 跳过实测(`.app` 进程占端口 47821/5173 → 自跑 = dog-fooding 自杀;留 user §F.6 自验证)

### Phase B — electron-builder directories.output + files glob + main 字段(`package.json`)

- `"main": "build/main/index.js"` 锁定 Electron 进程入口
- `directories.output: "build/dist"` 让 `pnpm dist` 产物落 `build/dist/` (`.dmg` + `.app` + blockmap)
- `files: ["build/**/*", "!build/dist/**", "resources/**/*"]` 整 `build/` + 排除 `build/dist` 防自引用;**不变量**:files 数组覆盖 electron-builder 默认 `["**/*"]`,但 `package.json` + 生产依赖 `node_modules/` 是 electron-builder mandatory auto include(不在 files override 控制范围内,spike4 asar 实测含 `/package.json` + `/node_modules/` 均 OK)
- spike3 实测:`build/dist/Agent Deck-0.1.0-arm64.dmg` (254.9 MB) + `build/dist/mac-arm64/Agent Deck.app` + blockmap 全部正确;`release/` 0 残留
- spike4 asar 内部实测:含 `/build/main/index.js` + `/build/main/transport-http-LPbIuJxi.js` + `/build/preload/index.js` + `/build/renderer/index.html` + `/build/renderer/assets/...`,不含 `/build/dist/...`(files glob 排除生效);extraResources `bin/{agent-deck, agent-deck.cmd}` + `claude-config/` + `codex-config/agent-deck-plugin/skills/{deep-review, flow-arch-plantuml, hello-from-deck}` + `sounds/` 全 copy;asar.unpacked 含 `@openai/codex` + `@anthropic-ai/claude-agent-sdk-darwin-arm64` native binary 正常 unpack

### Phase C — src/ 注释同步(`src/main/window.ts:22`)

- `dev 模式 __dirname 是 out/main/` → `dev 模式 __dirname 是 build/main/`(注释与 build outDir 行为对齐;Phase F.2 实测 `__dirname = build/main/` 注释正确)

### Phase D — `.gitignore` 改造(**提前到 finding fix 第一件**)

- 删 L2 `out` / L3 `release` / L4 `dist` 单数 dir entry
- 加 `build/` 整 build 子目录忽略(对齐应用 CLAUDE §新项目工程地基 §.gitignore canonical)
- **提前到 R1 finding fix 第一件**(reviewer-codex MED-2x 修法 + R2 LOW-2x 双修)避免 R2 / R3 review fix 期间 build/ 残留产物被 `git add` 误纳入
- `git check-ignore -v build/test.txt` 命中 `.gitignore:2:build/`;`git status --short` 干净无 `?? build/`

### Phase E — 项目根 docs + active convention 同步

- `README.md:107` `cp -R "release/mac-arm64/..."` → `cp -R "build/dist/mac-arm64/..."`
- `CLAUDE.md:210` `rm -rf release` → `rm -rf build/dist` + L214 `cp -R "release/mac-arm64/..."` → `cp -R "build/dist/mac-arm64/..."`
- `ref/conventions/tally.md:79` P26 entry 内 `out/main/*.js` × 2 处 chunk path + `agents-md-installer-cYcOGELy.js` chunk path 全改 `out/main/` → `build/main/`(R1 HIGH-1c reviewer-claude finding;chunk hash 部分是 REVIEW_25 frozen-in-time 历史快照,不追 build 后真 chunk hash 漂移 — R3 INFO-2 confirm)
- **故意保留**:`resources/claude-config/CLAUDE.md` 整文件(L390 + L408 两处 narrative 描述工具链默认 `out/` + `release/` 命名,是 narrative-only 应用打包模板,详 plan §不变量 6 例外;Phase F.5 grep gate 整文件 exclude scan range)

### Phase F — 全套验证

- F.0 **§不变量 8 enforcement**:Phase A-E 任何后续补 fix 改完立即跑对应 pnpm 命令实测产物落 `build/<sub>/`(不积累多 fix 一次 batch 跑,单点错误难定位)
- F.1 `pnpm typecheck` ✅
- F.2 `pnpm build` ✅ (3 bundle:`build/main/{index.js (750KB), transport-http-LPbIuJxi.js (3.7KB)}` + `build/preload/index.js (21.6KB)` + `build/renderer/{index.html, assets/index-q-8O80U5.css, assets/index-N2uTK-1O.js, assets/index-NMOQohSs.js (1.4MB)}`)
- F.3 `pnpm exec vitest run --exclude '**/task-repo.test.ts'` ⚠ partial (665 passed | 69 failed | 40 skipped):**全部 69 fail 为 pre-existing electron binary 缺失**(`Error: Electron failed to install correctly` getElectronPath node_modules/.pnpm/electron@33.4.11/node_modules/electron/index.js:17 — `dist/` + `path.txt` 都缺,`pnpm rebuild electron` 无效因 cache 已有 postinstall 跳过),failing test 全集中 `src/main/agent-deck-mcp/__tests__/tools.test.ts` 与本 plan 改动 0 关系;独立 fix 应走另一份 plan
- F.4 `pnpm dist` ✅ (DMG 254.9 MB + `.app` 落 `build/dist/mac-arm64/`;signing skip 是 pre-existing cert expired;better-sqlite3 native deps electron-builder 内部 rebuild 也跑过)
- F.5 grep 0 残留 ✅:`git grep -nE "out/(main|preload|renderer)|release/mac-arm64" -- src scripts README.md CLAUDE.md ref/conventions/ package.json electron.vite.config.ts .gitignore` 输出空(regex 边界精确不撞 `stdout/` `layout/` `timeout/` 普通词)
- F.6 dog-fooding 留 user 自验证(spike5 .app 重装 6 步 + spike2 `pnpm dev`;详 plan §F.6 cross-reference `CLAUDE.md §打包与本地安装` 5 步关系) — lead 严禁自跑步骤 ① `pkill "Agent Deck"` 避 .app SDK 子进程 cascade kill

### Phase G — Step 5 mixed deep-review × 3 轮 fix loop

- **R1 (kind='plan')**:reviewer-claude 12 finding (2 HIGH/5 MED/4 LOW/1 INFO) + reviewer-codex 3 finding (0 HIGH/2 MED/1 LOW),共 13 真 finding(2 overlap LOW)。覆盖 Phase A-E 落地准确性 + plan §不变量 6 例外边界 + `tally.md` P26 entry 内 chunk path 漂移 + `.gitignore` 提前到 finding fix 第一件 + Phase H.-1 commit step
- **R2 (kind='plan' post fix)**:reviewer-claude 6 finding (2 HIGH/2 MED/2 LOW) + reviewer-codex 3 finding (0 HIGH/1 MED/2 LOW),共 6+1 finding (2 overlap + lead 自检 1)。覆盖 R1 fix 验证 + Phase F.5 grep gate false positive (regex 撞 `stdout/` `layout/repaint` `Network timeout/` 5 处 + L390 narrative 漏标合法残留)+ plan §下一会话第一步 reply_to_message_id template threading 错 + §不变量 8 缺 Phase enforcement
- **R3 (kind='mixed' final sanity)**:reviewer-claude 5 finding (2 HIGH/2 MED/1 LOW + 3 INFO) + reviewer-codex 2 finding (0 HIGH/0 MED/2 LOW),共 7 finding (2 overlap LOW)。覆盖跨文件一致性 final check(**INFO-1 verified R1+R2 fix 跨 scope 8 文件全 ✅ 无 typo / 漂移**)+ plan narrative trace 漂移(§当前进度 prematurely 写 "R3 不需" / §Phase F.6 vs CLAUDE.md §打包 step 差异未注明 / §下一会话第一步 ⏳ entry + R2 prompt template stale / spike 综合 "Phase C-E 仍未做" 矛盾)+ cosmetic exclude list 冗余(F.5 exclude 列含 scan range 之外的 `resources/claude-config/CLAUDE.md`)+ F.3 vitest pre-existing claim 加 evidence link
- **0 反驳 + 0 新 HIGH 边界条件 + 0 code/config bug** — 代码 + config + src 注释本质完全正确,所有 finding 都是 plan narrative trace 漂移 / cosmetic;R4 评估**不需** → 直接 Phase H 收口

### Phase Spike — 5 spike 实测(spike1+3+4 ✅ + spike2/spike5 [⚠ skipped] static reasoning)

- spike1 electron-vite outDir 3 入口 ✅ + spike3 electron-builder dist ✅ + spike4 asar / extraResources / wrapper 链路完整性 ✅:三 spike 都 inline 完成 Phase A + B 代码改动 + 0 残留 0 异常 verify
- spike2 dev mode + spike5 .app 重装 [⚠ skipped] static reasoning 跳过实测:端口 47821/5173 被 `/Applications/Agent Deck.app` 占用(user 在用 + lead session 跑在 .app SDK 子进程内 = 自杀风险);静态等价证明 + user 收口后必走 §F.6 自验证

## 改动文件统计

- **3 config**:`electron.vite.config.ts`(outDir 3 入口)+ `package.json`(main/directories/files)+ `.gitignore`(加 `build/` 删单数 entry)
- **4 doc/src**:`src/main/window.ts:22` 注释 + `README.md:107` + `CLAUDE.md:210/214` + `ref/conventions/tally.md:79` P26 entry
- **1 plan 主体**:`.claude/plans/build-dir-migration-20260526.md`(全程在 worktree 内被 `.gitignore` 忽略,Phase H.5 mv 入 `ref/plans/build-dir-migration-20260526.md`)
- **1 changelog**:`ref/changelogs/CHANGELOG_154.md`(本文)
- **commits**:`7bc4c07 feat(build-dir): migrate build artifacts to build/ canonical (Phase A-E)`(Phase A-E 落地)+ 本 changelog commit + Phase H archive commit
- **build artifact**(被 `.gitignore` 整 build/ 忽略不入 git):`build/main/` + `build/preload/` + `build/renderer/` + `build/dist/{Agent Deck-0.1.0-arm64.dmg, mac-arm64/Agent Deck.app}`

详 [`ref/plans/build-dir-migration-20260526.md`](../../plans/history/build-dir-migration-20260526.md)
