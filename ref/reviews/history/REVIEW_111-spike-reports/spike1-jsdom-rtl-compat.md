# Spike 1 — React19 + RTL16 + vitest2 + jsdom29 兼容性 + Web API mock 可行性

> Plan: image-hook-race-tests-20260602（issue 6f86ac86 — 图片附件 hook 异步 race 缺 committed 回归测试）
> 日期: 2026-06-02
> 结论: **方案 (a)（引入 jsdom + RTL）完全可行，生产代码零改动**。三条目标 race 行为均可 renderHook 直测，且 MED-1 经 mutation test 证明能挡回归。

## 动机

REVIEW_102 R2 双 reviewer 命中 INFO：本轮风险最高的 useImageAttachments / useImageBlob hook 级异步 race 仅靠 /tmp sim 实证，无 committed test。用户拍板走方案 (a)：引入轻量 React hook 测试环境覆盖三条异步状态机：

- **MED-1**（useImageAttachments）：remove() 不 bump generationRef → 多图批量删任一张时同批 in-flight 兄弟不被连坐丢弃
- **LOW-1**（useImageBlob）：loader reject → loading:false + io_error result（不永久 loading）
- **LOW-2**（useImageBlob）：cache hit 刷新 ts（LRU 非 FIFO）

方案 (a) 的两个未知风险需 spike 验证：① React19+RTL+vitest+jsdom 版本兼容；② useImageAttachments.add() 走 FileReader/Image/canvas，jsdom 无实现，能否 mock 让其不卡死 + race 时序可控。

## 假设

1. `@testing-library/react@16` 支持 React 19
2. vitest 2.1.9 默认 esbuild 能转译 `.test.tsx`（无需额外 `@vitejs/plugin-react`）
3. `// @vitest-environment jsdom` docblock 能单文件切环境，不污染全局 node 测试
4. add() 的 FileReader/Image/canvas 三个 Web API 可用 stubGlobal/spyOn mock
5. **最高风险**：MED-1 的 race 时序（A 已入列、B/C 仍 in-flight）可被测试精确触发

## 实测

### 依赖版本（npm view + pnpm add 实测）

| 包 | 版本 | 关键点 |
|---|---|---|
| `@testing-library/react` | 16.3.2 | peerDeps `react: ^18.0.0 \|\| ^19.0.0` ✅ 明确支持 React 19 |
| `@testing-library/dom` | 10.4.1 | RTL16 peer 要求 `^10.0.0` |
| `jsdom` | 29.1.1 | |
| react / react-dom | 19.2.5 | worktree 实装 |

安装命令（`--ignore-scripts` 跳过 postinstall 的 `electron-builder install-app-deps`，避免触碰 better-sqlite3 native ABI 陷阱 —— CLAUDE.md 红线；hook 测试纯 renderer 不碰 DB）：
```
pnpm add -D 'jsdom@^29' '@testing-library/react@^16' '@testing-library/dom@^10' --ignore-scripts
```

### 配置变更（vitest.config.ts）

唯一需改：`include` 从 `['src/**/*.test.ts']` 扩到 `['src/**/*.test.ts', 'src/**/*.test.tsx']`（否则 `.test.tsx` 不被收集，实测 "No test files found"）。保持全局 `environment: 'node'`，hook 测试文件顶部加 `// @vitest-environment jsdom` docblock 单文件切。

### Spike 1 结果（_spike.test.tsx，4 tests passed）

- ① useImageBlob renderHook + act + waitFor 跑通：loader resolve ok / **reject → io_error** / **cache hit 刷新 ts** 三场景全绿
- ② useImageAttachments.add() 在 jsdom 下不卡死：mock FileReader（readAsDataURL → microtask onload）+ Image（src setter → onload）+ canvas（getContext/toDataURL spyOn）→ add 一张 png → attachments 出现一条

### Spike 2 结果（_spike2.test.tsx，1 test passed）— 最高风险项

MED-1 race 时序**可精确控制**。机制：FileReader 自动 microtask resolve，**Image.onload 进手动队列**，测试用 `flushOneImage()` 逐个 flush 控制 add() 的 push 时机。从而构造：
1. add([A,B,C]) 启动，settle 后卡在 A 的 thumb Image（attachments=0，队列有 A_img）
2. flush A_img → A push 入列（B 卡 Promise.all）
3. remove(A) ← 此刻 B/C 仍 in-flight
4. flush B_img + C_img → add 完成
5. 断言 attachments = [B, C]（A 删，B/C 没被连坐丢弃）

### Mutation test（关键 — 证明测试真能挡回归）

临时在 remove() 插回旧 bug `generationRef.current++` → spike2 **变红**：`expected [] to deeply equal ['B','C']`，精确复现"删 A 把同批 B/C 连坐静默丢弃"。撤销 mutation 后恢复绿。**这证明测试不是"摆设绿"，而是真正守门 MED-1 修法。**

## 结论

- 方案 (a) 可行，**生产代码零改动**（git diff 仅 package.json/lock + vitest.config.ts + 测试文件）
- React19+RTL16+vitest2+jsdom29 全兼容；esbuild 默认转 TSX 无需 plugin-react；docblock 单文件切 jsdom 工作
- 三条 race 行为全可 renderHook 直测；MED-1 race 时序用手动 Image.onload 队列精确可控且经 mutation test 验证能挡回归
- setupFiles（mock electron 等）对 hook 测试无害（hook 不 import electron）

## 残留风险

- **act() warning 噪音**：React 19 严格 act 环境下未包 act 的 state update 会 warn。正式测试需把所有触发 setState 的调用（add/remove/clear）包进 `act()`，已在 spike 验证可控。
- **SQLite 真测守门不受影响**：worktree `--ignore-scripts` 未 rebuild native binding，但全量 vitest 时 SQLite 真测有 `describe.skipIf(!bindingAvailable)` 守门（_binding-probe.ts），自动 skip 而非 crash。本机 `pnpm test`（electron-as-node ABI 130）才真跑 SQLite；hook 测试在 `pnpm test:node`（系统 node）即可跑。
- **正式收口需在主仓库验证 binding**：worktree 装的依赖最终随 package.json/lock 合回 main 后，主仓库需 `pnpm install` 拉新依赖（含 postinstall rebuild）。但本 plan 只加 devDeps（jsdom/RTL/dom，纯 JS 无 native），不影响 better-sqlite3 binding。
