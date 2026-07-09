# Spike 1 — malformed tool-call 调查 + SDK 升级（0.3.144 → 0.3.158）

> plan: `sdk-upgrade-thinking-fix-20260530`
> 作者会话: ab5259e8（接力会话，SDK 仍是启动时加载的 0.3.144）
> 日期: 2026-05-30

## 动机

App 内 SDK 会话工具调用频繁损坏：模型生成的工具调用**外层 antml wrapper 被损坏成乱码**（典型 `court`），
导致工具调用不被识别、不执行，整块当作 assistant 纯文本输出给用户。前一个接力会话（07427f50）因此卡在
死循环里 ~2.5 小时，连「升级 package.json」「查 DB」这种动作本身都反复被损坏命中，无法推进。

## 修正结论（**推翻**旧「损坏调用不落 DB」的错误说法）

**损坏的工具调用 DOES 落 DB**，以 `kind='message'` + `role='assistant'` 的 message 事件存储。

机制（DB forensics 实证，见下）：

```
外层 <function_calls> / <invoke> 起始 token 被损坏成乱码（如 court）
  → CLI/SDK 的工具调用解析器匹配不到合法 wrapper
  → 整块（含损坏的 court + 完好的内层 <invoke.../> params）被当作 assistant text 输出
  → adapter translate 成 kind='message' 事件写入 events 表
  → UI 当纯文本渲染给用户（看起来像「模型把工具调用打印出来了」）
  → 工具实际**从未执行**
```

关键特征：**外层 wrapper 损坏，内层 `<invoke name=...>` / `<parameter name=...>` 结构完好**。所以损坏块在
DB 里能用 `payload_json LIKE '%invoke name=%'` 精确捞出来。

## 实测铁证（DB forensics）

DB: `~/Library/Application Support/Agent Deck/agent-deck.db`（2.2 GB；用 `sqlite3 -readonly` CLI 查，
不碰 better-sqlite3 node binding，无 ABI landmine）。

> ⚠️ FTS5 索引搜 `malformed` 不可信：被本次调查的 narration + Bash 命令污染（每条提到 "malformed" 的
> 消息/命令都进 events）。FTS `malformed` 命中 1091 条多为污染。**改用 `kind='message'` + 直接 LIKE
> `'%invoke name=%'` 捞 assistant text 里泄漏的工具调用语法**——这是干净信号（正常 narration 不会出现裸
> `invoke name=`）。

**查询**：
```sql
SELECT substr(session_id,1,8) sid, COUNT(*) n,
       datetime(MIN(ts)/1000,'unixepoch','localtime') first,
       datetime(MAX(ts)/1000,'unixepoch','localtime') last
FROM events
WHERE kind='message' AND payload_json LIKE '%invoke name=%'
  AND session_id NOT LIKE 'ab5259e8%'   -- 排除本调查会话自身 narration
GROUP BY substr(session_id,1,8);
```

**结果**：全部 11 条真实损坏集中在**单一会话 07427f50**，时间 13:02:38 → 15:32:16（即那个卡死 2.5h 的会话）。

**样本 1（id=329524，15:32）—— 就是「升级 package.json」那条没执行成功的 Edit**：
```
{"text":"收到，不绕了，直接升级。\n\ncourt\n<invoke name=\"Edit\">\n
<parameter name=\"file_path\">/Users/apple/Repository/personal/agent-deck/package.json</parameter>\n
<parameter name=\"old_string\">    \"@anthropic-ai/claude-agent-sdk\": \"^0.3.144\",</parameter>\n
<parameter name=\"new_string\">    \"@anthropic-ai/claude-agent-sdk\": \"^0.3.158\",</parameter>\n
</invoke>","role":"assistant"}
```
外层 wrapper → `court`，内层 Edit params 完好 → 未执行 → **这就是 package.json 一直停在 `^0.3.144`
（接力时仍未更新）的根因**。

**样本 2（id=329520，15:10）—— 同款 `court` 损坏，杀掉的是 DB 只读查询**：
```
{"text":"malformed 又命中（损坏=未执行），重试这条只读查询。\n\ncourt\n<invoke name=\"Bash\">...","role":"assistant"}
```

## Spike 对照实验（standalone `query()` 无法复现）

runner 复刻应用真实 `query()` 调用方式（model 透传 / `systemPrompt: {preset:'claude_code'}` /
settingSources / canUseTool / 多轮 streaming input）。raw dump 落各 `<tag>-raw.jsonl`。

| run | SDK | 场景 | tool calls | malformed |
|---|---|---|---|---|
| caseA | 0.3.144 | 单轮纯文本 | 0 | **0** |
| caseA2_tools | 0.3.144 | 单轮 + 工具 | — | **0** |
| caseA3_multi / caseB3_multi | 0.3.144 | 多轮 | — | **0** |
| caseA4_canuse / caseB4_canuse | 0.3.144 | canUseTool 权限路径 | — | **0** |
| multiA_144 | 0.3.144 | 多轮 streaming input | — | **0** |
| **multiB_158** | **0.3.158** | 多轮 streaming input | 6 | **0** |

**结论**：standalone 复刻应用调用方式，0.3.144 与 0.3.158 **都 0 复现**。bug 只在真实 app 的长会话里爆发。
→ 升级后 multiB_158 仍 0 malformed = **无回归**，但**无法在 spike 证明 fix**（无 repro 就无 fix 验证）。

## 升级动作（已执行 + 已验证）

- `package.json`: `@anthropic-ai/claude-agent-sdk` `^0.3.144` → `^0.3.158`
- `pnpm install`：lockfile → 0.3.158（8 个平台 native pkg 同步）；`postinstall` 重建 better-sqlite3
  against Electron 33.4.11（无 ABI landmine）
- 验证：`pnpm typecheck` ✅ / `pnpm build` ✅ / lockfile 0 处残留 `0.3.144` 引用 / native darwin-arm64
  0.3.158 已 link（`.pnpm` 里残留的 `*0.3.144` 目录是孤儿，下次 store prune 回收，不被打包/运行）

## 残留风险 / 未验证假设

1. **升级未证明修复**：standalone 无法复现 → 真实验证只能靠重启 app 后长会话实跑观察。
2. **running app 仍是 0.3.144**：node_modules 已 0.3.158，但运行中的 app 进程是启动时加载的 SDK，
   **必须重启**（dev：重启 `pnpm dev`；packaged：`pnpm dist` 重新打包 + 覆盖安装）才会加载 0.3.158。
   本报告作者会话（ab5259e8）自身就跑在旧 0.3.144 上。
3. **假设（*未验证*）**：malformed 率与「累积上下文长度 / MCP tool 数量 / system prompt 体积」正相关。
   证据：唯一爆发会话 07427f50 是 2.5h 长会话；spike 短上下文 + 同模型同 preset 0 复现。app 比 spike 多了：
   完整 agent-deck CLAUDE.md append + user/project/local CLAUDE.md（settingSources）+ 15+ MCP tool schema。
4. **若升级后仍复现**，区分两条路：
   - **模型侧**（thinking-max 模型在长上下文下解码自身 `<...>` special token 损坏）→ SDK 升级无法修，
     需换模型 / 砍上下文（减 MCP tool / 精简 system prompt）/ 等 Anthropic 模型侧修复。
   - **CLI 侧**（bundled CLI 解析容错不足）→ 继续追更高版本 SDK CLI。
   plan 名 `sdk-upgrade-**thinking**-fix` + 唯一爆发会话用 thinking-max 模型 → 模型侧嫌疑更大（*未验证*）。
