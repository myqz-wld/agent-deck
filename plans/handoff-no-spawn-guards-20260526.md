---
plan_id: "handoff-no-spawn-guards-20260526"
created_at: "2026-05-26T12:45:00+08:00"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/handoff-no-spawn-guards-20260526"
status: "completed"
base_commit: "50b46ffbf20b11020153594b041c25937bd9308e"
base_branch: "main"
final_commit: "66294f49dd231fddbb075a2a2b0f4d9e3c68121f"
completed_at: "2026-05-26"
---
# Plan: hand-off 完全独立于 spawn-guards / 永不写 spawn-link

> **R1 deep-review 修订**(reviewer-claude + reviewer-codex 异构对抗 × 12 条 finding 全采纳):
> - **R1 HIGH-1** (codex 单方现场验证): Codex 端 §下一会话第一步 选项 B 误称"建+进" — `mcp__agent-deck__enter_worktree` 副作用明文「**不**自动切 codex SDK session cwd」(详 `resources/codex-config/CODEX_AGENTS.md:134`)。R1 修订改写 §下一会话第一步 选项 B 注明 codex 路径必须用 worktree 绝对路径或 `git -C <worktree>`,Step 2.1-2.7 加 worktree 绝对路径规约
> - **R1 HIGH-2** (claude + codex 部分重叠现场验证): §D6 改造扫荡漏 4 处资产/文档 — `helpers.ts:122` jsdoc + `schemas.ts:297-298` 注释 + `resources/claude-config/CLAUDE.md:186` + `resources/codex-config/CODEX_AGENTS.md:201`(后两份注入 SDK system prompt = caller 行为级 bug)+ `src/main/agent-deck-mcp/tools/index.ts` hand-off tool description。R1 修订 §D6 append 5 处资产同步 + Step 2.4.5 加独立资产同步小步
> - **R1 HIGH-3** (claude 单方现场验证): §D7 测试范围低估 — `spawn-guards.test.ts:106-130` 两 case 必删(D4 让 batonMode=true 三道全跳,这两 case 验"fan-out / rate-limit 仍 enforce" 直接矛盾) + `hand-off-session.archive-caller-false.test.ts` **整文件反转**(测试意图就是验 REVIEW_46/47 修法本身,plan §D5/D6 故意推翻这两个修法)。R1 修订 §D7 明示删/反转/重写范围
> - **R1 MED 4 条** (Step 2.6 vitest zsh glob 不匹配 / Step 2.1-2.2 文件路径不全 / Step 2.2 fanOutSlot 歧义 / D8 lambda 入参变化未列): 全 inline 到对应 step
> - **R1 LOW 3 条 + INFO 1 条**: D4 RFC 溯源 / 选项 A/B failure cleanup / adopt 测试 grep / changelog 改名说明 — 全 inline

## 总目标

`hand_off_session` 在 `archive_caller=false` (显式 opt-out) 路径下仍走 normal spawn 写 spawn-link → `SessionList` 把 caller 渲染为 lead、新 session 渲染为 teammate,违反 hand-off「不是派出小弟干活」设计意图。RFC 用户决策 hand-off 与 spawn 是两套独立语义,改造让 hand-off 路径**完全不走** spawn-guards 三道 + 永不写 spawn-link,无论 `archive_caller` 值,在 SessionList 都呈现为独立 root 不显示与 caller 的任何 spawn 关系。

## 不变量

1. **hand-off 是接力不是派活**:`src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:21-39` jsdoc 明文设计意图。`spawn-link` (`sessions.spawned_by` + `sessions.spawn_depth`) 是 spawn 派遣关系的数据表达,hand-off 路径**永不写**,不论 `archive_caller` / `adopt_teammates`。
2. **spawn-guards 三道防御只服务 spawn 派活**:depth check (防 chain 太深) / fan-out (防单 caller 起太多 child) / spawn-rate (防应用全局速率) 都是为 spawn fork-bomb 防御设计。hand-off 是平级接力,语义上不构成 fork-bomb 风险(详 §设计决策 D4 用户原话「不进行任何和 spawn session 有关的检查」)。
3. **archive_caller=false 是合法 power-user 路径**:lead 起多 hand-off 子任务自己仍想看 reviewer reply / debug 工具用例(详 RFC Q3)。改造不引入 deprecation hint / 不退役。
4. **SessionList 视觉表达**:hand-off 出来的 session 完全独立 root,不显示任何与 caller 的 spawn 关系 chip / badge / 缩进。如需查接力来源,SessionDetail 已有 cyan Hand-off badge + tooltip `planId/phaseLabel/fromCallerSid` (CHANGELOG_145)。
5. **events.payload.handOff metadata 不变**:CHANGELOG_145 已上的 5 字段 metadata (mode/planId/phaseLabel/fromCallerSid/hasAdoptedBlock) 是 SessionDetail UI 唯一接力关系信号源,本 plan 不动。
6. **spawn_session 公开 tool 行为不变**:外部 mcp client 直接调 `spawn_session` 仍走完整 spawn-guards 三道 + 写 spawn-link。改造只在 `hand_off_session` 内部调 spawn 时打开 hand-off-mode 通道。
7. **`adopt_teammates: true` 路径不受影响**:adopt 是 swapLead 接管 lead 角色,与 spawn-link / spawn-guards 正交;本 plan 改造不影响 adopt 路径(adopt 仍走原 swapLead loop)。
8. **`batonRole='lead'` 行为不变**:hand-off 调 spawn 时仍传 `batonRole='lead'` (与现状 `archive_caller=true` 路径一致),让新 session 接管 lead 角色防 `archiveTeamsIfOrphaned` 误触发。架构变化只是让 `archive_caller=false` 路径也用 'lead' (不再退化 undefined → 默认 'teammate')。
9. **sessions.spawn_depth 默认 0**(R1 MED-8 加边界):hand-off 路径不写 spawn-link → 新 session `spawnedBy=null` + `spawnDepth=0`,无论 caller 自身 `spawnDepth` 值。
   - **caller 是 hand-off 链节点**:caller.spawnDepth=0(因 hand-off 永不写),新 session.spawnDepth=0(同理)— 不累积
   - **caller 是 spawn 派遣链节点**(典型场景:reviewer-claude / reviewer-codex teammate 由 lead 用 spawn_session 派出,caller.spawnDepth=1):新 session 走 hand-off 路径**仍**.spawnDepth=0(**by design** — hand-off 不继承 spawn 派遣 depth)
   - **不变量含义**:caller spawnDepth > 0 时,通过 hand-off 起新 session 等于"绕过 maxDepth 限制" — 是 D4 power-user 自负责任语义内,**不是 bug**
   - 下游消费:`spawn-guards` 在新 session 起 spawn_session 派活时调 `sessionRepo.getSpawnDepth(caller.callerSessionId)`,新 session 自身 spawnDepth=0 → spawn_session 派活 depth 从 0 起算(此时 spawn_session 走完整 spawn-guards 不走 handOffMode)

