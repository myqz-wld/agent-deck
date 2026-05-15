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
import { app, dialog } from 'electron';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { adapterRegistry } from './adapters/registry';
import { buildCreateSessionOptions } from './adapters/options-builder';
import { eventBus } from './event-bus';
import { getFloatingWindow } from './window';
import { sessionManager } from './session/manager';
import { agentDeckTeamRepo, TeamInvariantError } from './store/agent-deck-team-repo';
import type { PermissionMode } from './adapters/types';

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
  permissionMode?: PermissionMode;
  resume?: string;
  focus: boolean;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  /** R3.E10：填了表示创建 / 加入指定 team（lead 角色） */
  team?: string;
  /** R3.E10：lead spawn 后再 spawn 这些 teammate sessions，全部加入 team（teammate 角色） */
  members: CliMemberSpec[];
}

export type CliInvocation = CliNewSession | { kind: 'noop' };

const SUBCOMMANDS = ['new'] as const;
const PERM_MODES: ReadonlyArray<PermissionMode> = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
];
const CODEX_SANDBOXES: ReadonlyArray<'workspace-write' | 'read-only' | 'danger-full-access'> = [
  'workspace-write',
  'read-only',
  'danger-full-access',
];

/**
 * adapter 短名 alias 映射（CHANGELOG_<X> A9）：让用户敲 `--adapter codex` 而不是
 * 完整的 `--agent codex-cli`。`--adapter` 与 `--agent` 等价（前者更通用，符合应用
 * 内部的 adapter 概念命名）。
 */
const AGENT_ALIASES: Record<string, string> = {
  codex: 'codex-cli',
  claude: 'claude-code',
};

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
  'agent',
  'adapter',
  'prompt',
  'permission-mode',
  'resume',
  'codex-sandbox',
  'team',     // R3.E10
  'member',   // R3.E10
]);

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
      i++;
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq > 0) {
      accumulate(tok.slice(2, eq), tok.slice(eq + 1));
      i++;
      continue;
    }
    const key = tok.slice(2);
    if (key.startsWith('no-')) {
      out.set(key.slice(3), false);
      i++;
      continue;
    }
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
    // CHANGELOG_<X> A9：--adapter 与 --agent 等价；优先取 --adapter（更新的命名）。
    // 短名 alias 自动展开（'codex' → 'codex-cli'）。
    const adapterRaw = asString(f.get('adapter')) ?? asString(f.get('agent')) ?? 'claude-code';
    const agent = AGENT_ALIASES[adapterRaw] ?? adapterRaw;
    // 缺省 prompt = '你好'，让裸跑 `agent-deck` 也能立刻发起会话；
    // 不然 SDK CLI 子进程拿不到首条 user message 会卡到 30s fallback。
    const prompt = asString(f.get('prompt')) ?? '你好';
    const resume = asString(f.get('resume'));

    const pmRaw = asString(f.get('permission-mode'));
    let permissionMode: PermissionMode | undefined;
    if (pmRaw !== undefined) {
      if (!PERM_MODES.includes(pmRaw as PermissionMode)) {
        throw new Error(
          `agent-deck new: --permission-mode 取值无效（应为 ${PERM_MODES.join(' | ')}）`,
        );
      }
      permissionMode = pmRaw as PermissionMode;
    }

    // CHANGELOG_<X> A9：--codex-sandbox 仅 codex-cli adapter 起效；其他 adapter 收下忽略。
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
      const memberAdapterRaw = spec.slice(colonIdx + 1);
      const memberAdapter = AGENT_ALIASES[memberAdapterRaw] ?? memberAdapterRaw;
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
      resume,
      focus,
      ...(codexSandbox !== undefined ? { codexSandbox } : {}),
      ...(team ? { team } : {}),
      members,
    };
  }

  return { kind: 'noop' };
}

async function resolveCwd(input: string): Promise<string> {
  // 相对路径按主进程 process.cwd() 解析 —— 不可靠（second-instance 的主实例
  // cwd 不是用户 shell 的 PWD），所以 wrapper 脚本应该把 --cwd 在 shell 端
  // 转成绝对路径再传进来。这里只是兜底。
  const abs = isAbsolute(input) ? input : resolve(process.cwd(), input);
  try {
    return await realpath(abs);
  } catch {
    // realpath 失败（路径不存在）就原样返回，让 SDK 抛出更明确的 ENOENT
    return abs;
  }
}

