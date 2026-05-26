---
plan_id: "cross-adapter-sandbox-inherit-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/cross-adapter-sandbox-inherit-20260515"
status: "in_progress"
base_commit: "a6dbbe07a3ffb35f41c6f04eb444e4446fab33c3"
base_branch: "main"
parent_rfc_id: "adapter-architecture-rfc-20260515"
parent_rfc_chapter: 2
parent_plan_id: "adapter-architecture-design-20260515"
---

# cross-adapter-sandbox-inherit-20260515 — RFC §2 Option D 重写 + Option E 重写实施(跨 adapter sandbox 继承 opt-in)

## 总目标 & 不变量

按 `docs/adapter-architecture-rfc-20260515.md` Chapter 2 「Option D 重写(string enum)+ Option E 重写(warnings 字段)」决策实施 — RFC 已 user sign-off accepted。

**不变量**:
- **决策不再争论**:option 取舍已在 RFC §2.4 sign-off,本 plan 仅实施。任何想推翻 D 重写(如改回 Option A 平凡映射 / 走 Option B abstract level / 走 Option F 硬 reject)的提议必须先回 RFC 阶段
- **默认行为零回归**:`inherit_sandbox` 字段未传时行为 == Option C(当前 spawn.ts:131-135 fallback chain),已有 caller / 单测**不应**因本 plan 行为变化
- **零不安全 silently 宽松化**:仅安全方向映射(strict→read-only / workspace-write→workspace-write);off / danger-full-access 不映射(默认值场景不放宽)
- **`allow_unrestricted_mapping: true` escape hatch** UI 高亮警告(本 plan src 端实装字段 + emit warnings;UI 高亮可留 followup 或本 plan 内做)
- **typecheck + 全单测一遍 + 异构对抗 review** 是合并门禁

**RFC 决策摘要**(详 RFC §2.3-2.8):
- 新加 `inherit_sandbox: 'restrictions-only'` + `allow_unrestricted_mapping: bool` 字段到 SpawnSessionArgs / HAND_OFF_SESSION_SCHEMA
- 新加 `warnings?: string[]` 到 SpawnSessionResult / HandOffSessionResult
- spawn handler 实装 string enum 映射 + emit message 到 lead session 双发 warnings
- hand-off-session.ts:281-303 同步透传逻辑(与 spawn handler 字面镜像)
- 单测覆盖 4 种跨 adapter 矩阵 × 3 档 inherit_sandbox 值 ≈ 16 case + hand-off passthrough
- 预估 ~+175 行(详 RFC §2.5)

## 设计决策(不再争论)

详 `docs/adapter-architecture-rfc-20260515.md` §2.1.2.1(lossy 详细清单 7 类结构化字段)+ §2.3 Option D 重写 / Option E 重写完整 typescript snippet + §2.4(推荐)+ §2.5(touchpoint estimate)+ §2.8(迁移路线 Step 1-5)。本 plan 不复述,实施时直接读 RFC。

**关键决策点不再争论**:
- 不退到 Option A(平凡映射)— RFC §2.1.2.1 实证 7 类结构化字段丢失(含 denyRead 敏感目录) + off↔danger-full-access 反方向危险
- 不退到 Option B(abstract level)— RFC §2.4 已 ack 双轨制 + 现有 UI/CLI 全改 + 根本问题没解决
- 不退到 Option G(codex enum 三档)— RFC §2.4 已 ack 与 D 重写 + escape hatch 等价但多一字段表达同一概念,违反信息密度
- 不走 Option F 硬 reject — RFC §2.4 标 ❓ 候选,默认不实施;若 D + E 推不动用户主动用 → 后续 followup 评估

## 步骤 checklist

### Phase 1: schema 字段 + handler 实装

- [ ] **Step 1.1 — `agent-deck-mcp/tools/schemas.ts` schema 字段**
  - SpawnSessionArgs(`schemas.ts:444-456`)加 `inherit_sandbox?: 'restrictions-only'` + `allow_unrestricted_mapping?: boolean`
  - HAND_OFF_SESSION_SCHEMA(`schemas.ts:252-363`)加同款字段
  - SpawnSessionResult(`schemas.ts:483-504`)加 `warnings?: string[]`
  - HandOffSessionResult 加 `warnings?: string[]`(具体行号实施时 grep)
  - JSDoc 字段说明含完整映射表(strict→read-only / workspace-write→workspace-write / off / danger-full-access 不映射 + escape hatch 语义)

