---
review_id: 25
reviewed_at: 2026-05-12
expired: false
skipped_expired:
heterogeneous_dual_completed: false  # 用户授权的「单点 bug 修」直接修，未走双异构对抗；现场验证（chunk 文件检查 + ping log 对比）足够硬
---

# REVIEW_25: 打包后 main 进程 bootstrap 报 `syncAgentDeckSection / syncSkills is not a function` —— vite SSR + 多处 dynamic import 同一模块 → chunk 空壳

## 触发场景

「打包 & 安装」流程跑 wrapper ping 验证时，捕捉到打包版 main 进程 bootstrap log 出现两条新错误（dev 模式不报）：

```
[bootstrap] syncAgentDeckSection 失败 TypeError: syncAgentDeckSection is not a function
    at /Applications/Agent Deck.app/Contents/Resources/app.asar/out/main/index.js:10551:7
[bootstrap] syncSkills 失败 TypeError: syncSkills is not a function
    at /Applications/Agent Deck.app/Contents/Resources/app.asar/out/main/index.js:10558:7
```

不影响 application 拉起 / DB 迁移 / adapter 注册 / window 显示 / session 创建，但 codex AGENTS.md 同步 + skills 镜像两个**功能在打包版完全不工作**（dev 模式 ESM 直 import 测不出来）。

## 方法

**单方现场实证（未走异构对抗）**：用户授权直接修的 bug，证据链可一次性闭环（cat chunk → 改 specifier → 重打包 → cat chunk 仍空 → 对比 transport-http 现场实证 → static import 修法 → chunk 消失 + ping log 干净）。所有结论带「现场验证手段」。

**范围**：5 处 dynamic import + 引用的 3 个 module + 1 个 vite config 检查。

```text
src/main/index.ts                          # 调用方 × 2（agents-md / skills bootstrap）
src/main/ipc/settings.ts                   # 调用方 × 3（toml-writer / agents-md / skills 即改即生效）
src/main/codex-config/agents-md-installer.ts  # 被引用模块（顶层无副作用）
src/main/codex-config/skills-installer.ts     # 被引用模块（顶层无副作用）
src/main/codex-config/toml-writer.ts          # 被引用模块（顶层无副作用，同 bug 但 ping 触发不到）
electron.vite.config.ts                    # alias 配置确认
```

**机器可读范围**（File-level Review Expiry 用）：

```review-scope
electron.vite.config.ts
src/main/codex-config/agents-md-installer.ts
src/main/codex-config/skills-installer.ts
src/main/codex-config/toml-writer.ts
src/main/index.ts
src/main/ipc/settings.ts
```

**约束**：本 review 不展开整体扫描，专注本根因 + 修复。

## 三态裁决结果

### ✅ 真问题（现场实证）

| # | 严重度 | 文件:行号 | 问题 | 验证手段 |
|---|---|---|---|---|
| 1 | HIGH | [src/main/index.ts:158-175](../../src/main/index.ts) + [src/main/ipc/settings.ts:101-149](../../src/main/ipc/settings.ts) | **同一模块在 main 进程被 ≥ 2 处 dynamic import** → vite SSR + rollup 把模块代码 inline 进主 `index.js`，单独 chunk 文件只剩 `require(...)` 空壳没有任何 `module.exports` / `Object.defineProperty(exports,...)`。dynamic import 拿到的就是这个空 stub，destructure 到 undefined → `TypeError: X is not a function`。 | (a) `cat out/main/agents-md-installer-cYcOGELy.js` 显示文件全文只有 8 行 `require(...)`，零 export；(b) 对照组 `cat out/main/transport-http-Ctvu5mtC.js`（**唯一**一处 dynamic import）有 `Object.defineProperty(exports, Symbol.toStringTag, ...)` + 完整函数体；(c) `grep -c "syncAgentDeckSection\|syncSkills" out/main/index.js = 12` 证明实现已 inline 进主 chunk；(d) 修后 `out/main/` 下三个 installer chunk 文件**完全消失**，主 `index.js` 从 382 kB → 390 kB（+8 kB 正是被 inline 进来的代码量）；(e) wrapper ping 后 bootstrap log 两条 TypeError 完全消失。 |

### ❌ 反驳（被现场核实证伪）