export async function applyCliInvocation(inv: CliInvocation): Promise<void> {
  if (inv.kind !== 'new-session') return;
  const adapter = adapterRegistry.get(inv.agent);
  if (!adapter?.createSession) {
    throw new Error(`agent-deck new: adapter "${inv.agent}" 不支持创建会话`);
  }
  const cwd = await resolveCwd(inv.cwd);
  // p4-d2-impl Step 2.1：用 buildCreateSessionOptions builder helper 按 inv.agent narrow
  // 到对应 union arm。inv.agent 是 string（CliInvocation.agent: string）走 string overload
  // 内部 isAgentId guard，invalid throw（caller 已 line 263-266 验过 adapter 存在 +
  // capabilities.canCreateSession，到此 inv.agent 应都是合法 union 成员）。
  const sid = await adapter.createSession(
    buildCreateSessionOptions(inv.agent, {
      cwd,
      prompt: inv.prompt,
      permissionMode: inv.permissionMode,
      resume: inv.resume,
      ...(inv.codexSandbox !== undefined ? { codexSandbox: inv.codexSandbox } : {}),
    }),
  );
  if (adapter.capabilities.canSetPermissionMode) {
    sessionManager.recordCreatedPermissionMode(sid, inv.permissionMode);
  }

  // R3.E10 universal team backend：--team 把 lead 加入指定 team；--member 再 spawn N teammate
  if (inv.team) {
    try {
      const team = agentDeckTeamRepo.ensureByName(inv.team, { source: 'cli' });
      // lead 自动加入（已 active 时 invariant，幂等吞掉）
      try {
        agentDeckTeamRepo.addMember({
          teamId: team.id,
          sessionId: sid,
          role: 'lead',
          displayName: null,
        });
        // REVIEW_35 MED-A7：emit `agent-deck-team-member-changed` 让 universal-message-watcher
        // dispatcher 收到 → fan-out member-joined adapter event 给同 team active member。
        // 修前 cli/spawn/ipc.adapters 只调 sessionManager.notifyTeamMembershipChanged 触发
        // session-upserted（renderer UI chip 刷新），但**不**emit member-changed → dispatcher
        // 永远收不到 member-joined，adapter notifyTeammateEvent 永远不被通知。
        eventBus.emit('agent-deck-team-member-changed', {
          teamId: team.id,
          sessionId: sid,
          kind: 'joined',
        });
      } catch (e) {
        if (!(e instanceof TeamInvariantError)) throw e;
      }
      // teammate spawn —— 并发以加快总耗时
      await Promise.all(
        inv.members.map(async (m) => {
          const memberAdapter = adapterRegistry.get(m.adapter);
          if (!memberAdapter?.createSession) {
            console.warn(
              `[cli] team member adapter "${m.adapter}" cannot create session; skip ${m.slug}`,
            );
            return;
          }
          try {
            // p4-d2-impl Step 2.1：team member spawn 也走 buildCreateSessionOptions narrow。
            // m.adapter 是 string（CliMemberSpec.adapter: string）走 string overload。
            const memberSid = await memberAdapter.createSession(
              buildCreateSessionOptions(m.adapter, {
                cwd,
                prompt: `你被 lead 加入了 team "${inv.team}"，等待 lead 通过 mcp__agent-deck__send_message 给你发消息。`,
                ...(inv.codexSandbox !== undefined && m.adapter === 'codex-cli'
                  ? { codexSandbox: inv.codexSandbox }
                  : {}),
              }),
            );
            agentDeckTeamRepo.addMember({
              teamId: team.id,
              sessionId: memberSid,
              role: 'teammate',
              displayName: m.slug,
            });
            // REVIEW_35 MED-A7：同 lead 路径，补 emit 让 dispatcher 看到 teammate 加入。
            eventBus.emit('agent-deck-team-member-changed', {
              teamId: team.id,
              sessionId: memberSid,
              kind: 'joined',
            });
          } catch (e) {
            console.warn(
              `[cli] failed to spawn team member ${m.slug}:${m.adapter}:`,
              e instanceof Error ? e.message : String(e),
            );
          }
        }),
      );
    } catch (e) {
      console.warn(`[cli] team setup failed for "${inv.team}":`, e);
    }
  }

  if (inv.focus) {
    const win = getFloatingWindow().window;
    win?.show();
    win?.focus();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
    eventBus.emit('session-focus-request', sid);
  }
}

/** 包一层 try/catch + 报错弹框，给 second-instance / 首启两个入口共用。 */
export async function handleCliArgv(argv: readonly string[]): Promise<void> {
  let inv: CliInvocation;
  try {
    inv = parseCliInvocation(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cli] parse failed:', msg);
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
    console.error('[cli] apply failed:', msg);
    try {
      dialog.showErrorBox('Agent Deck 命令行', msg);
    } catch {
      // 同上
    }
  }
}
