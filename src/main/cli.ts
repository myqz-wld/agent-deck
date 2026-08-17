/**
 * 命令行子命令支持。让用户在已运行的 Agent Deck 实例上通过命令行新建一个
 * 应用内 SDK 会话（首次启动也支持）。
 *
 * 入口三种：
 *   1. 打包应用首次启动：bootstrap 末尾把 `process.argv` 喂给 handleCliArgv。
 *   2. 打包应用 second-instance：requestSingleInstanceLock 触发的 'second-instance'
 *      事件携带新进程的 argv，转发给主实例处理。
 *   3. dev 模式：暂不支持。
 *
 * argv 在不同入口里 leading 段长度不同，统一找 'new' 子命令名之后的 token 作为参数。
 *
 * R3.E10：新增 `--team <name>` + `--member <slug:adapter>` repeatable，
 * 用于跨 adapter team 一键创建 lead + N teammate（详 docs/agent-deck-team-protocol.md §10.2 / §10.3）。
 */
import { dialog } from 'electron';
import { homedir } from 'node:os';
import { isAgentId } from './adapters/options-builder';
import {
  firstUnsupportedTargetRuntimeField,
  unsupportedTargetRuntimeFieldMessage,
} from './adapters/runtime-control-contracts';
import type {
  CodexApprovalPolicy,
  SelectablePermissionMode,
} from '@shared/types';
import { unwrapCliArgvPayload } from './cli-argv-payload';
import log from '@main/utils/logger';
import {
  CODEX_APPROVAL_POLICIES,
  PERMISSION_MODES,
} from '@shared/types';
import { normalizeGrokSandboxProfile } from '@shared/grok-sandbox';
import { applyCliInvocation } from './cli-session-creation';

const logger = log.scope('main-cli');

export interface CliMemberSpec {
  /** 如 'reviewer-claude'；用作 member.displayName */
  slug: string;
  /** adapter id（'claude-code' / 'codex-cli' / etc.） */
  adapter: string;
}

export interface CliNewSession {
  kind: 'new-session';
  agent: string;
  cwd: string;
  prompt: string;
  permissionMode?: SelectablePermissionMode;
  approvalPolicy?: CodexApprovalPolicy;
  resume?: string;
  /** Free-form provider model id for the lead session only. */
  model?: string;
  /** Claude Code Gateway profile id for the lead session. */
  gateway?: string;
  /** Codex Gateway id for the lead session. */
  provider?: string;
  /** Adapter-aware reasoning level for the lead session only. */
  thinking?: string;
  focus: boolean;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  grokSandbox?: string;
  /** R3.E10：填了表示创建 / 加入指定 team（lead 角色） */
  team?: string;
  /** R3.E10：lead spawn 后再 spawn 这些 teammate sessions，全部加入 team（teammate 角色） */
  members: CliMemberSpec[];
}

export type CliInvocation = CliNewSession | { kind: 'noop' };

const SUBCOMMANDS = ['new'] as const;
const PERM_MODES: ReadonlyArray<SelectablePermissionMode> = PERMISSION_MODES;
const CODEX_SANDBOXES: ReadonlyArray<'workspace-write' | 'read-only' | 'danger-full-access'> = [
  'workspace-write',
  'read-only',
  'danger-full-access',
];

function findSubcommand(argv: readonly string[]): { sub: string; args: string[] } | null {
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i];
    if ((SUBCOMMANDS as readonly string[]).includes(v)) {
      return { sub: v, args: argv.slice(i + 1) };
    }
  }
  return null;
}

/**
 * 简易 flag 解析。支持：
 *   --key value   / --key=value
 *   --no-key      （布尔反向开关，等价于 key=false）
 *   --key         （后面没值或紧跟下一个 --xxx 时视为 key=true）
 * 不实现 short flag、引号嵌套等高级语义 —— shell 那边会处理引号。
 *
 * REVIEW_2：加 valueRequired 集合。`cwd / agent / prompt / permission-mode / resume`
 * 这些值型 flag 缺值时不再静默吞为 true（再被 asString 转 undefined 走默认 fallback），
 * 直接抛错让用户知道命令拼错了，不要让 `--cwd`（缺值）静默落到 homedir。
 */
const VALUE_REQUIRED_FLAGS = new Set([
  'cwd',
  'adapter',
  'prompt',
  'permission-mode',
  'approval-policy',
  'resume',
  'codex-sandbox',
  'grok-sandbox',
  'model',
  'gateway',
  'provider',
  'thinking',
  'team',     // R3.E10
  'member',   // R3.E10
]);

