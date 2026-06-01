---
plan_id: "sqlite-tests-no-skip-20260601"
created_at: "2026-06-01"
status: "completed"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/sqlite-tests-no-skip-20260601"
base_commit: "8302aa8106967f050d4b4ef12b02bcbe77573468"
base_branch: "main"
final_commit: "29e5db33ad26914b068c868044349c78a5e250ff"
completed_at: "2026-06-01"
---
# 让 SQLite 单测「真跑不 skip」+ 修 4 个真失败文件

## 总目标

用户要求:**所有单元测试真跑通,不要 skip**。当前 `pnpm test`(系统 node v24 / ABI 137)下 better-sqlite3 ABI-130 Electron binding 加载失败 → 12 个文件 `skipIf(!bindingAvailable)` 全 skip(200 用例)+ 16 个环境 gate skip = 216 skip。同时有 4 个 test 文件存在真 bug(与 ABI 无关),即使 binding 能加载也挂。

**两层都要解**:
1. **(a) 让 vitest 能加载 ABI-130 binding** → 方案 A:`pnpm test` 默认走 Electron-as-node(用现装 binding,零 swap 零 corruption)
2. **(b) 修 4 个真失败 test 文件**(全是 test-side bug,生产代码全对)

## 不变量(必须满足,任一违反即回退)

1. **🔴 binding byte-identical**:现装 `better_sqlite3.node` 是 ABI-130 Electron(md5 `64beb2ef045af83e20a5294908f30f70`)。本 plan **全程不 swap binding**(方案 A 用现装 binding 原地加载)。任何阶段结束 md5 必须不变。
2. **生产代码不动**:4 个失败全是 test-side bug + 1 处测试基础设施(probe / wrapper)。`src/main/store/**` `src/main/agent-deck-mcp/**` `src/main/adapters/**` 的**生产 .ts 一律不改**(只改 `__tests__/` + `vitest-setup.ts` + `package.json` + 新增 `scripts/test-electron.mjs`)。
3. **app 仍能启动**:binding 没被破坏(`pnpm dev` / 已装 .app bootstrap 不报 NODE_MODULE_VERSION)。
4. **skip 守门保留**(用户 Q2 决策):12 个 `skipIf(!bindingAvailable)` 守门作安全网保留,binding 恒可用后它们恒为 false(不 skip);probe 失败时改 loud warn 提示「用错 runtime」。
5. **目标命令 0 fail + 仅剩真正环境无关 skip**(**on darwin-arm64 本机执行环境** — deep-review R1 claude LOW-1):`pnpm test`(走 Electron-as-node)→ 0 fail;skip 数从 216 降到 0(16 个环境 gate skip 也一并消除:codex-binary-layout 15 个修 `process.resourcesPath` 后真跑 + hand-off it.skip 1 个 un-skip)。
   - **跨平台限定**:codex-binary-layout 15 个是 `it.runIf(isDarwinArm64)` 平台门控(`isDarwinArm64 = darwin && arm64`,与 D7 resourcesPath 修复**正交**)。非 darwin-arm64(Linux/x64)上即便修了 D7,这 15 个仍按 runIf skip — 不算违反本不变量。本机 = darwin-arm64,故「0 skip」本机成立。

## 设计决策(不再争论)

### D1. 方案 A:`pnpm test` 默认走 Electron-as-node(RFC Q1 + Step 0.5 spike 实证)

- **机制**:`ELECTRON_RUN_AS_NODE=1 <electron 二进制> node_modules/vitest/vitest.mjs run`。Electron 内置 node = v20.18.3 / **ABI 130**,正好匹配现装 Electron binding → 加载成功。
- **spike 铁证**(全程 binding md5 恒 `64beb2ef...`):
  - 全套 **1485 passed**(原 216 skip 塌成 16,详 §验证 baseline 表)
  - ABI-130 binding 在该模式真加载真跑 SQL:`LOAD OK, select={x:1}`
  - `process.versions.modules === 130`(实测)