## 设计决策(不再争论)

### D1 — 修法路径:hand-off 永不写 spawn-link(RFC Q1 选 A)

**理由**:spawn-link 是 spawn 派遣关系的数据表达。hand-off 设计意图明文「不是派出小弟干活」(`src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:21-39` jsdoc),数据层不应记录 spawn-link 假装是 spawn 派遣关系。SessionList Phase C (CHANGELOG_77) 按 `spawnedBy` 树形分组渲染 `↳ teammate` badge → hand-off 路径写 spawn-link 让新 session UI 错挂 caller teammate 关系。

**对比备选**:
- B (加 `spawn_link_kind: 'spawn' | 'baton'` 枚举字段):schema migration + 表加列 + 多处改动 + cross-adapter 同步 + spawn-link 语义变复杂 → 推翻
- C (仅改 SessionList 渲染识别 hand-off 反查 events):需 SessionList 跨 events 子表反查 first message metadata + IPC 额外开销 + 数据层 spawn-link 仍误表达 → 推翻

### D2 — 视觉表达:完全独立 root,不显示任何关系(RFC Q2 选 A)

**理由**:数据层 spawn-link 不写 (D1) 自然导致 SessionList partition 把 hand-off 出来的 session 放进 roots,无 teammate chip / 无缩进。SessionDetail 已有 cyan Hand-off badge + tooltip 显示 `planId/phaseLabel/fromCallerSid` (CHANGELOG_145) 满足用户查接力来源需求。

### D3 — archive_caller=false 场景定位:合法 power-user 路径(RFC Q3 选 A)

**理由**:lead 起多 hand_off 处理子任务自己仍想看 reviewer reply / 出 summary;debug 工具想起新 session 实测某 plan 但 caller 仍要观察。不引入 deprecated hint,不强制 spawn_session 替代。

### D4 — spawn-guards 边界:hand-off 完全跳过(RFC Q4 follow-up 用户原话「不进行任何和 spawn session 有关的检查」)

**RFC 溯源**(R1 LOW-9 修法):本节决策溯源 = RFC Round 2 Q1 用户追加意见「hand off 应该不用 depth check 吧,都是平级的」 + RFC Round 3(follow-up)Q1 用户原话「不进行任何和 spawn session 有关的检查」。两轮均 @ 2026-05-26 本会话内对话记录,在 plan 写作前 AskUserQuestion 顺序记录。

**理由**:spawn-guards 三道 (depth / fan-out / spawn-rate) 都是为 spawn 派活防 fork-bomb 设计。hand-off 是平级接力 — 用户原话「都是平级的」+ 「不进行任何和 spawn session 有关的检查」。`archive_caller=false × N` 滥用风险由 power-user 自负责任 (D3)。

**对比备选**:
- B (现状,按 archive_caller 区分,REVIEW_46 修法):保留两路径分歧,与 D1 / D3 不一致 → 推翻
- C (拆 `suppressDepthCheck` 独立 flag):三个 flag (spawn-link / depth / role) 各自独立控制,API surface 复杂度比"hand-off 一个 flag 全切"高一档 → 推翻

### D5 — batonRole 'lead' 行为统一(原 M12 修法收口)

**现状**:`resolveBatonRoleForSpawn` 按 archive_caller 决定 batonRole:`archive_caller=true → 'lead'`,`archive_caller=false → undefined` (退化默认 'teammate')。

**改造后**:hand-off 两路径都传 `'lead'` (新 session 接管 lead 角色防 `archiveTeamsIfOrphaned` 误触发)。

**理由**:hand-off 是接力 lead 身份的语义,无论 caller 是否归档,新 session 都接管 lead 角色。M12 修法当时为了让 `archive_caller=false` 退化"normal spawn"显式传 undefined,本 plan 把"normal spawn"语义剥离 hand-off 路径后,M12 这个分支决策不再有意义。

### D6 — 改造接口设计:`opts.handOffMode: true` 替代 `opts.batonMode: true`

