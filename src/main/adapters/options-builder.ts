/**
 * D2 builder helper：caller 端把所有 raw 字段塞 raw，按 agentId narrow 到对应 union arm。
 *
 * 设计要点：
 * - exhaustive switch + `_exhaustive: never = agentId` —— 加新 adapter 漏 arm TS 编译期报错
 * - 每个 adapter 的 narrowToXOpts 只挑 raw 中本 adapter 接受的字段（filter 掉无效字段）
 * - caller 端调用：`buildCreateSessionOptions('claude-code', { ...rawArgs })` 拿到带 agentId
 *   字段的 narrow 结果，直接传给 typed adapter 的 createSession（TS 编译期 narrow）
 *
 * 与 typed registry overload 配合：
 * ```ts
 * const adapter = adapterRegistry.get('claude-code');  // : ClaudeCodeAdapter | undefined
 * const opts = buildCreateSessionOptions('claude-code', rawArgs);  // : ClaudeCreateOpts & { agentId }
 * await adapter?.createSession(opts);  // TS 编译期阻止字段误传
 * ```
 *
 * 加新 adapter 时强制三步：(1) types.ts 加 union arm + interface; (2) 本文件 switch 加 case;
 * (3) registry.ts AdapterIdMap 加映射。漏任一 TS 编译期报错。
 */

import os from 'node:os';
import path from 'node:path';
import type {
  ClaudeCreateOpts,
  CodexCreateOpts,
  CreateSessionOptions,
  CreateSessionOptionsRaw,
} from './types';

/**
 * agentId → 对应 adapter 接受的字段 interface 映射（不含 agentId 字段，agentId 由 builder 自动塞）。
 * 用于 buildCreateSessionOptions 泛型返回类型推导。
 */
export type CreateSessionOptionsByAdapter = {
  'claude-code': ClaudeCreateOpts;
  'deepseek-claude-code': ClaudeCreateOpts;
  'codex-cli': CodexCreateOpts;
};

/**
 * **agentId SSOT list**（p4-d2-impl R2 reviewer-codex MED follow-up）:
 *
 * 加新 adapter 时漏改本 list → `_assertAgentIdsListMatchesOptions` TS 编译期报错。本 list 同时
 * 驱动:
 * 1. `AgentId` type union(`(typeof AGENT_IDS)[number]`)— 旧版用 `keyof CreateSessionOptionsByAdapter`,
 *    现统一改用 list 驱动让 SSOT 唯一(避免 ByAdapter map / AGENT_IDS list 双源不一致)
 * 2. `isAgentId()` runtime guard — 旧版手写 4 个字面量,新增 adapter 漏改这里 TS 0 error 但 runtime
 *    string overload guard 拒绝(reviewer-codex R2 MED 指出);现 list 驱动让 runtime guard 与 type
 *    union 严格同源
 *
 * 详 §D2 多侧 SSOT 守门 注释表 守门点 (5)。
 */
export const AGENT_IDS = ['claude-code', 'deepseek-claude-code', 'codex-cli'] as const;

export type AgentId = (typeof AGENT_IDS)[number];

/**
 * **reviewer-* SSOT list**(plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.2 修法,
 * A1-MED-2 (claude) — 修前 reviewer agent hardcode 散布在多处 runtime
 * 分支与文档)。
 *
 * **覆盖 runtime 分支**(本文件):
 * - `narrowToCodexOpts` `isReviewerAgentName(raw.agentName)` 主分支 — codex teammate spawn
 *   reviewer runtime default spread enforce 点(所有 reviewer slot 同款 spread
 *   approvalPolicy / networkAccessEnabled / additionalDirectories；codexSandbox 走普通 spawn 继承链)
 *
 * **REVIEW_105 R2 INFO 订正(reviewer-codex 单方)**: 删除旧「reviewer-claude 子分支注入
 * AGENT_DECK_CLAUDE_PATH」描述 —— 该子分支已随 plan reviewer-codex-cross-adapter-20260519
 * Phase 2 删除(reviewer-claude 改 cross-adapter native, 不再走 wrapper Bash 起外部 codex CLI,
 * 不再注入 envOverrideExtra: AGENT_DECK_CLAUDE_PATH)。当前 reviewer 分支所有 slot 行为对称无子分支。
 *
 * **不 SSOT 化的位置**(by design):
 * - jsdoc / 注释里的字面量字符串(说明文档可读性优先,引用 const 名反而绕)
 * - 测试 fixture / mock data(测试就是要 hardcode 字面量验证 runtime 分支)
 * - schema description / hint 文案(给 caller LLM 看的英文文档)
 *
 * 加新 reviewer agent 时只需把名字加进本 list, reviewer 主分支 default spread 自动覆盖。
 */