- **方案 B 被否决**:better-sqlite3@11.10.0 `lib/database.js:48` 用 `require('bindings')('better_sqlite3.node')` → `bindings` 包只认 `build/Release/` 单槽,**不扫 `prebuilds/` 多 ABI 目录**。populate prebuilds/ 无效,除非 vendor 自定义 loader(太重)。(spike 实证:`grep require lib/database.js`)
- **可移植 wrapper**:新增 `scripts/test-electron.mjs`,用 `createRequire(import.meta.url)` + `require('electron')` 拿二进制路径(`require('electron')` 返回 string 路径,实证)。
- **🔴 wrapper 必备契约**(deep-review R1 双方独立提出 codex MED-1 + claude MED-2 ✅ 必修 — snippet 漏这两项会 ENOBUFS + 假绿退出码):
  ```js
  const res = spawnSync(electronPath, ['node_modules/vitest/vitest.mjs', 'run', ...args], {
    stdio: 'inherit',                                    // ← 必须:否则 vitest 输出 pipe 进内存(大输出 ENOBUFS)+ 终端哑巴
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (res.error) { console.error(res.error); process.exit(1); }  // spawn 自身失败(二进制缺失等)
  process.exit(res.status ?? 1);                          // ← 必须:status=null(signal 终止)按 1;否则 wrapper 恒退出 0 → 假绿
  ```
  - **stdio:'inherit'**:让 vitest 输出直达终端(spawnSync 默认 pipe→内存,大输出撞 ENOBUFS 截断,codex 实测 ~1.1MiB 即截);
  - **process.exit(res.status ?? 1)**:wrapper 是 `pnpm test` 唯一退出码来源,不透传则恒 0 → 任何后续 test 挂都假绿(本仓库无 CI,靠人工 Step 9 肉眼看 vitest "X failed" 兜底,blast radius 受限故 MED 非 HIGH,但必修防 latent);
  - **res.error 兜底**:spawn 自身失败(electron 二进制缺失)时 `res.status` 为 null,需显式 console.error + exit 1。
- **关键位置**:wrapper 必须放 repo 内 `scripts/`(放 /tmp 会 `MODULE_NOT_FOUND` —— `createRequire` 从脚本所在位置解析 electron,spike 实证两种位置差异)。

### D2. package.json scripts 改法(D1 落地)

- `"test": "node scripts/test-electron.mjs"` —— 默认走 Electron-as-node(0 binding-skip)
- `"test:node": "vitest run"` —— 保留系统 node 快速变体(非 SQLite 测试快速迭代用;SQLite 测试在此变体下仍优雅 skip)
- `"test:watch"` 保留现状(`vitest`,系统 node watch)
- **不动** `typecheck` / `dist` / 其他 scripts

### D3. probe loud warn + 收敛到一处(RFC Q2 + 提示词资产「信息密度」)

- probe `probeBetterSqliteBinding` 当前**重复 6 个定义点**(2 个 `_setup.ts` + 4 个 inline:v023/v024/v025-migration + repo-tiebreaker)。
- **收敛**:新建 `src/main/store/__tests__/_binding-probe.ts` 单一 SSOT export `bindingAvailable` + probe 实现。
- **🔴 改 import 分两类(deep-review R1 claude MED-1 ✅ 必修 — 不分类会 typecheck 挂)**:
  - **4 个 inline**(`const bindingAvailable = probeBetterSqliteBinding()` 本地自用,不 export,实证 v023:54/v024:63/v025:78/repo-tiebreaker:75)→ 直接换成 `import { bindingAvailable } from '<rel>/_binding-probe'`,干净无副作用。
  - **2 个 _setup.ts**(`export const bindingAvailable`)→ 改 import **并必须 re-export** `export { bindingAvailable } from '<rel>/_binding-probe'`(或 `import` 后 `export { bindingAvailable }`),否则下游 **8 个 consumer** 的 `import { bindingAvailable } from './_setup'` 全报「not exported」→ test 挂违反不变量 5。
  - **8 个下游 consumer**(0 改动,靠 _setup re-export):
    - `agent-deck-repos/_setup.ts` 的 7 个:`rejoin-after-soft-exit` / `issue-repo` / `agent-deck-team-repo` / `task-repo` / `agent-deck-message-repo` / `agent-deck-team-repo.swap-lead`(store/__tests__/)+ `dormant-teammate-shutdown`(agent-deck-mcp/__tests__/)
    - `session-repo/__tests__/_setup.ts` 的 1 个:`cwd-release-marker`
- **loud warn**:probe 失败时 `console.error`(非 warn)提示「**用错 runtime**:SQLite 单测需 ABI-130 binding。跑 `pnpm test`(Electron-as-node)而非 `pnpm test:node`(系统 node ABI 不匹配)」,让安全网兜底时明确告诉开发者怎么修。
- skip 守门(`describe.skipIf(!bindingAvailable)`)**全保留**(用户 Q2:作安全网)。binding 恒可用后恒为 false。

