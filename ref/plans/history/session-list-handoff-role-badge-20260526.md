---
plan_id: "session-list-handoff-role-badge-20260526"
created_at: "2026-05-26"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/session-list-handoff-role-badge-20260526"
status: "completed"
base_commit: "ef167940809bd22904a8f1bdd810f0cf8d02ace4"
base_branch: "main"
final_commit: "e44a058e0540336a5484bb07e8a2b31e8d7b8acd"
completed_at: "2026-05-26"
---
# Plan: SessionList hand_off lead/teammate badge 显示修复 (v4)

> **v4 修订**(基于 R3 deep-review 双 reviewer 共 8 finding,2 升级 HIGH 级): HIGH-α 移除 hand_off 不存在的 `display_name` 字段 (codex MED-1 grep 实证 strict safeParse 拦实测) + HIGH-β 场景 4 期望视觉重写为 D→B(lead)→C2 + C2 改名避同名混淆 (双方独立 claude MED-1 / codex LOW-1) + Step 4.1.5 加 mixed role corner 4+5 + R2 风险加 Phase 1 sessions.find O(N²) + 测试矩阵行号 align + D4 段落对齐 D7 mixed role 可达 + D7 grep 实证时间戳注。
>
> **v3 修订**(基于 R2 deep-review): D2 Phase 1 加 universal team 条件检查阻断 archive_caller:false 反例错锁 + isPureSpawnChain 自身独立单测 + D7 mixed role nested spawn 当前可达 + Step 4.1 补 hasOwner=true 路径 case + Step 5.4 重组独立 caller + display_name/cwd 注 + visibleLeadByTeamId 顺序防御注 + 跨 section fallback 失效已知踩坑 + O(N²) 性能注。**INFO-1 unknown role jsdoc** 双 reviewer 有分歧 (codex 否决「不扩 plan scope」) → 不修。
>
> **v2 修订**(基于 R1 deep-review): D4 反转(加 universal team 收编 fallback)+ HIGH-1 抽 shared util + HIGH-2 helper 区分纯 spawn 链 + Step 4.3 重写实测序列 + Q2 简化为单 parent + 测试矩阵补 corner + 加 unit test 步骤。

## 总目标

修复 `hand_off_session({adopt_teammates: true})` 过继 teammate 后,实时面板(SessionList)**新 session 不显示 👑 lead badge** + **原 teammate 不显示 ↳ teammate badge** + **缩进关系丢失** 三个症状。让 SessionList 在 badge + 树形缩进两个维度都正确反映 universal team backend 的 lead/teammate 关系,并与 PendingTab 行为对齐(同抽 shared util)。

**Why**:
- plan `handoff-no-spawn-guards-20260526`(已 merge,commit 66294f4)硬定语义「hand-off 永不写 spawn-link」(`sessions.spawned_by`/`spawn_depth` 保持 null/0)
- SessionList.tsx 的 `teamRole` 推断仍只看 spawn-link → hand-off 路径完全失去 badge + 缩进
- PendingTab.tsx:115 + SessionCard.tsx 都按 `teams[0].role` 单一规则,与本次新 D5「任一 lead 优先」规则冲突 → 需要抽 shared util 一起对齐(R1 HIGH-1 双方独立提出)

**如何应用**(给下一会话):cold-start `Bash: cat <plan-abs-path>` 全文 → frontmatter 取 `worktree_path` → `EnterWorktree(path: <worktree_path>)` → 按 §下一会话第一步 接力

## 不变量

1. **universal team role 是 SessionList badge + 树形缩进的 SSOT**: session.teams[*].role 命中即取该 role;**不**再单看 spawn-link
2. **spawn-link 仍是 fallback,但必须区分纯 spawn 链 vs universal team 参与场景**(R1 HIGH-2): session.teams 为空时,仅当该 session 与其所有 visible children/owner 均无 universal team membership 时才走 spawn-link 推断 lead/teammate;否则 badge undefined(避免 `archive_caller:false` adopt 后 caller 仍 active 但已 left team → 撞 spawn 子节点错标 lead)
3. **多 team 时「任一 lead 优先」**: 任一 team role==='lead' → badge 显示 lead;全 teammate → badge 显示 teammate(R1 HIGH-1: 抽 shared util `deriveTeamRole`,PendingTab 一起改)
4. **树形分组双源 fallback**(D4 反转,user confirmed): spawn-link 优先(老 spawn 路径行为不变),session 没 visible spawn parent 时,看 universal team membership 是否有同 team visible lead → 缩进到该 lead 下(hand_off 后 newSid+teammates 视觉层级回归)
5. **当前 spawn / hand_off 路径下 teammate 只有 1 个 visible lead 父亲**(grep + design 验证,详 §设计决策 D7): 
   - **同一 teammate 在多个 team 同时当 teammate** 当前路径**不可达**:renderer UI 无 `addAgentDeckTeamMember` 调用入口(grep 零命中)+ spawn_session 强制 caller=lead/new=teammate(teammate 一次 spawn 锁定单 team) + hand_off swapLead 不新建 membership。所以 universal team 收编 fallback 只需处理「teammate→单 visible lead」单 parent 情况
   - **Mixed lead+teammate**(同一 session 既是 team A 的 lead 又是 team B 的 teammate)**当前路径可达** (R2 codex LOW-2 实证): 任一 caller B 已是 T1 teammate, 再调 `spawn_session({team_name:'T2'})` 自己变 T2 lead → B 同时 T1 teammate + T2 lead。Phase 2 仍按 B 的 T1 teammate 角色把 B 收编到 T1 lead (设为 A) 下;同时 B 的 T2 teammates 缩进在 B 下。视觉:A → B(👑 lead, 任一 lead 优先) → C(T2 teammate)
   - **理论防御**: 如未来开 UI 入口让同 teammate 多 team teammate 出现, 退到 「first-match-wins」第一个 visible lead(不复制渲染); 当前不会触发
