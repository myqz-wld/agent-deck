# CHANGELOG_176 — plan sdk-spawn-shell-path-20260529 完整归档 (X1 user shell PATH 注入修 macOS .app launchd minimal PATH)

## 概要

[plan `sdk-spawn-shell-path-20260529`](../../plans/history/sdk-spawn-shell-path-20260529.md) 完整收口归档。修复 macOS `.app` 走 launchd 启动时主进程 `process.env.PATH` 极度缺失(只 `/usr/bin:/bin:/usr/sbin:/sbin` 4 条 minimal,无 brew/nvm/cargo/go/bun/pnpm)→ SDK 子进程跑 `pnpm typecheck` / `cargo` / 任何用户终端 CLI 撞 `command not found` 的根本问题。**X1 方案** 主进程启动早期(Phase 0.5)用 `execFileSync($SHELL, ['-ilc', sentinel-printf-cmd])` 实测用户真实终端 PATH 缓存,union 进 `process.env.PATH`,后续所有 spawn(SDK 子进程 + 主进程 git 等)自动 inherit 完整 PATH。

**继承自** follow-up task `6aec8cf7-5b84-4e70-a1ac-bf91d29803ed`(归档于 plan `deep-project-review-comprehensive-20260528`,user 反馈 reviewer-* teammate sandbox 跑 pnpm typecheck `command not found`)。

**净改动**:5 文件 +388 / -16 = +372 LOC。新建 `src/main/utils/user-shell-path.ts`(157 LOC helper)+ `src/main/utils/__tests__/user-shell-path.test.ts`(231 LOC,18 unit tests)。`src/main/index/bootstrap-infra.ts` Phase 0 加 mutate `process.env.PATH` 调用(+18 LOC)。`pnpm typecheck` ✅ + `pnpm build` ✅(main 711KB / preload 22KB / renderer 1.4MB)+ 18/18 tests passed。

**不变量守约**:
- ✅ **不引入新依赖** — 只用 `node:child_process`(execFileSync argv API)
- ✅ **失败不破坏现状** — `$SHELL` 未设走 `/bin/zsh` 兜底;shell 跑挂 / `-ilc` 不支持 / 无 sentinel → console.warn + 返 null,bootstrap 加 `&& newPath !== ''` 守门防 undefined → '' 退化(行为与原现状一致,不退化)
- ✅ **PATH 只补不替** — union 优先用户 PATH,原 process.env.PATH 末尾保留(避免丢 Electron bundle 路径 `.app/Contents/MacOS` / `Resources/bin`)
- ✅ **dedupe 保留优先序** — Set 保序去重避免 PATH 含重复条目(典型 user PATH 末尾 vs process.env.PATH 末尾撞 `agent-deck-plugin/bin`)
- ✅ **process.env 其他字段不动** — 只改 PATH 字段(避免污染 ANTHROPIC_API_KEY / NODE_OPTIONS 等)
- ✅ **修法 idempotent** — `captureUserShellPath()` sentinel 二分 memo `captured: boolean` + `cached: string | null`,失败路径也命中 memo
- ✅ **fail loud** — console.warn(让 user 在主进程 log 看到 fix 是否生效,但不抛错阻塞启动)
- ✅ **不暴露 setting** — 不加 enableShellPathInjection 配置项(符合 macOS 应用约定「环境变更 重启应用 生效」)

## 变更内容

### Phase 0 RFC(5 轮 RFC 对齐 design 大方向)

User 一句反馈「reviewer 起来后 sandbox 内 pnpm 找不到」 + 「这是不是只能解决 pnpm 的问题,有没有更加通用和泛化的解决逻辑」反推出**真问题**(SDK 子进程 PATH ≠ 用户终端 PATH,不是 pnpm 本身)。RFC 5 轮对齐:
- **Round 1** 修法策略 A/B/C/D — user 反问「通用化」推翻只 patch pnpm 路径的方案
- **Round 2** 修复 scope — user 选「所有 SDK spawn(含 lead)」最广 scope
- **Round 3** 通用方案 X1/X2/X3 — user 选 X1(主进程启动时 `$SHELL -ilc 'echo $PATH'` 实测 + 缓存,不引依赖)
- **Round 4** PATH 合并策略 + 失败兜底 — user 选 union 用户 PATH 优先 + 静默降级 console.warn
- **Round 5** 4 个 plan 实施细节 — dedupe 保序 + 启动早期预热 + 不暴露 setting + 主进程 process.env.PATH 也 union

### Phase 0.5 spike1(实测 6 假设 backing 全套 design 决策)

落 `<plan-artifact-dir>/spike-reports/spike1-shell-path-actual.md`(归档后 mv 到 `ref/plans/sdk-spawn-shell-path-20260529/spike-reports/`)。实测发现:

