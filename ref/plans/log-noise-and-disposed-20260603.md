---
plan_id: "log-noise-and-disposed-20260603"
created_at: "2026-06-03"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/log-noise-and-disposed-20260603"
status: "completed"
base_commit: "34ab566"
base_branch: "main"
final_commit: "a709ea0bb6c2acd782eaab3d82bdcf55efaf7c55"
completed_at: "2026-06-03"
---
# 日志降噪 + webFrameMain disposed 静默化

> 触发：user 主扫 06-03 5 天日志，扫到 6 类模式，2 类确认可改（B/E），其余 4 类已修过或环境噪声。
> 不含 RFC 多轮（fix 范围小且根因已确认），不含 spike（行为不依赖未知 SDK），但走 simple-review 在实施后扫一遍。

## 总目标

一次 commit 改 2 个文件落地 2 个独立 fix：

- **B — codex CLI loader warning 降级**：264 次/5 天同 8 个文件反复 log，**已 REVIEW_80 修过**过滤逻辑（不 emit UI），但 warn 级日志每天 50+ 行无诊断价值。降到 debug 级保留痕迹。
- **E — webFrameMain disposed 静默化**：18 次 error 单天爆发 14 次（06-02 01:10），与 `Claude Code process SIGKILL` 同波。**应用层 `safeSend` 已守 `isDestroyed()`**（`bootstrap-wiring.ts:51-52` 唯一 `webContents.send` 入口），但 Electron framework 在某些销毁竞态路径上仍会自己 emit `webContents.send` 失败并打 `Error sending from webFrameMain`。在 `safeSend` 内 catch 这条 framework 抛错 → 静默（不影响其他 send 失败路径）。

## 不变量（必须守住）

1. **N1 safeSend 现有 contract 不动**：`isDestroyed()` 守门保留（先 return，再 send，无 try/catch 是当前形态）。**仅新增 catch 框架 send 时的 webFrameMain disposed 抛错**，其他 send 失败仍走 `errorHandler.startCatching` 落盘。
2. **N2 codex-translate filter 逻辑不动**：REVIEW_80 修过的 `isLoaderWarning` 前缀 `'Ignoring malformed'` 锚点保留。**仅改日志级别** warn → debug（logger scope 不变）。
3. **N3 不动 safeSend caller 的 catch 分支**：`bootstrap-wiring.ts:75 / 156` 现存 try/catch 仍走原路径（`logger.error('[xxx] safeSend 异常 (吞掉防撞穿 emit caller):', err)`）；本 plan **只在 safeSend 内部加最末一道 catch**，不重复 caller 的报错链路。
4. **N4 生产代码 0 新文件**（reviewer-codex INFO 真观察→Round 3 修订）：改 6 个已存在 tracked 文件（`translate.ts` / `translate.test.ts` / `_deps.ts` / `bootstrap-wiring.ts` / `logger.ts` / `logger.test.ts`）+ 2 untracked test 文件（`bootstrap-wiring.test.ts` / `logger-end-to-end.test.ts`）。Round 1-2 plan 措辞「改 4 个」过窄,Round 3 加 logger.ts file transport hook (Fix E 改对层)+ 端到端测。生产代码 0 新文件成立(全改已存在),测试可新增 2 个。
5. **N5 回归测试**: 
   - codex-translate 既有测试（`src/main/adapters/codex-cli/__tests__/translate.test.ts`）断言 loader warning 走 logger.debug 而非 logger.warn;
   - safeSend 静默逻辑（`src/main/index/__tests__/bootstrap-wiring.test.ts`）7 case: null window / window destroyed / wc destroyed / framework race 静默 / TypeError 透传 / 非 Error 透传 / 正常路径;
   - logger hook 单测（`src/main/utils/__tests__/logger.test.ts`）9 case: 7 shouldDrop (双关键词/单关键词/不相关/非 string 元素/空 data/双关键词分布) + 2 install (首次 push + 重复 dedup);
   - **logger hook 端到端测（`src/main/utils/__tests__/logger-end-to-end.test.ts`）** 3 case 走 electron-log/node 真包 (vitest-setup.ts:21 NOT mock) + tmp file transport + 验真落盘: 双关键词不落盘 (HIGH-1 关键回归) / 普通业务 log 落盘 (HIGH-2 关键回归) / 单独 'Render frame was disposed' 字符串不误吞 (防 OR drift)。

## 设计决策（不再争论）

### D1 codex-translate 单行降级（最小改动）
`src/main/adapters/codex-cli/translate.ts:437` `logger.warn(...)` → `logger.debug(...)`。**保留完整 message 文本**（不要缩成前缀）—— debug 级别默认不进 file transport（logger D2 = file level 'info'，详 `runtime-logging-electron-log-20260529`），仅 console 留痕（dev 终端），用户磁盘日志彻底清掉这 264 次。

### D2 safeSend 框架抛错静默（最小 catch）
`src/main/index/bootstrap-wiring.ts:49-53`：

```ts
const safeSend = <T>(channel: string, payload: T): void => {
  const w = floating.window;
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
  try {
    w.webContents.send(channel, payload);
  } catch (err) {
    // Electron framework 在 webFrameMain 已被销毁时仍可能 throw
    // 'Error sending from webFrameMain: Error: Render frame was disposed ...'。
    // 静默这条已知 race 噪声,不影响其他 send 失败路径(errorHandler 仍兜底)。
    if (err instanceof Error && /Render frame was disposed/.test(err.message)) return;
    throw err;
  }
};
```

