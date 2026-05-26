# spike1: Claude SDK `--resume <sid>` 契约 + jsonl 路径

> spike 完成日期：2026-05-20
> runner: `spike1-runner.mjs` (read-only 静态实测,不烧 OAuth quota)
> log: `spike1.log`

## 动机

plan §设计决策 D1 假设「加 sessions.cli_session_id 列让 sessions.id 对外稳定 + cli_session_id 变化时 SDK `--resume <cli_session_id>` 能继续工作」。本 spike 验证这一假设的关键前提:

1. SDK `--resume <sid>` arg 是否原样透到 CLI binary?
2. CLI 起 jsonl 文件时用的 sid 是 SDK options.resume 还是 CLI 内部新生成?
3. jsonl 路径 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` 中 `<sid>` 等于 jsonl body 内 `sessionId` 字段吗?
4. encodeClaudeProjectDir 规则与应用层 platform.ts 内 impl 一致?

## 实测命令 + 实测结果

### 实测 1.1: SDK `--resume` verbatim 透传

```bash
# /Users/apple/Repository/personal/agent-deck/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.144_*/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
grep "resume" sdk.mjs
```

```javascript
// sdk.mjs L? (minified): if(k)i.push("--resume",k);
// k = options.resume (variable rename), i = CLI args 数组
// 条件: k 非空 → push "--resume" + k 字面值入 args
```

**结论 1.1**: ✅ SDK 把 `options.resume` 字符串原样作为 `--resume` 的值透到 CLI 子进程,**无任何转换**。这意味着应用层传 `<rec.cli_session_id>` 而非 `<rec.id>` 即能让 CLI 找到对应 jsonl,前提 (2)+(3) 成立。

### 实测 1.2: jsonl 文件名 == body.sessionId

抽样 `~/.claude/projects/-Users-apple-Repository-personal-agent-deck/` 下最近 mtime 5 个 .jsonl 文件:

| jsonl 文件名 (UUID) | body 第一条 record `sessionId` 字段 | match |
|---|---|---|
| `60fbbc92-c91e-4dd6-930f-acc412b69da1.jsonl` | `60fbbc92-c91e-4dd6-930f-acc412b69da1` | ✅ |
| `e3739004-198b-4397-967e-32ff3bcf1125.jsonl` | `e3739004-198b-4397-967e-32ff3bcf1125` | ✅ |
| `4053c0cd-3588-4a31-ad17-71147718edb1.jsonl` | `4053c0cd-3588-4a31-ad17-71147718edb1` | ✅ |
| (其余 2 个 sample 同款 ✅) | | ✅ |

**结论 1.2**: ✅ jsonl 文件名 100% 等于文件内第一条 record 的 sessionId 字段值 (5/5 sample,0 mismatch)。

### 实测 1.3: encodeClaudeProjectDir 规则一致

```javascript
function encodeClaudeProjectDir(cwd) {
  return '-' + cwd.split('/').filter(Boolean).join('-');
}
encodeClaudeProjectDir('/Users/apple/Repository/personal/agent-deck')
// → '-Users-apple-Repository-personal-agent-deck'
```

实际目录 `~/.claude/projects/-Users-apple-Repository-personal-agent-deck` 存在 ✅,与应用层 `src/main/platform.ts:23` 实现字面对齐。

### 实测 1.4: SDK forkSession 接口存在

`grep -E forkSession sdk.mjs` 命中 → SDK API 表层暴露 `forkSession()` 方法,但**不影响本 spike**。我们关心的是 `query({resume})` 路径下 CLI 的隐式 fork (CHANGELOG_27 / REVIEW_6 — 应用代码 `stream-processor.ts:283-285` 实测铁证有详细注释:`resume=OLD_ID, prompt='ping' → first session_id=NEW_ID`,与 SDK 文档承诺「forkSession 默认 false 不 fork」不一致)。

forkSession 走另一条 SDK API,与 query({resume}) 隐式 fork 不直接相关。spike2 专门测隐式 fork。

## 结论

✅ **D1 假设全部成立**:

1. SDK `--resume <sid>` 透到 CLI binary args — 应用层换 cli_session_id 即可让 CLI 找到 jsonl
2. jsonl 文件名 = CLI 写入时实际 sessionId,**与 SDK options.resume 入参可能不同** (隐式 fork 时 jsonl 文件名是 NEW_ID 而非 OLD_ID)
3. encodeClaudeProjectDir 规则与应用层 impl 字面对齐,无需修改
4. CLI 隐式 fork 是 query({resume}) 路径核心边界 (spike2 专测)

**实施推论 (D1 设计可行)**:
- 应用层 `sessionRepo.cli_session_id` 列存 CLI 当前 thread sid (= jsonl 文件名)
- `sessions.id` 对外稳定 (caller / wire prefix / team / mcp tool 永远拿这个)
- 各 fallback / fork rename 路径只 UPDATE `cli_session_id` 列,不改 `sessions.id`
- SDK `query({resume})` 调用时传 `<rec.cli_session_id>` 而非 `<rec.id>`
- jsonl 路径预检走 `<encoded-cwd>/<rec.cli_session_id>.jsonl`

## 残留风险

- ⚠️ **encodeClaudeProjectDir Win 平台规则未实测** (`platform.ts:13-25` jsdoc 已说 Win 端规则未官方文档,按推测用 `path.sep` split 后 join `-`)。本 spike 仅验 macOS — Win 用户实际行为如有偏差,影响 jsonl 预检命中率。**优先级 LOW** (本 plan 只动 mac/linux 路径)。
- ⚠️ **CLI 5301 个 jsonl 文件 sample 仅取最近 5 个**。理论上历史文件中可能有 mismatch (CLI 早期版本规则不同)。本 plan 看的是当前 SDK 0.3.144 行为,历史 mismatch 不影响实施。
- ⚠️ **SDK 0.3.144 minified 代码 `if(k)i.push("--resume",k)`**: `k` 变量名是 minify 后,实际指向哪个 option 字段需通过上下文 cross-reference 确认。已在 spike1-runner.mjs L17 grep 命中目标行确认是 `options.resume` (前后字段顺序与 sdk.d.ts 中 Options 类型字段顺序一致)。

## D1 验证标注 (回写 plan)

`*待 spike 验证*` → `*已 spike 1.1-1.4: SDK `--resume <sid>` verbatim 透传 + jsonl 文件名 == body.sessionId (5/5 sample) + encodeClaudeProjectDir 一致*`