### D4. 修 cwd-release-marker(4 fail)——补 session-repo `_setup.ts` migration 到 v026

- **根因**(spike 实证 exact error):session-repo `_setup.ts` 只载 v001-v020,但:
  - `core-crud.ts upsert` 写 `cli_session_id`(v021)→ `table sessions has no column named cli_session_id`(TC1c)
  - `rename.ts:99` INSERT 含 `cli_session_id`(v021)→ 同错(TC2b INSERT 分支)
  - `rename.ts:193` UPDATE `tasks.owner_session_id`(v023)→ `no such column: owner_session_id`(TC2b UPDATE 分支)
- **修法**:给 `src/main/store/session-repo/__tests__/_setup.ts` 补 v021-v026 import + 加进 makeMemoryDb 循环。对齐 `agent-deck-repos/_setup.ts`(已到 v026)。
- **安全性**:只 `cwd-release-marker.test.ts` import 此 _setup(`archive.test.ts` 不 import,实证),改动 contained。v021-v026 中仅 v023 `DROP TABLE tasks` 在 fresh in-memory DB 安全(DROP IF EXISTS + 重建)。
- **不改 `rename.ts` / `core-crud.ts`**(生产代码正确,只是测试 fixture 缺列)。

### D5. 修 task-repo(2 fail)——test spy 从 console.warn 改 logger spy

- **根因**(spike 实证):test(`task-repo.test.ts:513,534`)spy `console.warn`,但代码 `_deps.ts:53/56` 用 `logger.warn`(`log.scope('task-repo-deps')`,vitest-setup.ts:236 把 `electron-log/main` 的 `log.scope` mock 成按 name 缓存的 no-op `vi.fn()`)。354 console→logger 迁移后留下的 stale 断言。
- **修法(deep-review R1 双方 INFO 收敛到 path-a — 复用现有 log.scope spy 模式)**:test 改为断言 `log.scope('task-repo-deps').warn` 被调:
  ```ts
  import log from 'electron-log/main';   // vitest-setup 已 mock,log.scope 返缓存 vi.fn
  // ...
  const warnSpy = log.scope('task-repo-deps').warn as ReturnType<typeof vi.fn>;
  // 断言: expect(warnSpy).toHaveBeenCalled()
  ```
  - **🔴 scope name 必须精确 `'task-repo-deps'`**(与 `_deps.ts:23` 一致):typo 成别名 → 拿到另一 cache 实例 → `toHaveBeenCalled` 永远 false 假绿(claude LOW-2 提醒)。
  - reference 实证:`src/main/utils/__tests__/user-shell-path.test.ts:36-41` 已用同款 `import log from 'electron-log/main'; log.scope(...)` 模式。
  - 保留「损坏数据要 warn」契约验证(不退化成纯行为断言,保住脏数据可观测性回归保护)。
- **不改 `_deps.ts`**(生产代码 logger.warn 是迁移正确结果)。

### D6. 修 v023-migration(1 fail)——改幂等断言

- **根因**(spike 实证):test(`v023-migration.test.ts:230`)`expect(() => db.exec(v023)).toThrow(/already exists/i)`,但 v023 SQL 开头 `DROP TABLE IF EXISTS tasks`(L34)→ 重跑先 DROP 再 CREATE,**永不抛** already exists。test 断言与 SQL 行为矛盾。
- **修法(deep-review R1 codex LOW-1 — 避免「数据幂等」假不变量)**:重跑 v023 不是**数据**幂等(它 `DROP TABLE IF EXISTS` 会清空有数据的 tasks),而是**契约**幂等(重跑匹配 destructive DROP+CREATE 不抛 + schema 仍正确)。改断言为:
  - describe/it title 从「重复跑 v023 应抛错」改为「重复执行匹配 destructive DROP+CREATE 契约(不抛 + 重建空表)」
  - 断言:先插一条 task → 重跑 v023 → `expect(() => db.exec(v023)).not.toThrow()` + 显式断言 tasks 被清空(`COUNT(*)===0`)+ schema 列仍正确。明示 destructive rerun 语义,不留「可保数据」误导。
- **不改 v023 SQL**(生产 migration 行为正确:migration runner 不会重复跑同 version,DROP IF EXISTS 是防御性兜底)。

### D7. 修 codex-binary-layout(suite fail,仅 Electron-as-node 下暴露)——process.resourcesPath 用 defineProperty