- [ ] **Step 1.2 — spawn handler 实装映射逻辑 + warnings emit**
  - `spawn.ts:131-135` fallback chain 后加映射分支:
    - `inherit_sandbox === 'restrictions-only'` 且 cross-adapter 命中 → 按 RFC §2.3 Option D 重写映射表填 `effectiveCodexSandbox` / `effectiveClaudeCodeSandbox`(仅安全方向)
    - `allow_unrestricted_mapping: true` 且 cross-adapter 命中 → 完整平凡映射(包含 off↔danger-full-access)
    - 默认(字段未传)→ 现状 Option C 不变
  - ok return 加 `warnings: string[]` 字段(条件: lead 非默认 sandbox + 跨 adapter spawn + caller 没显式传字段)
  - emit message 到 lead session(`ctx.emit({ kind: 'message', sessionId: leadSid, text: '[warn] ...' })`)双发

- [ ] **Step 1.3 — hand-off-session.ts:281-303 同步逻辑**
  - 字面镜像 spawn handler 映射 + warnings 字段填充 + emit message 双发逻辑
  - **不要**改到 `hand-off-session-impl.ts`(R1 实证后者仅解析 plan/prompt,真实 sandbox 字段透传在 hand-off-session.ts)

### Phase 2: 单测覆盖

- [ ] **Step 2.1 — 新建 `__tests__/spawn-cross-adapter-sandbox.test.ts`**
  - 参数化 16 case(4 种跨 adapter 矩阵: claude→codex / codex→claude / claude→pty / codex→pty;3 档 inherit_sandbox 值: undefined / 'restrictions-only' / 'restrictions-only' + allow_unrestricted_mapping=true;部分组合)
  - 每 case 断言 `effectiveCodexSandbox` / `effectiveClaudeCodeSandbox` 期望值 + warnings 字段是否非空
  - 关键反例:claude `'off'` + `'restrictions-only'` → codex 不映射(走 default workspace-write),warnings 空(off 默认场景不 warn)
  - 关键反例:claude `'strict'` + 默认未传字段 + cross-adapter codex → warnings 含「lead claude is strict, but codex teammate spawned with default workspace-write...」

- [ ] **Step 2.2 — 扩 `__tests__/spawn-guards.test.ts`**
  - 加 cross-adapter sandbox edge case(确保 fallback chain 优先级:`args.codex_sandbox > inherit_sandbox 映射 > settings 全局值`)

- [ ] **Step 2.3 — 扩 `__tests__/hand-off-session.handler-cwd-generic.test.ts`**
  - 加 hand-off passthrough case(spawn handler 映射对在 hand-off 路径同款行为)

### Phase 3: 异构对抗 review

- [ ] **Step 3.1 — deep-code-review SKILL**
  - scope = Phase 1-2 改动 diff(schemas.ts / spawn.ts / hand-off-session.ts / 新单测)
  - focus = 「映射表正确性 / 边界(用户 escape hatch + cross-adapter 反向)/ warnings emit 是否在所有 cross-adapter 路径触发 / hand-off-session.ts 同步是否字面镜像」
  - 三态裁决修 ✅ HIGH

### Phase 4: 收口

- [ ] **Step 4.1 — REVIEW_X.md(可选)**
  - 若 Phase 3 异构对抗有 ≥ 2 HIGH finding → 单独入 review

- [ ] **Step 4.2 — CHANGELOG_X.md + plans/INDEX.md 同步**

- [ ] **Step 4.3 — `mcp__agent-deck__archive_plan` 自动归档**

## 当前进度

- ⬜ **stub 状态**:本 plan 已建文件、未启动。等用户后续显式 hand-off 触发或 hand_off_session 接力。**串行约定**:Chapter 1 (`p4-baseadapter-d2-implement-20260515.md`)收口后再启动本 plan(避免两个 plan 串行修同款 schema/handler 字段冲突)
- ⬜ Step 1.1 起手

## 下一会话第一步

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/plans/cross-adapter-sandbox-inherit-20260515.md` 全文读 plan(强制 cat 不用 Read,详 user CLAUDE.md §Step 3 末尾 callout)
2. **避开 EnterWorktree CLI stale base bug**(详 user CLAUDE.md §Step 1 末尾 callout):用 Bash 显式建 worktree(隐式用 HEAD 作 base):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-cross-adapter-sandbox-inherit-20260515 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/cross-adapter-sandbox-inherit-20260515
   ```
   然后 `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/cross-adapter-sandbox-inherit-20260515")` 进入(注意是 path 不是 name)
