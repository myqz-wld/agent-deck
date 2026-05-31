# REVIEW_87 — 全项目 deep review 批 F3：task handlers + team-scope 权限（Batch F 收官）

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG（含 1 越权 MED）+ 代码优化 + 文字措辞（全项目 deep review 第十七批，Batch F 子批 F3，**Batch F 收官**）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / plan task-team-id-restore-20260525（v024 权限模型重写）/ CHANGELOG_165（personal task skip ingest）/ REVIEW_85-86（F1/F2）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，复用 F pair dr-project-f-20260531）+ **反驳轮**（MED 单方 → 对方独立验证）+ 三态裁决 + lead 现场 Grep/Read 验证 + 4 fix 全 temp-revert 非空。
- 收口: R1 单轮 **异构 divergence** + 1 反驳轮。reviewer-codex 抓 MED（task_update teamId:null 越权），reviewer-claude R1 判 0 MED（漏 A→null 路径，自述只验 A→B 搬运）→ 反驳轮 reviewer-claude **同意 + 逐行 data-flow 确认 + 自纠 mental model**。MED 经反驳轮 → ✅ 双方独立。

## 范围（批 F3）

task-* MCP 结构化任务 store handler 6 文件 ~588 LOC：

| 文件 | LOC | 职责 |
|---|---|---|
| `task-helpers.ts` | 150 | 共享权限校验（isCallerInTeam 双条件 / isCallerAuthorizedToWrite·Read 镜像 / getVisibleTaskScope / argsToInputWithoutOwner）|
| `task-update.ts` | 112 | task_update（写权限 + teamId 改 team 校验 + becameCompleted ingest）|
| `task-create.ts` | 104 | task_create（owner 闭包 + teamId 校验 + ingest）|
| `task-list.ts` | 91 | task_list 三态分流（visibleScope OR / null-personal / 具体 teamId）|
| `task-delete.ts` | 84 | task_delete（写权限 + cascade BFS predicate + ownerMap emit）|
| `task-get.ts` | 47 | task_get（read 权限镜像）|

## 三态裁决结果

### [MED ✅ reviewer-codex 单方 + 反驳轮 reviewer-claude 逐行确认 + lead grep] task-update.ts:53 — 非 owner team member 把 team task 私吞成他人 personal task（权限域切换漏洞）

reviewer-codex 单方（reviewer-claude R1 判 0 MED，只验 A→B 搬运漏了 A→null）。**攻击链**：
1. task = `{teamId:'team-A', ownerSessionId:'sess-mate'}`（共享 team task，mate 拥有）
2. sess-caller（team-A active member，**非 owner**）调 `task_update({taskId, teamId:null})`
3. `isCallerAuthorizedToWrite(caller, existing)`（task-update.ts:47）：existing team-bound → `isCallerInTeam('sess-caller','team-A')` → true **通过，无 owner 校验**
4. teamId=null 分支（:57）：`args.teamId !== null` = false → **跳过新 team 校验**
5. `argsToInputWithoutOwner` 透传 `teamId:null`（不含 ownerSessionId）；repo update 写 `team_id=NULL`，ownerSessionId 不在 UPDATABLE_KEYS（闭包锁）→ **保留 'sess-mate'**
6. 结果 task = `{teamId:null, ownerSessionId:'sess-mate'}` = mate 的 personal task → team-A 全员（含 caller）失可见性，只剩原 owner 可见

**核心**：用**旧域**（team membership）权限授权了切到**新域**（owner-scoped personal）的操作，新域约束 caller==owner 被 `args.teamId !== null` 短路跳过——经典「权限域切换漏洞」。

**lead 验证（grep + Read）**：task-helpers.ts:124 team-bound 写权限只查 isCallerInTeam 不查 owner；task-repo-crud.ts UPDATABLE_KEYS 含 teamId 不含 ownerSessionId；isCallerAuthorizedToRead personal 分支 `caller===owner` 确认 caller 转换后失可见。

**反驳轮（reviewer-claude）**：**同意，真 MED**。逐行 data-flow 确认每一步（授权分支走向 / 短路条件 / 白名单含 teamId 不含 owner），确认可见性损失（visibleScope OR 两分支都不命中 caller），裁 MED（限 team 内 active member + 无永久数据丢失 + 无系统级提权，不升 HIGH）。验证修法不误伤（owner 自转 personal / 已 personal no-op / A→B 搬运都正确放行）。**自纠 mental model**：「§权限镜像核实 read==write 对称只验了静态镜像，没考虑 teamId=null patch 动态切换权限域；下轮遇『字段 update 改变记录自身权限域』必须单独推演用旧域权限改到新域是否绕过新域约束」。