- **Finding A** SDK 子进程 PATH(当前 user 机器双击 .app)只 5 条:`/usr/bin:/bin:/usr/sbin:/sbin:<plugin/bin>`(launchd 4 + agent-deck-plugin/bin 1)
- **Finding B** 用户真实终端 PATH(zsh -ilc)22 条:含 `/Users/<user>/.nvm/versions/node/v24.10.0/bin` + `/opt/homebrew/bin` + `/Users/<user>/.cargo/bin` + `/Users/<user>/.bun/bin` 等
- **Finding C** 缺失 17 条:含 nvm Node 24 / Homebrew / Rust cargo / Go / Bun / .gvm / .claude
- **Finding D** pnpm 实际位置 `~/.nvm/versions/node/v24.10.0/bin/pnpm`(corepack-managed via nvm Node 24,版本 10.33.0)
- **Finding E** 应用 spawn options.env 当前实现 — `sdk-runtime.ts:40-57 getSdkRuntimeOptions()` baseEnv 100% 拷贝 `process.env`;`codex-cli/sdk-bridge/index.ts:57-63 snapshotProcessEnv()` 同款 spread。Bug 已知性:`sdk-runtime.ts:6-9` 注释明文「macOS .app 走 launchd 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin」,应用层已知但未根治
- **Finding F** $SHELL -ilc 启动 cost ~460ms 平均(可接受,Electron 启动几秒级)
- **Finding G** 跨 shell 兼容性 — bash/zsh/sh -ilc 都支持,bash 不读 zsh rc(必须用 user $SHELL 不假设 zsh)

### Phase 1 plan 文件(commit `5347c14` 前置 plan)

按应用 CLAUDE.md §复杂 plan workflow §Step 1 模板写 plan,frontmatter / 总目标 / 11 不变量 / 设计决策表 / 步骤 checklist / 当前进度 / 下一会话第一步 / 已知踩坑全节齐。

### Phase 1.5 Deep-Review plan(SKILL kind='plan',3 round 共识 0 HIGH/MED 可合)

invoke `agent-deck:deep-review` SKILL kind='plan' 评审 plan + spike1 报告。**3 round 共 16 finding fix 落地**:
- **Round 1**: 11 finding(claude HIGH-1 §修法落点 evolved + HIGH-2 fish shell follow-up + 5 MED + 1 LOW + 1 INFO;codex 3 MED + 2 LOW)
- **Round 2**: 5 R2 finding(MED-A 双方共识 stale execSync × 8 处 / MED-B codex 实测 tcsh/csh `-ilc` `Unknown option: '-lc'` 推翻 spike 阶段「`/etc/shells` 默认列表都支持 -ilc」断言 / LOW-A failure-memo 测试缺 / LOW-B case 4 spawnSync 默认无 stderr 需 shell:true 才返 status 127)
- **Round 3**: reviewer-codex L67 stderr 抑制 INFO nit fix
- 双方共识可合后 user 显式 confirm 进 Step 2 EnterWorktree

### Phase 2 EnterWorktree(避开 v2.1.112 stale base bug)

走主路径 (b) Bash + EnterWorktree(path:):
```bash
git -C <main-repo> worktree add -b worktree-sdk-spawn-shell-path-20260529 \
  <main-repo>/.claude/worktrees/sdk-spawn-shell-path-20260529
```
+ `EnterWorktree(path: <worktree-abs-path>)`。HEAD 自检 `e1fbc6e` = base_commit ✅ 无 stale base bug。

### Phase 3 实施(3 commit chain)

#### Step 3.1 helper(commit `f474352`)

`src/main/utils/user-shell-path.ts` 3 函数 export:
- `captureUserShellPath(): string | null` — execFileSync argv API + sentinel 二分 memo + `$SHELL || /bin/zsh` fallback + 3000ms timeout + stdio `['ignore', 'pipe', 'pipe']` + sentinel marker 包围 PATH 输出(Round 1 fix 后)
- `dedupePath(path: string | undefined): string` — Set 保序去重,空输入返空
- `unionUserShellPath(originalPath: string | undefined): string` — user PATH 优先 union + dedupe + fallback originalPath

#### Step 3.2 bootstrap mutate(commit `43315e3`)

`src/main/index/bootstrap-infra.ts:initInfra` Phase 0.5(L71 applyClaudeSettingsEnv 之后,L73-75 browser-window-created listener 之后,L78 initDb 之前)加:
```ts
const newPath = unionUserShellPath(process.env.PATH);
if (newPath !== process.env.PATH && newPath !== '') {  // R1 LOW-1 守门后
  process.env.PATH = newPath;
}
```
后续所有 spawn 自动 inherit 新 PATH(`getSdkRuntimeOptions()` / `snapshotProcessEnv()` 都是 spawn-time 函数内 spread,非 module-level cache)。

#### Step 3.3 unit tests(commit `95da518` 14 tests + R1 fix 后 +4 = 18 tests)