6. **enrichWithTeams / swapLead / IPC 链路不动**: 修法只动 renderer 层(SessionList.tsx + SessionCard.tsx jsdoc + PendingTab.tsx 接 shared util + 新建 `src/renderer/lib/derive-team-role.ts`),**0 接口签名变更 / 0 DB 字段变更 / 0 IPC channel 变更**
7. **typecheck + build pass + 新 helper unit test 全 pass**(R1 LOW-1 reviewer-codex F4): Step 3/4 加 helper unit test 覆盖所有 corner case
8. **dev 实测 hand_off 一次**: UI 视觉行为只能在浏览器实测验证(本约定 §Doing tasks 强约束);Step 4.3 给完整可执行实测序列

## 设计决策(不再争论)

### D1 抽 module-level shared util `deriveTeamRole` 到 `src/renderer/lib/derive-team-role.ts`

**Why** (R1 HIGH-1 reviewer-claude MED-1 + reviewer-codex F3 双方独立提出): PendingTab.tsx:115 + SessionCard 都用 `teams[0].role` 单一规则,SessionList 改用新 D5 规则会让同一 session 在两处显示不同 badge,与 §总目标 直接冲突。抽 shared util 让所有 renderer 渲染 lead/teammate badge 的位置走同一份规则,DRY 防漂移。

**新文件**: `src/renderer/lib/derive-team-role.ts`

```ts
import type { SessionRecord } from '@shared/types';

/**
 * 从 session 推断 team 角色 badge。SSOT for 所有 renderer 渲染 lead/teammate badge 的位置
 * (SessionList / PendingTab / 未来新增组件)。
 *
 * 优先级 (plan session-list-handoff-role-badge-20260526 §不变量 1-2):
 *   1. universal team backend membership (DB 权威)
 *      - 任一 team role==='lead' → 'lead' (R1 §不变量 3 任一 lead 优先)
 *      - 否则 → 'teammate'
 *   2. spawn-link 退化(仅纯 spawn 链场景,即 session 自身 + 所有 visible spawn 相关
 *      session 均无 universal team membership;否则 universal team backend 才是权威,
 *      spawn-link 不能越权代理 lead/teammate 标识 — 详 §不变量 2 + HIGH-2)
 *      - hasOwner=true && self 无 universal team → 'teammate'
 *      - childrenCount > 0 && self 无 universal team && pureSpawnChain=true → 'lead'
 *      - 其余 → undefined
 *
 * @param session         目标 session
 * @param hasOwner        本 session 有 visible spawn owner (SessionList 树形分组计算)
 * @param childrenCount   本 session visible spawn children 数量
 * @param pureSpawnChain  visible owner / children 是否均无 universal team membership
 *                        (避免 `archive_caller:false` adopt 后 caller 仍 active 但已 left
 *                        team → 撞 spawn 子节点错标 lead;详 R1 HIGH-2)
 */
export function deriveTeamRole(
  session: SessionRecord,
  hasOwner: boolean,
  childrenCount: number,
  pureSpawnChain: boolean,
): 'lead' | 'teammate' | undefined {
  // 1. universal team backend SSOT
  const teams = session.teams ?? [];
  if (teams.length > 0) {
    if (teams.some((t) => t.role === 'lead')) return 'lead';
    return 'teammate';
  }
  // 2. spawn-link 退化(仅纯 spawn 链)
  if (!pureSpawnChain) return undefined;
  if (hasOwner) return 'teammate';
  if (childrenCount > 0) return 'lead';
  return undefined;
}
```

**对 PendingTab 调用方**: PendingTab 平铺无树形 context,调 `deriveTeamRole(session, false, 0, true)` 等价「仅看 universal team」(hasOwner+childrenCount 都 0 + pureSpawnChain=true 让 fallback 分支始终返 undefined),与现有 `primaryTeam?.role` 行为兼容(单 team 时一致;多 team 全 lead 升级到「任一 lead 优先」是合理对齐)。

**对 MembersSection.tsx 不影响**: MembersSection 是 per-team view,直接读 `member.role`(单 team scope),不走 shared util。

### D2 SessionList.tsx 树形分组双源 fallback + 缩进 hand_off teammates 到 lead 下

**Why** (D4 反转,user confirmed + R1 reviewer-claude MED-3 mid-tier 注释): D4 旧决定「不动树形分组」让 hand_off 后 newSid + teammates 平铺,视觉层级丢失。改为 spawn-link 优先 + universal team 收编 fallback,既保留老 spawn 派遣链树语义,又给 hand_off 路径恢复缩进。

**位置**: `src/renderer/components/SessionList.tsx:29-87`

**当前 childrenByOwner 构造逻辑** (L29-40):
```ts
const childrenByOwner = new Map<string, SessionRecord[]>();
const roots: SessionRecord[] = [];
for (const s of sessions) {
  if (s.spawnedBy && visibleIds.has(s.spawnedBy)) {
    const arr = childrenByOwner.get(s.spawnedBy) ?? [];
    arr.push(s);
    childrenByOwner.set(s.spawnedBy, arr);
  } else {
    roots.push(s);
  }
}
```