const KNOWN_FLAGS = new Set([...VALUE_REQUIRED_FLAGS, 'focus']);

/** 可重复 flag —— 同 key 多次出现时累积成数组而非覆盖 */
const REPEATABLE_FLAGS = new Set(['member']);

function parseFlags(args: readonly string[]): Map<string, string | boolean | string[]> {
  const out = new Map<string, string | boolean | string[]>();
  const accumulate = (key: string, value: string): void => {
    if (REPEATABLE_FLAGS.has(key)) {
      const cur = out.get(key);
      if (Array.isArray(cur)) cur.push(value);
      else out.set(key, [value]);
    } else {
      out.set(key, value);
    }
  };
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    if (!tok.startsWith('--')) {
      throw new Error(`agent-deck new: 不支持的位置参数 "${tok}"`);
    }
    const eq = tok.indexOf('=');
    if (eq > 0) {
      const key = tok.slice(2, eq);
      if (!KNOWN_FLAGS.has(key)) throw new Error(`agent-deck new: 未知参数 --${key}`);
      accumulate(key, tok.slice(eq + 1));
      i++;
      continue;
    }
    const key = tok.slice(2);
    if (key.startsWith('no-')) {
      const positiveKey = key.slice(3);
      if (!KNOWN_FLAGS.has(positiveKey)) {
        throw new Error(`agent-deck new: 未知参数 --${key}`);
      }
      out.set(positiveKey, false);
      i++;
      continue;
    }
    if (!KNOWN_FLAGS.has(key)) throw new Error(`agent-deck new: 未知参数 --${key}`);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      accumulate(key, next);
      i += 2;
    } else {
      if (VALUE_REQUIRED_FLAGS.has(key)) {
        throw new Error(`agent-deck new: --${key} 缺少取值（用法：--${key} <value>）`);
      }
      out.set(key, true);
      i++;
    }
  }
  return out;
}

