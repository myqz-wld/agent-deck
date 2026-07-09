# REVIEW_66 — 历史会话"消失"事件：app.setName 副作用改变 userData 目录 + 数据迁移

- 日期: 2026-05-30
- 类型: Debug / 数据事件（无代码改动 — 用户决策保留新路径，走数据迁移）
- 用户感知严重度: critical（误以为 1065 历史会话丢失）/ 实际: **数据完好无损**

## 现象

1. "问题"(Issues) 渲染页面空白（"暂无 issue"）
2. 历史会话全部消失（标题栏只剩 "1 会话"）

## 根因

`src/main/utils/logger.ts:30` 的 `app.setName('Agent Deck')`（commit `307e3ae`，plan `runtime-logging-electron-log-20260529` §D7 / Step 3.0.4 引入）。

本意（注释 M7）：统一 dev/prod 的**日志路径** `app.getPath('logs')`，避免 dev 落 `~/Library/Logs/Electron/`。

副作用：Electron `app.setName()` 全局改 `app.name`，**同时**改变 `app.getPath('userData')`：

| | userData 目录 |
|---|---|
| 改前（package.json name="agent-deck"） | `~/Library/Application Support/agent-deck/` |
| 改后（setName 值） | `~/Library/Application Support/Agent Deck/` |

`logger.ts` 是 `index.ts` **第一行 import**，在 `db.ts:15`（`app.getPath('userData')` 拼 DB 路径）之前执行 → 应用把 DB 建到了新空目录，读不到旧库。

**两个现象同一根因**：不是 `IssuesPanel.tsx` 渲染 bug，是整个应用换了一个空数据库（sessions + issues 全空）。

## 证据（全程只读）

| 库 | 路径 | sessions | 大小 |
|---|---|---|---|
| 旧（真数据） | `~/Library/Application Support/agent-deck/agent-deck.db` | **1065**（active 480 / closed 551 / dormant 34） | 2.18 GB |
| 新（空） | `~/Library/Application Support/Agent Deck/agent-deck.db` | 2（今日测试） | 4 KB |

- `logger.ts:13` 注释明文 "app.setName('Agent Deck') 让 dev/prod logs path 一致"
- `logger.ts:27-30` M7："app.setName 必须在 app.getPath('logs') 之前调"
- `db.ts:15` `const userDataDir = app.getPath('userData')`
- `package.json` name="agent-deck" / productName="Agent Deck"

## 处理方案（用户决策）

用户选择**保留 `Agent Deck` 路径**（不改 logger.ts setName），把旧库数据迁移到新路径，验证后删旧目录。迁移后 dev/prod 统一用 `Agent Deck/`，无路径漂移遗留。

## 执行步骤

### 已执行（应用运行中安全做 — 只读静止旧目录 + 写全新临时目录，不碰应用在用的库）

```bash
ditto "$HOME/Library/Application Support/agent-deck" "$HOME/Library/Application Support/Agent Deck.incoming"
```

校验通过：DB byte-identical（2188038144）/ sessions 1065 / 顶层 24 项一致 / image-uploads 55 项一致 / settings md5 一致 / `PRAGMA quick_check` = ok

### 待用户执行（停机窗口 — 必须退应用，因 agent 跑在应用内不能自杀进程）

```bash
# 1. 完全退出 Agent Deck 应用（Cmd+Q）
# 2. 终端执行：
cd ~/Library/Application\ Support
mv "Agent Deck" "Agent Deck.emptybak"      # 备份空库（回滚用，暂不删）
mv "Agent Deck.incoming" "Agent Deck"       # 旧数据就位
# 3. 重开应用
```

## 验证 checklist（2026-05-30 已确认）

- [x] 标题栏会话数 ≈ 1065（实测在用库 1067 sessions，迁移后新增 2 个）
- [x] 历史 tab 显示大量会话
- [x] 问题页面正常渲染

## 回滚（验证失败时）

```bash
cd ~/Library/Application\ Support
rm -rf "Agent Deck"
mv "Agent Deck.emptybak" "Agent Deck"       # 还原空库（与改前等价）
# 旧源 agent-deck/ 全程未动，.incoming 可重新生成重试
```

## 清理（已执行 — 2026-05-30）

验证通过后执行；旧源 + 空备份均已删除，仅留在用 `Agent Deck`（1067 sessions / 2.18 GB byte-identical 完好）：

```bash
rm -rf ~/Library/Application\ Support/agent-deck             # 删旧源目录（2.18 GB）✓
rm -rf ~/Library/Application\ Support/Agent\ Deck.emptybak   # 删空库备份 ✓
```

## 遗留风险

1. **旧库 2.18 GB 偏大** — 大概率 events 表膨胀。迁移后历史会话回归，但启动 / 查询可能偏慢。建议后续单独 plan 瘦身（events retention GC / `VACUUM`）。
2. **setName 耦合 logs + userData** — `app.setName` 同时影响两个 path，无法分离。当前已统一到 `Agent Deck`，dev/prod 一致。**未来若改 package.json name 或动 setName 值，userData 会再次漂移 → 重演本事件**。如需解耦，可在 `logger.ts` setName 后显式 `app.setPath('userData', join(app.getPath('appData'), '<固定名>'))` 锁定（本次用户选择不解耦）。