**改为双 phase**(v3 修订 HIGH-A: Phase 1 加 universal team 条件检查):
```ts
// Phase 1: spawn-link primary (有条件收编)
const childrenByOwner = new Map<string, SessionRecord[]>();
const claimedBySpawn = new Set<string>();
for (const s of sessions) {
  if (!s.spawnedBy || !visibleIds.has(s.spawnedBy)) continue;

  // v3 HIGH-A 修法 (R2 codex MED-1): 对有 universal team teammate membership 的 child,
  // 必须验证 spawn owner 仍是 child 某 team 的 active visible lead;否则不锁 claimedBySpawn,
  // 让 Phase 2 走 universal team SSOT 收编 (避免 archive_caller:false 反例下 caller 已 left_at
  // 但 child spawnedBy 仍指向它,Phase 1 把 child 错锁在 stale caller 下)。
  //
  // 纯 spawn 子任务 (s.teams 为空) → 直接走 spawn-link 收编 (无 universal team 干扰)
  const sTeams = s.teams ?? [];
  if (sTeams.length > 0) {
    const owner = sessions.find((o) => o.id === s.spawnedBy);
    // owner 是 child 某 team 的 active visible lead → spawn-link 与 universal team 一致,锁
    const ownerLeadsSomeTeamOfS =
      owner?.teams?.some(
        (ot) => ot.role === 'lead' && sTeams.some((st) => st.teamId === ot.teamId),
      ) ?? false;
    if (!ownerLeadsSomeTeamOfS) continue; // 不锁 Phase 1,让 Phase 2 按 universal team reparent
  }

  const arr = childrenByOwner.get(s.spawnedBy) ?? [];
  arr.push(s);
  childrenByOwner.set(s.spawnedBy, arr);
  claimedBySpawn.add(s.id);
}

// Phase 2: universal team 收编 fallback
// 仅 Phase 1 未收编的 teammate 走此分支;teammate 找同 team 的 visible lead 缩进进去
// (first-match-wins 单 parent,详 §不变量 5)
//
// v3 LOW-4 防御性注 (R2 claude LOW-4): visibleLeadByTeamId 取**第一个**遍历到的 visible lead per
// team_id (按 sessions 数组顺序 = selectLiveSessions 返回顺序);swap 保证唯一 lead 时不会冲突,
// 如出现数据不一致 (理论 corner — swap 中间态 / DB race) 走 selectLiveSessions 顺序的第一个,
// 这是防御性行为不是 guarantee。
const visibleLeadByTeamId = new Map<string, SessionRecord>(); // teamId → visible lead session
for (const s of sessions) {
  for (const t of s.teams ?? []) {
    if (t.role === 'lead' && !visibleLeadByTeamId.has(t.teamId)) {
      visibleLeadByTeamId.set(t.teamId, s);
    }
  }
}
const claimedByTeam = new Set<string>();
for (const s of sessions) {
  if (claimedBySpawn.has(s.id)) continue; // spawn-link 已收编
  // 找 self 是 teammate 的 team,取第一个 visible lead 收编
  for (const t of s.teams ?? []) {
    if (t.role !== 'teammate') continue;
    const lead = visibleLeadByTeamId.get(t.teamId);
    if (!lead || lead.id === s.id) continue;
    const arr = childrenByOwner.get(lead.id) ?? [];
    arr.push(s);
    childrenByOwner.set(lead.id, arr);
    claimedByTeam.add(s.id);
    break; // first-match-wins 单 parent (§不变量 5)
  }
}

// Phase 3: roots = 未被任何方式收编的 session
const roots: SessionRecord[] = sessions.filter(
  (s) => !claimedBySpawn.has(s.id) && !claimedByTeam.has(s.id),
);
```

**renderNode 内 teamRole 计算** 改用 `deriveTeamRole` shared util:
```ts
function renderNode(session, visualDepth, hasOwner): JSX.Element[] {
  const children = childrenByOwner.get(session.id) ?? [];
  // pureSpawnChain: 本 session 自己 + visible owner(如有) + visible children 是否全无 universal team membership
  // (R1 HIGH-2: 避免 `archive_caller:false` adopt 后 caller 仍 active 但已 left team → 撞 spawn 子节点错标 lead)
  const pureSpawnChain = isPureSpawnChain(session, children, sessions);
  const teamRole = deriveTeamRole(session, hasOwner, children.length, pureSpawnChain);
  // ...
}

// module-level helper
function isPureSpawnChain(
  self: SessionRecord,
  children: SessionRecord[],
  allSessions: SessionRecord[],
): boolean {
  if ((self.teams?.length ?? 0) > 0) return false;
  for (const c of children) {
    if ((c.teams?.length ?? 0) > 0) return false;
  }
  if (self.spawnedBy) {
    const owner = allSessions.find((s) => s.id === self.spawnedBy);
    if (owner && (owner.teams?.length ?? 0) > 0) return false;
  }
  return true;
}
```

**注**: SessionList renderNode 的 `hasOwner` 现在由「Phase 1 spawn-link 收编」OR「Phase 2 universal team 收编」决定(传 `claimedBySpawn.has(s.id) || claimedByTeam.has(s.id)` 进 renderNode 替代原 hasOwner)。

**mid-tier dual-role 注释更新** (R1 reviewer-claude MED-3): SessionList.tsx L48-50 原注释「hasOwner 优先 teammate」改写为反映新优先级路径:
> hasOwner 走 `deriveTeamRole` shared util,优先看 universal team membership(任一 lead → lead),退化才用「对 owner 是 teammate」(纯 spawn 链场景)。mid-tier dual-role 节点(既有 owner 又有 children) badge 来源可能来自 universal team backend(与原"始终 teammate"行为改写,详 plan §D1 优先级)。

### D3 SessionCard.tsx jsdoc + hover title 更新

**位置**: `src/renderer/components/SessionCard.tsx:12-22` jsdoc + `:119-134` badge `title` 属性

**jsdoc** 改为:
```ts
/**
 * Phase C (CHANGELOG_77) + plan session-list-handoff-role-badge-20260526 §D1:
 * 在 team 中的角色 badge,数据来源走 `deriveTeamRole` shared util:
 * - 'lead': 优先看 session.teams[*].role==='lead' (任一 lead);退化看是否为纯 spawn 链
 *   的 owner (visible children > 0 且全无 universal team)
 * - 'teammate': 优先看 session.teams[*].role==='teammate';退化看是否在纯 spawn 链
 *   的子位置 (hasOwner=true 且 self / owner 全无 universal team)
 * - undefined: 既无 universal team membership,也不是纯 spawn 链相关节点
 *
 * SessionList 在树形分组时计算 owner→children Map(spawn-link 优先 + universal team
 * 收编 fallback,详 plan §D2)后传入。SessionList / PendingTab 共用同一份 deriveTeamRole
 * util 保持行为一致(plan §D1 HIGH-1)。
 *
 * lead 走「蓝边」(border 颜色);teammate 走「浅蓝小 chip」(bg+text),与现有 🛡 teamName
 * chip 风格一致。
 */
teamRole?: 'lead' | 'teammate';
```