**改造点**(API surface — R1 HIGH-2 修订后含资产/文档同步 5 处):

**代码层**(4 处):
- `src/main/agent-deck-mcp/spawn-guards.ts` 入参 `opts.batonMode` → `opts.handOffMode`(语义升级:不仅跳 depth,跳全部三道 + 不调 `inFlightChildren.inc` 详 §Step 2.2)
- `src/main/agent-deck-mcp/tools/handlers/spawn-link-guard.ts` 入参 `opts.batonMode` → `opts.handOffMode`(语义不变,仍是 true → 不写)
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts` opts 接收字段 rename + `applySpawnGuards` 入参更新 + `shouldWriteSpawnLink` 入参更新 + spawnDepth fallback line 同步
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts` `resolveBatonRoleForSpawn` 简化 + handler 内 `spawnFn(args, ctx, {handOffMode, batonRole})` 调用同步

**资产/文档层**(5 处 — R1 HIGH-2 新增):
- `src/main/agent-deck-mcp/tools/helpers.ts:122` jsdoc rename `batonMode` → `handOffMode`(withMcpGuard wrapper 第三参数 jsdoc)
- `src/main/agent-deck-mcp/tools/schemas.ts:297-298` 注释更新:旧"batonMode 跳 spawn-guards depth check + setSpawnLink lateral parentDepth(不 +1)"→ 新"handOffMode 跳 spawn-guards 三道全部 + 永不写 spawn-link"
- **`src/main/agent-deck-mcp/tools/index.ts` hand-off tool description**(R1 codex MED-2 现场 grep 命中):清理 batonMode / "archive_caller=false 退化 normal spawn" 旧描述,改成 D4 决策(完整 grep 实施位置 detail 详 §Step 2.4.5)
- **`resources/claude-config/CLAUDE.md:186`**(R1 HIGH-2 关键 — 注入 SDK system prompt):整段重写,删「baton 不计 spawn_depth(仅 archive_caller=true 时)」+「`archive_caller: false` 退化 normal spawn」+「防止 caller 用 opt-out 路径绕过 spawn_depth 限制开 N-phase fork-bomb」三段旧描述,改成 D4 决策:"hand-off 路径完全独立于 spawn-guards 三道防御 / 永不写 spawn-link / `archive_caller` 与 spawn-guards 解耦 / power-user 滥用风险自负"
- **`resources/codex-config/CODEX_AGENTS.md:201`**(R1 HIGH-2 关键 — codex 端镜像):同 claude 端做对偶更新(user CLAUDE.md §提示词资产维护 §约束 7 对偶资产同步硬约束)

**理由**:`batonMode` 词义偏窄(暗指 archive_caller=true 才"真 baton"),`handOffMode` 直接对应 hand-off tool 调用路径,无歧义。语义升级 (跳一道 → 跳三道 + 不写 spawn-link 一致) 配合改名让阅读者立刻看出"hand-off 是独立路径"。**资产同步硬约束**:`resources/{claude,codex}-config/*.md` 注入 SDK system prompt,不改 = caller 看到 doc 描述行为(archive_caller=false 退化 normal spawn)与 production 行为(D4 hand-off 完全跳过)不一致,**是用户体验级别 bug**。

### D7 — 测试影响范围(R1 HIGH-3 修订完整化)

**reviewer-claude HIGH-2 现场实测 + lead 现场验证铁证**:旧 plan 文字「需调整」严重低估实际工作量,以下是真实改造范围。

**必删 2 case**:
- `src/main/agent-deck-mcp/__tests__/spawn-guards.test.ts:106-130`(两 case)
  - L106-116 `'batonMode=true 但 fan-out 上限仍 enforce(防 baton race 多次接力)'`
  - L118-130 `'batonMode=true 但 rate-limit 仍 enforce(防 spam K2 接力)'`
  - **删除理由**:这两 case 的"仍 enforce"断言与 D4 决策「handOffMode 三道全跳」直接矛盾;不是改名能修(改 batonMode → handOffMode 后断言反转才一致)。**直接删,不保留**

**必整文件反转/重写 1 文件**:
- `src/main/agent-deck-mcp/__tests__/hand-off-session.archive-caller-false.test.ts`(整个文件)
  - **测试意图反转**:旧文件意图 = 验 REVIEW_46 B-HIGH-2 + REVIEW_47 M12 修法(`archive_caller=false → batonMode=false / batonRole=undefined`);新 plan 故意推翻这两个修法 → 重写为验 D4/D5/D6 推翻 REVIEW_46/47 修法(`archive_caller=false → handOffMode=true / batonRole='lead'` 与 archive_caller=true 路径完全一致)
  - **重写范围**(具体代码位):
    - 文件 jsdoc L1-22 重写:删 REVIEW_46/47 修法描述,改"R1 deep-review plan handoff-no-spawn-guards-20260526 D4/D5/D6 推翻 REVIEW_46/47 修法"段落
    - L33-68 `describe('resolveBatonRoleForSpawn lambda')` 块:
      - L46-52 case 3 `archive_caller=false → batonMode=false, batonRole=undefined` 断言反转为 `→ handOffMode=true, batonRole='lead'`
      - L54-67 case 4 后半部(L62-67) `archive_caller=false + team_name → batonMode=false + batonRole undefined` 断言反转为 `→ handOffMode=true + batonRole='lead'`
      - **lambda 入参** L35/L41/L47/L56/L57/L64 删 `archive_caller` 字段(D8 决策已删该入参)— 4-6 处 typecheck error 必修
    - L70+ `describe('handOffSessionHandler — archive_caller=false 退化 normal spawn (B-HIGH-2 + M12 端到端)')` 块:
      - describe 名重命名:删"退化 normal spawn (B-HIGH-2 + M12 端到端)",改"完整跳过 spawn-guards (D4/D5/D6 推翻 REVIEW_46/47)"
      - case 1 (L130-175) `archive_caller=false → opts.batonMode === false + 'batonRole' in opts === false` 断言反转为 `→ opts.handOffMode === true + opts.batonRole === 'lead'`
      - case 4 (L255-299) `archive_caller=false + team_name → opts.batonMode false + batonRole 不在 opts` 断言反转为 `→ opts.handOffMode true + batonRole 'lead' 在 opts`

