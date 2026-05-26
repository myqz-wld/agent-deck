---
review_id: 31
reviewed_at: 2026-05-13
expired: false
skipped_expired:
heterogeneous_dual_completed: false  # 用户主动中止 deep-code-review SKILL 后的 4 bug 单点修；每条都有现场实证（DB 铁证 / 类型签名对比 / schema cap 数字 / 真 stderr stack），按 trivial 例外不走双异构对抗
---

# REVIEW_31: deep-code-review SKILL 实测暴露 5 个独立 bug — agent body 注入 / wait_reply timeout / teammate display name / pre-existing test setup

## 触发场景

用户调 `agent-deck:deep-code-review` SKILL 准备 review 最近 50 commit，lead spawn 两个 reviewer teammate 后**首批就崩**，连续暴露 5 个 bug：

1. **Bug 1**：teammate 收到的 prompt 顶部是 `[from claude-code:8023f956 @ claude-code][msg <id>]\n[object Object]\n\n---\n\n<caller prompt>` —— agent body 该出现的位置变成了字符串 `"[object Object]"`
2. **Bug 2**：`spawn_session({agent_name:'reviewer-claude'})` / `spawn_session({agent_name:'reviewer-codex'})` 看似传了，实际 reviewer 完全不知自己是 reviewer 角色 —— 与 Bug 1 同根因
3. **Bug 3**：`wait_reply({timeout_ms: 900_000})` 直接被 zod 校验拒（hard cap 600_000 = 10min），重深度 review reviewer 跑完 6900 行完整 scope + 多文件验证常 15-25min
4. **Bug 4**：spawn 出来的 reviewer 在 SessionList / TeamDetail 只显示 cwd basename（如多组并行 review 全是 `agent-deck`），完全分不出哪个是 reviewer-claude 哪个是 reviewer-codex
5. **Bug 5（pre-existing，本轮一并修）**：跑 `pnpm exec vitest run` 全套发现 `manager-public-api.test.ts > archive()` + `manager-delete.test.ts > 删除窗口` 两处 stderr 报 `Database not initialized` —— 三个 manager test 文件没 mock `@main/store/agent-deck-team-repo`，sessionManager.list/delete/markClosed 内部调真 repo 路径全挂

DB 铁证（`/Users/apple/Library/Application Support/agent-deck/agent-deck.db` snapshot）锁定 Bug 1+2 同根因：

```sql
SELECT id, length(body) AS body_len, substr(body,1,80) AS body_head, status
FROM agent_deck_messages WHERE id = '17870ace-930d-4823-8513-c62d999bc973';

id                                    body_len  body_head                                      status
------------------------------------  --------  ---------------------------------------------  ---------
17870ace-930d-4823-8513-c62d999bc973  5142      [object Object]\n\n---\n\noutput_mode: ...    delivered
```

DB body 的前 16 字节是 `[object Object]`，紧跟 `\n\n---\n\n` 分隔符 + 完整 caller prompt —— 正是 `tools.ts:408 promptToUse = ${body}\n\n---\n\n${args.prompt}` 模板字符串拼接的结果，其中 `body` 被当 string 用但实际是 object 走 toString。

## 方法

**单方现场实证（未走异构对抗）**：所有 5 条 bug 都有「单线证据链一次性闭环」级证据，按 CLAUDE.md「决策对抗」节 trivial 例外不走双对抗。

**范围**：5 文件改动 + 3 文档同步。

```text
src/main/agent-deck-mcp/tools.ts                              # Bug 1+2 union 解构 + Bug 3 cap 抬升 + Bug 4 schema 加 display_name + addMember fallback + setTitle 调用
src/main/agent-deck-mcp/__tests__/tools.test.ts               # mock 签名对齐 + 4 个 regression case（Bug 1+2 1 条 / Bug 4 3 条 priority chain）
src/main/store/session-repo.ts                                # Bug 4 加 setTitle API
src/main/session/__tests__/manager-test-setup.ts              # Bug 5 加 makeAgentDeckTeamRepoMock factory
src/main/session/__tests__/manager-public-api.test.ts         # Bug 5 vi.mock 加 agent-deck-team-repo
src/main/session/__tests__/manager-delete.test.ts             # Bug 5 vi.mock 加 agent-deck-team-repo
src/main/session/__tests__/manager-ingest.test.ts             # Bug 5 vi.mock 加 agent-deck-team-repo
resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md  # Bug 3 timeout 上限 + Bug 4 display_name 字段提示
resources/claude-config/CLAUDE.md                             # Bug 3 wait_reply 注释更新
```