`src/main/utils/__tests__/user-shell-path.test.ts` 18 tests 覆盖:
- captureUserShellPath success/throw/no-sentinel × memo cache 三状态(success/failure/no-sentinel 都「连调 2 次只跑 1 次 + console.warn 只 1 次」验证 sentinel 二分 memo 设计)
- dedupePath 保序去重 × 空输入 × 单元素
- unionUserShellPath 拼接 + 失败 fallback + originalPath undefined / '' / 都失败返空
- **新增 4 test (R1 fix)**: zsh `.zlogout` 后写 logout text 防 last-line 污染 / rc echo 在 marker 前 / 完全空 stdout / `$SHELL` undefined → /bin/zsh fallback / `originalPath = ''` 显式覆盖

### Step 3.6 Deep-Review code(SKILL kind='mixed',2 round 共识可合)

invoke `agent-deck:deep-review` SKILL kind='mixed' 评审 plan + code 实施一致性 + helper 实现质量 + bootstrap mutate 时序 + unit test 覆盖。**2 round 共 6 finding fix 落地**(commit `f69e7a9` 一次合 R1 fix):
- **Round 1**: 0 HIGH / 2 MED + 2 LOW + 3 INFO
  - **MED-1 (codex 实测铁证)** zsh `.zlogout` 输出污染 PATH last-line — codex 在 /tmp 构造 HOME + .zlogout 实测;helper 改用 `__AGENT_DECK_PATH_BEGIN__/END__` sentinel marker 包围 PATH 输出,parse 时找 sentinel 而非依赖 last-line
  - **MED-2 (双方共识)** plan §当前进度 / §下一会话第一步 未同步实施进度 — plan main repo 文件更新到 R1 fix 进度
  - **LOW-1 (claude 实证)** bootstrap mutate 加 `&& newPath !== ''` 守门防 undefined → '' 退化(7 case 矩阵全覆盖验证)
  - **LOW-2 (claude)** console.warn 在 .app launchd 无回显 — 与 follow-up task `e1493ecd-...`(运行时日志落盘 electron-log)重叠,plan §已知踩坑 9 加注脚指向 follow-up,本 plan 不独立修
  - **INFO-2 (claude)** test 加 `originalPath = ''` 显式覆盖
  - **INFO-3 (claude)** test 加 `$SHELL` undefined → /bin/zsh fallback 显式覆盖
- **Round 2**: 双方共识可合 — claude 0 HIGH/MED/真 LOW + 1 INFO,codex 0 HIGH/MED/LOW + 2 INFO(双方 INFO 重叠 sentinel hardcoded string 边界 case + codex L199 文案 nit 已 fix)
- **codex 现场实测铁证**累计 3 次:(1) tcsh/csh `-ilc` 失败 / (2) Node 默认 spawnSync 无 stderr 需 shell:true / (3) zsh `.zlogout` 污染 last-line — 都靠 reviewer-codex 现场实测推翻 lead / spike 阶段假设,异构对抗实战价值

### Step 3.7 build verification

- ✅ `pnpm typecheck`
- ✅ `pnpm build`(main 711KB / preload 22KB / renderer 1.4MB,3 部分都 OK)
- ⏳ `pnpm dist` plan 不强求(走完整打包 5 min cost,本 plan 不动 packaging,Step 4 收口前 user 手动验证)

## Follow-up tasks(plan 收口时已 booking 进 mcp task store)

| task id | priority | 描述 |
|---|---|---|
| `30924a26-...` | 2 (LOW) | sentinel marker 改 `crypto.randomUUID()` per-capture nonce — Step 3.6 Round 2 双方共识 INFO,现实可能性 ≈ 0 但 hardening 可选 |
| `e1493ecd-...` | 4 (MED) | 运行时日志落盘 + 应用内查看按钮(electron-log 选型)— 与本 plan §已知踩坑 9 重叠,实施后 console.warn 自动落 log file 可见 |
| `<新建>` | 5 (LOW) | tcsh/csh/fish/nu 等不支持 `-ilc` shell 的 fallback — 需 spike2 实测各 shell PATH 来源 / login config / nvm/fnm/asdf 初始化链 |

## 经验沉淀

`ref/conventions/tally.md` 加候选 **P37**(count=1):**macOS .app launchd 启动主进程 PATH 极度缺失** — Electron 应用 spawn 子进程跨 OS 通用坑,8 项预防措施(execFileSync argv API / sentinel marker / sentinel 二分 memo / 失败兜底链 / 限定 shell 集合 / 主进程 mutate 而非 SDK adapter spread layer / `.gitignore` 加本地状态目录 等)。count < 3 静默更新,后续撞同主题再 +1;count ≥ 3 走双对抗三态裁决升级到 `ref/conventions/<X>-electron-path-injection.md`。