export const REVIEWER_AGENT_NAMES = ['reviewer-claude', 'reviewer-codex', 'reviewer-deepseek'] as const;
export type ReviewerAgentName = (typeof REVIEWER_AGENT_NAMES)[number];

/**
 * runtime guard:`raw.agentName` 是否属于 reviewer-* SSOT list。narrow 也用作 type predicate
 * 让 TS 在分支里把 `raw.agentName` narrow 到 `ReviewerAgentName` union。
 *
 * **签名**:接收 `string | null | undefined`(`CreateSessionOptionsRaw.agentName` 的精确类型),
 * null / undefined 全 narrow 为 false。
 */
export function isReviewerAgentName(name: string | null | undefined): name is ReviewerAgentName {
  return name != null && (REVIEWER_AGENT_NAMES as readonly string[]).includes(name);
}

/**
 * raw → ClaudeCreateOpts narrow：从 raw 中挑 claude-code adapter 接受的字段（filter 掉
 * codexSandbox 等 codex 专属字段）。undefined 字段被剔除（避免 spread 进 opts 后变成显式
 * undefined 字段污染 caller spread 链）。
 */
function narrowToClaudeOpts(raw: CreateSessionOptionsRaw): ClaudeCreateOpts {
  const out: ClaudeCreateOpts = { cwd: raw.cwd };
  if (raw.prompt !== undefined) out.prompt = raw.prompt;
  if (raw.permissionMode !== undefined) out.permissionMode = raw.permissionMode;
  if (raw.resume !== undefined) out.resume = raw.resume;
  if (raw.teamName !== undefined) out.teamName = raw.teamName;
  if (raw.attachments !== undefined) out.attachments = raw.attachments;
  if (raw.model !== undefined) out.model = raw.model;
  if (raw.claudeCodeEffortLevel !== undefined) {
    out.claudeCodeEffortLevel = raw.claudeCodeEffortLevel;
  }
  if (raw.claudeAgentName !== undefined) out.claudeAgentName = raw.claudeAgentName;
  if (raw.claudeAgents !== undefined) out.claudeAgents = raw.claudeAgents;
  if (raw.claudeCodeSandbox !== undefined) out.claudeCodeSandbox = raw.claudeCodeSandbox;
  if (raw.extraAllowWrite !== undefined) out.extraAllowWrite = raw.extraAllowWrite;
  // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2:透传 handOff metadata
  // 给 claude-code adapter,bridge createSession → finalizeSessionStart emit first user message
  // 时 spread 进 events.payload。
  if (raw.handOff !== undefined) out.handOff = raw.handOff;
  if (raw.awaitCanonicalId !== undefined) out.awaitCanonicalId = raw.awaitCanonicalId;
  return out;
}

/**
 * raw → CodexCreateOpts narrow：从 raw 中挑 codex-cli adapter 接受的字段（filter 掉
 * permissionMode / claudeCodeSandbox 等 claude 专属字段）。
 *
 * **plan codex-handoff-team-alignment-20260518 §P3 Step 3.5 + §不变量 6 (v4 修订) + §D7**:
 * 按 `raw.agentName in REVIEWER_AGENT_NAMES` 触发 codex teammate spawn
 * default spread —— 3 字段 reviewer runtime default（`approvalPolicy: 'never'` /
 * `networkAccessEnabled: true` /
 * `additionalDirectories: ['~/.claude', '~/.codex', '/tmp']`）。
 *
 * **enforce 点 = 本函数（options-builder 层）**，**禁** `bridge.startThread` hardcode default
 * （污染普通 codex session lead 路径）。普通 codex session（agentName 缺省 / 非 reviewer-*）
 * 走 caller 显式字段路径，不被 spread 污染（不变量 6）。reviewer-* 的 codexSandbox 不在本层
 * 强制覆盖，沿用 caller 显式值 / same-adapter 继承 / target adapter 默认值。
 *
 * **信号源 = `raw.agentName`**（v4 D7）：禁用 `opts.spawnedBy` 反向信号源（v3 错误信号 — spawn
 * link 在 spawn handler `setSpawnLink` 后才写库，adapter.createSession 时刻 spawned_by 还没
 * 持久化；baton 路径已删 spawnedBy 写入更不能用）。
 */