- **根因**(spike 实证 exact error):`codex-binary-layout.test.ts:57,62` 在 `beforeAll`/`afterAll` 直接赋值 `process.resourcesPath = ...`。系统 node 下该属性 undefined(可随意赋值)→ 15 pass;但 **Electron 把 `process.resourcesPath` 设为 read-only**(`writable:false, configurable:true`,实证 descriptor)→ `TypeError: Cannot assign to read only property 'resourcesPath'` → 整个 suite fail(15 个 `it.runIf(isDarwinArm64)` 全被标 skip)。
- **修法**:`beforeAll`/`afterAll` 改用 `Object.defineProperty(process, 'resourcesPath', { value, configurable: true, writable: true })`。spike 实证两 runtime 都 work(node 下 descriptor undefined 也能 defineProperty;Electron 下 configurable:true 允许重定义 + 可还原)。
- **还原**:`afterAll` 用 defineProperty 还原 `originalResourcesPath`(若原 undefined 则 `delete process.resourcesPath` 或定义回 undefined)。
- **不改生产代码**(`resolveBundledCodexBinary` 读 `process.resourcesPath` 正常)。

### D8. un-skip hand-off-session.impl-core it.skip(1 skip)(RFC Q3)——重写为当前 worktreeExists 契约

- **根因**:`hand-off-session.impl-core.test.ts:323` 的 `it.skip`。REVIEW_56 Batch B 把 `handOffSessionImpl` 改为**不再 hard-reject** worktree 不存在,改返结构化 `worktreeExists: false` flag 让 handler 决策(`hand-off-session-impl.ts:125,297,346` 实证)。test 仍按旧 hard-reject 期望写 → skip。
- **修法**:重写该 test 断言当前契约:
  - `result` 是 **resolved**(非 error):`_isHandOffSessionError(result) === false`
  - `result.worktreeExists === false`
  - `result.worktreePath === worktreePath`(仍正确解析)
  - 去掉旧的 `err.error.toContain('worktreePath does not exist')` / `err.hint.toContain('git worktree add')` 断言(那是已废弃的 hard-reject 行为)
- 改 `it.skip` → `it`,更新 describe/it 注释说明从 hard-reject 改为 worktreeExists flag 的契约迁移。
- **风险**:需确认 `makeState`/`makeDeps`/`missingWorktree` 测试 fixture 在 worktreeExists=false 路径下行为(deep-review R1 claude 已实证 fixture **支持**:相邻未 skip 的 `impl-core.test.ts:354`「worktreePath 存在→resolved」已用 `_isHandOffSessionError===false`+`ok.worktreePath` 同款 pattern,`state.missingWorktree=true` 能干净表达「不存在」)。若 fixture 仍阻塞 → 降级保留 it.skip + plan 注明(用户 Q3 是「尝试」un-skip,fixture 阻塞时不强行)。

### D8b. handler/cwd-resolver worktreeExists 决策树补测(deep-review R1 codex MED-2 ✅ 必修)

- **根因**:D8 只测 impl 层 `worktreeExists` flag,但真实契约的决策树在 **handler 层** `validatePlanModeWorktreeExists`(`src/main/agent-deck-mcp/tools/handlers/hand-off-session/cwd-resolver.ts:184`,现场验证函数存在)。该函数 3 个 reject/warn 分支**无任何专属 test**(`grep worktreeExists src/main/agent-deck-mcp/__tests__` 只命中 impl-core.test.ts)。只测 impl flag 防不住 `finalCwd=worktreePath` 继续 spawn ENOENT / 外置 worktree 误放行。
- **修法**:新增(或在现有 hand-off-session 测试文件加)cwd-resolver 决策树 3 case:
  1. **missing conventional worktree(mainRepo subtree)+ finalCwd=mainRepo** → 返 `null`(放行)+ logger.warn(让 cold-start 自建)
  2. **missing + finalCwd=worktreePath** → 返 `{result: err(...)}` hard reject(reason: ENOENT inevitable)
  3. **missing external worktree(非 mainRepo subtree)** → 返 `{result: err(...)}` hard reject(reason: 父目录也不存在无法自建)
  - 可选第 4 case:`finalCwd` 在 mainRepo 外(如 /tmp)但 isInternalWorktree=true → hard reject(CHANGELOG_169 F3 `finalCwdInMainRepo` 校验,cwd-resolver.ts:195-201)