**必改名 rename + 逻辑不变** 3 文件:
- `src/main/agent-deck-mcp/__tests__/spawn-link-guard.test.ts`(3 case)
  - L8 import `shouldWriteSpawnLink` 后入参 `batonMode` → `handOffMode`
  - L11-22 三 case 断言关键字 `batonMode` → `handOffMode`(逻辑不变:true → false / false → true / undefined → true)
- `src/main/agent-deck-mcp/__tests__/spawn-guards.test.ts`(除 L106-130 已删两 case,其余 case)
  - 检查并 rename 所有 `batonMode` → `handOffMode` 字面字段(预计 5-8 处)
  - **新增 case**:`handOffMode=true` 三道全跳(depth + fan-out + rate)同时通过(对应 §不变量 2)
- `src/main/agent-deck-mcp/__tests__/hand-off-session.*.test.ts` 剩余文件(R1 LOW-11 + claude MED-5 ripple):
  - `hand-off-session.handler-deny-happy.test.ts` / `hand-off-session.handler-cwd-generic.test.ts` / `hand-off-session.adopt-teammates.test.ts` / `hand-off-session.task-reassign.test.ts` / `hand-off-session.impl-core.test.ts`
  - **实施会话 grep 命令**(R1 LOW-11 修法明示):`grep -nE 'batonMode|batonRole|applySpawnGuards|inFlightChildren|fanOutSlot|archive_caller' src/main/agent-deck-mcp/__tests__/hand-off-session.*.test.ts` 列每处 hit,**逐条核实**是否需 rename / 反转 / 删除

**必改名 rename + 逻辑不变** 4 文件(**R2 codex MED-1 修法新增 tools.test.ts**):
- `src/main/agent-deck-mcp/__tests__/tools.test.ts` (3 处直接传 `opts.batonMode` 给 spawnSessionHandler 的 case + 多处注释/用例名)
  - L986 `{ batonMode: true, batonRole: 'lead' }` → `{ handOffMode: true, batonRole: 'lead' }`
  - L1017 `{ batonMode: true, batonRole: 'teammate' }` → `{ handOffMode: true, batonRole: 'teammate' }`(case 守门 explicit teammate 不变)
  - L1043 `{ batonMode: true, batonRole: 'lead' }` → `{ handOffMode: true, batonRole: 'lead' }`
  - L941 / L998-999 / L1026-1030 / L1055-1070 / L1070 注释/用例名/inline jsdoc 内 `batonMode` → `handOffMode` 同步改(包括 case it 字符串 `'... batonMode=true → ...'` rename 为 `'... handOffMode=true → ...'`,但保留普通 spawn 缺省路径 case 不动)
  - 含 R1 历史 reference 已收回(L998 "hand-off-mcp-teammate-bug-20260515 R2 LOW-1 / INFO-1" / L1026 "方案 1 双对抗 R1+R1.5 反驳轮共识" 仍 valid 因为方案 1 本身没被推翻 — D1 仍是「hand-off 永不写 spawn-link」一致)
  - **验证**:grep `'batonMode\|batonRole'` 在 tools.test.ts 实测命中 全 rename 后应不再含 `batonMode`(允许 `batonRole` 保留 — batonRole 仍是 hand-off 路径关键字段名)

**新增测试**(对应 §不变量 1 + 7 + 9):
- hand-off + archive_caller=false 路径下,新 session `spawnedBy === null` 与 `spawnDepth === 0`(已删 spawn-link 写入的实证)
- hand-off + caller 自身 spawnDepth > 0 路径下,新 session 仍 `spawnDepth === 0`(§不变量 9 边界)
- **adopt_teammates: true 路径 opts 第三参覆盖**(R3 codex LOW-2 修法):在 `src/main/agent-deck-mcp/__tests__/hand-off-session.adopt-teammates.test.ts` 加一例 `adopt_teammates: true` case,mock spawn 捕获第三参 opts(原 `makeOkSpawn` 只记录 `spawnArgs` 不记 opts 需扩展)并断言 `opts.handOffMode === true` + `opts.batonRole === 'lead'`,同时保留 `spawnArgs.team_name` 省略的现有断言。锁住 §不变量 7「adopt_teammates: true 路径不受影响 — adopt 是 swapLead 接管 lead 角色与 spawn-link / spawn-guards 正交」

### D8 — `resolveBatonRoleForSpawn` lambda 决策(R1 MED-7 修订)

**改造后逻辑极简**(无 archive_caller 分流) → 函数本身退化为常量 `(_: void) => ({ handOffMode: true, batonRole: 'lead' as const })`。

