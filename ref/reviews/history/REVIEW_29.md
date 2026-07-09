---
review_id: 29
reviewed_at: 2026-05-13
expired: false
skipped_expired:
heterogeneous_dual_completed: false  # 用户授权的「单点 bug 修」直接修，未走双异构对抗；现场验证（rollup 报错 + chunk 行为对照 + sqlite_master 索引核实 + bootstrap log 完整观察）足够硬
---

# REVIEW_29: commit & push & 打包 & 安装 流程暴露两个独立 bootstrap-blocking bug —— refractor v5 ESM exports 严格化 + v014 漏 DROP partial index

## 触发场景

用户跑「commit & push & 打包 & 安装」一气呵成的全套流程，**dev 模式下完全不报**的两个独立 bug 在打包 / 启动两个不同阶段暴露：

1. **打包阶段**：第一次 `pnpm dist` 失败：

   ```
   [vite]: Rollup failed to resolve import "refractor/lang/bash"
     from "/.../src/renderer/components/MarkdownText.tsx".
   This is most likely unintended because it can break your application at runtime.
   ```

   该 import 由上一个 commit `fe1effe feat(ui): MarkdownText 加代码块 syntax highlighting + TeamDetail messages 接 Markdown` 引入；dev 模式下 vite deps optimizer 兜底拿到模块没暴露；打包 production rollup 严格按 v5 `package.json` `exports` 字段（`"./*": "./lang/*.js"`）解析直接挂掉。

2. **bootstrap 阶段**（修完 #1 重打包重装后）：wrapper ping 验证暴露 main 进程 bootstrap fatal：

   ```
   bootstrap failed SqliteError: error in index idx_sessions_team_name after drop column: no such column: team_name
       at Database.exec (.../node_modules/better-sqlite3/lib/methods/wrappers.js:9:14)
       at /Applications/Agent Deck.app/Contents/Resources/app.asar/out/main/index.js:1197:12
       at sqliteTransaction (.../better-sqlite3/lib/methods/transaction.js:65:24)
       at initDb (.../app.asar/out/main/index.js:1202:5)
       at bootstrap (.../app.asar/out/main/index.js:11217:3)
   ```

   v014 migration `bb13b32 feat: plan team-cohesion-fix Phase F — 团队级生命周期清理（D6 被动 + D7 主动）` 落地时注释错误地写「v006 只 ADD COLUMN，DROP 安全」，但 v006 实际同时建过 `idx_sessions_team_name ON sessions(team_name) WHERE team_name IS NOT NULL` 部分索引；SQLite ALTER TABLE DROP COLUMN 拒绝 column 被 index 引用 → 整个 v014 migration 事务回滚 → 应用 bootstrap fatal 起不来。

两个 bug 共同点：

- **dev 模式 100% 静默**（vite optimizer 兜底 / SQLite 不会跑生产用户 DB 迁移）
- **首次 production / 首次新装 .app 必触发**（不是概率性）
- **任何 git 静态检查抓不到**（typecheck 通过 / build 步骤前的 unit test 通过）

## 方法

**单方现场实证（未走异构对抗）**：两 bug 各自证据链可一次性闭环（rollup 报错 + 包结构核实 + 修法实证 / 错误堆栈 + sqlite_master 索引核实 + 修法实证）。所有结论带「现场验证手段」。trivial 范围（单点 typo 级 import 路径错配 + migration 漏一行 DROP INDEX），按 CLAUDE.md「决策对抗」节 trivial 例外不走双对抗。

**范围**：4 个文件 + 1 个 migration + 1 个 package.json。

```text
package.json                                                # +1 行 refractor 提为直接依赖
src/renderer/components/MarkdownText.tsx                    # 15 行 import 路径修正（v3→v5）
src/renderer/global.d.ts                                    # ambient shim pattern v3→v5
src/main/store/migrations/v014_drop_sessions_team_name.sql  # +1 行 DROP INDEX + 注释修正
```

**机器可读范围**（File-level Review Expiry 用）：

```review-scope
package.json
src/main/store/migrations/v014_drop_sessions_team_name.sql
src/renderer/components/MarkdownText.tsx
src/renderer/global.d.ts
```

**约束**：本 review 不展开整体扫描，专注本次两 bug + 修复。

## 三态裁决结果

