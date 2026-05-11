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
import { PtyFileWatcher } from './file-watcher';

const ADAPTER_ID_GENERIC_PTY = 'generic-pty';
const ADAPTER_ID_AIDER = 'aider';

/** SIGTERM 后等多久再 SIGKILL（仿 SDK fallback 等待）。 */
const KILL_GRACE_MS = 10_000;

/**
 * 单条消息 / 首条 prompt 长度上限。
 *
 * REVIEW_24 HIGH-2：与 `agent-deck-message-repo.ts:44` 的 MAX_BODY_LENGTH (102_400 char)
 * 对齐 — universal-message-watcher 入队校验是 `body.length > MAX_BODY_LENGTH`，
 * 投递时 wireBody = `[from xxx]\n` + body 长度还会增加。如果 bridge 端用 byteLength
 * 100_000 校验（旧 R4 落地），CJK / 接近 ASCII 上限的 cross-adapter message 会在
 * watcher 入队 OK 但 bridge 端 throw → markFailed 重试 3 次都同样失败。改 `.length`
 * 与 messageRepo 对齐（PTY 写 stdin 是 char-based 不挑 byte）。
 *
 * 注意：claude-code / codex-cli adapter 的 sendMessage cap 仍是 byteLength 100_000
 * （constants.ts），是 R3 系统性遗留，本轮 R4 不改 R3 老 adapter。Follow-up 应统一所有
 * adapter cap 与 messageRepo 一致，详 reviews/REVIEW_24.md HIGH-2 节。
 */