3. 自检 worktree HEAD == main HEAD == frontmatter `base_commit` (`a6dbbe07a3ff...`):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck/.claude/worktrees/cross-adapter-sandbox-inherit-20260515 rev-parse HEAD
   git -C /Users/apple/Repository/personal/agent-deck rev-parse HEAD
   ```
   不等 → `git -C <worktree-abs-path> reset --hard <main-HEAD>` 修正(参 user CLAUDE.md §Step 1 callout)
4. **串行约束自检**:`Bash: grep -E "^status:" /Users/apple/Repository/personal/agent-deck/plans/p4-baseadapter-d2-implement-20260515.md` 必须返回 `status: "completed"`,否则 abort 等 Chapter 1 plan 收尾再启动本 plan(防 schema 字段冲突)
5. `Bash: cat /Users/apple/Repository/personal/agent-deck/docs/adapter-architecture-rfc-20260515.md` 读 RFC 全文(尤其 §2.1.2.1 lossy 清单 + §2.3 Option D/E 重写 完整 snippet + §2.5 touchpoint + §2.8 迁移路线)
6. **从 Step 1.1 开始动手**:打开 `src/main/agent-deck-mcp/tools/schemas.ts:444-456`(SpawnSessionArgs)看现 schema,按 RFC §2.3 加新字段
7. 改完每步:
   - **路径全用 worktree 内绝对路径**(详 user CLAUDE.md §Step 1 末尾 callout)
   - `pnpm typecheck` 必跑
   - commit message 含「(cross-adapter-sandbox-inherit Step <X.Y>)」
8. 决策点(如 emit message 文案 / warnings 字段命名细节 / UI 高亮是否本 plan 落)告诉用户征得确认

⚠️ **跨会话第一次读「长期存在 + 其他会话动过的文件」必须用 `Bash: cat` 而非 `Read` 工具**(详 user CLAUDE.md §Step 3 末尾 callout)

## 已知踩坑

- **EnterWorktree(name:) CLI stale base bug**:必走 Bash `git worktree add` + `EnterWorktree(path:)`(详 user CLAUDE.md §Step 1 末尾 callout)
- **worktree 内绝对路径**:Edit / Read / Write / Grep / Glob / Bash `git -C` 全部带 worktree 前缀(详 user CLAUDE.md §Step 1 callout)
- **`hand-off-session.ts:281-303` 是 hand-off 真实组装点**(R1 实证),不是 `hand-off-session-impl.ts` — 改 sandbox 字段透传一定改前者
- **串行约束**:本 plan 启动前必须确认 Chapter 1 plan(`p4-baseadapter-d2-implement-20260515.md`)已 status=completed,否则两个 plan 串行修同款 schema/handler 字段会冲突 + 重复 churn(详 user CLAUDE.md「复杂 plan」节)。若 Chapter 1 plan 仍 in_progress,abort 等收口
- **默认行为零回归**:`inherit_sandbox` 字段未传时 spawn handler 行为必须 == Option C(当前 spawn.ts:131-135 fallback chain),已有单测不能因本 plan 失败 — Phase 1 改完先跑全 spawn 单测确认零回归
- **fallback chain 优先级**:`args.codex_sandbox` 显式传值 > `inherit_sandbox: 'restrictions-only'` 映射 > settings 全局值。caller 显式传 sandbox 字段时 inherit_sandbox 不再 override
- **emit message 双发**:`ctx.emit({ kind: 'message', sessionId: leadSid })` 在 spawn handler 内走 lead session conversation flow;同款 emit 在 hand-off-session.ts 内 spawn 出新 session 时,**leadSid 是谁?** 若 hand-off 是 caller→new session(无 lead 关系)则 emit 到 caller session;若有 team_name 则 emit 到 lead — 实施时确认语义
- **`allow_unrestricted_mapping: true` UI 高亮**:本 plan src 端实装 schema 字段 + emit warnings,UI 高亮可留单独 followup 或顺手做 — 实施时与用户确认范围

## 相关 followup

- **Chapter 1 实施**:`p4-baseadapter-d2-implement-20260515.md`(已建 stub plan,**串行实施 — Chapter 1 必须先收口本 plan 才启动**)
- **Chapter 3 不需 plan**:加新 scheduler 时引用 RFC §3.3 命名 convention + §3.3.4 双类周期 settings 约定即可
- **可选 Option F(硬 reject)followup**:RFC §2.4 标 ❓ 候选;若 D + E 落地后用户实际不主动用 inherit_sandbox(跨 adapter spawn 仍 silently 宽松),评估是否升级到 Option F 强制表态

## 会话风格授权

承袭 RFC 决策范围 + 本 plan 实施性质:
- **RFC 已 sign-off 决策**(option 取舍 / string enum 映射方向 / warnings 字段形态)不再问用户
- **新增映射边界 case**(grep 漏 / RFC §2.1.2.1 7 类 lossy 字段额外补救)必须告诉用户征得确认 + 写入 RFC §2.3 修订
- **emit message 文案 / warnings 字段命名细节**:lead 自主判断,若与 RFC §2.3 snippet 偏离再问用户
- **UI 高亮范围**(本 plan vs followup):拿不准时停下问用户
- **Phase 3 异构对抗 review HIGH finding** 默认采纳;反驳轮裁决属常规流程不打扰用户