| 假设 | 反驳依据 |
|---|---|
| 「两条 specifier 字符串不一致（`./codex-config/...` 相对 vs `@main/codex-config/...` alias）导致 vite 解析成两个 chunk 入口」 | 把 `src/main/index.ts` 两条 dynamic import 改成 `@main/...` 与 settings.ts 完全一致后**重打包**，chunk 文件名 + 大小 0.17 kB **完全不变**（`agents-md-installer-cYcOGELy.js` hash 都没变），cat 内容仍是空壳。说明 specifier 一致性**不是**根因——真正根因是「同模块多处 dynamic import + vite SSR 默认 chunking」。 |

### ❓ 部分 / 未验证

| 现场 | 视角 | 是否已验证 | 结论 |
|---|---|---|---|
| `event-bus.ts` / `agent-deck-team-repo.ts` 打包 log warning 提示「dynamic import + static import will not move into another chunk」 | 推测：vite 看到同模块同时被 static + dynamic import 时**放弃** dynamic chunk 拆分（warning 中文字面意），实际生成的代码会把 dynamic import 当 static 处理（拿到正常 export），所以这两个不会炸 | 未单独验证，但**无报错说明被这条 warning 救了**——本次三个 installer 模块**没有任何静态 import 路径**（只被 dynamic import），rollup 才走「拆 chunk + inline 到父 chunk + chunk 文件变空」这条死路 | 不修；后续若新加模块**只**被 dynamic import 引用（无静态 import）需 grep 同 specifier 引用次数，> 1 次必须改 static |

## 修复（本 review 直接落地）

### HIGH-1：5 处 dynamic import → static import + 同步 try/catch

**diff 范围**：

- [src/main/ipc/settings.ts](../../src/main/ipc/settings.ts)
  - 顶部新增 3 条 static import（`writeMcpServersToCodexConfig` / `syncAgentDeckSection` / `syncSkills`）+ 大段 NOTE 注释解释为什么禁用 dynamic import
  - `applyCodexMcpServers` / `applyCodexAgentsMd` / `applyCodexSkills` 三个 helper 改为同步直接调，去掉 `void import(...).then(...).catch(...)` 包装
- [src/main/index.ts](../../src/main/index.ts)
  - 顶部新增 2 条 static import（`syncAgentDeckSection` / `syncSkills`）+ 大段 NOTE 注释
  - bootstrap 段两条 dynamic import 改为同步 try/catch 直接调

**等价性论证**：三个被引模块顶层都纯 `import {...}` + `export function ...`（[agents-md-installer.ts](../../src/main/codex-config/agents-md-installer.ts) / [skills-installer.ts](../../src/main/codex-config/skills-installer.ts) / [toml-writer.ts](../../src/main/codex-config/toml-writer.ts) 头部 30 行已现场确认**无任何 module-level 副作用**，无 `app.getPath()` 调用 / 无 IPC 注册 / 无 fs 写入），static import 与 dynamic import 在「函数调用时机」上等价（顶层只是模块解析，函数行为由 caller 控制）。settings.ts 三个 helper 本来就被 `applyAll` 同步串行调用，dynamic import 反而把 sync 路径异步化，去掉后语义 + 错误处理（warn 不抛）完全保留。

### 验证

- `pnpm typecheck` ✅
- `pnpm dist` ✅，输出 chunk 列表确认 3 个空壳文件全部消失：
  ```
  out/main/transport-http-Ctvu5mtC.js    2.16 kB
  out/main/index.js                    390.73 kB
  ```
- 覆盖装到 /Applications + ad-hoc 重签 + wrapper ping → bootstrap log 干净，两条 `TypeError` 完全消失，所有 adapter / hook-server / window / session 正常。

### 守门提醒

`src/main/ipc/settings.ts` + `src/main/index.ts` 顶部的 NOTE 注释已说明「禁止改回 dynamic import + 原因」，下次有人想「lazy load 减少 main 启动开销」回退前必须读这条 NOTE。

## 关联 changelog

无。本 review 内直接落地（与 REVIEW_10 / 11 / 12 / 13 / 16 同惯例：纯 bug fix 不引入功能变更，不单开 CHANGELOG）。

## Agent 踩坑沉淀

本次提炼出 1 条 agent-pitfall 候选（追加到 `.claude/conventions-tally.md`「Agent 踩坑候选」section）：

- **「main 进程同模块多处 dynamic import → vite SSR + rollup 打包 chunk 变空壳，dev 模式测不出」** —— 同主题再撞 2 次会触发升级到 CLAUDE.md 项目约定。