**两种选择**:
- (a) 保留 lambda export(test seam 不破,与原 jsdoc 一致风格)
- (b) 直接 inline 删 lambda(函数变常量后 test seam 价值退化 — 没必要 export 单测一个常量)

**选择 (a) 保留 lambda + 内部简化**,**但必须删除入参签名**(R1 MED-7):lambda 入参原本是 `{archive_caller?: boolean; team_name?: string}`,改造后入参变成 `{}`(空 object 或 void)。

**ripple 范围**(R1 MED-7 修法已在 §D7 列出):`hand-off-session.archive-caller-false.test.ts` lambda describe 块 L33-68 共 6 处 `resolveBatonRoleForSpawn({...})` 调用入参全部去 `archive_caller` 字段 + `team_name` 字段(后者本来就是预留无效字段)。typecheck error 修法已 inline §D7。

## 步骤 checklist

- [x] Step 0 — RFC 完成(R1 Round 1+2+3 共 3 轮 AskUserQuestion 收 4 决策点 D1-D4 + follow-up D4 边界精确化)
- [x] Step 0.5 — Spike 不需要(无未知 SDK / lib 行为,纯现有代码语义改造)
- [x] Step 1 — 写本 plan 文件(done at write time)
- [x] Step 1.5 R1 — invoke `/agent-deck:deep-review` (kind: 'plan') R1 完成;2 HIGH + 4 MED + 3 LOW + 1 INFO + codex 1 HIGH + 2 MED 共 12 条 finding 全采纳(0 反驳)inline 修订到本 plan
- [x] Step 1.5 R2 — invoke `/agent-deck:deep-review` (kind: 'plan') R2 完成;reviewer-claude 0 HIGH 0 真 MED + 3 LOW + 1 INFO 显式"可合";reviewer-codex 0 HIGH 2 真 MED(D7 漏 tools.test.ts + 失败 cleanup 漏 cwd_release_marker)0 反驳全采纳 inline 修订;6 处 R2 fix 全 inline
- [x] Step 1.5 R3 — invoke `/agent-deck:deep-review` (kind: 'plan') R3 完成;reviewer-claude R3 verify 0 HIGH 0 真 MED + 1 INFO L941 inclusion cosmetic 冗余 grep 兜底 显式"R3 可合";reviewer-codex 旧 session reply 卡住 user shutdown re-spawn 新 codex R1 全量(等价 lead 视角 R3 verify)收 0 HIGH + 1 真 MED + 2 LOW(plan 状态漂移 / Step 2.1-2.3 typecheck 边界 / adopt 测试 opts 第三参覆盖)0 反驳全采纳 inline 修订
- [ ] Step 2 — 进 worktree(**互斥二选一**,详 §下一会话第一步):
  - 选项 A (claude builtin):`git -C <main> worktree add -b worktree-<plan-id> <worktree-path> 50b46ffbf20b11020153594b041c25937bd9308e` → `EnterWorktree(path: ...)`
  - 选项 B (mcp tool):`mcp__agent-deck__enter_worktree({ plan_id, base_commit })` + **codex 端**手工 cwd 切换(详 §下一会话第一步)

> **Step 2.1-2.3 整合 commit 边界说明**(R3 codex LOW-1 修法):Step 2.1 (`shouldWriteSpawnLink` 入参 rename) + Step 2.2 (`applySpawnGuards` 入参 rename + 三道全跳逻辑) + Step 2.3 (`spawn.ts` 调用点同步 rename)是**强耦合子步骤,不能独立绿色 commit**。Step 2.1 改 `shouldWriteSpawnLink` 入参后 spawn.ts:324 调用点 typecheck error;Step 2.2 改 `applySpawnGuards` 入参后 spawn.ts:68-69 调用点 typecheck error。**实施会话必须三步连续做完,在 Step 2.5 typecheck 前不试 commit;三步合成一个 commit「rename batonMode → handOffMode + 三道全跳 plumbing」一并落地**。Step 2.4 (`hand-off-session.ts`) 因调用 `resolveBatonRoleForSpawn` 内部签名变化也耦合,可与 2.1-2.3 同 commit 或单独 commit(取决于 lambda 入参 rename 是否独立 typecheck pass)。Step 2.4.5 (资产同步 5 处)、Step 2.6 (测试) 与 Step 2.7 (实测) 是后置独立 commit 边界。