**修法**：`args.teamId === null && existing.teamId !== null && callerSid !== existing.ownerSessionId` → reject（team-bound 转 personal 必须 caller==owner）。+2 回归 test（非 owner reject / owner 放行；temp-revert 删 check → test FAIL）。

### [LOW ✅ reviewer-codex + reviewer-claude 双方独立] task-delete.ts:47 — ownerMap pre-walk 不应用 predicate，展开越权 cascade 子图

**双方独立**（codex LOW + claude INFO，同点不同角度）→ ✅。repo 层 cascade predicate 已 unauthorized child skip 且不展开（task-repo-delete.ts:101-108 `continue` 不 push child.blocks），但 handler 为收集 emit ownerMap 先全图 pre-walk（task-delete.ts:48-57）**不应用同 predicate**——对越权 child（跨 team / 他人 personal）仍 `taskRepo.get` + `queue.push(...child.blocks)` 展开越权子图。功能结果正确（repo 不删这些节点），但偏离「越权 child skip 不展开」防御边界 + ownerMap 收集了实际不会被删的节点。claude 补充 TOCTOU 角度（两次独立 BFS 漂移，emit ownerSessionId 可能退化 root，已有 `?? target.ownerSessionId` 兜底）。

**lead 验证（Read）**：task-delete.ts:48-57 handler pre-walk over target.blocks 无 predicate vs task-repo-delete.ts:101-108 repo BFS predicate continue。

**修法**：pre-walk 复用 `isCallerAuthorizedToWrite(callerSid, child)`，越权 child skip 且不入队下游（与 repo predicate 边界对齐）→ ownerMap 只含真删节点 + 不展开越权子图。+1 回归 test（root→越权 child→grandchild：断言 pre-walk 读 t2 但不读 t3；temp-revert → test FAIL）。**未采用** claude 建议的「repo.delete 返回 {id,owner}[] 单 SSOT」方案（改 repo 返回类型 + 公开 result schema 跨 Batch G，handler-side predicate 是更小修法）。

### [LOW ✅ reviewer-codex 单方 + lead Read] task-update.ts:67 — 空 patch 返回 ok 并广播 updated 事件

reviewer-codex 单方。TASK_UPDATE_SCHEMA 仅 taskId 必填，`task_update({taskId})` 时 `argsToInputWithoutOwner(rest)` 产 `{}`。repo update 对空 sets 返回 existing 不刷 updated_at（task-repo-crud.ts:105），但 handler 仍 emit `task-changed kind='updated'` + 返回 ok → 无 DB 变更的 realtime 噪声 + tool 描述「updated_at is auto-refreshed」该路径失真。

**lead 验证（Read）**：schemas.ts 仅 taskId 必填；task-helpers.ts:40-51 空 rest 返空对象；task-repo-crud.ts:105 空 sets return existing；task-update.ts emit 无差异检查。

**修法**：`Object.keys(patch).length === 0` → 返回 ok(existing) 提前返回（不调 update / 不 emit，保持「无变更不广播」语义）。+1 回归 test（空 patch 不 emit + 不调 update；temp-revert → test FAIL）。

### [LOW ✅ reviewer-claude 单方 + lead 算例（schema 已挡，纵深防御）] task-create.ts:50 — teamId 校验用 truthy，空串绕过建畸形 task

reviewer-claude 单方。create 用 `if (args.teamId)`（truthy），`teamId=''` falsy 跳过 isCallerInTeam 校验后 `'' ?? null` = `''`（?? 仅 null/undefined 触发）→ 建出 `teamId=''` 畸形 task（既非 personal 也非合法 team，isCallerInTeam('') 恒 false → 永久无人可读写）。schema teamId `.min(1)` 当前挡空串故**不可达**，但 handler 自身防御不应隐式耦合 schema + 与 task-update.ts:57 显式 `!== null` 判定不一致。

**lead 验证（算例）**：`'' ?? null` JS 语义 = `''`；schemas.ts teamId `.min(1)` 确认 schema 层挡（当前不可达）。

**修法**：`normalizedTeamId = args.teamId == null || args.teamId === '' ? null : args.teamId` 归一空串到 null + 显式 `!== null` 校验 + ingest 守卫改用 `created.teamId`（与 task-update 用 updated.teamId 对称）。+1 回归 test（teamId='' → create 收 teamId:null；temp-revert truthy → test FAIL）。

### [INFO] 双方已核实无问题项（裁决参考）