- **不改生产代码**(`validatePlanModeWorktreeExists` 行为正确,只是缺 test 覆盖)。
- **范围注**:此为 D8 顺手补的测试盲区,与「让 SQLite 真跑」主线正交但同属「测试质量」收口,纳入本 plan(避免单独开 follow-up)。

## 步骤 checklist

- [x] Step 1 — 新增 `scripts/test-electron.mjs` 可移植 wrapper(D1)— done，wrapper + exit code 透传实测 fail→1/pass→0
- [x] Step 2 — 改 `package.json` scripts:test / test:node(D2)— done
- [x] Step 3 — 新建 `src/main/store/__tests__/_binding-probe.ts` SSOT + loud error,6 处 probe 收敛 import + 2 _setup re-export(D3)— done
- [x] Step 4 — 补 session-repo `_setup.ts` v021-v026(D4)→ 修 cwd-release-marker 4 fail — done(+ 顺手修 TC2b 边角 stale 断言,详 §实施新增发现)
- [x] Step 5 — 修 task-repo.test.ts logger.warn 断言(D5)→ 修 2 fail — done(log.scope('task-repo-deps').warn spy)
- [x] Step 6 — 修 v023-migration.test.ts 幂等断言(D6)→ 修 1 fail — done(destructive DROP+CREATE 契约)
- [x] Step 7 — 修 codex-binary-layout.test.ts process.resourcesPath defineProperty(D7)→ 修 suite fail — done(两 runtime 各 15 pass)
- [x] Step 8 — un-skip hand-off-session.impl-core it.skip 重写(D8)→ 1 skip — done(改 worktreeExists flag 契约)
- [x] Step 8b — 补 cwd-resolver `validatePlanModeWorktreeExists` 决策树 case 测试(D8b,codex MED-2)— done(新建 hand-off-session.cwd-resolver-worktree.test.ts 7 case)
- [x] Step 9 — 全套验证 — done:`pnpm test`(Electron-as-node)**1514 pass / 0 fail / 0 skip** + exit 0 / `pnpm typecheck` 双配置绿 / **binding md5 恒 `64beb2ef...`** / `pnpm test:node` 1299 pass + 215 graceful skip + loud error / 真 Electron 加载 binding ABI-130 OK
- [x] Step 10 — REVIEW_97 + INDEX + archive_plan — REVIEW_97 写好 + INDEX 更新 + worktree commit 29e5db3，archive 进行中

## 验证(§验收标准)

### baseline 对照表(Step 0.5 spike 实测,全程 binding md5 恒 `64beb2ef...`)

| 运行方式 | Test Files | Tests |
|---|---|---|
| **今(`pnpm test`,系统 node ABI 137)** | 99 pass / 11 skip | 1292 pass / **216 skip** / 0 fail |
| **方案 A(Electron-as-node ABI 130,未修)** | 106 pass / **4 fail** | 1485 pass / **7 fail** / 16 skip |
| **方案 A(修完,目标)** | 110 pass / 0 fail | **1507 pass / 0 fail / 0 skip** |

- 216 skip = 200 binding-gated(12 文件)+ 16 环境 gate(codex-binary-layout 15 + hand-off it.skip 1)。修完全消。
- 7 fail = cwd-marker 4 + task-repo 2 + v023 1。codex-binary-layout 是 suite-fail(testFails=0)不计入 7,但修 D7 才能让它 15 个真跑。

### 验证命令

```bash
pnpm test           # Electron-as-node → 期望 0 fail 0 skip(darwin-arm64 本机;或仅剩真正无法本机跑的 skip)
pnpm test:node      # 系统 node → SQLite 测试优雅 skip + loud warn,非 SQLite 全过
pnpm typecheck      # tsc 双配置绿
md5 node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node
# ↑ binding 健康【主判据】: 必须 = 64beb2ef045af83e20a5294908f30f70(方案 A 全程不碰 binding,md5 不变即保证无 NODE_MODULE_VERSION)
pnpm dev            # 可选肉眼确认: app bootstrap 不报 NODE_MODULE_VERSION(GUI 常驻退出码判不了,md5 已是主保证,此为冗余 belt-and-suspenders)
```

## 当前进度

