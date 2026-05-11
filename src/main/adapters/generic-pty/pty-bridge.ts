/**
 * GenericPtyBridge — 用 node-pty 包裹任意 stdin/stdout-only CLI 的 per-session backend
 * （R4·F2，plan §F-bonus 选项 B 落地：aider / generic-pty 各 own 一个 bridge instance）。
 *
 * 职责（F2 范围）：
 * - 用 node-pty.spawn 起 PTY 子进程（**必须 PTY 不能 child_process**，否则 aider 等检测到
 *   stdout 不是 TTY 会切到 dumb 模式丢 ANSI 颜色 / readline 编辑能力）
 * - per-session: { pty, idleTimer (F3), fileWatcher (F4) }
 * - createSession：spawn → emit session-start + 首条 user message → 注册 onData / onExit listener
 * - sendMessage：pty.write(text + '\\n') 走 stdin；attachments 当下不支持（PTY 没有 attachment 概念）
 * - interrupt：pty.write('\\x03') Ctrl+C ASCII
 * - closeSession：pty.kill('SIGTERM')，10s grace 后 SIGKILL
 *
 * F2 不做（留给后续 step）：
 * - ANSI strip（F3）：当下 emit message 的 text 是 raw stdout，含 ANSI escape，UI 显示会带控制字符
 * - idle 检测（F3）：当下不 emit waiting-for-user
 * - file-watcher（F4）：当下不 emit file-changed
 *
 * 设计取舍：
 * - sessionId 用 randomUUID（与 task-repo / claude-code tempKey 同款）。PTY backend 没有
 *   server-assigned id，bridge 自己 generate 即可；不存在 codex / claude SDK 那种
 *   tempKey → realId rename 路径
 * - emit source='sdk'：与 codex-cli / claude-code 同款，标识应用内创建的 session（hook 通道
 *   不会观测 generic-pty，因为 generic-pty 不挂 hook）
 * - sessionRepo.setGenericPtyConfig 紧跟 emit session-start 后跑：emit 同步派发到
 *   sessionManager.ingest → sessionRepo.upsert 创建 record；之后 setGenericPtyConfig UPDATE
 *   必然命中（与 codex bridge setCodexSandbox 同模式，详 sdk-bridge/index.ts:267-274）
 * - spawn-helper 权限兜底：node-pty 1.1.0 prebuilds/<arch>/spawn-helper 经 pnpm install 后
 *   可能丢 x bit（pnpm hard-link 拷贝丢权限，实测）；adapter init 时 silent chmod 0o755 兜底
 *   （重复 chmod 安全；缺权限直接抛 posix_spawnp failed）
 */

import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { IPty } from 'node-pty';
import { spawn as ptySpawn } from 'node-pty';
import type { AgentEvent, GenericPtyConfig, UploadedAttachmentRef } from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';
import { IdleDetector, PtyOutputBuffer, stripAnsi } from './ansi-parser';

const ADAPTER_ID_GENERIC_PTY = 'generic-pty';
const ADAPTER_ID_AIDER = 'aider';

/** SIGTERM 后等多久再 SIGKILL（仿 SDK fallback 等待）。 */
const KILL_GRACE_MS = 10_000;

/** 用户首条 user message 渲染长度上限（与 codex-cli sdk-bridge 同 100KB）。 */
const MAX_FIRST_PROMPT_BYTES = 100_000;

interface PtySessionState {
  /** node-pty IPty 实例 */
  pty: IPty;
  /** 持久化的 spawn config（重启后 resume 用；当下 F2 没用 resume，留给未来） */
  config: GenericPtyConfig;
  /** sessions 表 cwd（用于 emit session-start payload） */
  cwd: string;
  /** SIGTERM 后调度的 SIGKILL timer（close 时清；session-end 时清） */
  killTimer: NodeJS.Timeout | null;
  /** 标记本 session 已被显式 close（区分 user-initiated close 与子进程自然 exit） */
  intentionallyClosed: boolean;
  /** F3：环形 buffer，保留最近 stripped stdout，给 promptSuffixRegex 二次校验用 */
  outputBuffer: PtyOutputBuffer;
  /** F3：idle 检测器；onData 时 reset、close 时 dispose */
  idleDetector: IdleDetector;
  /**
   * F3：去重 waiting-for-user emit。idle timer 触发后置 true，下次 onData 复位
   * （避免连续 idle / promptSuffix 反复 match 同一段静默生成多条 waiting-for-user 事件）。
   */
  idleEmitted: boolean;
}

