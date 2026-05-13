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
 *
 * CHANGELOG_82 Step 3.1 Tier 2 拆分：原 pty-bridge.ts (506 行) 拆为：
 * - pty-bridge/index.ts (本文件) — class facade + createSession 主体
 * - pty-bridge/pty-session-state.ts — type/常量
 * - pty-bridge/spawn-helper.ts — chmod 兜底（promise 单飞 state 仍在 class 内）
 * - pty-bridge/lifecycle.ts — closeSession + shutdownAll
 * - pty-bridge/message-io.ts — sendMessage + interrupt + onData/onExit listener factory
 *
 * 外部 caller import 路径不变（`from './pty-bridge'` / `'../generic-pty/pty-bridge'`），
 * TS module resolution 自动透传到本 index.ts。
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { IPty } from 'node-pty';
import { spawn as ptySpawn } from 'node-pty';
import type { UploadedAttachmentRef } from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';
import { IdleDetector, PtyOutputBuffer } from '../ansi-parser';
import { PtyFileWatcher } from '../file-watcher';
import {
  ADAPTER_ID_AIDER,
  ADAPTER_ID_GENERIC_PTY,
  MAX_PROMPT_LENGTH,
  type CreatePtySessionInput,
  type GenericPtyBridgeOptions,
  type PtySessionState,
} from './pty-session-state';
import { chmodSpawnHelper } from './spawn-helper';
import { closeSessionImpl, shutdownAllImpl } from './lifecycle';
import {
  interruptImpl,
  makeExitListener,
  makeStdoutListener,
  sendMessageImpl,
} from './message-io';

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

    // 注册 stdout / exit listener（factory 见 message-io.ts）
    pty.onData(makeStdoutListener(state, sessionId, this.opts));
    pty.onExit(makeExitListener(this.sessions, state, sessionId, this.opts));

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

  /** 写 stdin。详 message-io.ts 文档。 */
  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    return sendMessageImpl(this.sessions, this.opts, sessionId, text, attachments);
  }

  /** Ctrl+C ASCII 中断。详 message-io.ts 文档。 */
  async interrupt(sessionId: string): Promise<void> {
    return interruptImpl(this.sessions, sessionId);
  }

  /** SIGTERM → 10s grace → SIGKILL 兜底。详 lifecycle.ts 文档。 */
  async closeSession(sessionId: string): Promise<void> {
    return closeSessionImpl(this.sessions, this.opts, sessionId);
  }

  /** 进程级 cleanup（app shutdown 用）。详 lifecycle.ts 文档。 */
  async shutdownAll(): Promise<void> {
    return shutdownAllImpl(this.sessions, this.opts);
  }

  /**
   * spawn-helper 权限兜底 facade（promise 单飞）。
   *
   * 实际 chmod 实现拆到 spawn-helper.ts；本 facade 保留 spawnHelperReady promise 单飞
   * 状态（class-instance scoped），多次 createSession 共享同一 promise 等待。
   */
  private async ensureSpawnHelperExecutable(): Promise<void> {
    if (!this.spawnHelperReady) {
      this.spawnHelperReady = chmodSpawnHelper(this.opts.adapterId);
    }
    await this.spawnHelperReady;
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

// adapter id 常量 + sub-module type 透传 re-export（外部 caller 仍用 `from './pty-bridge'`）
export { ADAPTER_ID_AIDER, ADAPTER_ID_GENERIC_PTY };
export type { CreatePtySessionInput, GenericPtyBridgeOptions, PtySessionState };