- [ ] Step 2.1 — 改 `src/main/agent-deck-mcp/tools/handlers/spawn-link-guard.ts`(R1 MED-5 加完整路径):rename `ShouldWriteSpawnLinkOpts.batonMode` → `handOffMode`,逻辑不变 + jsdoc 更新明示"hand-off 路径永不写 spawn-link / 语义升级"
- [ ] Step 2.2 — 改 `src/main/agent-deck-mcp/spawn-guards.ts`(R1 MED-5 加完整路径 + MED-6 fanOutSlot 歧义修法):
  - 入参 `opts.batonMode` → `opts.handOffMode`
  - `handOffMode=true` 三道全跳实现细节(**R1 MED-6 明示**):
    - depth check (L88-94) 跳:`if (!opts?.handOffMode && parentDepth >= maxDepth)` → 与现状 batonMode 一致
    - fan-out check (L96-105) 跳:`if (!opts?.handOffMode) { /* fan-out check 整段 */ }` 包整段
    - spawn-rate check (L107-114) 跳:`if (!opts?.handOffMode && !spawnRateLimiter.tryConsume())` 加 handOffMode 排除。**R2 LOW-3 明示**:JS `&&` 短路求值 — `handOffMode=true` 时 `!opts?.handOffMode` 为 false,整个表达式短路不执行 `!spawnRateLimiter.tryConsume()`,**token 不消耗**(`SlidingWindowRateLimiter.tryConsume` 实现内 push to `requests` array 副作用也跳)— 与 D4 用户原话"不进行任何 spawn 检查"语义一致
    - **`inFlightChildren.inc` 跳**(MED-6 明示):L117 `inFlightChildren.inc(caller.callerSessionId)` 包在 `if (!opts?.handOffMode) { ... }` 内 — hand-off 路径**完全不进** in-flight 计数表
    - `fanOutSlot.release` (L122-128 release lambda block;**R2 LOW-2 行号校准** — 原 plan 误写 L121-128) 退化 no-op:hand-off 路径 `released=false` 不调 dec(因没 inc 过)
    - `parentDepth` 字段:仍返 `sessionRepo.getSpawnDepth(caller.callerSessionId)`(因下游 spawn.ts:493 `spawnDepth fallback` 有兜底 `created?.spawnDepth ?? (... handOffMode 时 0)`,parentDepth 值在 handOffMode 分支不消费 — 但显式返真实值不增成本,reviewer 可 grep `parentDepth` 在 spawn.ts 全文实际消费位置 desk check)
  - jsdoc 更新:CHANGELOG_98 节内"batonMode=true 时跳过 depth check"→"handOffMode=true 时跳过三道防御 + 不进 in-flight 计数(D4 决策)"
- [ ] Step 2.3 — 改 `src/main/agent-deck-mcp/tools/handlers/spawn.ts`:
  - L45 spawn handler `opts?: { batonMode?: boolean; batonRole?: ... }` → `opts?: { handOffMode?: boolean; batonRole?: ... }`
  - L68 `applySpawnGuards` 调用入参 `batonMode: opts?.batonMode ?? false` → `handOffMode: opts?.handOffMode ?? false`
  - L324 `shouldWriteSpawnLink({ batonMode: opts?.batonMode })` → `shouldWriteSpawnLink({ handOffMode: opts?.handOffMode })`
  - L493 spawnDepth fallback 同款 rename
  - 全文 grep `batonMode` 同步改完(jsdoc + 注释 + 变量名)
- [ ] Step 2.4 — 改 `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts`:
  - `resolveBatonRoleForSpawn` 入参签名(L249-256)简化:删 `archive_caller` + `team_name` 入参字段 → `(_: void): { handOffMode: true; batonRole: 'lead' }` 直接返常量
  - handler 内 L672 调用 `resolveBatonRoleForSpawn({archive_caller, team_name})` 改 `resolveBatonRoleForSpawn()` 无参
  - L676-682 `spawnFn(spawnArgs, ctx, omitUndefined({ batonMode, batonRole }))` 改 `spawnFn(spawnArgs, ctx, { handOffMode: true, batonRole: 'lead' })`
  - jsdoc L226-247 重写:删 B-HIGH-2 / M12 描述(故意推翻),改"R1 plan handoff-no-spawn-guards-20260526 D4/D5/D6 — hand-off 完全独立于 spawn-guards / 永不写 spawn-link / batonRole 始终 'lead'"
  - **R2 LOW-1 修法**:全文 grep `'M12 修法|B-HIGH-2|退化 normal spawn'` 把 L664/L679 内联注释清理(均含「M12 修法 / B-HIGH-2 / archive_caller=false 退化 normal spawn」推翻后语义反转的 stale 内联注释)+ L710/L1179「baton 单向交接 = caller 会话使命终结」inline 注释 desk check(L710/L1179 在 D4/D5/D6 后仍 valid 因为 default `archive_caller=true` 路径语义不变;但需 Verify 不与 D3 power-user 描述矛盾)+ jsdoc L20 CHANGELOG_97 段保留(D4 后仍描述 baton 设计意图 valid)
- [ ] Step 2.4.5 — **R1 HIGH-2 修法新增**:同步 5 处资产/文档(顺序无依赖,可批量):
  - `src/main/agent-deck-mcp/tools/helpers.ts:122` jsdoc rename `batonMode` → `handOffMode`
  - `src/main/agent-deck-mcp/tools/schemas.ts:297-298` 注释更新成 D4 决策语义
  - `src/main/agent-deck-mcp/tools/index.ts` hand-off tool description(实施会话 grep `'batonMode\|baton 不计\|archive_caller=false 退化\|防止 caller 用 opt-out'` 定位 + 重写)
  - `resources/claude-config/CLAUDE.md:186` 整段重写(详 §D6 资产同步 4)
  - `resources/codex-config/CODEX_AGENTS.md:201` 同款对偶更新(详 §D6 资产同步 5)
- [ ] Step 2.5 — 跑 `pnpm typecheck` + `pnpm build`
- [ ] Step 2.6 — 跑测试(**R1 MED-4 修法 — 修正 zsh glob 不匹配**):
  ```bash
  pnpm exec vitest run \
    src/main/agent-deck-mcp/__tests__/spawn-link-guard.test.ts \
    src/main/agent-deck-mcp/__tests__/spawn-guards.test.ts \
    src/main/agent-deck-mcp/__tests__/hand-off-session.archive-caller-false.test.ts \
    src/main/agent-deck-mcp/__tests__/hand-off-session.handler-deny-happy.test.ts \
    src/main/agent-deck-mcp/__tests__/hand-off-session.handler-cwd-generic.test.ts \
    src/main/agent-deck-mcp/__tests__/hand-off-session.adopt-teammates.test.ts \
    src/main/agent-deck-mcp/__tests__/hand-off-session.task-reassign.test.ts \
    src/main/agent-deck-mcp/__tests__/hand-off-session.impl-core.test.ts \
    src/main/agent-deck-mcp/__tests__/tools.test.ts
  ```
  或全量 `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/`(更稳但慢)。修测试 + 加新 case(D7 新增 case 2 条)