function narrowToCodexOpts(raw: CreateSessionOptionsRaw): CodexCreateOpts {
  const out: CodexCreateOpts = { cwd: raw.cwd };
  if (raw.prompt !== undefined) out.prompt = raw.prompt;
  if (raw.resume !== undefined) out.resume = raw.resume;
  if (raw.teamName !== undefined) out.teamName = raw.teamName;
  if (raw.attachments !== undefined) out.attachments = raw.attachments;
  if (raw.model !== undefined) out.model = raw.model;
  if (raw.modelReasoningEffort !== undefined) {
    out.modelReasoningEffort = raw.modelReasoningEffort;
  }
  if (raw.developerInstructions !== undefined) {
    out.developerInstructions = raw.developerInstructions;
  }
  if (raw.codexConfigOverrides !== undefined) {
    out.codexConfigOverrides = raw.codexConfigOverrides;
  }
  if (raw.codexSandbox !== undefined) out.codexSandbox = raw.codexSandbox;
  if (raw.extraAllowWrite !== undefined) out.extraAllowWrite = raw.extraAllowWrite;
  // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2:透传 handOff metadata
  // 给 codex-cli adapter,bridge createSession → thread-loop / resume emit first user message
  // 时 spread 进 events.payload(3 处 emit:thread-loop fallback + thread-loop success +
  // sdk-bridge resume,详 plan §不变量 5)。
  if (raw.handOff !== undefined) out.handOff = raw.handOff;
  if (raw.awaitCanonicalId !== undefined) out.awaitCanonicalId = raw.awaitCanonicalId;

  // plan §P3 Step 3.5 + §不变量 6: codex reviewer teammate spawn (REVIEWER_AGENT_NAMES
  // SSOT) runtime default spread enforce 点。caller 路径 / 普通 codex session 走
  // raw.agentName 缺省 / 非 reviewer-* 路径,不进本分支不被污染。
  // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.2 修法(A1-MED-2 claude):用
  // isReviewerAgentName SSOT guard 替代 reviewer agent hardcode。
  if (isReviewerAgentName(raw.agentName)) {
    // codexSandbox 不在 reviewer 分支强制覆盖。spawn handler 已在本函数前完成
    // caller explicit > same-adapter inherit > target default 的 effective 计算；这里保留该值。
    // approvalPolicy='never' 跳过 codex CLI 工具审批弹窗(reviewer 是 in-process bridge 派发,
    // PendingTab UI 走应用层 / 没有 user 在 codex CLI 直接审批的入口)
    out.approvalPolicy = 'never';
    // networkAccessEnabled=true 让 reviewer-codex 能 web search / 调外部资源(spike 3 实证 codex
    // sandbox=workspace-write 默认 networkAccessEnabled 在某些 platform 受限,显式打开稳)
    out.networkAccessEnabled = true;
    // additionalDirectories: ['~/.claude', '~/.codex', '/tmp'] 让 codex sandbox 允许跨目录访
    // plan / claude config / codex config 文件 + reviewer 走 /tmp 中间文件
    // (REVIEW_105 R2 INFO 订正: 旧叙述「reviewer-claude wrapper 走 /tmp」已过时 —— cross-adapter
    // native 后 reviewer-claude 不再走 wrapper Bash 路径; /tmp 仍必需 = reviewer-codex 端 shell
    // 工具调用 / sandbox-exec 中间文件路由需求(spike4 实证不含 /tmp 时 codex sandbox-exec 拒读
    // 中间文件输出); 详 spike-reports/spike4-claude-nested-sandbox.md)。
    out.additionalDirectories = [
      path.join(os.homedir(), '.claude'),
      path.join(os.homedir(), '.codex'),
      '/tmp',
    ];
  }

  return out;
}

