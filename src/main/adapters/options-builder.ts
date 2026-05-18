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
import { resolveBundledClaudeBinary } from './claude-code/resolve-bundled-claude';
import type {
  ClaudeCreateOpts,
  CodexCreateOpts,
  CreateSessionOptions,
  CreateSessionOptionsRaw,
  PtyCreateOpts,
} from './types';

/**
 * agentId → 对应 adapter 接受的字段 interface 映射（不含 agentId 字段，agentId 由 builder 自动塞）。
 * 用于 buildCreateSessionOptions 泛型返回类型推导。
 */
export type CreateSessionOptionsByAdapter = {
  'claude-code': ClaudeCreateOpts;
  'codex-cli': CodexCreateOpts;
  'aider': PtyCreateOpts;
  'generic-pty': PtyCreateOpts;
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
export const AGENT_IDS = ['claude-code', 'codex-cli', 'aider', 'generic-pty'] as const;

export type AgentId = (typeof AGENT_IDS)[number];

/**
 * raw → ClaudeCreateOpts narrow：从 raw 中挑 claude-code adapter 接受的字段（filter 掉
 * codexSandbox / genericPtyConfig）。undefined 字段被剔除（避免 spread 进 opts 后变成显式
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
  if (raw.claudeCodeSandbox !== undefined) out.claudeCodeSandbox = raw.claudeCodeSandbox;
  if (raw.extraAllowWrite !== undefined) out.extraAllowWrite = raw.extraAllowWrite;
  return out;
}

/**
 * raw → CodexCreateOpts narrow：从 raw 中挑 codex-cli adapter 接受的字段（filter 掉
 * permissionMode / claudeCodeSandbox / genericPtyConfig）。
 *
 * **plan codex-handoff-team-alignment-20260518 §P3 Step 3.5 + §不变量 6 (v4 修订) + §D7**:
 * 按 `raw.agentName in ['reviewer-claude', 'reviewer-codex']` 触发 codex teammate spawn
 * default spread —— 4 字段 unsafe default 强制（`codexSandbox: 'workspace-write'` 不允许
 * caller 覆盖；`approvalPolicy: 'never'` / `networkAccessEnabled: true` /
 * `additionalDirectories: ['~/.claude', '~/.codex']`）+ reviewer-claude 路径加
 * `envOverrideExtra: {AGENT_DECK_CLAUDE_PATH: resolveBundledClaudeBinary()}`（v4 M7：
 * wrapper Bash 模板用 env var，不 hardcode 路径）。
 *
 * **enforce 点 = 本函数（options-builder 层）**，**禁** `bridge.startThread` hardcode default
 * （污染普通 codex session lead 路径）。普通 codex session（agentName 缺省 / 非 reviewer-*）
 * 走 caller 显式字段路径，不被 spread 污染（不变量 6）。
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
  if (raw.codexSandbox !== undefined) out.codexSandbox = raw.codexSandbox;
  if (raw.extraAllowWrite !== undefined) out.extraAllowWrite = raw.extraAllowWrite;

  // plan §P3 Step 3.5 + §不变量 6: codex teammate spawn (reviewer-claude / reviewer-codex)
  // unsafe default spread enforce 点。caller 路径 / 普通 codex session 走 raw.agentName 缺省 /
  // 非 reviewer-* 路径,不进本分支不被污染。
  if (raw.agentName === 'reviewer-claude' || raw.agentName === 'reviewer-codex') {
    // codexSandbox 强制 'workspace-write'(不允许 caller 覆盖) — reviewer 必须能写 worktree 内
    // cache 副本 + 跨目录读 plan / claude config / codex config(配合 additionalDirectories)
    out.codexSandbox = 'workspace-write';
    // approvalPolicy='never' 跳过 codex CLI 工具审批弹窗(reviewer 是 in-process bridge 派发,
    // PendingTab UI 走应用层 / 没有 user 在 codex CLI 直接审批的入口)
    out.approvalPolicy = 'never';
    // networkAccessEnabled=true 让 reviewer-codex 能 web search / reviewer-claude wrapper
    // 内的 claude SDK 能 fetch 工具调外部资源(spike 3 实证 codex sandbox=workspace-write
    // 默认 networkAccessEnabled 在某些 platform 受限,显式打开稳)
    out.networkAccessEnabled = true;
    // additionalDirectories: ['~/.claude', '~/.codex'] 让 codex sandbox 允许跨目录访 plan /
    // claude config / codex config 文件(不需 caller 每次 cp 副本到 worktree 内)
    out.additionalDirectories = [
      path.join(os.homedir(), '.claude'),
      path.join(os.homedir(), '.codex'),
    ];

    // v4 M7: reviewer-claude wrapper 路径加 AGENT_DECK_CLAUDE_PATH env 让 wrapper Bash 模板
    // `$AGENT_DECK_CLAUDE_PATH -p < input.txt` 引用 bundled claude binary(不 hardcode 路径)。
    // resolveBundledClaudeBinary() 委托 sdk-runtime.getPathToClaudeCodeExecutable(),dev /
    // packaged 双路径都返非 null(dev 真实 node_modules 路径 / packaged unpacked 路径)。
    // 返 null(require.resolve 失败 / OS 不在 candidate list)→ 不注入 env var,wrapper Bash
    // 模板回退到 PATH 找 `claude`(脚本作者职责处理 fallback;options-builder 不静默替换)。
    if (raw.agentName === 'reviewer-claude') {
      const claudePath = resolveBundledClaudeBinary();
      if (claudePath !== null) {
        out.envOverrideExtra = { AGENT_DECK_CLAUDE_PATH: claudePath };
      }
    }
  }

  return out;
}

/**
 * raw → PtyCreateOpts narrow：从 raw 中挑 PTY adapter（aider / generic-pty）接受的字段
 * （filter 掉 permissionMode / resume / model / codexSandbox / claudeCodeSandbox /
 * extraAllowWrite）。
 */
function narrowToPtyOpts(raw: CreateSessionOptionsRaw): PtyCreateOpts {
  const out: PtyCreateOpts = { cwd: raw.cwd };
  if (raw.prompt !== undefined) out.prompt = raw.prompt;
  if (raw.teamName !== undefined) out.teamName = raw.teamName;
  if (raw.attachments !== undefined) out.attachments = raw.attachments;
  if (raw.genericPtyConfig !== undefined) out.genericPtyConfig = raw.genericPtyConfig;
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
      `unknown agentId: "${agentId}" (expected: claude-code | codex-cli | aider | generic-pty)`,
    );
  }
  switch (agentId) {
    case 'claude-code':
      return { agentId, ...narrowToClaudeOpts(raw) };
    case 'codex-cli':
      return { agentId, ...narrowToCodexOpts(raw) };
    case 'aider':
    case 'generic-pty':
      return { agentId, ...narrowToPtyOpts(raw) };
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
 *
 * (1)+(2)+(3)+(4)+(5) 是「主链 5 处 TS 编译期强守门」— 加新 adapter 时漏改 TS 编译必报错;
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