export interface GenericPtyBridgeOptions {
  /**
   * 适配器 id（注入由哪个 adapter own 本 bridge）。
   * - 'generic-pty'：用户自定义命令，要求 createSession 入参传 genericPtyConfig
   * - 'aider'：固定 'aider' preset（adapter 层兜底；用户也可在 NewSessionDialog 微调 args）
   *
   * 写入 emit 的 agentId + sessionRepo.upsert 的 agent_id；watcher 反查
   * adapterRegistry.get(agentId) 时也用此 id 找回正确 adapter。
   */
  adapterId: 'generic-pty' | 'aider';

  /**
   * 当 createSession 入参 genericPtyConfig === undefined 时的 fallback config。
   * - aider adapter 注入 GENERIC_PTY_PRESETS 里的 'aider' preset config
   * - generic-pty adapter 注入 undefined → createSession 直接 throw "missing config"
   */
  fallbackConfig: GenericPtyConfig | null;

  /** AgentEvent 派发回调（adapter init 时由 ctx.emit 注入）。 */
  emit: (event: AgentEvent) => void;
}

export interface CreatePtySessionInput {
  cwd: string;
  prompt?: string;
  /** 可选用户配置；undefined → 用 bridge.fallbackConfig（aider）；null → throw（generic-pty） */
  genericPtyConfig?: GenericPtyConfig;
  /** 与其他 adapter 接口对齐；PTY 不支持 attachments（无概念），传了静默忽略 */
  attachments?: UploadedAttachmentRef[];
}

export class GenericPtyBridge {
  private sessions = new Map<string, PtySessionState>();
  /** spawn-helper 权限兜底单飞标记（多次 createSession 不重复 chmod）。 */
  private spawnHelperReady = false;

  constructor(private readonly opts: GenericPtyBridgeOptions) {}

