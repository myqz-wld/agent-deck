# REVIEW_105 — adapter spawn-options 构建 + 注册分发（options-builder.ts + registry.ts）deep-review

> 全项目滚动 deep-review Batch 7。`agent-deck:deep-review` SKILL 多轮异构对抗。

## Scope

- **2 文件 412 LOC，高内聚 adapter spawn 入口 + 生命周期**：
  - `src/main/adapters/options-builder.ts`(312)：`buildCreateSessionOptions(agentId, raw)` 按 agentId narrow raw 字段到对应判别联合 arm（filter 掉不属于该 adapter 的字段）。核心安全敏感逻辑 = `narrowToCodexOpts` reviewer-* unsafe default spread（codexSandbox/approvalPolicy/networkAccessEnabled/additionalDirectories 强制覆盖不许 caller 绕过）+ isAgentId/isReviewerAgentName runtime guard + TS 编译期 SSOT 守门。
  - `src/main/adapters/registry.ts`(100)：AdapterRegistryClass（register/get/list/initAll/shutdownAll），init/shutdown 对每个 adapter try/catch 吞错只 log + AdapterIdMap TS 守门。
- **选批方法学（复用 Batch 4/5/6）**：`options-builder.ts` fp:NONE 金标准 + basename spot-check —— basename 命中 REVIEW_47/36/75/60/79 经逐个核验全是 `claude-code/sdk-bridge/` 下同名子文件（`query-options-builder.ts` / `thread-options-builder.ts`），顶层这个真未审。`registry.ts` REVIEW_2 远古审（line 61），D2 重构后核心逻辑大改 = 已审过期。纯 type `create-session-opts.ts`(313, 0 函数) 按 Batch 6 教训排除（BUG ROI 极低）。

## 轮次 / reviewer

- **R1+R2 双轮异构对抗**，reviewer-claude(Opus4.7) `ad3bfb4e` + reviewer-codex(gpt-5.5) `019e8704`，teamId `b3fe4a29`（已 shutdown）。
- **commits**：`3b9f6b7`（R1 合并修法）+ `9ba12f8`（R2 收口）+ 本 REVIEW。
- **lead 现场验证**（不 rubber-stamp）：git 考古（plan reverse-rename line 222 + git -S options-builder 0 命中）+ 类型链 trace（bridge 内部 CreateSessionOpts vs facade ClaudeCreateOpts 双套独立 type）+ 反向验证 field 守门（临时加 _probe typecheck 立报 TS2322）+ SSOT 迁移自洽性交叉验证（grep 无残留 facade 引用 / 新锚点无环）+ envOverrideExtra 零 producer grep 实证。

## 异构对抗高光

- **MED-1 三重独立命中**：reviewer-codex（MED）+ reviewer-claude（MED）+ **lead 预备独立分析**同时命中 `resumeCliSid`/`resumeMode` narrow 漏挑——异构对抗强冗余即算验证的教科书 case。
- **R1 reviewer-codex 增量**：指出「单修 builder narrow 不够，adapter facade index.ts:81-93/85-101 白名单 spread 也丢这俩字段」——lead 现场验证成立（grep facade `0 0`）。
- **R2 双方独立命中同一 LOW**：reviewer-codex 从「未来接线会复发漏挑」+ reviewer-claude 从「jsdoc 理由事实错误 + 与 MED-1 同 bug 类」两侧面命中 `envOverrideExtra` 守门例外集错归类。
- **lead 决定性增量（修法方向）**：用户授权 lead 定方向。**架构一致性铁证**——bridge 内部 `CreateSessionOpts` 已有同款 internal 字段 `cancelCheck`/`skipFirstUserEmit` 只活在 bridge 不进 facade，`resumeCliSid`/`resumeMode` 语义相同（plan reverse-rename line 222「caller 不该传，recoverer/restart 直调 bridge」）却误混进 facade → 删字段 = **回归既定分层模式**（非发明新约定），比单纯「最小改动」理由更硬。

## Findings 三态裁决