### ✅ 真问题（现场实证）

| # | 严重度 | 文件:行号 | 问题 | 验证手段 |
|---|---|---|---|---|
| 1 | HIGH | [src/renderer/components/MarkdownText.tsx:8-22](../../src/renderer/components/MarkdownText.tsx) + [package.json:37-38](../../package.json) + [src/renderer/global.d.ts](../../src/renderer/global.d.ts) | **refractor v5 ESM exports 严格化 + pnpm strict isolation 联合坑**：(a) v5 `package.json` 的 `exports` 字段改成 `"./*": "./lang/*.js"`，正确 import 形态是 `refractor/<lang>` 不再是 v3 老风格 `refractor/lang/<lang>`；(b) refractor 是 react-syntax-highlighter@16.1.1 的传递依赖，pnpm strict isolation 下不暴露在 root `node_modules`，production rollup 严格 resolve 时找不到；(c) 即便上面两个修了，TS `moduleResolution: "node"` 不识别 conditional exports，typecheck 仍 TS2307 全报。**dev 模式**：vite deps optimizer 走 `.pnpm/refractor@5.0.0/node_modules/refractor/lang/*.js` 老路径成功兜底，路径写法对错都能跑。 | (a) `cat node_modules/.pnpm/refractor@5.0.0/node_modules/refractor/package.json` 拿到 `"exports": {".": "./lib/common.js", "./all": "./lib/all.js", "./core": "./lib/core.js", "./*": "./lang/*.js"}` 铁证 v5 子路径形态是 `refractor/<lang>`；(b) `ls node_modules/refractor/` → "No such file or directory"，`grep -E "refractor" package.json` 修前空，证明传递依赖未暴露；(c) `pnpm typecheck` 修完 import 后报 `error TS2307: Cannot find module 'refractor/jsx' ... There are types at .../refractor/lang/jsx.d.ts, but this result could not be resolved under your current 'moduleResolution' setting. Consider updating to 'node16', 'nodenext', or 'bundler'.`，14 处全报；(d) 修后 `pnpm dist` 二轮 `✓ 520 modules transformed` 全过 + `pnpm typecheck` 全过。 |
| 2 | HIGH | [src/main/store/migrations/v014_drop_sessions_team_name.sql:60](../../src/main/store/migrations/v014_drop_sessions_team_name.sql) + [src/main/store/migrations/v006_sessions_team_name.sql:11-12](../../src/main/store/migrations/v006_sessions_team_name.sql) | **v014 注释错误说「v006 只 ADD COLUMN，DROP 安全」，但 v006 实际同时建了 `idx_sessions_team_name ON sessions(team_name) WHERE team_name IS NOT NULL` partial index**。SQLite 3.35+ ALTER TABLE DROP COLUMN 拒绝 column 被任何 index 引用（含 partial index 的 WHERE 表达式），v014 直接 `ALTER TABLE sessions DROP COLUMN team_name` 必挂在「error in index idx_sessions_team_name after drop column」→ migration runner `db.transaction()` 全部回滚 → user_version 不 bump → 下次启动重跑 v014 还是同样挂 → 应用永远 bootstrap fatal 起不来。**任何升级 + 任何全新装**都触发（v006→v014 路径 + 0→v014 路径都中招）。 | (a) `grep -rn "idx_sessions_team_name" src/main/store/ --include="*.sql"` 单一来源 [v006_sessions_team_name.sql:11](../../src/main/store/migrations/v006_sessions_team_name.sql) `CREATE INDEX IF NOT EXISTS idx_sessions_team_name ON sessions(team_name) WHERE team_name IS NOT NULL`；(b) v014 注释 [src/main/store/migrations/v014_drop_sessions_team_name.sql:13-14](../../src/main/store/migrations/v014_drop_sessions_team_name.sql)（修前）原文「sessions.team_name 列没有 index（v006 只 ADD COLUMN），DROP 安全」与 v006 实际矛盾；(c) [src/main/store/db.ts:33-40](../../src/main/store/db.ts) `db.transaction()` 包裹 migration 全 step，v014 失败必整事务回滚；(d) bootstrap log 第一次完整堆栈直指 `initDb (.../out/main/index.js:1202:5) → bootstrap`；(e) 修后第二次 wrapper ping log 干净：`[db] migrated to v14 (drop_sessions_team_name)` + `[db] migrated to v15 (agent_deck_messages_reply_to)` + 4 adapter 起来 + window 显示 + session 创建。 |