- [ ] Step 2.7 — 实测:dev 启动 → 应用内起一对 hand_off 链(`archive_caller=true` 默认 + `archive_caller=false` 显式) → SessionList 看新 session 是 root 不缩进 / SessionCard 无 teammate chip / caller 无 lead chip
- [ ] Step 3 — 写 changelog 引用归档(CHANGELOG_151,**R1 INFO-12 修法 inline 明示**):
  - 显式 inline 一段:"batonMode 改名 handOffMode,语义从「跳 spawn-guards depth check」升级为「跳 spawn-guards 三道 + 永不写 spawn-link」(故意推翻 REVIEW_46/47 部分修法,详 D4 power-user 自负责任)。历史 REVIEW_39/46/47/48 出现的 batonMode 同义于现 handOffMode"
- [ ] Step 4 — archive_plan + 合 base_branch + 删 worktree

## 当前进度

Step 0 RFC + Step 0.5 (跳过) + Step 1 (首版本 plan) + Step 1.5 R1 + Step 1.5 R2 + Step 1.5 R3 全部完成。R1 收 12 条 finding(0 反驳)/ R2 收 6 条 finding(0 反驳)/ R3 收 4 条 finding(0 反驳)全部 inline 修订。

**最终 R3 共识**(双 reviewer 复用同对 + 旧 codex R3 卡住 user shutdown re-spawn 新 codex 跑 R1 全量等价 lead 视角 R3 verify):
- reviewer-claude R3 verify:0 HIGH 0 真 MED + 1 INFO cosmetic(L941 inclusion grep 兜底) → 显式"R3 可合"
- reviewer-codex R3(re-spawn R1 全量):0 HIGH 1 真 MED + 2 LOW 全采纳 inline 修订,本 plan 现在已 R3 修订版

**下一步**:用户 confirm 后进 Step 2 EnterWorktree 实施。**不再开 R4**(R3 修订都是 plan 状态自身漂移 / Step 2.1-2.3 typecheck 边界明示 / adopt 测试 opts 覆盖,trivial 修法 implementor cold-start 时可 desk verify)。