/**
 * D2 核心 builder：按 agentId narrow raw 到对应 union arm + 自动塞 agentId 字段。
 *
 * 加新 adapter 时 default 分支 `_exhaustive: never = agentId` TS 编译期报错强制补 case。
 *
 * **两 overload**:
 * 1. **typed overload** `<T extends AgentId>(agentId: T, raw)`: caller 端 agentId 已是
 *    enum union（如 SpawnSessionArgs.adapter 经 zod enum 校验）→ 拿 narrow return type
 *    `Extract<CreateSessionOptions, { agentId: T }>`,可直接传给 typed adapter 的 createSession
 *    (TS 编译期 narrow)
 * 2. **string overload** `(agentId: string, raw)`: caller 端 agentId 是 dynamic string
 *    （如 CliInvocation.agent / parseStringId IPC raw）→ 内部 isAgentId guard,invalid throw;
 *    返回 `CreateSessionOptions` union（不带具体 arm narrow,caller 仍可传 generic
 *    `adapter.createSession(opts)` 因 adapter union 接受 union arm）
 *
 * @example
 * ```ts
 * // typed overload（agentId 已 narrow）
 * const opts = buildCreateSessionOptions('claude-code', { cwd, prompt, codexSandbox: 'read-only' });
 * // opts: ClaudeCreateOpts & { agentId: 'claude-code' } — codexSandbox 被 filter 掉
 *
 * // string overload（dynamic agentId）
 * const opts = buildCreateSessionOptions(cliArgs.agent, { cwd, prompt }); // cliArgs.agent: string
 * // opts: CreateSessionOptions union — invalid agentId throw
 * ```
 */
export function buildCreateSessionOptions<T extends AgentId>(
  agentId: T,
  raw: CreateSessionOptionsRaw,
): Extract<CreateSessionOptions, { agentId: T }>;
export function buildCreateSessionOptions(
  agentId: string,
  raw: CreateSessionOptionsRaw,
): CreateSessionOptions;
export function buildCreateSessionOptions(
  agentId: string,
  raw: CreateSessionOptionsRaw,
): CreateSessionOptions {
  if (!isAgentId(agentId)) {
    throw new Error(
      `unknown agentId: "${agentId}" (expected: claude-code | deepseek-claude-code | codex-cli)`,
    );
  }
  switch (agentId) {
    case 'claude-code':
      return { agentId, ...narrowToClaudeOpts(raw) };
    case 'deepseek-claude-code':
      return { agentId, ...narrowToClaudeOpts(raw) };
    case 'codex-cli':
      return { agentId, ...narrowToCodexOpts(raw) };
    default: {
      const _exhaustive: never = agentId;
      throw new Error(`unknown agentId: ${String(_exhaustive)}`);
    }
  }
}

/**
 * 类型守卫：raw 中的 string agentId 是否合法 union 成员。
 * caller 端从 IPC raw 输入拿到 agentId（string）时用本守卫窄化到 AgentId union 后才能调
 * buildCreateSessionOptions / typed registry overload。
 *
 * **list 驱动**（p4-d2-impl R2 reviewer-codex MED follow-up）:用 AGENT_IDS list 替代手写
 * 字面量,与 AgentId type union 同源。加新 adapter 时只改 AGENT_IDS 一处 list 即可同时刷新
 * type union + runtime guard,无双源漂移风险。
 */