### [MED-1 ✅ 真问题] options-builder.ts narrowToClaudeOpts / narrowToCodexOpts 双双漏挑 resumeCliSid + resumeMode（contract-vs-impl 矛盾 + facade 死字段）

**双 reviewer + lead 三重独立命中。** facade type（ClaudeCreateOpts:95/125、CodexCreateOpts:193/198、CreateSessionOptionsRaw:298-299）都声明这俩字段 + Raw jsdoc 写「builder narrow 时透传给 claude/codex 都消费」，但两个 narrow 函数都不挑、facade.createSession 白名单也不 spread = 死字段 + 契约矛盾。

**根因（git 考古 + 类型链 trace）**：
- `resumeCliSid`/`resumeMode` 原始设计是 **bridge internal 字段**（plan reverse-rename line 222「caller 不该传」），真正消费者只有 bridge 内部独立 type `CreateSessionOpts`（claude `create-session/_deps.ts:76,83`，restart-controller/recoverer 直调 bridge 走这条，正常工作）。
- 它们进 facade `ClaudeCreateOpts` 是 commit e18da65「Phase 4.9 facade 拆分」机械遗留；options-builder `git -S` 0 命中证明 narrow **从来没挑过**。
- **当前 active 影响 = 无**（5 个 builder caller 都不传这俩字段；resume 路径走 recoverer/restart 直调 bridge 绕过 builder）→ latent。判 MED 因 Raw jsdoc 是显式契约邀请，未来 caller 按 jsdoc 经 builder 传会被静默丢 + TS 不报错 + 落到 resume 子系统最脆弱处（7 组合不变量靠这俩字段判路径）。

**修法（方向 b 收窄删字段，commit 3b9f6b7）**：
- 删 facade 三处声明（ClaudeCreateOpts/CodexCreateOpts/CreateSessionOptionsRaw），留 REVIEW_105 说明注释。架构依据 = bridge 已有 cancelCheck/skipFirstUserEmit 同款 internal 字段分层。
- SSOT 7 组合不变量表 jsdoc 从 facade 迁到 bridge `create-session/_deps.ts`（真正消费处），改 6 处悬空引用（codex bridge `_deps` / claude recoverer `_deps`×2 / 两端 restart-controller）指向新锚点。
- **field 级 TS 守门（c，双 reviewer 共识 follow-up）**：`_assertClaudePassthroughCoversArm` / `_assertCodexPassthroughCoversArm`（options-builder.ts 末，守门点 9）下探字段级，堵「arm 加 caller-passthrough 字段但 narrow 漏挑」复发（修前守门 1-8 全 agentId 集合级 typecheck 拦不住）。**反向验证**：临时给 ClaudeCreateOpts 加 `_probe` 字段 → typecheck 立报 `error TS2322`，证明守门非 vacuous。

### [MED-2 ✅ 真问题] registry.ts initAll 吞错降级成启动成功，半死 adapter 对外服务零启动期可观测

**reviewer-codex MED / reviewer-claude LOW（取可观测性改进）+ lead 现场验证。** `initAll` catch 后只 log 不返回失败状态、不标 adapter 不可用；bootstrap-infra.ts:128 await initAll 后不查返回值继续 wiring → `adapterRegistry.get()` 仍返回 init 失败（bridge undefined）的 adapter → 用户 spawn 该 adapter 时才在 createSession 抛 cryptic `'adapter not initialized'`，启动期唯一痕迹一行 logger.error。

**修法（commit 3b9f6b7）**：保留「单 adapter init 失败不连坐其他」resilience 续跑（双 adapter 桌面应用 codex 挂了 claude 仍可用 = by-design，reviewer-claude 论证正确），但 `initAll` 改返回 `AdapterInitResult[]` 让 bootstrap 消费 `failedAdapters.filter(!ok)` 升级 actionable hint 日志（该 adapter 会话将无法创建）。未 fail-fast（reviewer-codex R1 建议但 R2 认可「续跑+surface」取舍，没找到必须 fail-fast 场景：两 adapter 平级无依赖）。

### [LOW ✅ 真问题，R2] options-builder.ts envOverrideExtra 守门例外集理由事实错误