  /**
   * 起一个新 PTY session。返回 sessionId（randomUUID）。
   *
   * 启动顺序：
   * 1. 解析 effective config（入参优先 / fallback 兜底）
   * 2. 解析 effective cwd（config.cwd 优先 / 入参 cwd 兜底 / homedir 兜底）
   * 3. spawn-helper 权限兜底（lazy，only first time）
   * 4. node-pty.spawn → 拿 IPty
   * 5. 注册 onData / onExit listener
   * 6. emit session-start（同步触发 ingest → sessionRepo.upsert 建 record）
   * 7. setGenericPtyConfig UPDATE 持久化 config
   * 8. emit 首条 user message（如有 prompt）
   * 9. 把 prompt 写进 stdin（让 CLI 实际看到）
   *
   * 失败：spawn 抛错 → throw 不留 PtySessionState；caller 负责回滚 attachments。
   */
  async createSession(input: CreatePtySessionInput): Promise<{ sessionId: string }> {
    const config = input.genericPtyConfig ?? this.opts.fallbackConfig;
    if (!config) {
      throw new Error(
        `[generic-pty:${this.opts.adapterId}] missing genericPtyConfig (no fallback for adapter)`,
      );
    }
    if (!config.command || config.command.trim().length === 0) {
      throw new Error(`[generic-pty:${this.opts.adapterId}] config.command must be non-empty`);
    }

    // 入参 prompt 大小校验（与 IPC 层 100KB 一致；这里 defense-in-depth 防 IPC bypass）
    if (input.prompt && Buffer.byteLength(input.prompt, 'utf8') > MAX_FIRST_PROMPT_BYTES) {
      throw new Error(
        `[generic-pty:${this.opts.adapterId}] prompt > ${MAX_FIRST_PROMPT_BYTES} bytes`,
      );
    }

    // cwd 兜底链：config.cwd（用户指定）→ input.cwd（IPC 入参）→ homedir
    const cwd =
      (config.cwd && config.cwd.trim()) || (input.cwd && input.cwd.trim()) || homedir();

    await this.ensureSpawnHelperExecutable();

    const env = { ...process.env, ...config.env } as Record<string, string>;

    let pty: IPty;
    try {
      pty = ptySpawn(config.command, config.args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd,
        env,
      });
    } catch (err) {
      throw new Error(
        `[generic-pty:${this.opts.adapterId}] spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const sessionId = randomUUID();
    const outputBuffer = new PtyOutputBuffer();
    const idleDetector = new IdleDetector({
      idleQuietMs: config.idleQuietMs,
      promptSuffixRegex: config.promptSuffixRegex,
      onIdle: () => {
        const s = this.sessions.get(sessionId);
        if (!s || s.idleEmitted || s.intentionallyClosed) return;
        s.idleEmitted = true;
        this.opts.emit({
          sessionId,
          agentId: this.opts.adapterId,
          kind: 'waiting-for-user',
          payload: { source: 'pty-idle' },
          ts: Date.now(),
          source: 'sdk',
        });
      },
    });
    const state: PtySessionState = {
      pty,
      config,
      cwd,
      killTimer: null,
      intentionallyClosed: false,
      outputBuffer,
      idleDetector,
      idleEmitted: false,
    };
    this.sessions.set(sessionId, state);

    // emit session-start 同步派发 → ingest 创建 sessions row（agent_id = adapterId）
    this.opts.emit({
      sessionId,
      agentId: this.opts.adapterId,
      kind: 'session-start',
      payload: { cwd, source: 'sdk' },
      ts: Date.now(),
      source: 'sdk',
    });

    // 持久化 config 到 sessions.generic_pty_config（resume 路径用；F2 不做 resume，留给未来）
    // try/catch 兜底：DB 异常不应阻塞会话启动（与 codex bridge setCodexSandbox 同款防御）
    try {
      sessionRepo.setGenericPtyConfig(sessionId, config);
    } catch (err) {
      console.warn(
        `[generic-pty:${this.opts.adapterId}] setGenericPtyConfig(${sessionId}) 失败`,
        err,
      );
    }

    // 注册 stdout listener
    pty.onData((data: string) => {
      // F3：strip ANSI escape，避免 UI 渲染控制字符。push 进 buffer 给 idle 二次校验用。
      const stripped = stripAnsi(data);
      state.outputBuffer.push(stripped);
      // 收到新 chunk → 复位 idle emit dedup（让下次 idle 能再 emit）+ reset detector
      state.idleEmitted = false;
      state.idleDetector.onData(state.outputBuffer);
      this.opts.emit({
        sessionId,
        agentId: this.opts.adapterId,
        kind: 'message',
        payload: { text: stripped, role: 'assistant' },
        ts: Date.now(),
        source: 'sdk',
      });
    });

    // 注册 exit listener — 子进程结束时 emit session-end + 清理 state
    pty.onExit(({ exitCode, signal }) => {
      const reason = state.intentionallyClosed
        ? 'user-closed'
        : signal !== undefined && signal !== null && signal !== 0
          ? `signal=${signal}`
          : `exit=${exitCode ?? 0}`;
      this.opts.emit({
        sessionId,
        agentId: this.opts.adapterId,
        kind: 'session-end',
        payload: { reason },
        ts: Date.now(),
        source: 'sdk',
      });
      // 清理 idle detector + killTimer + 从 Map 移除
      state.idleDetector.dispose();
      if (state.killTimer) {
        clearTimeout(state.killTimer);
        state.killTimer = null;
      }
      this.sessions.delete(sessionId);
    });

    // 首条 user message：emit + 写 stdin
    if (input.prompt && input.prompt.length > 0) {
      this.opts.emit({
        sessionId,
        agentId: this.opts.adapterId,
        kind: 'message',
        payload: { text: input.prompt, role: 'user' },
        ts: Date.now(),
        source: 'sdk',
      });
      // PTY 行模式：必须以 \n 结尾让 CLI readline 收到完整一行
      pty.write(input.prompt.endsWith('\n') ? input.prompt : input.prompt + '\n');
    }

    return { sessionId };
  }

  /**
   * 写 stdin。attachments 静默忽略（PTY 没概念）。
   * - 与 receiveTeammateMessage 同实现（F-bonus 加 capabilities 后让 watcher 调）
   * - 不抛错也不返回成功 / 失败信号；UI / watcher 视 emit message 为「已送达」线索
   */
  async sendMessage(
    sessionId: string,
    text: string,
    _attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`[generic-pty:${this.opts.adapterId}] session ${sessionId} not found`);
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_FIRST_PROMPT_BYTES) {
      throw new Error(
        `[generic-pty:${this.opts.adapterId}] message > ${MAX_FIRST_PROMPT_BYTES} bytes`,
      );
    }
    // emit user message 让 UI 立即看到
    this.opts.emit({
      sessionId,
      agentId: this.opts.adapterId,
      kind: 'message',
      payload: { text, role: 'user' },
      ts: Date.now(),
      source: 'sdk',
    });
    state.pty.write(text.endsWith('\n') ? text : text + '\n');
  }

  /**
   * Ctrl+C ASCII (\x03) 中断当前命令。不杀子进程，PTY 仍存活。
   * 与 codex / claude SDK 的 interrupt 概念对齐（中断当前 turn，不关 session）。
   */
  async interrupt(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return; // session 不在了直接 noop（不抛错，与 codex/claude 同款）
    state.pty.write('\x03');
  }

  /**
   * 关闭 session：SIGTERM → 10s grace → SIGKILL 兜底 → onExit 清理 state。
   * 多次调用安全（已 closed 直接 noop）。
   */
  async closeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.intentionallyClosed) return; // 已 close 中，等 onExit 自然清
    state.intentionallyClosed = true;
    // F3：close 时立刻 dispose idle detector（避免 SIGTERM 后子进程未退期间还有迟到 chunk 触发 timer）
    state.idleDetector.dispose();
    try {
      state.pty.kill('SIGTERM');
    } catch (err) {
      console.warn(`[generic-pty:${this.opts.adapterId}] SIGTERM ${sessionId} 失败`, err);
    }
    // 10s 后兜底 SIGKILL（与 R3 进程 cleanup 节奏对齐）
    state.killTimer = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return; // 已被 onExit 清掉
      try {
        s.pty.kill('SIGKILL');
      } catch (err) {
        console.warn(`[generic-pty:${this.opts.adapterId}] SIGKILL ${sessionId} 失败`, err);
      }
    }, KILL_GRACE_MS);
    // 注：不在此 await onExit；caller 不需要等子进程实际退出（emit session-end 异步触发）
  }

  /** 进程级 cleanup：app shutdown 时调，SIGKILL 所有未关 session（best-effort）。 */
  async shutdownAll(): Promise<void> {
    for (const [sid, state] of this.sessions) {
      state.intentionallyClosed = true;
      state.idleDetector.dispose();
      if (state.killTimer) clearTimeout(state.killTimer);
      try {
        state.pty.kill('SIGKILL');
      } catch (err) {
        console.warn(`[generic-pty:${this.opts.adapterId}] shutdown SIGKILL ${sid} 失败`, err);
      }
    }
    this.sessions.clear();
  }

  /**
   * spawn-helper 权限兜底（CLAUDE.md「打包配置已踩的坑」同款 native binding 处理）。
   *
   * node-pty 1.1.0 在 darwin/linux 走 `prebuilds/<platform>-<arch>/spawn-helper` 这个
   * 独立二进制做 posix_spawnp。pnpm install 拷贝时 hard-link 可能丢 +x 位（实测 -rw-r--r--）
   * → posix_spawnp failed。这里 lazy chmod 0o755 兜底，多次 createSession 只跑一次。
   *
   * 失败不抛（设为 best-effort）：如果 helper 真不存在 / 权限重置失败，spawn 路径会报
   * posix_spawnp failed，由 createSession throw 包装传上层。
   */
  private async ensureSpawnHelperExecutable(): Promise<void> {
    if (this.spawnHelperReady) return;
    this.spawnHelperReady = true; // 单飞 + 失败也置位（避免每次 spawn 都 chmod）
    try {
      // node-pty native binding 路径：与 lib/utils.js 内 native.dir + '/spawn-helper' 同款。
      // require.resolve('node-pty') 拿 lib/index.js 路径；上回到包根；拼 prebuilds/<platform>-<arch>。
      const ptyEntry = require.resolve('node-pty');
      const ptyPkgRoot = path.resolve(path.dirname(ptyEntry), '..');
      const helperPath = path.join(
        ptyPkgRoot,
        'prebuilds',
        `${process.platform}-${process.arch}`,
        'spawn-helper',
      );
      // app.asar.unpacked 路径替换（打包后 asar 内 binary 不能跑，必须 unpack）
      const unpackedPath = helperPath
        .replace('app.asar', 'app.asar.unpacked')
        .replace('node_modules.asar', 'node_modules.asar.unpacked');
      await fsp.chmod(unpackedPath, 0o755).catch(() => {
        // 路径不存在（其他平台 / 未打包）→ silent
      });
    } catch (err) {
      // require.resolve 失败 / 路径拼错 → silent
      console.warn(`[generic-pty:${this.opts.adapterId}] ensureSpawnHelperExecutable 失败`, err);
    }
  }

  // ──────────── 测试 / 调试便利方法（非接口）────────────

  /** vitest 用：只读快照。 */
  __debugSessionCount(): number {
    return this.sessions.size;
  }

  /** vitest 用：只读获取 session 状态。 */
  __debugGetSession(sessionId: string): PtySessionState | undefined {
    return this.sessions.get(sessionId);
  }
}

// adapter id 常量导出（adapter index.ts / 测试用）
export { ADAPTER_ID_GENERIC_PTY, ADAPTER_ID_AIDER };