**hover title 改为 multi-team 详列** (R1 reviewer-claude LOW-4 模仿 PendingTab.tsx:116-121):
```tsx
{teamRole === 'lead' && (
  <span
    className="rounded bg-blue-400/15 px-1 py-0.5 text-[9px] font-medium text-blue-200"
    title={teamHoverTitle || '本会话是某 team 的 lead'}
  >
    👑 lead
  </span>
)}
{teamRole === 'teammate' && (
  <span
    className="rounded bg-blue-400/10 px-1 py-0.5 text-[9px] font-medium text-blue-200/85"
    title={teamHoverTitle || '本会话是某 team 的 teammate'}
  >
    ↳ teammate
  </span>
)}
```

复用 SessionCard.tsx L74-79 已有的 `teamHoverTitle` 变量(multi-team 时列完整 `team [role]` 表;single-team 时单行)。

### D4 PendingTab.tsx 改接 `deriveTeamRole` shared util

**位置**: `src/renderer/components/PendingTab.tsx:115`

**Why** (R1 HIGH-1): 不改 PendingTab 会撞 §D5 与 PendingTab 行为不一致(同一 session 在 SessionList 显 lead, 在 PendingTab 显 teammate)。

**改为**:
```ts
const primaryTeam = session.teams?.[0];
const displayTeamName = primaryTeam?.teamName ?? null;
const teamCount = session.teams?.length ?? 0;
const teamRole = deriveTeamRole(session, false, 0, true); // 平铺无树 → fallback 始终 undefined
// hover title 仍按 primaryTeam 显示(`Agent Team: <name> [<role>]`);teamRole 走 shared util
// 保证「任一 lead 优先」与 SessionList 对齐(R1 HIGH-1)。
```

L218-233 badge 渲染 + hover title 文案保持原样(teamRole 改 source 不改 visual)。

**对单 team 用户行为兼容**: 单 team 场景下 `teams[0].role` 与 `deriveTeamRole(...)` 输出一致;多 team mixed role (v4 R3 codex LOW-2 对齐 D7: 由 nested spawn 当前路径可达 — 详 §D7) 首次升级到「任一 lead 优先」,这是合理统一。

### D5 「任一 lead 优先」多 team 角色规则

(同 v1 D5,内容不变;此处保留作为 ssot)

session 同时是 team A 的 lead + team B 的 teammate 时 badge 显示 lead。**Why**: 让 lead 身份突出,避免被误认成纯 teammate。🛡 chip + hover title 仍 PendingTab 风格列完整 `team [role]` 列表(D3 hover 部分已对齐)。

### D6 hand_off `archive_caller: false` corner case 修法

**Why** (R1 HIGH-2 reviewer-codex F1 + reviewer-claude MED-2 双方独立提出): hand_off + adopt_teammates=true + archive_caller=false 时,caller 仍 active 但 swapLead 把 caller 的 team membership `left_at=now` → enrichWithTeams 不再灌 caller 的 team → caller.teams=[];但原 teammate 的 spawnedBy 仍指向 caller(visible)→ caller 在 SessionList 有 visible children → 旧 fallback 错把 caller 标成 lead(实际 newSid 才是 lead)。

**修法** (§D1 helper 内已 enforce): `deriveTeamRole` 接收 `pureSpawnChain` 参数,只当本节点 + visible owner/children 全无 universal team membership 时才走 spawn-link 推断 lead。此 corner 场景:
- caller.teams=[](../已 left)
- 原 teammate.teams=[{role:'teammate'}](../universal team 仍是 teammate)
- → `isPureSpawnChain(caller, [原 teammate], allSessions)` returns false(children 含 universal team)
- → caller 的 `teamRole = undefined`(无 badge),不再误标 lead ✓

**对原 teammate**: 它有 universal team(teammate role)→ 走优先级 1 显示 teammate badge ✓

**对 newSid**: 它在 universal team 是 lead → 走优先级 1 显示 lead badge + 树形 Phase 2 把原 teammate 缩进到 newSid 下 ✓

**结果**: 用户视角 caller 仍 active 但无 badge(已 left 不再代表团队),newSid 是 lead 且带原 teammate(视觉清晰反映新所有权)。

### D7 当前不会出现「同 teammate 多 visible lead」证据 + Mixed lead+teammate 当前可达

**Why**: §不变量 5 引用,user 提出的「这种功能存在吗?」需 plan inline 证据;R2 codex LOW-2 指出 mixed role nested spawn 当前可达需明示。

**Grep 实证(同 teammate 多 lead parent 不可达)**:
```
grep -rn "addAgentDeckTeamMember\|window.api.addAgent\|AddMember" src/renderer/
→ 零命中
```
(实证时间: v3 plan 写作时, base_commit `ef167940`;如未来添加 AddMember UI 重新跑此 grep + 更新 §不变量 5 — v4 R3 claude INFO-1)
即 `IpcInvoke.AgentDeckTeamAddMember` IPC handler 存在(`src/main/ipc/teams.ts:178`)+ preload expose(`src/preload/api/teams.ts:76`),但 renderer 无任何 UI 入口调用。

**当前自动产生 membership 的路径**:
- `spawn_session({team_name})` (spawn.ts:383+405): caller=lead / new=teammate
- `swapLead` (member-crud.ts:252-352): 仅过继 lead 角色,不新建 membership
- `cli.ts:292+333`: main 内部 path,无 multi-team teammate 模式

**结论 1: 同 teammate 多 teammate parent 当前不可达** — teammate 一次 spawn 锁定单 team,后续仅能再当 lead 不能再当 teammate;Phase 2 单 parent first-match-wins 即可。