function asString(v: string | boolean | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asStringArray(v: string | boolean | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return [v];
  return [];
}

export function parseCliInvocation(argv: readonly string[]): CliInvocation {
  const sub = findSubcommand(argv);
  if (!sub) return { kind: 'noop' };

  if (sub.sub === 'new') {
    const f = parseFlags(sub.args);
    // cwd 缺省 → 用户主目录（与 renderer NewSessionDialog 行为一致）。
    // wrapper 脚本 resources/bin/agent-deck 在 shell 端已用 $PWD 兜底，
    // 这里再兜一层是给「直接调 .app 二进制 / 第三方调用」的场景。
    const cwd = asString(f.get('cwd')) ?? homedir();
    const agent = asString(f.get('adapter')) ?? 'claude-code';
    if (!isAgentId(agent)) {
      throw new Error(
        `agent-deck new: --adapter 取值无效（应为 claude-code | codex-cli | grok-build）`,
      );
    }
    // 缺省 prompt = '你好'，让 `agent-deck new` 直接发起会话；
    // 不然 SDK CLI 子进程拿不到首条 user message 会卡到 30s fallback。
    const prompt = asString(f.get('prompt')) ?? '你好';
    const resume = asString(f.get('resume'));
    const model = asString(f.get('model'));
    const gateway = asString(f.get('gateway'));
    const provider = asString(f.get('provider'));
    const thinking = asString(f.get('thinking'));

    const pmRaw = asString(f.get('permission-mode'));
    let permissionMode: SelectablePermissionMode | undefined;
    if (pmRaw !== undefined) {
      if (!PERM_MODES.includes(pmRaw as SelectablePermissionMode)) {
        throw new Error(
          `agent-deck new: --permission-mode 取值无效（应为 ${PERM_MODES.join(' | ')}）`,
        );
      }
      permissionMode = pmRaw as SelectablePermissionMode;
    }
    if (agent === 'claude-code' && permissionMode === undefined) {
      permissionMode = 'bypassPermissions';
    }

    const approvalRaw = asString(f.get('approval-policy'));
    let approvalPolicy: CodexApprovalPolicy | undefined;
    if (approvalRaw !== undefined) {
      if (!CODEX_APPROVAL_POLICIES.includes(approvalRaw as CodexApprovalPolicy)) {
        throw new Error(
          `agent-deck new: --approval-policy 取值无效（应为 ${CODEX_APPROVAL_POLICIES.join(' | ')}）`,
        );
      }
      approvalPolicy = approvalRaw as CodexApprovalPolicy;
    }
    if (agent === 'codex-cli' && approvalPolicy === undefined) {
      approvalPolicy = 'never';
    }

    // Parse global enums first; adapter ownership is checked below.
    const csRaw = asString(f.get('codex-sandbox'));
    let codexSandbox: 'workspace-write' | 'read-only' | 'danger-full-access' | undefined;
    if (csRaw !== undefined) {
      if (!CODEX_SANDBOXES.includes(csRaw as (typeof CODEX_SANDBOXES)[number])) {
        throw new Error(
          `agent-deck new: --codex-sandbox 取值无效（应为 ${CODEX_SANDBOXES.join(' | ')}）`,
        );
      }
      codexSandbox = csRaw as (typeof CODEX_SANDBOXES)[number];
    }
    const gsRaw = asString(f.get('grok-sandbox'));
    let grokSandbox: string | undefined;
    if (gsRaw !== undefined) {
      try {
        grokSandbox = normalizeGrokSandboxProfile(gsRaw);
      } catch (error) {
        throw new Error(
          `agent-deck new: --grok-sandbox 取值无效（${
            error instanceof Error ? error.message : String(error)
          }）`,
        );
      }
    }
    if (isAgentId(agent)) {
      const unsupportedRuntimeField = firstUnsupportedTargetRuntimeField(agent, {
        ...(gateway !== undefined ? { gateway } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
        ...(codexSandbox !== undefined ? { codexSandbox } : {}),
        ...(grokSandbox !== undefined ? { grokSandbox } : {}),
      });
      if (unsupportedRuntimeField !== null) {
        const flag =
          unsupportedRuntimeField === 'permissionMode'
            ? 'permission-mode'
            : unsupportedRuntimeField === 'approvalPolicy'
              ? 'approval-policy'
              : unsupportedRuntimeField === 'codexSandbox'
                ? 'codex-sandbox'
                : unsupportedRuntimeField === 'grokSandbox'
                  ? 'grok-sandbox'
                  : unsupportedRuntimeField;
        throw new Error(
          `agent-deck new: --${flag} 与 adapter "${agent}" 不兼容（${unsupportedTargetRuntimeFieldMessage(agent, unsupportedRuntimeField)}）`,
        );
      }
    }

    // 默认聚焦；--no-focus 显式关掉
    const focusFlag = f.get('focus');
    const focus = focusFlag !== false;

    // R3.E10：--team / --member 解析
    const team = asString(f.get('team'));
    const memberRaw = asStringArray(f.get('member'));
    const members: CliMemberSpec[] = [];
    for (const spec of memberRaw) {
      const colonIdx = spec.lastIndexOf(':');
      if (colonIdx <= 0 || colonIdx === spec.length - 1) {
        throw new Error(
          `agent-deck new: --member 格式应为 <slug>:<adapter>（如 reviewer-claude:claude-code），得到 "${spec}"`,
        );
      }
      const slug = spec.slice(0, colonIdx);
      const memberAdapter = spec.slice(colonIdx + 1);
      if (!isAgentId(memberAdapter)) {
        throw new Error(
          `agent-deck new: --member adapter 取值无效（应为 claude-code | codex-cli | grok-build），得到 "${memberAdapter}"`,
        );
      }
      members.push({ slug, adapter: memberAdapter });
    }
    if (members.length > 0 && !team) {
      throw new Error('agent-deck new: --member 必须配合 --team <name> 一起使用');
    }

    return {
      kind: 'new-session',
      agent,
      cwd,
      prompt,
      permissionMode,
      approvalPolicy,
      resume,
      ...(model !== undefined ? { model } : {}),
      ...(gateway !== undefined ? { gateway } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      focus,
      ...(codexSandbox !== undefined ? { codexSandbox } : {}),
      ...(grokSandbox !== undefined ? { grokSandbox } : {}),
      ...(team ? { team } : {}),
      members,
    };
  }

  return { kind: 'noop' };
}

export { applyCliInvocation };

/** 包一层 try/catch + 报错弹框，给 second-instance / 首启两个入口共用。 */
export async function handleCliArgv(argv: readonly string[]): Promise<void> {
  let inv: CliInvocation;
  try {
    inv = parseCliInvocation(unwrapCliArgvPayload(argv));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[cli] parse failed:', msg);
    try {
      dialog.showErrorBox('Agent Deck 命令行', msg);
    } catch {
      // dialog 在 app ready 之前可能不可用，吞掉
    }
    return;
  }
  if (inv.kind === 'noop') return;
  try {
    await applyCliInvocation(inv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[cli] apply failed:', msg);
    try {
      dialog.showErrorBox('Agent Deck 命令行', msg);
    } catch {
      // 同上
    }
  }
}