### ❌ 反驳（被现场核实证伪 / 阶段性假设否定）

| 阶段假设 | 反驳依据 |
|---|---|
| 「打包前 typecheck 跑过 → 任何打包失败都是 build/打包链问题」（隐含倾向：仍在 pnpm dist / electron-builder 配置层找原因） | 第一次 dist 失败 stack 顶端是 vite 报 `Rollup failed to resolve import "refractor/lang/bash"` from `MarkdownText.tsx`，定位明确指向**源码 import 路径**而非 build 配置；进一步 `cat refractor@5/package.json exports` 与 v3 风格不一致铁证根因；不再追 build chain，直接修源码 |
| 「DB migration 之前都跑通了 → v014 必然没问题」（隐含倾向：去其他 bootstrap 步骤找原因） | 第二次 wrapper ping log 第一行 `bootstrap failed SqliteError: error in index idx_sessions_team_name after drop column` 指明 `at initDb` + `at bootstrap`，错误源头在 migration 阶段；进一步 grep `idx_sessions_team_name` 全 codebase 锁定 v006 创建源 + 与 v014 注释「v006 只 ADD COLUMN」矛盾铁证；不追其他 bootstrap 步骤 |

### ❓ 部分 / 未验证

| 现场 | 视角 | 是否已验证 | 结论 |
|---|---|---|---|
| 用户生产 DB（`~/Library/Application Support/Agent Deck/agent-deck.db`）的实际 user_version 状态 | 推测：本机当前没该文件（`ls "$HOME/Library/Application Support/Agent Deck/agent-deck.db" → No such file`），所以本次新装是 0→v15 全跑路径；但其他用户 / 历史本机 DB（如曾经手动删过的 / 有备份的）可能停在某个 v013 状态 | **本机零状态已确认**（ls 无文件），其他用户场景**未单独验证** | 不修；migration 事务化设计保证「v014 失败回滚到 v013 → 修后重跑 v014 一次成功」对任何 user_version ≤ 13 的 DB 都成立，无需额外兜底 |
| 是否还有别的 v00X migration 创建过 column-bound index 但对应 DROP COLUMN migration 漏了 DROP INDEX | 推测：本次修法只针对 v014 同根因；如果未来还有类似 DROP COLUMN migration 落地需要复用同款检查 | **未做全 migration 扫描** | 不修，但写 P30 候选沉淀「migration drop column 前必须 grep 引用该列的 index / view / trigger」预防再撞 |
| TS `moduleResolution: "bundler"` 升级是否更优解（替代 ambient shim） | 推测：v5 ESM 包都用 conditional exports，long-term 项目级 `bundler` 模式更通用；但本次最小侵入选 shim 路径 | **未做 bundler 模式实测**（评估：要全 renderer + main typecheck 全跑通确认无回归，超出本 hotfix 范围） | 不修；本次保 ambient shim 路径不引入项目级 ts 配置改动；后续如果再撞 ≥ 1 个新 v5 ESM 包同问题，应升级 `moduleResolution: "bundler"` 一次性收口 |

## 修复（本 review 直接落地）

### HIGH-1：refractor v5 import 路径 + ambient shim 适配（[`c3d843b`](https://github.com/myqz-wld/agent-deck/commit/c3d843b)）

**diff 范围**：

- [src/renderer/components/MarkdownText.tsx](../../src/renderer/components/MarkdownText.tsx)：15 行 import 路径全改 `refractor/<lang>`（v5 正确形态），顶部 NOTE 注释解释 v5 exports 字段语义
- [package.json](../../package.json)：把 `refractor: "^5.0.0"` 从「react-syntax-highlighter 传递依赖」提为直接依赖（pnpm strict isolation 不会把传递依赖暴露到 root `node_modules`，production rollup 严格 resolve 找不到）
- [src/renderer/global.d.ts](../../src/renderer/global.d.ts)：ambient shim pattern 同步改 `declare module 'refractor/*'`（兜 TS `moduleResolution: "node"` 不识别 conditional exports 的 TS2307 报错），注释完整说明「dev / prod / TS 三套 resolver 行为分歧」