**结论 2: Mixed lead+teammate 当前可达** (R2 codex LOW-2 实证 — `spawn.ts:381-418` 任意 caller 传 team_name 都成为该 team lead): 
- caller B 已在 team T1 是 teammate (T1 由其他 caller A spawn 出 B 时锁定)
- B 自己再调 `spawn_session({team_name:'T2', prompt:..., cwd:..., display_name:'C'})` → spawn handler 把 B 加入 T2 当 lead + 新 session C 加入 T2 当 teammate
- 结果 B 同时 T1 teammate + T2 lead;C 是 T2 teammate

**Mixed role 在 SessionList 的视觉路径**:
- Phase 1: B.spawnedBy=A,A 是 T1 lead,B.teams 含 T1 teammate 对齐 → spawn-link 锁 B 到 A 下
- Phase 1: C.spawnedBy=B,B 是 T2 lead,C.teams 含 T2 teammate 对齐 → spawn-link 锁 C 到 B 下
- B 自己 badge: `deriveTeamRole(B)` 看 B.teams=[{T1,teammate},{T2,lead}],「任一 lead 优先」→ 显 lead
- 视觉: A → B(👑 lead) → C(↳ teammate)。mid-tier B 对 owner A 是 teammate (缩进位),对 children 是 lead (badge 显 lead) — D5 决策让 badge 与原 L48-50「始终 teammate」承诺改写

**理论防御**: 如未来开 UI 入口让同 teammate 出现在多 team teammate (即同时 T1 teammate + T2 teammate),fallback 走 first-match-wins 第一个 visible lead,**不复制渲染**(简化 design)。R3 reviewer 验证此假设。

### D8 不动其他组件

- `manager-enrich.ts`: 已正确灌 role,不动
- `agent-deck-team-repo/member-crud.ts` swapLead: 已正确 UPDATE role,不动
- `hand-off-session.ts`: emit + notifyTeamMembershipChanged 链路完整,不动
- `TeamDetail/MembersSection.tsx`: 是 per-team view,直接读 `member.role`,不走 shared util,不动

## 步骤 checklist

- [x] **Step 1** — 写 plan 文件 v1 (已完成,跑了 R1)
- [x] **Step 1.5 R1** — `/agent-deck:deep-review` 走完,共 13 finding(0 HIGH/3 MED reviewer-claude + 0 HIGH/2 MED reviewer-codex),双方独立提出升级 2 HIGH;全 ✅ 接受,本 v2 已整合
- [x] **Step 1.5 R2** — R2 评审 v2 修订, 共 13 finding(0 raw HIGH/3 MED reviewer-claude + 0 raw HIGH/2 MED reviewer-codex), 升级 2 HIGH: HIGH-A (codex MED-1) D2 Phase 1 无条件 spawn-link 收编破坏 archive_caller:false 反例 + HIGH-B (双方 MED-2) isPureSpawnChain 缺单测; INFO-1 unknown role jsdoc 双方分歧 codex 否决 → 不修。本 v3 已整合
- [x] **Step 1.5 R3** — R3 评审 v3 修订, 共 8 finding (0 raw HIGH/2 MED reviewer-claude + 0 raw HIGH/1 MED reviewer-codex), 升级 2 HIGH 级: HIGH-α (codex MED-1) hand_off_session schema 无 display_name 字段 (strict safeParse 拦实测) + HIGH-β (双方 claude MED-1/codex LOW-1) 场景 4 期望视觉与场景 1 后实际状态不一致。本 v4 已整合 6 项修订 + INFO grep 时间戳。User 决策 v4 后跳 R4 直接进 Step 2 (修订都是文档/测试 corner 补充, 不是 design 重写, 风险低)
- [ ] **Step 2** — User confirm 后 EnterWorktree(path:):`git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-session-list-handoff-role-badge-20260526 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/session-list-handoff-role-badge-20260526` + `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/session-list-handoff-role-badge-20260526")` — **当前阶段 (Step 1.5 deep-review 已闭环)**
- [ ] **Step 3** — 改代码(全部路径用 worktree 绝对路径):
  - Step 3.1: `Write <worktree>/src/renderer/lib/derive-team-role.ts` — 新建 D1 helper
  - Step 3.2: Edit `<worktree>/src/renderer/components/SessionList.tsx` — D2 双 phase childrenByOwner(含 v3 HIGH-A Phase 1 条件检查 + LOW-4 顺序防御注) + isPureSpawnChain helper + renderNode 接 shared util + 更新 L8-21 节注释 + mid-tier dual-role 注释(R1 MED-3)
  - Step 3.3: Edit `<worktree>/src/renderer/components/SessionCard.tsx` — D3 jsdoc + hover title 复用 teamHoverTitle(R1 LOW-4)
  - Step 3.4: Edit `<worktree>/src/renderer/components/PendingTab.tsx` — D4 改 import + teamRole 调 deriveTeamRole(R1 HIGH-1)
