/**
 * Aider 适配器（R4·F-bonus 实装）。
 *
 * 设计（plan §F-bonus 选项 B 落地）：
 * - 与 generic-pty adapter 共享 GenericPtyBridge class（PTY backend 同款）
 * - 各自 own 一个 bridge instance（sessionId Map 互不干扰，不存在 init 序耦合）
 * - 注入 'aider' preset (GENERIC_PTY_PRESETS[0]) 作为 fallback：用户可在 NewSessionDialog
 *   不传 genericPtyConfig 直接创建 aider session（与 generic-pty 强制传 config 不同 UX）
 *
 * Capabilities 与 generic-pty 完全相同（都走同一 bridge）；UI 暴露差异（adapter 下拉
 * 显示「Aider」vs「Generic PTY」+ NewSessionDialog 默认 preset）由 displayName / 默认
 * config 决定，不在 capabilities 上反映。
 *
 * 未来叠加 aider 专属逻辑（如 `.aider.input.history` 监听 / aider `/commands` 解析）
 * 可在本文件注入额外 listener，不影响 generic-pty 通用实现。
 */

import type { AgentAdapter, AdapterContext, CreateSessionOptions } from '../types';
import type { UploadedAttachmentRef } from '@shared/types';
import { GENERIC_PTY_PRESETS } from '@shared/types';
import { ADAPTER_ID_AIDER, GenericPtyBridge } from '../generic-pty/pty-bridge';

const AIDER_PRESET = GENERIC_PTY_PRESETS.find((p) => p.id === 'aider');
if (!AIDER_PRESET) {
  // 启动时校验：preset 列表必须含 'aider'，否则配置漂移（应在 zod schema / 单测覆盖）
  throw new Error('[aider-adapter] missing "aider" preset in GENERIC_PTY_PRESETS');
}

class AiderAdapterImpl implements AgentAdapter {
  id = ADAPTER_ID_AIDER;
  displayName = 'Aider';
  capabilities = {
    canCreateSession: true,
    canInterrupt: true,
    canSendMessage: true,
    canInstallHooks: false,
    canRespondPermission: false,
    canSetPermissionMode: false,
    canRestartWithPermissionMode: false,
    canRestartWithCodexSandbox: false,
    canRestartWithClaudeCodeSandbox: false,
    canCloseSession: true,
    // R4·F-bonus：universal team backend 接收 cross-adapter 消息（与 generic-pty 同款）
    canCollaborate: true,
    // REVIEW_35 HIGH-D2：PTY 写 stdin 没法编码二进制 → 静默丢图，UI 必须 gate 入口
    canAcceptAttachments: false,
  };

  private bridge: GenericPtyBridge | null = null;

  async init(ctx: AdapterContext): Promise<void> {
    this.bridge = new GenericPtyBridge({
      adapterId: 'aider',
      // aider 默认 fallback：'aider' preset config（命令 'aider' + --no-stream + --no-pretty
      // + idleQuietMs 3000 + promptSuffixRegex '\\>\\s*$'）。用户可在 NewSessionDialog
      // 用 opts.genericPtyConfig 覆盖。
      fallbackConfig: AIDER_PRESET!.config,
      emit: ctx.emit,
    });
  }

  async shutdown(): Promise<void> {
    if (this.bridge) {
      await this.bridge.shutdownAll();
    }
  }

  async createSession(opts: CreateSessionOptions): Promise<string> {
    if (!this.bridge) throw new Error('aider adapter not initialized');
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
    if (!this.bridge) throw new Error('aider adapter not initialized');
    await this.bridge.sendMessage(sessionId, text, attachments);
  }

  /**
   * R4·F-bonus：receiveTeammateMessage = sendMessage（与 generic-pty / claude-code /
   * codex-cli 同模式）。watcher 已在 body 里拼好前缀。
   */
  async receiveTeammateMessage(
    sessionId: string,
    _fromMemberId: string,
    body: string,
  ): Promise<void> {
    if (!this.bridge) throw new Error('aider adapter not initialized');
    await this.bridge.sendMessage(sessionId, body);
  }
}

export const aiderAdapter: AgentAdapter = new AiderAdapterImpl();