**机器可读范围**（File-level Review Expiry 用）：

```review-scope
resources/claude-config/CLAUDE.md
resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/tools.ts
src/main/session/__tests__/manager-delete.test.ts
src/main/session/__tests__/manager-ingest.test.ts
src/main/session/__tests__/manager-public-api.test.ts
src/main/session/__tests__/manager-test-setup.ts
src/main/store/session-repo.ts
```

## 三态裁决

| # | 标记 | 严重度 | 主题 |
|---|---|---|---|
| 1 | ✅ | **HIGH（封锁 SKILL）** | `getBundledAssetContent` 真返 union object，handler 当 string 用 → `[object Object]`；测试 mock 签名错齐导致单测 100% 通过 / 生产 100% 失败 |
| 2 | ✅ | **HIGH（封锁 SKILL）** | 同 #1 根因 —— agent_name 注入路径自 CHANGELOG_76 D1 落地以来从未真实生效，reviewer 不知自己是 reviewer 角色 |
| 3 | ✅ | MED | `wait_reply.timeout_ms` hard cap 600_000ms (10min) 对深度 review 太短 |
| 4 | ✅ | MED（UX） | spawn_session 没暴露 `display_name`，UI 显示链路虽通但写入端写死 null |
| 5 | ✅ | MED（pre-existing test debt） | 3 个 manager test 文件缺 `agent-deck-team-repo` mock，archive/delete 路径触发真 DB query 报 `Database not initialized` |

## 修复条目

### Bug 1+2 — agent body 注入 union 解构 + 测试 mock 签名对齐

**根因**：

`src/main/bundled-assets.ts:50-61` 真实签名：
```ts
export function getBundledAssetContent(kind, name):
  { ok: true; content: string } | { ok: false; reason: string }
```

`src/main/agent-deck-mcp/tools.ts:393-408`（修复前）当 `string | null` 用：
```ts
const body = getBundledAssetContent('agent', args.agent_name);
if (body === null) { ... }                       // ❌ 永不为 null（return object）
promptToUse = `${body}\n\n---\n\n${args.prompt}`; // ❌ ${object} → "[object Object]"
```

`src/main/agent-deck-mcp/__tests__/tools.test.ts:321-328`（修复前）mock 故意写错齐：
```ts
vi.mock('@main/bundled-assets', () => ({
  getBundledAssetContent: (kind, name): string | null => {
    if (kind === 'agent' && name === 'reviewer-claude') return '...';
    return null;
  },
}));
```
mock 与真实签名**完全不一致** → 单测断言 `expect(prompt).toContain('REVIEWER-CLAUDE BODY')` 通过（mock 真返 string）/ 生产路径 `${union object}` 拼成 `[object Object]` 完全没注入。

**修法**（`tools.ts:393-422` + `tools.test.ts:321-336` + 加 1 条 regression case）：

```ts
// tools.ts 修复后
let promptToUse = args.prompt;
if (args.agent_name) {
  const bodyResult = getBundledAssetContent('agent', args.agent_name);
  if (!bodyResult.ok) {
    fanOutSlot.release();
    return err(
      `agent body not found for agent_name="${args.agent_name}": ${bodyResult.reason}`,
      '...',
    );
  }
  promptToUse = `${bodyResult.content}\n\n---\n\n${args.prompt}`;
}
```

```ts
// tools.test.ts mock 修复后（与真实签名一致）
vi.mock('@main/bundled-assets', () => ({
  getBundledAssetContent: (
    kind: 'agent' | 'skill',
    name: string,
  ): { ok: true; content: string } | { ok: false; reason: string } => {
    if (kind === 'agent' && name === 'reviewer-claude') {
      return { ok: true, content: '# REVIEWER-CLAUDE BODY (mocked)\n你是对抗 reviewer。' };
    }
    return { ok: false, reason: `not found: ${kind}/${name}` };
  },
}));
```

