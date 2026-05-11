/**
 * Generic-PTY 适配器（R4·F2 实装）。
 *
 * 用 node-pty 包装任意 stdin/stdout-only CLI（用户自定义命令 / args / env / cwd）。
 * 通过 ANSI 解析与 idle 检测推断状态（F3 加），文件改动通过 chokidar（F4 加）。
 *
 * Capabilities：
 * - canCreateSession / canSendMessage / canInterrupt / canCloseSession：true（PTY 支持）
 * - canCollaborate：false（F-bonus 加 receiveTeammateMessage 后改 true）
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
    // F-bonus 加 receiveTeammateMessage 后改 true
    canCollaborate: false,
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
}

export const genericPtyAdapter: AgentAdapter = new GenericPtyAdapterImpl();
