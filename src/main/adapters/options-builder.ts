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

export type AgentId = keyof CreateSessionOptionsByAdapter;

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
 */
export function isAgentId(value: string): value is AgentId {
  return (
    value === 'claude-code' ||
    value === 'codex-cli' ||
    value === 'aider' ||
    value === 'generic-pty'
  );
}

/**
 * **D2 多侧 SSOT 守门（p4-d2-impl R1 reviewer-codex MED follow-up）**:
 *
 * 加新 adapter 时漏改任一处 → TS 编译期报错 / 运行时立即 throw。强约束的范围:
 *
 * | 守门点 | 漏改时行为 | 守门方式 |
 * |---|---|---|
 * | (1) types.ts CreateSessionOptions union 加 arm | TS 报错 | `_assertCreateSessionUnionConsistent` |
 * | (2) options-builder.ts switch 加 case + narrowToXOpts | TS 报错 | `_exhaustive: never = agentId` switch default |
 * | (3) options-builder.ts CreateSessionOptionsByAdapter 加 entry | TS 报错 | `_assertOptionsByAdapterMatchesUnion` |
 * | (4) registry.ts AdapterIdMap 加 entry | TS 报错 | `_assertAdapterIdMapMatchesOptions` (registry.ts 内) |
 * | (5) main/index.ts adapterRegistry.register(<NewAdapter>) | runtime 拿不到 adapter,caller throw "adapter cannot create sessions" | **流程检查** + adapter init 集成测试 |
 * | (6) MCP schemas.ts SpawnSessionArgs.adapter zod enum / IPC schema enum | runtime user 调 mcp 时 zod 报「不在 enum」 | **流程检查** + MCP handler 集成测试 |
 * | (7) cli.ts parseCliInvocation enum 校验(若有) | runtime user CLI 调时报 unknown agent | **流程检查** |
 *
 * (1)+(2)+(3)+(4) 是「主链 4 处 TS 编译期强守门」— 加新 adapter 时漏改 TS 编译必报错;
 * (5)+(6)+(7) 是「runtime 边界 3 处流程检查」— TS 类型层无法守门(register 是 runtime 调用,
 * zod schema 是 runtime parser),靠 commit message + plan checklist + 集成测试覆盖。
 *
 * **TS 守门 trick 解释**:
 * - `AssertSameKeys<A, B>`: A/B 两 type 的 keys 必须严格一致(双向 extends)。漏 entry → false → 赋值
 *   true 报错 — Type 'false' is not assignable to type 'true'。
 * - 用 `keyof CreateSessionOptionsByAdapter` 作 single source of truth,反向 extract union arm
 *   agentId 字面量与之一致。
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