- 仅 catch **Electron framework 已知 race**（message 正则匹配 `Render frame was disposed`），**不静默其他异常**（TypeError / 真实 bug 仍 throw 走 `errorHandler.startCatching` 落盘）
- 不写 logger（避免双层 log：framework 已经打了一条 `Error sending from webFrameMain`，再 logger 一次变 2 行；改成静默就是完全静默）

### D3 测试矩阵
- **codex-translate 既有测试**：看 `translate.test.ts` 现是否断言 log 调用级别。如有 `expect(...).toHaveBeenCalledWith('warn', ...)` → 改 `debug`。如只断言走 suppress UI emit 路径 → 0 改动。
- **safeSend 单测**：新建 `src/main/index/__tests__/bootstrap-wiring.test.ts`（如不存在）或在同 __tests__ 目录加：
  1. mock `floating.window` 为 destroyed → 直接 return（覆盖现有守门）
  2. mock `webContents.send` throw `Error('Render frame was disposed')` → safeSend 不 throw
  3. mock `webContents.send` throw `Error('TypeError: xxx')` → safeSend rethrow

## 步骤 checklist

- [x] Step 1 — 建 worktree（Step 2 节主路径 (b) Bash + `EnterWorktree(path:)` 两步，避 stale base bug）
- [x] Step 2 — codex-translate 改 1 行 warn → debug
- [x] Step 3 — bootstrap-wiring.ts safeSend 加 try/catch
- [x] Step 4 — translate.test.ts 改断言（如有）
- [x] Step 5 — 新增 safeSend unit test
- [x] Step 6 — `pnpm typecheck` + `pnpm exec vitest run <两个新测/改测>` — Round 1: translate.test 40/40 + bootstrap-wiring.test 7/7 = 47 全过; Round 3 加 logger.test 22 + logger-end-to-end.test 3 = 72 全过 (双层测防 R1 no-op 二次重演); typecheck 双绿
- [x] Step 7 — simple-review SKILL 扫 1 轮（reviewer-claude + reviewer-codex 异构对抗）
  - **R1**: reviewer-codex 0/0/0 + 1 INFO (N4 措辞过严 → 修订); reviewer-claude 1 HIGH (Fix E 改错层 — Electron framework native try/catch 吞错, 应用层 safeSend try 永不进, 14/14 日志全带 framework console.error 前缀铁证) → 修
  - **R2**: reviewer-codex 1 HIGH (filter 装到 transports.file.hooks 错 — electron-log v5 Logger.js:177 reduce 只读 this.hooks 不读 transport.hooks, 装到死属性) → 修; reviewer-claude 2 HIGH (1 同款 + keep-path 返 undefined 会把 reduce 短路丢全部业务 log) + 1 MED (transportName 门控 + 端到端测) → 全修
  - **R3**: reviewer-codex 0/0/0 + 1 INFO (plan bookkeeping) → 修
  - **0 HIGH/MED 残留,所有 LOW/INFO 已 fold**
- [ ] Step 8 — CHANGELOG + INDEX + archive_plan

## 当前进度

- ✅ 日志扫 5 天 6 类模式，user 选 B + E
- ✅ B 根因 = `src/main/adapters/codex-cli/translate.ts:437` warn level
- ✅ E 根因 = Electron framework `webContents.send` 销毁竞态（应用层 safeSend 全守 isDestroyed，唯 1 处 `webContents.send` 在 `bootstrap-wiring.ts:52`）
- ✅ user 收到 F 解释（F 不动）
- ✅ plan 文件写完

## 下一会话第一步

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/log-noise-and-disposed-20260603.md`（必 cat 详会话记录）
2. Step 1 建 worktree（先 bash 创 + EnterWorktree(path:)，不用 `EnterWorktree(name:)`）：
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-log-noise-and-disposed-20260603 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/log-noise-and-disposed-20260603
   EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/log-noise-and-disposed-20260603")
   ```
3. Step 2-6 在 worktree 内实施（路径全部加 worktree 前缀，避免 §Step 2 末 callout 主仓库污染陷阱）
4. Step 7 跑 simple-review
5. Step 8 归档：CHANGELOG_205.md + INDEX + archive_plan

## 已知踩坑

- **worktree 内跑 vitest 必须用主仓库 Electron binary**（详 message-retention plan §已知踩坑）：worktree 无 node_modules，跑测试走 `/Users/apple/Repository/personal/agent-deck/node_modules/.pnpm/electron@33.4.11/.../Electron` + `ELECTRON_RUN_AS_NODE=1`，**勿 symlink node_modules 进 worktree** 会被 vitest .vite 缓存污染。
- **safeSend 内 catch 必须 instanceof Error + 正则匹配**：避免吞掉 TypeError（caller 代码 bug 应 throw）；框架抛错 message 形如 `Error sending from webFrameMain: Error: Render frame was disposed before WebFrameMain could be accessed`（实测日志样本），捕获 message 子串 `'Render frame was disposed'` 即覆盖全部已知 race 形态。
- **codex-translate 改 warn→debug 影响 dev 终端 console 输出**（silly 级别仍全开）：dev 用户观察 message 路径时不会看到 loader warning —— REVIEW_80 已将 UI emit 路径关掉，dev 调试需要的话自己开 `setLogLevel('debug')`（runtime-logging-electron-log plan §不变量 8 落地）。
- **N1 safeSend 现 contract 是先 return 再 send 无 try/catch**：本 plan 在 `webContents.send` 调用上加 try/catch 不破坏语义（caller 不感知内部加 try/catch；只对抛 framework 已知 race 时 caller 端表现为「正常返回」）。