**R2 双 reviewer 独立命中 + lead 现场验证。** field 守门 `_assertCodexPassthroughCoversArm` 排除集把 `envOverrideExtra` 与 3 个真 reviewer-spread 字段用同一句「仅 reviewer-* 分支 spread 产出」捆绑，但 reviewer 分支实际不 spread envOverrideExtra（TC8/TC9 断言它 undefined）。现场验证：reviewer 分支只 4 个 out.X 赋值无 envOverrideExtra；grep 全仓 envOverrideExtra **零 producer**（facade 声明 + bridge 消费链就绪但无 SET 点）= 与 MED-1 同 bug 类的 facade 死字段，仅因「故意保留供未来 caller」而非缺陷。

**修法（方向 a 零风险，commit 9ba12f8）**：jsdoc 拆分排除理由，envOverrideExtra 单列「internal 直传 + 零 producer」类 + 维护警告（未来接 caller 必须移出排除集加进 PASSTHROUGH 否则 MED-1 漏挑复发）。根治方向 b（归位 bridge，牵动 codex index.ts:96 透传链）列 follow-up。

### [INFO ✅ 已 fix，R2]

- **INFO-1（codex）field-coverage 测试漏覆盖 handOff**：handOff 在 PASSTHROUGH 清单内但 R1 矩阵没构造 handOff fixture → 删 narrow handOff 赋值 typecheck+测试都不挂（运行时盲区）。补最小 HandOffMetadata fixture + 两 arm 断言 `opts.handOff === fixture`（commit 9ba12f8）。
- **INFO-2（codex）AGENT_DECK_CLAUDE_PATH wrapper stale 注释**：REVIEWER_AGENT_NAMES 注释 + additionalDirectories 注释仍描述已删的 reviewer-claude wrapper 子分支（cross-adapter native 改造删 wrapper 时漏改注释，Batch 6 教训③同款）。订正为当前事实（commit 9ba12f8）。

### [INFO 正向确认] reviewer-* unsafe default spread 安全边界无洞

**reviewer-claude INFO 正向 + lead 独立验证。** `narrowToCodexOpts` reviewer-* 分支 4 字段强制覆盖**不可被 caller 绕过**：① 覆盖顺序正确（caller codexSandbox 先赋 L138 → reviewer 分支后覆盖 L167，无法绕过）② agentName 唯一能喂进 builder 的路径是 spawn.ts，调 builder 前先 `getBundledAssetContent(agentName)` 未知名直接 reject → 无法伪造 agentName 白嫖特权 sandbox ③ isReviewerAgentName 用精确 includes 全字符串匹配无大小写/空格绕过 ④ 已被 TC8-11b 覆盖。

## 收口

**R1+R2 双轮 both-agree conclude**：双 reviewer R2 均明示「0 HIGH 0 MED + 可合」，删字段方向(b)成立 + initAll「续跑+surface」取舍可接受。

- **测试**：+3 builder field-coverage 矩阵（全字段透传 + resumeCliSid/resumeMode 不漏到 facade 输出 + handOff 防漏）+ 4 registry initAll per-adapter result（全成功/部分失败续跑/半死留 registry/重复 register throw）。
- **验证**：typecheck 双配置（tsconfig.node + tsconfig.web）绿 + 全量 1426 passed | 236 skipped 零回归（比 Batch 6 的 1419 多 7 = 新增测试）。

## 遗留 follow-up（非阻塞）

- **envOverrideExtra 彻底归位 bridge（方向 b）**：当前 a 方案（jsdoc 拆分 + 维护警告）零风险够用；根治是把 envOverrideExtra 从 facade CodexCreateOpts 移回 bridge `_deps.ts`（同 resumeCliSid 归位），牵动 codex index.ts:96 透传链，需独立小 plan。与 MED-1 修法一致性最高。双方裁定可接受。
- **initAll UI 事件 surface（可选增强）**：当前仅 logger.error，若想让用户在 UI 看到「codex 不可用」可 emit 事件——桌面应用启动期日志兜底已是合理下限，reviewer-claude 裁定非缺陷不强求。
