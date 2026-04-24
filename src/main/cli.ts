/**
 * 命令行子命令支持。让用户在已运行的 Agent Deck 实例上通过命令行新建一个
 * 应用内 SDK 会话（首次启动也支持）。
 *
 * 入口三种：
 *   1. 打包应用首次启动：bootstrap 末尾把 `process.argv` 喂给 handleCliArgv。
 *   2. 打包应用 second-instance：requestSingleInstanceLock 触发的 'second-instance'
 *      事件携带新进程的 argv，转发给主实例处理。
 *   3. dev 模式：暂不支持（电用 ＋ 按钮即可），但 parseCliInvocation 是纯函数，
 *      typecheck 即可验证。
 *
 * argv 在不同入口里 leading 段长度不同（exe / electron+projectDir / 还有
 * --inspect 等 electron 自带 flag），不能按 index 取。统一找 'new' 子命令名
 * 之后的 token 作为参数。
 */
import { app, dialog } from 'electron';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { adapterRegistry } from './adapters/registry';
import { eventBus } from './event-bus';
import { getFloatingWindow } from './window';
import { sessionManager } from './session/manager';
import type { PermissionMode } from './adapters/types';

export interface CliNewSession {
  kind: 'new-session';
  agent: string;
  cwd: string;
  /** 缺省时填 `'你好'`，避免 SDK 卡 30s fallback 才显出会话。
   *  显式传 `--prompt ''` 视为用户主动要空（asString 返回 ''，?? 不触发）。 */
  prompt: string;
  model?: string;
  permissionMode?: PermissionMode;
  resume?: string;
  /** 创建后是否聚焦窗口并选中新会话（默认 true，--no-focus 关闭）。 */
  focus: boolean;
}

export type CliInvocation = CliNewSession | { kind: 'noop' };

const SUBCOMMANDS = ['new'] as const;
const PERM_MODES: ReadonlyArray<PermissionMode> = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
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
 * REVIEW_2：加 valueRequired 集合。`cwd / agent / prompt / model / permission-mode / resume`
 * 这些值型 flag 缺值时不再静默吞为 true（再被 asString 转 undefined 走默认 fallback），
 * 直接抛错让用户知道命令拼错了，不要让 `--cwd`（缺值）静默落到 homedir。
 */
const VALUE_REQUIRED_FLAGS = new Set([
  'cwd',
  'agent',
  'prompt',
  'model',
  'permission-mode',
  'resume',
]);

function parseFlags(args: readonly string[]): Map<string, string | boolean> {
  const out = new Map<string, string | boolean>();
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    if (!tok.startsWith('--')) {
      i++;
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq > 0) {
      out.set(tok.slice(2, eq), tok.slice(eq + 1));
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
      out.set(key, next);
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

function asString(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
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
    const agent = asString(f.get('agent')) ?? 'claude-code';
    // 缺省 prompt = '你好'，让裸跑 `agent-deck` 也能立刻发起会话；
    // 不然 SDK CLI 子进程拿不到首条 user message 会卡到 30s fallback。
    const prompt = asString(f.get('prompt')) ?? '你好';
    const model = asString(f.get('model'));
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

    // 默认聚焦；--no-focus 显式关掉
    const focusFlag = f.get('focus');
    const focus = focusFlag !== false;

    return {
      kind: 'new-session',
      agent,
      cwd,
      prompt,
      model,
      permissionMode,
      resume,
      focus,
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
  const sid = await adapter.createSession({
    cwd,
    prompt: inv.prompt,
    model: inv.model,
    permissionMode: inv.permissionMode,
    resume: inv.resume,
  });
  // 按 adapter capability 决定是否持久化 permissionMode：
  // - canSetPermissionMode=true（如 claude-code）→ 写入 sessions.permission_mode 让
  //   SessionDetail 下拉读到正确值，跟 SDK 真实状态对齐。
  // - canSetPermissionMode=false（如 codex-cli）→ 不写，避免污染 DB 列让别处误读
  //   一个其实"未生效"的 mode（CLI 路径之前总是写，而 codex SDK 完全忽略）。
  // REVIEW_2 修。
  if (adapter.capabilities.canSetPermissionMode) {
    sessionManager.recordCreatedPermissionMode(sid, inv.permissionMode);
  }
  if (inv.focus) {
    const win = getFloatingWindow().window;
    win?.show();
    win?.focus();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
    // 通知 renderer：切到「实时」并选中这条会话。session-upserted / agent-event
    // 走的是各自通道，单独再发一个 focus-request 让 UI 跳过去，避免用户找不到。
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