- ✅ Step 0 RFC 完成(用户 3 问拍板:Q1 默认 Electron-as-node / Q2 保留守门+loud warn / Q3 un-skip)
- ✅ Step 0.5 spike 完成(全非破坏性,binding 零 swap)—— 方案 A 全验证、方案 B 否决、4 个失败文件 exact error 定位、wrapper 可行性验证、process.resourcesPath configurable 验证
- ✅ Step 1.5 deep-review R1 完成(reviewer-claude + reviewer-codex 异构对抗)——**0 HIGH**,双方独立确认 4+1 根因准确 + 不变量 2「生产代码不动」成立。5 条 MED/LOW 已全部补进 plan:wrapper stdio/exit 契约(双方独立,D1)/ D3 re-export+8 consumer(claude MED-1)/ D8b cwd-resolver 决策树补测(codex MED-2)/ §下一会话第一步 adapter-safe(codex MED-3)/ v023 表述精确化(codex LOW-1)/ 不变量5 darwin-arm64 限定(claude LOW-1)/ D5 收敛 log.scope spy(双方 INFO)
- ⏳ 待用户 confirm 进 worktree → Step 2 EnterWorktree → 实施

## 下一会话第一步

> ⚠️ worktree **目前尚未创建**(Step 2 EnterWorktree 待用户 confirm 后才执行;deep-review R1 codex MED-3 实证 `test -d <worktreePath>` = MISSING)。下面分「worktree 已建 / 未建」+「claude / codex adapter」两维度给 adapter-safe 指令。

新会话:
1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/sqlite-tests-no-skip-20260601.md` 读全
2. **判断 worktree 是否已建**:`Bash: test -d /Users/apple/Repository/personal/agent-deck/.claude/worktrees/sqlite-tests-no-skip-20260601 && echo EXISTS || echo MISSING`
3. **进/建 worktree(按 adapter 分流)**:
   - **claude adapter + worktree 已建**:`EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/sqlite-tests-no-skip-20260601")`
   - **claude adapter + worktree 未建**:先 `Bash: git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-sqlite-tests-no-skip-20260601 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/sqlite-tests-no-skip-20260601`(隐式 HEAD 作 base,避开 EnterWorktree CLI stale base bug)→ 再 `EnterWorktree(path: ...)`
   - **codex adapter**(无 native EnterWorktree):worktree 未建 → `mcp__agent-deck__enter_worktree({ planId: 'sqlite-tests-no-skip-20260601', baseCommit: '8302aa8106967f050d4b4ef12b02bcbe77573468' })`(自建 + 写 cwd marker;不改 codex cwd);已建 → 不调 enter_worktree,直接对 `<worktreePath>/...` 或 `git -C <worktreePath>` 操作
4. 按 checklist 未打勾项推进。**所有代码资产路径加 worktree 前缀** `.claude/worktrees/sqlite-tests-no-skip-20260601/`(claude 进 worktree 后用相对/绝对均可;codex 始终用绝对路径或 `git -C <worktreePath>`)
5. 每步改完先 `pnpm test:node`(快)验非 SQLite 不回归,SQLite 相关步骤用 `pnpm test`(Electron-as-node)验

## 实施新增发现

- **cwd-marker TC2b 边角 stale 断言**(Step 4 实施时发现,spike 阶段被 `no such column` crash 遮蔽):补 v021-v026 后该用例从「撞列错」变「断言错」(`expected null to be '/existing/wt'`)。根因是 test 写于 P5 Round 1 reviewer-codex MED-2 修法**之前** —— 老断言期望「OLD null 时不覆盖 NEW 已有 marker」,但生产 `rename.ts:283` 已改为**无条件**用 fromRow 覆盖(marker 是 transient session state,rename=OLD 接管 NEW 身份,OLD null 必须清掉 NEW stale marker)。test comment 还引用了已删除的 `if (toExists && fromRow.cwd_release_marker)` guard。**仍是 test-side stale 断言(不变量 2 成立,生产代码正确)**,改断言为 NEW 被清空 null。

## 已知踩坑

- **🔴 binding 红线**:全程不 swap binding。方案 A 本就不需要 swap(用现装 ABI-130)。任何阶段都 `md5` 自检。
- **wrapper 位置**:`scripts/test-electron.mjs` 必须在 repo 内,`createRequire` 才能从 repo node_modules 解析 electron(放 /tmp 会 MODULE_NOT_FOUND,spike 实证)。
- **`process.resourcesPath` read-only**:Electron 下不可直接赋值,必须 defineProperty(D7)。
- **`?raw` import**:vitest 基于 vite,migration SQL 的 `?raw` import 原生支持(spike 实证全过)。
- **生产代码红线**(不变量 2):4 个失败全是 test bug,生产 .ts 一律不改。任何想改生产代码的冲动 = 误判,停下重新核对。