export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/**
 * **D2 多侧 SSOT 守门（p4-d2-impl R1 reviewer-codex MED follow-up + R2 reviewer-codex MED follow-up）**:
 *
 * 加新 adapter 时漏改任一处 → TS 编译期报错 / 运行时立即 throw。强约束的范围:
 *
 * | 守门点 | 漏改时行为 | 守门方式 |
 * |---|---|---|
 * | (1) types.ts CreateSessionOptions union 加 arm | TS 报错 | `_assertOptionsByAdapterMatchesUnion`(同 (3),双向覆盖 union arm ⇆ ByAdapter entry 一致性) |
 * | (2) options-builder.ts switch 加 case + narrowToXOpts | TS 报错 | `_exhaustive: never = agentId` switch default |
 * | (3) options-builder.ts CreateSessionOptionsByAdapter 加 entry | TS 报错 | `_assertOptionsByAdapterMatchesUnion` |
 * | (4) registry.ts AdapterIdMap 加 entry | TS 报错 | `_assertAdapterIdMapMatchesOptions` (registry.ts 内) |
 * | (5) options-builder.ts AGENT_IDS list 加 entry(同时驱动 AgentId type + isAgentId runtime guard) | TS 报错 | `_assertAgentIdsListMatchesOptions`(本文件) |
 * | (6) main/index.ts adapterRegistry.register(<NewAdapter>) | runtime 拿不到 adapter,caller throw "adapter cannot create sessions" | **流程检查** + adapter init 集成测试 |
 * | (7) MCP schemas.ts SpawnSessionArgs.adapter zod enum / IPC schema enum | runtime user 调 mcp 时 zod 报「不在 enum」 | **流程检查** + MCP handler 集成测试 |
 * | (8) cli.ts parseCliInvocation enum 校验(若有) | runtime user CLI 调时报 unknown agent | **流程检查** |
 * | (9) options-builder.ts narrowToXOpts 漏挑某 arm 字段(REVIEW_105 MED-1) | TS 报错 | `_assertClaudePassthroughCoversArm` / `_assertCodexPassthroughCoversArm`(field 级, 本文件末) |
 *
 * (1)+(2)+(3)+(4)+(5)+(9) 是「TS 编译期强守门」— (1)-(5) agentId 集合级(加新 adapter 漏改报错),
 * (9) field 级(arm 新增 caller-passthrough 字段但 narrow 漏挑报错, 修前缺此守门导致 resumeCliSid /
 * resumeMode 静默漏挑 typecheck 仍过);
 * (6)+(7)+(8) 是「runtime 边界 3 处流程检查」— TS 类型层无法守门(register 是 runtime 调用,
 * zod schema 是 runtime parser),靠 commit message + plan checklist + 集成测试覆盖。
 *
 * **TS 守门 trick 解释**:
 * - `AssertSameKeys<A, B>`: A/B 两 type 的 keys 必须严格一致(双向 extends)。漏 entry → false → 赋值
 *   true 报错 — Type 'false' is not assignable to type 'true'。
 * - 用 `keyof CreateSessionOptionsByAdapter` 作 single source of truth,反向 extract union arm
 *   agentId 字面量与之一致。AGENT_IDS list 通过 `Record<AgentId, unknown>` 转 keys 后与 ByAdapter
 *   双向比较。
 */
type AssertSameKeys<A, B> = keyof A extends keyof B
  ? keyof B extends keyof A
    ? true
    : false
  : false;

/**
 * 守门 (3): CreateSessionOptionsByAdapter keys 必须与 CreateSessionOptions union arm
 * `agentId` literals 严格一致。types.ts 加 union arm 但 options-builder.ts 未加 entry → 此 type
 * 解析为 false → 赋值 true 报错。反向:options-builder.ts 加 entry 但 types.ts 未加 union arm →
 * 同款报错。
 */
type ExtractAgentIdsFromUnion<T extends { agentId: string }> = T['agentId'];
type _UnionAgentIds = ExtractAgentIdsFromUnion<CreateSessionOptions>;
type _UnionAgentIdsAsKeys = { [K in _UnionAgentIds]: unknown };

const _assertOptionsByAdapterMatchesUnion: AssertSameKeys<
  CreateSessionOptionsByAdapter,
  _UnionAgentIdsAsKeys
> = true;
void _assertOptionsByAdapterMatchesUnion;

/**
 * 守门 (5): AGENT_IDS list 通过 `Record<AgentId, unknown>` 转 keys 后必须与 ByAdapter keys 严格
 * 一致。AGENT_IDS 漏 entry → AgentId union 缺成员 → Record keys 缺 → 报错;反向 ByAdapter 漏 entry
 * → 同款报错。让 isAgentId runtime guard 与 type union / ByAdapter map 三向 SSOT 同源。
 */
const _assertAgentIdsListMatchesOptions: AssertSameKeys<
  Record<AgentId, unknown>,
  CreateSessionOptionsByAdapter
> = true;
void _assertAgentIdsListMatchesOptions;