const MAX_PROMPT_LENGTH = 102_400;

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
  /** F4：cwd 文件改动 watcher；close 时必 await 关闭释放 fs handle */
  fileWatcher: PtyFileWatcher;
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
  /**
   * spawn-helper 权限兜底单飞（REVIEW_24 MED-Claude5：promise 单飞替代 boolean）。
   *
   * 之前 boolean 实现：`if (ready) return; ready = true; await chmod(...)` —— 但 await
   * 之前已置位 → race window：A 进 chmod 期间 B 看到 ready=true 直接 return → B 的 ptySpawn
   * 可能在 A chmod 完成前跑（spawn-helper 可能仍无 +x）。改用 promise 单飞：第一个 caller
   * 创建 promise，后续 caller 都 await 同一个 promise，确保 chmod 完成后才返回。
   * promise 失败也保留（resolved status 即可），避免每次 spawn 都重 chmod。
   */
  private spawnHelperReady: Promise<void> | null = null;

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

    // 入参 prompt 长度校验（与 messageRepo cap 对齐 102_400 char；REVIEW_24 HIGH-2 修）
    if (input.prompt && input.prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(
        `[generic-pty:${this.opts.adapterId}] prompt > ${MAX_PROMPT_LENGTH} chars`,
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
    // F4：cwd file watcher（fire-and-forget start；close 时必 await）
    const fileWatcher = new PtyFileWatcher({
      cwd,
      sessionId,
      adapterId: this.opts.adapterId,
      emit: this.opts.emit,
    });
    void fileWatcher.start(); // 不阻塞 createSession（chokidar fsevents init 是异步）
    const state: PtySessionState = {
      pty,
      config,
      cwd,
      killTimer: null,
      intentionallyClosed: false,
      outputBuffer,
      idleDetector,
      idleEmitted: false,
      fileWatcher,
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
      // 清理 idle detector + killTimer + 从 Map 移除；F4 fileWatcher.close 异步触发但
      // 不 await（onExit 是 sync callback，不能 await；R3 老 team-watcher 在 SDK shutdown
      // 链路里 await 因为是 promise chain，这里 PTY exit 是 native callback 不是 promise，
      // void close() fire-and-forget；shutdownAll / closeSession 路径仍 await）。
      state.idleDetector.dispose();
      void state.fileWatcher.close();
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
   *
   * REVIEW_24 MED-Claude4：closeSession 后窗口期内仍有 sendMessage / receiveTeammateMessage
   * 进来 — 之前 state 还在 Map（要等 onExit 异步清），会 emit 一条 user message 然后
   * pty.write 撞到 SIGTERM 后的 PTY 触发 broken pipe → throw → watcher retry 3 次都同款失败 →
   * markFailed reason=EIO（不准）。修法：sendMessage 顶部检查 intentionallyClosed，立刻
   * throw 让 watcher 走 retry → state 清后下次 retry 拿 'session not found' markFailed
   * reason 准确，且节省 3 次 retry quota。
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
    if (state.intentionallyClosed) {
      throw new Error(
        `[generic-pty:${this.opts.adapterId}] session ${sessionId} is closing`,
      );
    }
    if (text.length > MAX_PROMPT_LENGTH) {
      throw new Error(
        `[generic-pty:${this.opts.adapterId}] message > ${MAX_PROMPT_LENGTH} chars`,
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
   *
   * REVIEW_24 codex MED 1：先 SIGTERM 让 kernel 立即开始 grace；fileWatcher.close
   * 改 fire-and-forget（不阻塞 close 主流程）。**之前** await watcher 在 SIGTERM 之前 →
   * watcher close 慢 / throw 时 SIGTERM 路径不可达，违背关闭契约。
   *
   * REVIEW_24 codex MED 2：设 killTimer 前 check sessions Map 还在（onExit 在
   * SIGTERM ↔ killTimer 设置之间同步触发可能已 delete）。否则 killTimer 引用已脱离
   * Map 的 state，会额外持 event loop 直到 10s grace 到（虽然不影响正确性，是 leak）。
   *
   * shutdownAll 仍保持 await all watcher.close（process exit 时必须释放 fs handle）。
   */
  async closeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.intentionallyClosed) return; // 已 close 中，等 onExit 自然清
    state.intentionallyClosed = true;
    // F3：close 时立刻 dispose idle detector（避免 SIGTERM 后子进程未退期间还有迟到 chunk 触发 timer）
    state.idleDetector.dispose();
    // codex MED 1：先 SIGTERM 让 kernel 立刻开始 grace（不被 watcher close 阻塞）
    try {
      state.pty.kill('SIGTERM');
    } catch (err) {
      console.warn(`[generic-pty:${this.opts.adapterId}] SIGTERM ${sessionId} 失败`, err);
    }
    // codex MED 2：onExit 可能已在 SIGTERM 同步路径里 fire 并 delete sessions[sid]
    // → 此处 sessions.has() check 防止 killTimer 引用已脱离 Map 的 state 多挂 10s
    if (this.sessions.has(sessionId)) {
      state.killTimer = setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (!s) return; // 已被 onExit 清掉
        try {
          s.pty.kill('SIGKILL');
        } catch (err) {
          console.warn(`[generic-pty:${this.opts.adapterId}] SIGKILL ${sessionId} 失败`, err);
        }
      }, KILL_GRACE_MS);
    }
    // F4 + codex MED 1：fileWatcher.close fire-and-forget（不阻塞 closeSession 返回；
    // fs handle 释放是异步关，对业务无影响。shutdownAll 路径仍 await 所有 close 兜底）。
    void state.fileWatcher.close().catch((err) => {
      console.warn(
        `[generic-pty:${this.opts.adapterId}] fileWatcher.close ${sessionId} 失败`,
        err,
      );
    });
    // 注：不在此 await onExit；caller 不需要等子进程实际退出（emit session-end 异步触发）
  }

  /**
   * 进程级 cleanup：app shutdown 时调，SIGKILL 所有未关 session（best-effort）。
   * F4：并发 await 所有 fileWatcher.close（释放 fs handle 是退出关键）。
   */
  async shutdownAll(): Promise<void> {
    const closeTasks: Promise<void>[] = [];
    for (const [sid, state] of this.sessions) {
      state.intentionallyClosed = true;
      state.idleDetector.dispose();
      if (state.killTimer) clearTimeout(state.killTimer);
      try {
        state.pty.kill('SIGKILL');
      } catch (err) {
        console.warn(`[generic-pty:${this.opts.adapterId}] shutdown SIGKILL ${sid} 失败`, err);
      }
      closeTasks.push(
        state.fileWatcher.close().catch((err) => {
          console.warn(
            `[generic-pty:${this.opts.adapterId}] shutdown fileWatcher.close ${sid} 失败`,
            err,
          );
        }),
      );
    }
    await Promise.all(closeTasks);
    this.sessions.clear();
  }

  /**
   * spawn-helper 权限兜底（CLAUDE.md「打包配置已踩的坑」同款 native binding 处理）。
   *
   * node-pty 1.1.0 在 darwin/linux 走 `prebuilds/<platform>-<arch>/spawn-helper` 这个
   * 独立二进制做 posix_spawnp。pnpm install 拷贝时 hard-link 可能丢 +x 位（实测 -rw-r--r--）
   * → posix_spawnp failed。这里 promise 单飞 chmod 0o755 兜底，多次 createSession 共享同一
   * promise 等待（REVIEW_24 MED-Claude5 修：boolean → promise 单飞消除 race window）。
   *
   * 失败不抛（设为 best-effort）：如果 helper 真不存在 / 权限重置失败，spawn 路径会报
   * posix_spawnp failed，由 createSession throw 包装传上层。
   */
  private async ensureSpawnHelperExecutable(): Promise<void> {
    if (!this.spawnHelperReady) {
      this.spawnHelperReady = this.chmodSpawnHelper();
    }
    await this.spawnHelperReady;
  }

  private async chmodSpawnHelper(): Promise<void> {
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
      // REVIEW_24 MED-Claude3：用 regex 锚定路径段（与 sdk-runtime.ts:87 同款）替代裸
      // String.replace。裸 replace 的 case 2/3 误匹配：`app.asar.unpacked` → `app.asar.unpacked.unpacked`、
      // 用户路径含 `app.asar` 子串如 `/Users/foo/my-app.asar.fork/...` → `/Users/foo/my-app.asar.unpacked.fork/...`。
      const unpackedPath = helperPath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
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
