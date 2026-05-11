/**
 * Generic-PTY 适配器（R4·F2 实装 + F-bonus canCollaborate）。
 *
 * 用 node-pty 包装任意 stdin/stdout-only CLI（用户自定义命令 / args / env / cwd）。
 * 通过 ANSI 解析与 idle 检测推断状态（F3），文件改动通过 chokidar（F4）。
 *
 * Capabilities：
 * - canCreateSession / canSendMessage / canInterrupt / canCloseSession：true（PTY 支持）
 * - canCollaborate：true（F-bonus：实装 receiveTeammateMessage = sendMessage，
 *   让 universal team backend 能把跨 adapter 消息塞进 PTY stdin）
 * - canRespondPermission / canSetPermissionMode / canInstallHooks / canRestartWith*：false（无概念）
 *
 * 与 aider adapter 的关系（plan §F-bonus 选项 B 落地）：共享 GenericPtyBridge class，
 * 但各自 own 一个 instance。本 adapter 不接 fallback config（强制用户传 genericPtyConfig），
 * aider adapter 注入 'aider' preset 作为 fallback。
 */

import type { AgentAdapter, AdapterContext, CreateSessionOptions } from '../types';
import type { UploadedAttachmentRef } from '@shared/types';
import { ADAPTER_ID_GENERIC_PTY, GenericPtyBridge } from './pty-bridge';

class GenericPtyAdapterImpl implements AgentAdapter {
  id = ADAPTER_ID_GENERIC_PTY;
  displayName = 'Generic PTY';
  capabilities = {
    canCreateSession: true,
    canInterrupt: true,
    canSendMessage: true,
    canInstallHooks: false,
    canRespondPermission: false,
    canSetPermissionMode: false,
    canRestartWithPermissionMode: false,
    canRestartWithCodexSandbox: false,
    canCloseSession: true,
    // R4·F-bonus：universal team backend 接收 cross-adapter 消息（receiveTeammateMessage =
    // sendMessage 透传给 stdin write，与 claude-code / codex-cli 同模式）
    canCollaborate: true,
  };

  private bridge: GenericPtyBridge | null = null;

  async init(ctx: AdapterContext): Promise<void> {
    this.bridge = new GenericPtyBridge({
      adapterId: 'generic-pty',
      // generic-pty 没有 fallback：用户必须传 genericPtyConfig，否则 createSession throw
      fallbackConfig: null,
      emit: ctx.emit,
    });
  }

  async shutdown(): Promise<void> {
    if (this.bridge) {
      await this.bridge.shutdownAll();
    }
  }

  async createSession(opts: CreateSessionOptions): Promise<string> {
    if (!this.bridge) throw new Error('generic-pty adapter not initialized');
    const result = await this.bridge.createSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      genericPtyConfig: opts.genericPtyConfig,
      attachments: opts.attachments,
    });
    return result.sessionId;
  }

  async interruptSession(sessionId: string): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.interrupt(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.closeSession(sessionId);
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    if (!this.bridge) throw new Error('generic-pty adapter not initialized');
    await this.bridge.sendMessage(sessionId, text, attachments);
  }

  /**
   * R4·F-bonus：receiveTeammateMessage = 调本 adapter 的 sendMessage（与 claude-code /
   * codex-cli 同模式）。watcher 已在 body 里拼好 `[from <displayName> @ <adapterId>]` 前缀，
   * 直接透传给 stdin write 即可。fromMemberId 仅用于 logging。
   */
  async receiveTeammateMessage(
    sessionId: string,
    _fromMemberId: string,
    body: string,
  ): Promise<void> {
    if (!this.bridge) throw new Error('generic-pty adapter not initialized');
    await this.bridge.sendMessage(sessionId, body);
  }
}

export const genericPtyAdapter: AgentAdapter = new GenericPtyAdapterImpl();