/**
 * **守门 (9) field 级 narrow 覆盖（REVIEW_105 MED-1 deep-review Batch 7 双 reviewer 共识 follow-up）**:
 *
 * 修前缺陷：守门 (1)-(8) 全是 **agentId 字面量集合级**（AssertSameKeys 只比 adapter id keys），
 * **管不到 narrowToXOpts 内部逐字段覆盖** —— 这正是 resumeCliSid / resumeMode 能静默漏挑且
 * typecheck 通过的根因（两 reviewer + lead 三重独立命中）。
 *
 * 本守门下探到字段级：强制「narrow 应透传的字段清单」与「对应 arm 的 key 集（减去 by-design
 * 例外）」**双向一致**。Raw / arm 新增一个 caller-passthrough 字段但 narrow 漏挑 → 开发者漏更新
 * 下方 PASSTHROUGH 清单 → AssertSameKeys 编译期报错（清单列了但实际 narrow 没写的运行时遗漏由
 * teammate-spawn-defaults.test.ts field-coverage 矩阵兜底，类型层无法验证运行时挑了哪些 key）。
 *
 * **by-design 例外**（不算 narrow 该挑、故从对比集排除）：
 * - `cwd`：必填字段，narrow 起手 `{ cwd: raw.cwd }` 恒挑，不进 optional 清单
 * - codex `approvalPolicy` / `networkAccessEnabled` / `additionalDirectories`：仅 reviewer-* 分支
 *   spread 产出（不变量 6），**不是** caller 经 Raw 透传字段，故不在 Raw、也不该被主分支 narrow
 *   挑（narrow 主分支挑了反而污染普通 codex session）
 * - codex `envOverrideExtra`：**性质不同于上 3 个**（REVIEW_105 R2 双 reviewer 独立命中 LOW 订正）——
 *   它**不是** reviewer-* spread 字段（reviewer 分支 L163-180 实际只 spread 上 3 个 + codexSandbox,
 *   无 envOverrideExtra；TC8/TC9 显式断言 reviewer 路径下它 undefined），而是「facade 声明 + bridge
 *   消费但当前零 producer」的 internal 直传字段（create-session-opts.ts CodexCreateOpts.envOverrideExtra
 *   jsdoc 明说「目前无 hot caller，字段保留供未来 caller 重用」, 不在 Raw → narrow 挑不到）。与刚修的
 *   resumeCliSid / resumeMode 同 bug 类(facade 死字段), 仅因「故意保留未接线」而非缺陷。**维护警告**:
 *   未来若给 envOverrideExtra 接 caller(经 Raw 透传), 必须把它移出本排除集 + 加进 _CODEX_PASSTHROUGH_KEYS,
 *   否则守门不会提醒「Raw 加了但 narrow 漏挑」→ MED-1 同款漏挑复发(根治方向 = 同 resumeCliSid 归位
 *   bridge _deps.ts, 牵动 codex index.ts 透传链, 见 REVIEW_105 follow-up)。
 */
type OmitKey<T, K extends PropertyKey> = { [P in Exclude<keyof T, K>]: unknown };

/** claude arm 中 narrow 应从 raw 透传的字段（cwd 必填恒挑除外）。漏挑某字段时此清单与 arm key 集不一致 → 报错。 */
const _CLAUDE_PASSTHROUGH_KEYS = {
  prompt: 0,
  permissionMode: 0,
  resume: 0,
  teamName: 0,
  attachments: 0,
  model: 0,
  claudeCodeEffortLevel: 0,
  claudeAgentName: 0,
  claudeAgents: 0,
  claudeCodeSandbox: 0,
  extraAllowWrite: 0,
  handOff: 0,
  awaitCanonicalId: 0,
} as const;
const _assertClaudePassthroughCoversArm: AssertSameKeys<
  typeof _CLAUDE_PASSTHROUGH_KEYS,
  OmitKey<ClaudeCreateOpts, 'cwd'>
> = true;
void _assertClaudePassthroughCoversArm;

/** codex arm 中 narrow 主分支应从 raw 透传的字段（cwd 必填 + 4 个 reviewer-* spread-only 字段除外）。 */
const _CODEX_PASSTHROUGH_KEYS = {
  prompt: 0,
  resume: 0,
  teamName: 0,
  attachments: 0,
  model: 0,
  modelReasoningEffort: 0,
  developerInstructions: 0,
  codexConfigOverrides: 0,
  codexSandbox: 0,
  extraAllowWrite: 0,
  handOff: 0,
  awaitCanonicalId: 0,
} as const;
const _assertCodexPassthroughCoversArm: AssertSameKeys<
  typeof _CODEX_PASSTHROUGH_KEYS,
  OmitKey<
    CodexCreateOpts,
    'cwd' | 'approvalPolicy' | 'networkAccessEnabled' | 'additionalDirectories' | 'envOverrideExtra'
  >
> = true;
void _assertCodexPassthroughCoversArm;