- [ ] **Step 4** — Helper + isPureSpawnChain 单元测试(R2 HIGH-B 双方独立 + R1 LOW-1 reviewer-codex F4 + R2 claude MED-1):
  - Step 4.1: `Write <worktree>/src/renderer/lib/__tests__/derive-team-role.test.ts` 覆盖 11 corner:
    1. teams=undefined + pureSpawnChain=true + hasOwner=false + 0 children → undefined
    2. teams=[] + 同上 → undefined
    3. teams=[{role:'lead'}] → lead
    4. teams=[{role:'teammate'}] → teammate
    5. teams=[{role:'lead'},{role:'lead'}] (全 lead) → lead
    6. teams=[{role:'teammate'},{role:'teammate'}] (全 teammate) → teammate
    7. teams=[{role:'lead'},{role:'teammate'}] (mixed,nested spawn 可达) → lead (任一 lead 优先)
    8. teams=[] + pureSpawnChain=true + childrenCount=2 + hasOwner=false → lead (纯 spawn 链 owner)
    9. teams=[] + pureSpawnChain=false + childrenCount=2 + hasOwner=false → undefined (HIGH-2 反例 owner 视角)
    10. **(v3 R2 claude MED-1 case A)** teams=[] + pureSpawnChain=true + hasOwner=true + childrenCount=0 → 'teammate' (纯 spawn 子节点 fallback)
    11. **(v3 R2 claude MED-1 case B)** teams=[] + pureSpawnChain=false + hasOwner=true + childrenCount=0 → undefined (HIGH-2 反例 children 视角 mirror)
  - Step 4.1.5: **(v3 R2 HIGH-B)** `Write <worktree>/src/renderer/components/__tests__/session-list.test.ts` 覆盖 isPureSpawnChain 5 corner + childrenByOwner Phase 1 条件检查 5 corner:
    - isPureSpawnChain corner 1: self.teams 不空 → false (priority 1 短路)
    - isPureSpawnChain corner 2: 任一 child.teams 不空 → false (主修复 archive_caller=false 反例 caller 自身)
    - isPureSpawnChain corner 3: 有 spawnedBy + owner 在 allSessions 但 owner.teams 不空 → false
    - isPureSpawnChain corner 4: **有 spawnedBy 但 owner 不在 allSessions** (跨 section / lifecycle 过滤) → return true (silent 跨 section 行为锁定; 应明示这是预期防御行为)
    - isPureSpawnChain corner 5: 全空 → true
    - childrenByOwner Phase 1 conditional corner 1 (HIGH-A): child has universal team + spawn owner is child's team active lead → 锁 claimedBySpawn
    - childrenByOwner Phase 1 conditional corner 2 (HIGH-A): **child has universal team + spawn owner NOT child's team active lead** (archive_caller:false 反例) → 不锁,Phase 2 reparent 到正确 lead
    - childrenByOwner Phase 1 conditional corner 3: child no universal team (纯 spawn) → 直接锁 claimedBySpawn
    - **(v4 R3 claude MED-2) childrenByOwner Phase 1 conditional corner 4 (mixed role nested spawn)**: `child.teams=[{T2,teammate}]`, `owner.teams=[{T1,teammate},{T2,lead}]` → ownerLeadsSomeTeamOfS=true (B 是 C2 的 T2 lead) → 锁 C2 到 B 下 (验证 some/some 嵌套语义在 mixed-team owner 下正确)
    - **(v4 R3 claude MED-2) childrenByOwner Phase 1 conditional corner 5 (teamId 不匹配 confusion case)**: `owner.teams=[{T1,lead}]` 但 `child.teams=[{T2,teammate}]` (teamId 不匹配) → ownerLeadsSomeTeamOfS=false → 不锁 (理论 corner 当前不可达, 但 cross-team teamId 不匹配的 confusion case 应有单测保护防 some 早 return 漏判)
  - Step 4.2: `cd <worktree> && zsh -i -l -c "pnpm exec vitest run src/renderer/lib/__tests__/derive-team-role.test.ts src/renderer/components/__tests__/session-list.test.ts"` pass