## 下一会话第一步

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/handoff-no-spawn-guards-20260526.md` 全文
2. 若 §当前进度 仍 Step 1.5 R3 未通过 → invoke `/agent-deck:deep-review` (args: `{kind: 'plan', paths: ['/Users/apple/Repository/personal/agent-deck/.claude/plans/handoff-no-spawn-guards-20260526.md']}`) 走对应轮次复审
3. 若 §当前进度 Step 1.5 R3 已通过(双 reviewer "可合" 共识)→ 用户 confirm 进 worktree 后,**互斥二选一**:

   **选项 A — claude 端 手工 git + builtin EnterWorktree**(两步):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-handoff-no-spawn-guards-20260526 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/handoff-no-spawn-guards-20260526 50b46ffbf20b11020153594b041c25937bd9308e
   ```
   ⚠️ 末尾 `50b46ffbf20b11020153594b041c25937bd9308e` 是 plan frontmatter `base_commit` **必须显式传**(避开 EnterWorktree CLI v2.1.112 stale base bug,详 user CLAUDE.md §EnterWorktree CLI stale base bug callout)。

   然后进 worktree:
   ```
   EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/handoff-no-spawn-guards-20260526")
   ```
   ⚠️ 用 `path:` 不用 `name:`,避开 stale base bug。

   **选项 B — codex 端 mcp 创建 worktree + 手工 cwd 切换**(R1 HIGH-1 修法 — codex MCP 不自动切 cwd):
   ```
   mcp__agent-deck__enter_worktree({ plan_id: "handoff-no-spawn-guards-20260526", base_commit: "50b46ffbf20b11020153594b041c25937bd9308e" })
   ```
   ⚠️ **mcp `enter_worktree` 副作用**(`resources/codex-config/CODEX_AGENTS.md:134` 明文):创建 worktree 目录 + 新 branch + setCwdReleaseMarker。**不**自动切 codex SDK session cwd(codex SDK session cwd 在 spawn 时 frozen,后续 shell tool 走子 shell)。
   ⚠️ **codex 端必须**在 Step 2.1-2.7 后续每个 shell / apply_patch 调用使用 worktree 绝对路径 `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/handoff-no-spawn-guards-20260526/...` 或 `git -C /Users/apple/Repository/personal/agent-deck/.claude/worktrees/handoff-no-spawn-guards-20260526 <cmd>`。**绝不**使用相对路径(会落到 codex spawn 时的 cwd,即主仓库 `/Users/apple/Repository/personal/agent-deck`,污染 main working tree)。

   **绝不**先跑 A 再跑 B(或反之)— path / branch 已存在,第二条命令必失败。

   **失败 cleanup**(R1 LOW-10 + **R2 codex MED-2** 修法 — A/B 路径分流):任一选项跑了一半失败 → 已建 worktree 目录 + branch + (选项 B) DB `cwd_release_marker`,后续切另一选项必撞 "path/branch already exists" + (选项 B) stale marker 让 archive_plan / exit_worktree 预检走错路径。

   **选项 A 失败 cleanup**(纯 git,无 DB marker 副作用):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck worktree remove /Users/apple/Repository/personal/agent-deck/.claude/worktrees/handoff-no-spawn-guards-20260526 --force
   git -C /Users/apple/Repository/personal/agent-deck branch -D worktree-handoff-no-spawn-guards-20260526
   ```

   **选项 B 失败 cleanup**(MCP 路径,优先用 `exit_worktree` 一并清 marker + worktree + branch — 因 `enter_worktree` 成功步骤 8 写 `cwd_release_marker`,纯 git cleanup 不清 DB marker):
   ```
   mcp__agent-deck__exit_worktree({ action: "remove", worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/handoff-no-spawn-guards-20260526", discard_changes: true })
   ```
   ⚠️ **`enter_worktree` 在 marker 写入失败的错误分支**(`enter-worktree-impl.ts:302-316` step 8):返回 `error: "worktree created but setCwdReleaseMarker failed: ..."` + hint「caller 必须显式传 `args.worktree_path`」 — 此时 worktree 已建但 marker 没写,exit_worktree 自动反查不到 → caller 必须显式传 `worktree_path` 才能清。
   ⚠️ **MCP exit_worktree 自身失败的兜底**(罕见):退化纯 git cleanup(同选项 A 命令)+ console.warn 提醒「stale `cwd_release_marker` 可能残留 → 重启 app 或手工清 sessions 表 cwd_release_marker 字段」。

   然后再切另一选项重试。

4. 进 worktree 后按 Step 2.1 → 2.7 顺序实施,trivial 在前(rename + 文档同步类先做,Step 2.1 → 2.4.5),逻辑改在后(Step 2.4 hand-off-session.ts 简化 lambda + handler 调用是核心)
5. 进度 / 决策变更必须先告诉用户征得确认

## 已知踩坑

- **`batonMode` 这个词在代码注释 + jsdoc + REVIEW_39/46/47/48 历史 review 文档遍布**:rename 不可能 grep -R 全替(REVIEW 历史不动),只改活代码 + 测试 + 资产文档(已 inline 到 §D6 资产/文档同步 5 处 + Step 2.4.5)。jsdoc + changelog 必须明示 `batonMode` 历史名词已 rename 为 `handOffMode` + 语义升级范围(详 §Step 3 R1 INFO-12 修法)。
- **`applySpawnGuards` 三道全跳实现细节**(R1 MED-6 修法已明示在 §Step 2.2):`inFlightChildren.inc` 也跳过,`fanOutSlot.release` 退化 no-op,`parentDepth` 仍返真实值(下游不消费 但显式返不增成本)。**reviewer 必查 grep `parentDepth`** 在 spawn.ts 实际消费位与 handOffMode 路径下是否真无影响。
- **`spawn-link-guard.test.ts:8` 与 `spawn-link-guard.ts:21` 函数签名是 testing surface**:rename batonMode → handOffMode 同步改(已 inline 到 §D7)。
- **REVIEW_46/47 当年的 fork-bomb 修法(B-HIGH-2 + M12)被本 plan 故意推翻**:用户接受 power-user 自负责任(D3 + D4)。changelog 必须显式说明 "推翻 REVIEW_46/47 部分修法",避免未来 reviewer 看 REVIEW_46/47 又"修回去"(R1 INFO-12 修法)。
- **`hand-off-session.archive-caller-false.test.ts` **整文件反转**(R1 HIGH-3 + MED-7)**:整个文件测试意图就是验 REVIEW_46/47 修法本身,plan §D5/D6 故意推翻 → 文件 jsdoc 重写 + 4 个 lambda case 入参/断言全反转 + 4 个 handler case 中 2 个反转。详 §D7 完整列表。
- **`adopt_teammates: true` 与本 plan 改造**(R1 LOW-11 修法已加 grep 命令):adopt 是 swapLead 接管 lead 角色与 spawn-link / spawn-guards 正交。改造不应影响 adopt 路径。**实施会话 grep `(applySpawnGuards|batonMode|inFlightChildren|fanOutSlot)`** 在 `src/main/agent-deck-mcp/__tests__/hand-off-session.adopt-teammates.test.ts` 实测 hit 数,逐条核实是否需 rename / 反转 / 删除(N5 ≥1 lead 硬约束 / firstTeam fatal abort / 非 firstTeam 软失败 etc. 不动)。
- **问题 1 改动 (SessionList.tsx + CHANGELOG_150 + INDEX) 仍在 main working tree 未 commit**:plan worktree 是独立 branch 不冲突。archive_plan 时检查 main critical paths (`plans/INDEX.md / plans/<plan-id>.md / 同名子目录`) 不 dirty,问题 1 改的 `src/renderer/components/SessionList.tsx` + `changelog/INDEX.md` + `changelog/CHANGELOG_150.md` 都不在 critical paths,只 warn 不 reject。
- **codex 端 worktree 路径硬约束**(R1 HIGH-1 修法已 inline 到 §下一会话第一步 选项 B):mcp `enter_worktree` 不切 codex SDK cwd,实施会话所有 shell / apply_patch 必须用 worktree 绝对路径或 `git -C <worktree>` — 否则相对路径会落到主仓库 main working tree。
- **R1 deep-review 12 条 finding 0 反驳全采纳**:全 inline 修订到 plan;R2 复审验所有修订是否落到位 + 是否引入新问题。