### HIGH-2：v014 DROP COLUMN team_name 前先 DROP partial index（[`5120ad8`](https://github.com/myqz-wld/agent-deck/commit/5120ad8)）

**diff 范围**：

- [src/main/store/migrations/v014_drop_sessions_team_name.sql](../../src/main/store/migrations/v014_drop_sessions_team_name.sql)：Step 2 之前加 `DROP INDEX IF EXISTS idx_sessions_team_name;`；注释修正 v006 实际状态描述（v006 同时建了 partial index 不只是 ADD COLUMN）+ 说明 SQLite ALTER TABLE DROP COLUMN 与 partial index 的冲突机制（`WHERE team_name IS NOT NULL` 表达式中 column 引用触发拒绝）

**等价性论证**：

- DROP INDEX 在 DROP COLUMN 之前，column 仍存在 → DROP INDEX 安全；DROP COLUMN 后 column 消失 → 新 schema 不需要该 index（universal team backend `agent_deck_team_members.team_id` 索引已是 team 关系唯一权威），不需要在新 schema 重建
- 事务化保证：v014 在 db.ts:33 `db.transaction()` 内整 step 跑，DROP INDEX + DROP COLUMN 原子；如再有失败回滚到 v013 干净
- 老用户路径（v013 已成功，v014 第一次跑挂）：本次修法把 v014 跑通后 user_version 推到 14，下个启动直接进 v15 不再卡
- 全新装路径（user_version=0 → 一路跑）：v006 建 sessions.team_name + idx_sessions_team_name → v014 DROP INDEX + DROP COLUMN，原子事务 + 老 schema 不在 column 引用上挂

### 验证

- `pnpm typecheck` ✅（HIGH-1 修完 + ambient shim 兜底）
- `pnpm dist` ✅（HIGH-1 修完）：vite SSR + rollup `✓ 520 modules transformed` + `out/main/index.js 416.19 kB` + electron-builder 成功输出 `release/mac-arm64/Agent Deck.app` + `release/Agent Deck-0.1.0-arm64.dmg`
- 覆盖装到 /Applications + ad-hoc 重签 + 清 quarantine + wrapper `agent-deck new --cwd "$PWD" --prompt "ping"` 触发 → bootstrap log 干净：

  ```
  [db] migrated to v14 (drop_sessions_team_name)
  [db] migrated to v15 (agent_deck_messages_reply_to)
  [adapter] claude-code initialized
  [adapter] codex-cli initialized
  [adapter] aider initialized
  [adapter] generic-pty initialized
  [agent-deck-mcp] HTTP transport mounted at /mcp
  [hook-server] listening on 127.0.0.1:47821
  [universal-message-watcher] started (poll=250ms, debounce=50ms, batch=16)
  [window] shown via did-finish-load
  [session-mgr] hook→sdk re-claim (new sid): sessionId=fd8cef1b-1b13-4e10-87ce-48e003d6f3cd
  ```

  HIGH-1 + HIGH-2 全收口，应用拉起 / 4 adapter 注册 / DB 全 migrate / hook-server 47821 / MCP HTTP transport / window 显示 / 新会话创建全部正常。

## 关联 changelog

无。本 review 内直接落地（与 REVIEW_10 / 11 / 12 / 13 / 16 / 25 / 26 同惯例：纯 bug fix 不引入功能变更，不单开 CHANGELOG）。

## Agent 踩坑沉淀

本次提炼 2 条 agent-pitfall 候选（追加到 [.claude/conventions-tally.md](../../.claude/conventions-tally.md)「Agent 踩坑候选」section）：

- **P29**：第三方包升级到 v5 / 引入 ESM `exports` 字段 + 是传递依赖（pnpm strict isolation）联合时，dev 与 prod 的 resolver 行为分歧 → 打包前测不出，prod build / `tsc` 不同 resolver 各自报不同错。
- **P30**：写 / review SQLite migration 时如要 DROP COLUMN，必须**先 grep 整 codebase 找所有引用该 column 的 index / view / trigger** 再判断「DROP 安全」。注释凭旧记忆判断「无 index」必埋 ALTER TABLE 失败回滚 → bootstrap fatal 雷。

同主题再撞 2 次会触发升级到 CLAUDE.md 项目约定。