- [ ] **Step 5** — 验证 + dev 实测:
  - Step 5.1: `cd <worktree> && zsh -i -l -c "pnpm typecheck"` pass
  - Step 5.2: `cd <worktree> && zsh -i -l -c "pnpm build"` pass
  - Step 5.3: `cd <worktree> && zsh -i -l -c "lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9; pkill -f 'electron-vite dev' 2>/dev/null; pkill -f 'Electron.app/Contents/MacOS/Electron' 2>/dev/null; pnpm dev"` 启动 dev (HMR 推 renderer 变更不需重启)
  - Step 5.4: dev UI 实测序列(v3 R2 codex LOW-1 重组 — **每场景用独立 caller**, 避免 5.4.4 后 A 已 archive 后续步骤复用 A 撞失败):
    > ⚠️ **hand_off 新 SDK cwd 默认 = mainRepo** (CHANGELOG_99 cwd resilience, R2 claude LOW-2): hand_off 起的新 SDK D 默认 `cwd = mainRepo` 不是 worktree;实测时如希望 D 也在 worktree 跑显式传 `cwd:'<worktree-abs-path>'`。本实测不强制 D 在 worktree (D 在 mainRepo 仍能看见 worktree 内未 commit 的代码 — git 索引共享),但 git status 显示会两边不同
    
    **场景 1: 主修复 — hand_off adopt_teammates=true** (测试矩阵 #2):
    1. **当前 caller 当 lead**: 应用启动后,假设当前在 dev 跑的会话 sid 为 `A` (在 SessionList 选「+ 新建会话」起一个 claude-code SDK session = caller A,记下 `A.sid`)
    2. **A spawn teammate B**: A 内调 `mcp__agent-deck__spawn_session({adapter:'claude-code', cwd:'/Users/apple/Repository/personal/agent-deck', prompt:'你好,我是 teammate B', team_name:'test-handoff-badge-fix', display_name:'Teammate-B'})` → SessionList 出现 B, A=👑 lead + B=↳ teammate + B 缩进在 A 下 ✓
    3. **A spawn 第二个 teammate C**: 同上 args 但 `display_name:'Teammate-C'` → SessionList A 下挂 B + C 两个 teammate ✓
    4. **A 调 hand_off adopt_teammates=true**: A 内调 `mcp__agent-deck__hand_off_session({adopt_teammates:true, prompt:'你接力,把 teammate 都收下'})` → 等 baton 完成
       - **核心验证**: A 进归档区 (active 列表消失); newSid=D 出现在实时面板(D 的 sid 在 hand_off_session 返回值 `sessionId` 字段 / UI hand-off badge 看到), D=👑 lead 且 **B + C 缩进在 D 下** + B/C=↳ teammate ✓
       - 若 D 在 root 平铺无 children + B/C 也 root 平铺 → D2 双 phase 算法有 bug, abort 回 plan 调整
    5. **回归: PendingTab 角色一致**: 若 SessionList D=lead, 切到 PendingTab 看 D 也显示 👑 lead (D4 shared util 对齐验证)
    
    **场景 2: 回归 — 纯 spawn 子任务退化** (测试矩阵 #3, **独立 caller E**, R2 codex LOW-1):
    6. **新建无 team caller E**: SessionList「+ 新建会话」起 caller E (不传 team_name)
    7. **E spawn 不传 team_name 子任务 F**: E 内调 `mcp__agent-deck__spawn_session({adapter, cwd, prompt:'纯 spawn 子任务'})` 不传 team_name → E 显示 👑 lead + F 显示 ↳ teammate (退化分支 work, 纯 spawn 链场景) ✓
    
    **场景 3: 回归 — archive_caller:false 反例** (测试矩阵 #4, **独立 caller A2**, R2 codex LOW-1 + HIGH-A 修法验证):
    8. **新建 lead caller A2**: SessionList「+ 新建会话」起 caller A2
    9. **A2 spawn teammate B2**: A2 调 `spawn_session({adapter, cwd, prompt, team_name:'test-archive-caller-false', display_name:'Teammate-B2'})` → A2=lead + B2=teammate 缩进 A2 下 ✓
    10. **A2 调 hand_off archive_caller=false**: A2 调 `hand_off_session({adopt_teammates:true, archive_caller:false, prompt:'接力但 A2 不归档'})` → 等 baton 完成 (newSid D2 sid 在 hand_off_session 返回值 `sessionId` 字段 / UI hand-off badge 看到)
        - **核心验证 (HIGH-A 修法)**: A2 仍 active 在实时面板, 但 **A2 不显示 lead badge** (走 §D6, A2.teams=[] + B2.teams 仍 teammate → pureSpawnChain=false → undefined); newSid D2=👑 lead + **B2 缩进在 D2 下** + B2=↳ teammate ✓ (HIGH-A: Phase 1 验证 spawn owner 不再是 B2 team lead → 不锁,Phase 2 reparent B2 到 D2)
        - 若 B2 仍缩进在 A2 下 + D2 root 平铺 → D2 Phase 1 条件检查算法有 bug, abort 回 plan 调整
    
    **场景 4 (可选,验证 D7 mixed role nested spawn)**: 测试矩阵 #6 (**v4 HIGH-β 修订**: 重命名避同名 + 视觉链路对齐场景 1 后实际状态):
    11. (沿用场景 1 — 场景 1 §5.4.4 后 A 已归档, 实时面板剩 D + B + C, B/C 缩进 D 下) B 已是 T1 teammate (在 D 下), B 自己调 `mcp__agent-deck__spawn_session({adapter, cwd:'/Users/apple/Repository/personal/agent-deck', prompt:'你是 T2 teammate', team_name:'T2-nested', display_name:'Teammate-C2-in-T2'})` → 新 session **C2** 加入 T2 当 teammate, B 加入 T2 当 lead (新 session 命名 C2 避免与场景 1 已有 Teammate-C 同名混淆)
    12. **核心验证**: 视觉 **D (T1 lead) → B(👑 lead, Phase 1 conditional 让 C2 锁 B 下) → C2(↳ teammate) + D → C (↳ teammate)** ✓ (B 的 mid-tier dual-role 视觉验证: 对 D 是 T1 teammate (缩进位) + 对 C2 是 T2 lead (badge 任一 lead 优先))
        - 若 B 不显示 lead badge → D1 deriveTeamRole「任一 lead 优先」有 bug
        - 若 C2 root 平铺不缩进在 B 下 → Phase 1 conditional check 失效 (HIGH-A 修法 regression)
  - Step 5.5: `lsof -ti:47821,5173 | xargs -r kill -9 && pkill -f 'electron-vite dev' && pkill -f 'Electron.app/Contents/MacOS/Electron'` 收尾杀进程
- [ ] **Step 6** — `ExitWorktree(action:"keep")` → 主仓库 `git -C <worktree> add` + `commit` 改动到 worktree branch(commit message: `fix(session-list): hand_off teammate role badge + 缩进显示`)
- [ ] **Step 7** — 写 changelog 条目(R1 reviewer-claude LOW-2):**写 changelog 前先 `ls changelog/ ref/changelogs/ 2>/dev/null` 看哪个存在**(ref-layout-full-migration 状态可能影响目录名),写到存在的那个;追加最新 CHANGELOG_X.md 或新建 CHANGELOG_X+1.md,同步对应 INDEX.md
- [ ] **Step 8** — `mcp__agent-deck__archive_plan({plan_id:'session-list-handoff-role-badge-20260526', worktree_path:'/Users/apple/Repository/personal/agent-deck/.claude/worktrees/session-list-handoff-role-badge-20260526', changelog_id:'<X>'})` 一键收口归档

## 测试矩阵覆盖

| # | 场景 | universal team | spawn-link | 期望 badge | 期望缩进 | 验证位置 |
|---|---|---|---|---|---|---|
| 1 | spawn lead + 起 teammate(team_name 共享) | lead/teammate | parent/child | lead/teammate | teammate 缩进 lead 下 | Step 5.4.2-3 |
| 2 | **hand_off adopt_teammates(主修复)** | newSid=lead, 原 teammate=teammate | newSid 无 spawn_by, 原 teammate spawnedBy=已 archived caller | newSid=lead, 原 teammate=teammate | **teammate 缩进 newSid 下(D2 universal team 收编 fallback)** | Step 5.4.4-5 |
| 3 | 纯 spawn 子任务(不传 team_name) | 无 | parent/child | parent=lead, child=teammate | 缩进保留(纯 spawn 链 fallback) | Step 5.4.6-7 |
| 4 | **hand_off archive_caller=false(D6 corner)** | newSid=lead, 原 teammate=teammate, caller=空 | newSid 无 spawn_by, 原 teammate spawnedBy=caller (仍 visible) | newSid=lead, teammate=teammate, **caller=undefined 无 badge** | newSid 下挂原 teammate;caller root 平铺 | Step 5.4.8-10 |
| 5 | 多 team 同角色(全 lead / 全 teammate) | 多 team 同 role | 不限 | 按 role | Phase 2 收编各自 team teammate | Step 4.1 unit test |
| 6 | **Mixed lead+teammate** (v3 R2 codex LOW-2: nested spawn 可达 — B 是 T1 teammate, B 再 spawn 加 T2 当 lead → B 同时 T1 teammate + T2 lead) | mixed | D→B→C2 链 (沿用场景 1 后 A 已 archive,实时面板剩 D + B + C; B 再 spawn C2) | B=lead(任一 lead 优先);C2=teammate | D(lead)→B(lead)→C2(teammate) + D→C(teammate) | Step 4.1 case 7 unit test + Step 4.1.5 corner 4 unit test + Step 5.4.11-12 实测 |
| 7 | dormant section session(R1 reviewer-claude LOW-1) | 不限 | 不限 | 同 active 同款规则 | 同款 | dev 实测 5.4 等几分钟看 teammate 转 dormant 仍显示 badge |
| 8 | closed teammate(R1 reviewer-claude INFO-1) | N/A | N/A | 不渲染(selectLiveSessions 过滤) | 不渲染 | 默认 hand_off `adopt_teammates:false`(baton-cleanup phase 1)teammate 直接 close → SessionList 完全不显示,**与本 plan 修法无关**(本 plan 只覆盖 `adopt_teammates:true`) |
| 9 | 普通 session(无 team 无 spawn) | 无 | 无 | undefined(无 badge) | root 平铺 | 默认行为不变 |

## 风险评估

- **R1 enrichWithTeams 性能影响**: 0(已有逻辑)
- **R2 SessionList 树形重算成本**: Phase 1 hash O(N) + **Phase 1 内 ownerLeadsSomeTeamOfS 含 sessions.find 是 O(N), Phase 1 整体 O(N²)** (v4 R3 claude LOW-1) + Phase 2 收编 O(N×M) (N=visible session 数, M=avg team 数 ≤ 2 典型) + **isPureSpawnChain 每 renderNode 调一次, 内部 allSessions.find 是 O(N), renderNode 递归 N 次 → 整体 O(N²)** (v3 R2 claude LOW-3); 典型 SessionList N<100 时 < 0.1ms 可接受; **可选优化** (未来 N 增长时): renderTreeGroup 顶部预构建 `sessionsById = new Map(sessions.map(s => [s.id, s]))` + `teamPresentSet = new Set(sessions.filter(s => s.teams?.length > 0).map(s => s.id))`, Phase 1 conditional + isPureSpawnChain 全走 Map.get / Set.has lookup → 总 O(N)
- **R3 spawn 子任务 badge 行为回退**: 0, 走 §不变量 2 纯 spawn 链分支
- **R4 多 team 视觉冲突**: 极低, §D5 + 🛡 chip + hover title 已分别表达不同维度
- **R5 PendingTab teamRole 改 source 引入回归**: 低, shared util 单 team 行为与现有 `primaryTeam?.role` 一致; 多 team mixed role (R2 codex LOW-2 实证 nested spawn 可达) 是新升级行为 (R1 HIGH-1 设计意图)
- **R6 deep-review R3 反例**: 任何 reviewer 找到的 corner case 会在 R3 收敛, 然后回 D1-D7 调整

## 已知踩坑

- **changelog/ vs ref/changelogs/ 路径**(R1 reviewer-claude LOW-2 + reviewer-codex F5): 项目 `ref-layout-full-migration-20260526` plan 仍 in_progress,可能把 `changelog/` git mv 到 `ref/changelogs/`。Step 7 写 changelog 前必须 `ls changelog/ ref/changelogs/ 2>/dev/null` 看哪个存在再写,避免撞「目录不存在」。**`archive_plan` tool 路径不会自适配** (impl 仍 hard-code `<main-repo>/plans/`),如收口时 ref migration 已 merge,需要手工 rebase 把 plan 路径迁到 ref/plans 或单独调归档目录

- **dev 实测前必须 unset ELECTRON_RUN_AS_NODE** (项目 CLAUDE.md §打包与本地安装节): Step 5.3 dev 启动命令在 zsh login shell 里跑,避免 Electron 二进制被切到 Node 伪装模式

- **改 renderer 走 HMR**(项目 CLAUDE.md §验证流程节): Step 5.4 改完直接看实时效果不需重启;只有改 main / preload 才需 kill 重启

- **default baton 路径 teammate 直接被 close**(R1 reviewer-claude INFO-1): `hand_off_session` 默认 `adopt_teammates:false` 时 baton-cleanup phase 1 close teammate → SessionList 完全不显示(`selectLiveSessions` 过滤 closed)。本 plan 只覆盖 `adopt_teammates:true` 路径,default 路径行为按设计不变(不是 bug)。R3 reviewer 不要把这条当遗漏

- **D2 Phase 2 universal team 收编 fallback 跨 section 失效**(v3 R2 reviewer-claude MED-3): SessionList render 按 `grouped.active` 和 `grouped.dormant` 双 section 分别调 `renderTreeGroup(sessions, ...)`,L13-14 注释明文「不跨 group 关联」。Phase 2 universal team 收编隐式只在单 section 内找 visible lead。**跨 section 失效场景**: caller A 转 dormant + teammate B 仍 active → active section 找不到 A 当 lead → B 在 active root 平铺带 teammate badge 但无 lead 缩进;dormant section A 是 lead 但找不到 visible teammate → A 在 dormant root 平铺带 lead badge 下面无人。**视觉脱节是设计预期** (L13-14 不跨 group 关联),不是 bug。如未来需求要跨 section 缩进,需 plan 单独评估架构变更

## 下一会话第一步

> 仅适用于本会话 hand_off 出去的下一会话(如有);本会话当前直接进 Step 1.5 R2 不 hand_off

如真要 hand_off:
1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/session-list-handoff-role-badge-20260526.md`
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/session-list-handoff-role-badge-20260526")` (建议先确认 worktree 已创建,详 §Step 2)
3. 按上面 §步骤 checklist 当前未打勾的最低 Step 编号开始执行