regression test 加在 `tools.test.ts:735` —— 显式断言 `prompt.not.toContain('[object Object]')` + `prompt.toContain('# REVIEWER-CLAUDE BODY (mocked)')` 同时锁住 createSession 路径与 placeholder DB body 路径。

**验证**：`pnpm exec vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts` → 41/41 全过（含新加的 regression case）。

### Bug 3 — wait_reply.timeout_ms hard cap 抬到 30min

**根因**：`tools.ts:282-283`：`timeout_ms: z.number().min(1000).max(600_000).default(600_000)`，10min 上限对 deep review reviewer 跑完 6900 行 + 验证不够。

**修法**（`tools.ts:269-289` + `tools.ts:785` nudge clamp 同步抬）：

```ts
nudge_after_ms: z.number().int().min(5_000).max(1_800_000).optional()...
timeout_ms: z.number().int().min(1_000).max(1_800_000).default(600_000)
  .describe('Total timeout (1s ~ 30min). ... Default 10min covers normal review turns; deep multi-file reviews / heavy reasoning may need 15-30min — pass a larger value explicitly.'),
// nudgeDelay clamp 同步抬：
const nudgeDelay = args.nudge_after_ms ?? Math.max(5_000, Math.min(args.timeout_ms / 2, 1_800_000));
```

**默认 600_000 不动**（短任务不破坏现有调用），让需要长 timeout 的 caller 显式传更大值。SKILL.md 模板已更新示例 `timeout_ms: 1_800_000`。

**验证**：手测调 `wait_reply({timeout_ms: 1_800_000})` 不再被 zod 拒；41 单测全过（含 1 秒 timeout + 5 秒 nudge case 仍通过）。

### Bug 4 — spawn_session 加 display_name + setTitle 调用 + addMember displayName fallback

**根因**：`spawn_session` schema 没暴露 display_name 入参；`tools.ts:474-493`（修复前）两次 addMember 时 displayName 写死 null。UI 端 `MembersSection.tsx:39` + `LineageSection.tsx:93` + `universal-message-watcher.ts:179` 已经按 `displayName ?? sess?.title ?? sid前8字符` fallback 链渲染，渠道通了但写入端没接。

**修法**（4 处协同改动）：

1. `tools.ts:208-228` schema 加 `display_name?: z.string().min(1).max(80).optional()`
2. `session-repo.ts:243-252` 加 `setTitle(id, title)` API
3. `tools.ts:481-494` spawn handler 在 setSpawnLink 之后调 `setTitle`：
```ts
const teammateDisplayName = args.display_name ?? args.agent_name ?? null;
if (teammateDisplayName) {
  try {
    sessionRepo.setTitle(sid, teammateDisplayName);
  } catch (e) {
    console.warn(`[mcp spawn_session] setTitle(${sid}, ${teammateDisplayName}) failed:`, e);
  }
}
```
4. `tools.ts:519` teammate addMember 走 fallback chain：
```ts
agentDeckTeamRepo.addMember({ ..., displayName: teammateDisplayName });
```

lead 端 displayName 仍 null（lead 通常已有 title，且 lead 自己往往是 caller 的「lead 身份」不需特别命名）。

**fallback 链**：`args.display_name > args.agent_name > 不动 (默认 cwd-basename)`。

**验证**：3 条 regression test（`tools.test.ts:756-820`）：
- `display_name overrides agent_name`：传 `display_name:'reviewer-claude · batch A'` + `agent_name:'reviewer-claude'` → setTitle 走 display_name + teammate addMember.displayName 同步
- `agent_name fallback when display_name omitted`：只传 agent_name → setTitle/addMember 都用 agent_name
- `no display_name + no agent_name → setTitle skipped`：裸 spawn → 不调 setTitle 保留默认 title + addMember.displayName=null

### Bug 5 — manager test 缺 agent-deck-team-repo mock（pre-existing）

**根因**：`session/manager.ts:642` `enrichWithTeamsBatch` / `manager.ts:518` `delete` 路径会调 `agent-deck-team-repo.findActiveMembershipsBySession(Ids)`。三个 manager test 文件（manager-public-api / manager-delete / manager-ingest）顶部 vi.mock 只 mock 了 `sessionRepo / eventRepo / fileChangeRepo / event-bus` 4 段，没 mock `agent-deck-team-repo` → sessionManager 主路径调真 `defaultRepo() → getDb()` → 抛 `Database not initialized`。