reviewer-claude 穷举核实正确：read/write 镜像（isCallerAuthorizedToRead 直接 return Write）/ isCallerInTeam 双条件 ghost membership 过滤 / becameCompleted 三条件防 v024 teamId check 漂移 / ingest 双守卫 personal skip / teamName 取 args.teamId·updated.teamId lookup 不漂移 / task_list 三态分流 + hasMore / external deny / cascade predicate skip 同时阻断下游（repo 层正确，仅缺 test）。reviewer-codex 主路径权限模型核实正确。

### [INFO 测试盲区] reviewer-claude

(a) task_update teamId A→B 搬运（caller 双边 active）无 test；(b) cascade child 越权 skip 后下游孙节点不被删的不变量 task-crud.test 只验 predicate 返回值未验下游阻断（本批 LOW ownerMap test 已部分覆盖 handler 侧；repo 侧仍隐式）。留 follow-up。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | task-update.ts:~65 | MED ✅ | team→personal 转换要求 caller==owner | codex 单方 + 反驳轮 claude 逐行确认 + lead grep + 2 test temp-revert FAIL |
| 2 | task-delete.ts:~54 | LOW ✅ | pre-walk 复用 predicate 越权 child skip 不展开 | 双方独立 + lead Read + 1 test temp-revert FAIL |
| 3 | task-update.ts:67 | LOW ✅ | 空 patch 提前返回不 emit | codex 单方 + lead Read + 1 test temp-revert FAIL |
| 4 | task-create.ts:50 | LOW ✅ | teamId 空串归一 null + 显式判定 | claude 单方 + lead 算例 + 1 test temp-revert FAIL |

## 验证

```
typecheck（双配置 tsconfig.node + tsconfig.web）：PASS
node_modules/.bin/vitest run agent-deck-mcp/__tests__/：593 passed | 3 skipped（36 files）
  含 task-crud.test.ts 39 passed（34 既有 + 5 新增）+ task-events 8 + task-external-caller 13
temp-revert 全验证非空：
  MED → 删 owner check → 非 owner 转 personal test FAIL（误放行）
  LOW pre-walk → 删 predicate → 越权子图展开 test FAIL（读到 t3）
  LOW 空 patch → 删提前返回 → 空 patch emit test FAIL
  LOW teamId='' → 还原 truthy + '' ?? null → 归一 test FAIL（teamId='' 而非 null）
```

## 结论

**Batch F 收官批**。task handlers 经 v024 plan task-team-id-restore 大改造 + 多轮 deep-review 沉淀，权限模型主体扎实（read/write 镜像 / 双条件 active / cascade predicate / 三态分流 / ingest 守卫 / external deny 全正确）。本轮挖出 1 越权 MED + 3 LOW。

**异构对抗价值（教科书级反驳轮自纠）**：reviewer-codex 抓 MED（权限域切换越权），reviewer-claude R1 **判 0 MED 漏了这条**（只验 A→B 搬运安全，没验 A→null 转换）。反驳轮 reviewer-claude 不仅同意，还逐行 data-flow 确认攻击链每一步 + 验证修法不误伤 4 条路径 + **自纠 mental model 根因**（「静态 read/write 镜像核实不够，必须单独推演字段 update 是否动态切换权限域 + 用旧域权限改到新域是否绕过新域约束」）。这正是反驳轮设计意图——不是简单复核，而是补盲点 + 升级方法论。两条 LOW 双方独立（ownerMap pre-walk）/ 互补（codex 空 patch / claude teamId 空串）。

**Batch F 全收官**：F1（spawn+guards，REVIEW_85，4 MED + 2 LOW）+ F2（send+dispatch，REVIEW_86，3 MED + 3 LOW）+ F3（task handlers，REVIEW_87，1 MED + 3 LOW）= 全 16 文件 / **8 MED + 8 LOW = 16 fix** + 19 回归 test（F1 7 + F2 8 + F3 5，注：部分 fix 共享 test）+ 3 反驳轮（F2 starvation / F3 MED 各 1，F1 0 — 全单方 lead 验证）。mcp 编排 + dispatch + task 三子系统全链路覆盖。共性主题贯穿三批：**失败/异常/权限切换路径处理不彻底**（F1 spawn 失败清理 / F2 claim 后异常 + backpressure liveness / F3 权限域切换越权）。

## Follow-up（留用户回来决策）

1. **[测试盲区] task_update teamId A→B 搬运无 test**（reviewer-claude）——caller 双边 active member 搬运路径建议补 test。
2. **[测试盲区] cascade child 越权 skip 后下游孙节点不被删的 repo 层不变量**（reviewer-claude）——repo 侧 task-repo-delete.test 仅验 predicate 返回值，建议补「predicate false → grandchild 不在 deletedIds」repo 层 test（handler 侧本批 LOW test 已覆盖 pre-walk）。
