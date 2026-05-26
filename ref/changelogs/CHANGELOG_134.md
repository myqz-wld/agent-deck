# CHANGELOG_134 — Plan `add-claude-cli-path-override-and-bump-sdks-20260520` Follow-up F1+F2+F3 实施

## 概要

实施 `plans/add-claude-cli-path-override-and-bump-sdks-20260520.md` §设计决策 D7/D8/D9 + CHANGELOG_133 backlog 的 3 个 follow-up:

- **F1**:`@anthropic-ai/sdk@^0.96.0` 加直接 dep 消除 peer warn
- **F2**:加 existsSync 护栏(plan §D7 deviation)
- **F3**:写 priority chain 单元测试(plan §D8 §1.7 实施)

2 commits + 1 新 helper + 1 新 test 文件 + 净 +175/-14 LOC。

## 变更内容

### Follow-up F1 commit `dab3101` — clear peer warn(plan §D9 实施)

claude-agent-sdk 0.3.144 声明 peer `@anthropic-ai/sdk@>=0.93.0` 但实际间接装 0.81.0 → 每次 `pnpm install` / `pnpm typecheck` / `pnpm build` 撞 1 行 `WARN unmet peer @anthropic-ai/sdk@>=0.93.0: found 0.81.0`,且 claude SDK 内部用 0.81 旧版 API。

修法:`pnpm add @anthropic-ai/sdk@^0.96.0`(2026-05-13 release 7 天稳定,跳过昨天发布的 0.97.0 / 0.97.1 = "保守稳定版"原则与 plan §D2 一致)。

spike 验证 GREEN:
- pnpm install 后 unmet peer WARN 消失
- typecheck 0 errors
- pnpm test --run: 762 pass | 76 skipped | 0 fail
- pnpm build GREEN

**副作用**(positive):pnpm 顺带把 main repo node_modules 的 chokidar / node-pty 老 dep 真清掉(plan `remove-aider-generic-pty-adapters-20260520` / CHANGELOG_131 已删 package.json 但 main repo node_modules 仍残留,本 follow-up 触发 prune)。

### Follow-up F2+F3 commit `d6b7df6` — existsSync guard + priority chain 单测(抽 helper)

**3 个改动放一个 commit**(功能耦合,helper extraction 让 F3 单测 cleanly 实施):

1. **新建 `src/main/adapters/claude-code/resolve-claude-binary.ts`**(~30 LOC):helper `resolveClaudeBinary(): string | undefined` 封装 priority chain + existsSync 护栏 + bundled fallback + console.warn on missing path
2. **`sdk-bridge/index.ts:253` + `claude-runner.ts:55`**:改成 1 行 `resolveClaudeBinary()` helper 调用,删原 inline pattern + 删 unused import `settingsStore` / `getPathToClaudeCodeExecutable`(2 caller 已不直接需要)
3. **新建 `src/main/adapters/claude-code/__tests__/resolve-claude-binary.test.ts`**(~110 LOC,6 case)显式 verify 6 边界:
   - case 1: `claudeCliPath=null` → fallback bundled,no warn
   - case 2: `claudeCliPath=""` → fallback bundled,no warn
   - case 3: `claudeCliPath="   \t  "` → trim falsy → fallback bundled,no warn
   - case 4: `claudeCliPath="/missing/path"` + existsSync false → fallback bundled + console.warn(含 missing path 字面)
   - case 5: `claudeCliPath="/usr/bin/claude"` + existsSync true → user override,no warn
   - case 6: `claudeCliPath="  /usr/bin/claude  "` + existsSync(trim 后路径)→ trim 后用作 override,no warn(filepicker 残留 user-friendly)

**两个 design 决策 deviation**(plan §D5 + §D7,user 显式 opted in F2+F3):

| 原 design | Follow-up deviation | 理由 |
|---|---|---|
| §D5「inline 不抽 helper,镜像 codex N=2」 | 抽 helper `resolveClaudeBinary()`(单独文件) | F3 单测不依赖 sdk-bridge 全 mock boilerplate;sdk-runtime.ts 仍保持 pure utility(helper 单独文件不污染) |
| §D7「不加 existsSync,镜像 codex」 | 加 existsSync 护栏 + console.warn | user 填错路径时 silently fallback 不让 SDK spawn 直接撞 ENOENT,user 终端可见 warn 提示路径无效 |

**与 codex 镜像偏离**:本 follow-up 后 claude priority chain 与 codex 不再字面对齐(claude 有 existsSync 护栏 + helper 抽出;codex 仍 inline + 无 existsSync)。Plan §D5 / §D7 原决策是「镜像 codex 现行」,本 follow-up 单方向 enhance claude 端(codex 同款 enhance 留作 codex 端 future follow-up,**不在本 plan 范围**)。

### verify

- typecheck 0 errors
- pnpm test --run: **768 passed**(+6 F3 new) | 76 skipped | **0 fail**
- pnpm build GREEN(187+8+449 modules transformed,无新 error)

## 关键 commits

- `dab3101` Follow-up F1: add @anthropic-ai/sdk@^0.96.0 direct dep (clear peer warn)
- `d6b7df6` Follow-up F2+F3: existsSync guard + priority chain unit test (extract helper)

## 残留 follow-up

- **F4 deferred**(plan §Phase 4.1-4.3):user 完整 e2e smoke — `pnpm dist` 出 .app + install + boot smoke + claude/codex session sandbox 切档 + mcp tool approval gate + 设置面板 Claude 二进制路径填空验证。**本 follow-up commit 后**会启动 `pnpm dist`,user 装 .app 后实测交互。
- **Codex side existsSync + helper extraction**(本 follow-up 引入的 cross-adapter asymmetry):如未来想消除偏离,follow-up plan 在 codex 端同款 enhance(加 existsSync 护栏 + 抽 `resolveCodexBinary()` helper);**当前接受此偏离**(claude / codex 两个独立 adapter,enhance 时序不一致合理)。

## 详

- 归档 plan: [`plans/add-claude-cli-path-override-and-bump-sdks-20260520.md`](../plans/add-claude-cli-path-override-and-bump-sdks-20260520.md) §设计决策 D5+D7+D9 + §Follow-up
- 上一份 changelog: [CHANGELOG_133.md](CHANGELOG_133.md)(本 plan 主体收口)