`manager-public-api.test.ts > archive()` 直接 fail；`manager-delete.test.ts > 删除窗口` 不 fail（delete 路径吞 import 错只 console.warn）但 stderr 噪声很大；`manager-ingest.test.ts` 不触发该路径所以 silent ok。

**修法**（4 文件协同）：

1. `manager-test-setup.ts:179-220` 加 `makeAgentDeckTeamRepoMock` factory（返「无 team membership」5 个 stub method 全空安全 fallback）
2. 三个 test 文件顶部 vi.mock 加一段（factory 体复用 setup）：
```ts
vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: makeAgentDeckTeamRepoMock(),
  TeamInvariantError: class extends Error {},  // sessionManager.delete 路径 catch 时引用
}));
```

**验证**：`pnpm exec vitest run` → 21 文件 / 331 case 全过 / 0 stderr `Database not initialized` warning。

## 关联 changelog

- 无独立 CHANGELOG（本 review 文件直接归档；改动属 bug 修复 + 测试基础设施修，不引新功能）。
- 同步更新 SKILL.md 模板的 spawn 示例（`display_name` 字段）+ wait_reply timeout 上限说明
- 同步更新 `resources/claude-config/CLAUDE.md` Universal Team Backend 节 wait_reply timeout 注释（默认 600_000ms / hard cap 1_800_000ms）

## 不动文件保护清单（≤ 500 LOC 护栏例外登记）

CLAUDE.md「单文件 ≤ 500 行 — 超了必须试拆」要求 commit 前对 LOC > 500 的代码文件做拆分尝试。本轮触发文件 + 不拆理由：

| 文件 | LOC | 本轮 delta | 不拆理由 |
|---|---:|---:|---|
| `src/main/agent-deck-mcp/tools.ts` | 968 (+56) | +Bug 1+2 union 解构 (~10) +Bug 3 cap 抬升 (~6) +Bug 4 schema/setTitle/addMember (~25) +注释 (~15) | 已存在超限文件（修前 932 行）。本轮属 bug 修不引入新主体逻辑。文件性质 = 6 个 mcp tool handler 集中注册（spawn / send / reply / wait / list / get / shutdown），每个 handler 100-200 行强耦合 schema + zod + caller-context + 错误返回 + DB / repo / sessionManager / fanOutSlot 闭环。三档拆分尝试都不合适：① 抽 module-level 函数 — 已抽（projectSession / makeCallerContext / denyExternalIfNotAllowed / validateExternalCaller 都在）② 目录化 sub-module — 7 个 tool 拆 7 文件后每个文件还要重复 import 同套依赖（schema / context helper / repos），无收益 ③ 拆 class — tools.ts 是 functional 风格无 class，不适用。**本轮登记保留**，下次有专门拆分轮再处理 |
| `src/main/store/session-repo.ts` | 590 (+10) | +Bug 4 加 setTitle method (~10) | 已存在超限文件（修前 580 行）。文件性质 = 单 SessionRecord 表的 CRUD 集中地，所有 method 共享同一 row 结构 + getDb() / prepare 模式。拆分 = 强行把 SQL 分散到多文件违反「single responsibility = 一张表一份 repo」的现有 codebase 约定（task-repo / event-repo / agent-deck-team-repo / agent-deck-message-repo 都是单文件 ~400-600 行同款）。**本轮登记保留**，未来如表 schema 大改可重新评估 |

## 后续

- **必须重打包重装 .app**才能让 main 进程加载修复（dev mode `pnpm dev` 也行；当前装的 .app 内 main 二进制还是 bug 版本）。重装后 `agent-deck:deep-code-review` SKILL 才真正可用
- 建议下一轮先用 trivial 范围实测 SKILL 端到端 spawn × 2 + wait_reply 流程，确认 reviewer 真正按 reviewer-{claude,codex}.md body 跑出反 review；通过后再续跑 batch A R3 Universal Team Backend deep review（这次中止那个）
