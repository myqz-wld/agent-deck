import { randomUUID } from 'node:crypto';

import { methods, type SessionUpdate } from '@agentclientprotocol/sdk';
import type { PendingAgentMessage } from '@main/adapters/types';
import {
  enqueuePayloadFingerprint,
  isAcceptedEnqueueRetry,
  rememberAcceptedEnqueue,
} from '@main/adapters/enqueue-idempotency';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import type { UploadedAttachmentRef } from '@shared/types';

import type { GrokExtensionNotification, GrokPromptCompleteNotification } from './extension';
import { GrokLivePromptCompletion } from './live-prompt-completion';
import { errorText } from './protocol-utils';
import { GrokFirstModelEventWatchdog } from './first-model-event-watchdog';
import { applyRecoveredGrokTurn, GrokProviderCompletionRecovery } from './provider-completion-recovery';
import type { GrokPendingMessage, GrokRuntime, GrokSubmittingMessage } from './runtime-types';
import {
  handleGrokTurnFailure,
  resolveGrokSessionCommand,
} from './session-command-feedback';
import { grokTurnBoundaryBlocked, prepareGrokNextTurn } from './turn-boundary';
import { finalizeGrokAcpResponse, responseFromGrokLiveOutcome } from './turn-response';
import type {
  GrokEnqueueOptions, GrokInterjectRequest, GrokTurnQueueOptions, PreparedGrokMessage,
} from './turn-queue-types';
import { beginGrokTurn, clearGrokTurnLiveRate, flushGrokTextUpdates } from './translate';
import {
  isCancelled,
  isInterjectionUnsupported,
  promptBlocks,
  requireNativeSession,
  supportsImages,
  toPendingAgentMessage,
} from './turn-queue-helpers';

const MAX_PENDING_MESSAGES = 20;
const GROK_INTERJECT_METHOD = 'x.ai/interject';
const GROK_INTERJECT_WIRE_METHOD = `_${GROK_INTERJECT_METHOD}`;

export class GrokTurnQueue {
  private readonly firstModelEventWatchdog: GrokFirstModelEventWatchdog;
  private readonly livePromptCompletion = new GrokLivePromptCompletion();
  private readonly providerCompletionRecovery: GrokProviderCompletionRecovery;

  constructor(private readonly options: GrokTurnQueueOptions) {
    const diagnostics = options.runtimeHost?.diagnostics;
    this.firstModelEventWatchdog =
      new GrokFirstModelEventWatchdog(
        options.firstModelEventTimeoutMs,
        diagnostics,
      );
    this.providerCompletionRecovery = new GrokProviderCompletionRecovery({
      diagnostics,
      pollMs: options.providerCompletionPollMs,
      root: options.providerHistoryRoot,
    });
  }

  observeModelActivity(runtime: GrokRuntime, update: SessionUpdate): void {
    this.firstModelEventWatchdog.observe(runtime, update);
  }

  observePromptComplete(
    runtime: GrokRuntime,
    notification: GrokPromptCompleteNotification | GrokExtensionNotification,
  ): void {
    if (!this.livePromptCompletion.observe(runtime, notification)) return;
    this.firstModelEventWatchdog.clear(runtime);
  }

  async send(
    runtime: GrokRuntime,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: GrokEnqueueOptions,
  ): Promise<void> {
    const prepared = this.prepareMessage(runtime, text, attachments, options);
    if (!prepared) return;

    if (
      runtime.running &&
      runtime.ready &&
      runtime.interjectionSupported !== false &&
      !runtime.submittingMessage
    ) {
      if (this.startInterject(runtime, prepared)) return;
    }
    this.enqueuePrepared(runtime, prepared);
  }

  enqueue(
    runtime: GrokRuntime,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: GrokEnqueueOptions,
  ): void {
    const prepared = this.prepareMessage(runtime, text, attachments, options);
    if (!prepared) return;
    this.enqueuePrepared(runtime, prepared);
  }

  async steer(runtime: GrokRuntime, text: string, attachments?: UploadedAttachmentRef[]): Promise<void> {
    if (!runtime.running || !runtime.ready || runtime.closed) {
      throw new Error('Grok Build 当前没有可插入内容的活动轮次。');
    }
    const prepared = this.prepareMessage(runtime, text, attachments);
    if (!prepared) return;
    if (runtime.submittingMessage) {
      throw new Error('当前 Grok Build 消息仍在提交，请稍后再试。');
    }
    if (!this.startInterject(runtime, prepared)) {
      throw new Error('当前 Grok Build 版本不支持活动轮次插入。');
    }
  }

  listPendingOutgoingMessages(runtime: GrokRuntime): PendingAgentMessage[] {
    const queued = runtime.queue.flatMap((message) => {
      const pending = toPendingAgentMessage(message);
      return pending ? [pending] : [];
    });
    const submitting = runtime.submittingMessage;
    const current = submitting?.status !== 'cancelled'
      ? toPendingAgentMessage(submitting?.message)
      : null;
    return current ? [current, ...queued] : queued;
  }

  async removePendingOutgoingMessage(
    runtime: GrokRuntime,
    messageId: string,
  ): Promise<PendingAgentMessage | null> {
    const index = runtime.queue.findIndex(
      (message) => toPendingAgentMessage(message)?.id === messageId,
    );
    if (index >= 0) {
      const [removed] = runtime.queue.splice(index, 1);
      return toPendingAgentMessage(removed);
    }
    const submitting = runtime.submittingMessage;
    const pending = toPendingAgentMessage(submitting?.message);
    if (
      !submitting ||
      pending?.id !== messageId ||
      submitting.status !== 'submitting'
    ) return null;
    if (submitting.kind === 'interject') {
      submitting.status = 'cancelled';
      submitting.requestController?.abort();
      if (runtime.submittingMessage === submitting) runtime.submittingMessage = null;
      void this.drain(runtime);
      return pending;
    }
    submitting.status = 'cancelling';
    if (!submitting.promptRequestIssued) {
      submitting.status = 'cancelled';
      return pending;
    }
    try {
      await runtime.process?.connection.agent.notify(methods.agent.session.cancel, {
        sessionId: requireNativeSession(runtime),
      });
    } catch (error) {
      if (runtime.submittingMessage === submitting) submitting.status = 'submitting';
      throw error;
    }
    if (runtime.submittingMessage !== submitting || submitting.status !== 'cancelling') {
      return null;
    }
    submitting.status = 'cancelled';
    return pending;
  }

  confirmPromptAccepted(runtime: GrokRuntime): void {
    const submitting = runtime.submittingMessage;
    if (!submitting || submitting.kind !== 'prompt' || submitting.status === 'cancelled') return;
    runtime.submittingMessage = null;
    if (!submitting.message.suppressUserEvent) this.emitUserMessage(runtime, submitting.message);
  }

  cancelSubmittingInterjection(runtime: GrokRuntime): void {
    const submitting = runtime.submittingMessage;
    if (!submitting || submitting.kind !== 'interject') return;
    submitting.status = 'cancelled';
    submitting.requestController?.abort();
    if (runtime.submittingMessage === submitting) runtime.submittingMessage = null;
    void this.drain(runtime);
  }

  private prepareMessage(
    runtime: GrokRuntime,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: GrokEnqueueOptions,
  ): PreparedGrokMessage | null {
    if (text.length > MAX_USER_MESSAGE_LENGTH) {
      throw new Error(
        `单条消息 ${text.length.toLocaleString()} 字符超过 ${MAX_USER_MESSAGE_LENGTH.toLocaleString()} 字符上限。`,
      );
    }
    if (runtime.closed || runtime.sealed) {
      throw new Error(`Grok Build 会话 ${runtime.applicationSessionId} 正在关闭。`);
    }
    if (attachments?.length && !supportsImages(runtime)) {
      throw new Error(
        '当前 Grok Build ACP 会话未声明图片输入能力。请升级 Grok Build；当 initialize 返回 image=true 后，Agent Deck 会自动开放附件。',
      );
    }
    if (!text.trim() && !attachments?.length) {
      throw new Error('消息文本和图片附件不能同时为空。');
    }

    const key = options?.idempotencyKey;
    const fingerprint = key ? enqueuePayloadFingerprint(text, attachments) : null;
    if (
      key &&
      fingerprint &&
      isAcceptedEnqueueRetry(runtime.acceptedEnqueueFingerprints, key, fingerprint)
    ) {
      return null;
    }
    const message: GrokPendingMessage = {
      id: randomUUID(),
      text,
      ...(attachments?.length
        ? { attachments: attachments.map((attachment) => ({ ...attachment })) }
        : {}),
      ...(options?.handOff ? { handOff: options.handOff } : {}),
      ...(options?.providerText ? { providerText: options.providerText } : {}),
      ...(options?.continuation ? { continuation: options.continuation } : {}),
      ...(options?.deferUserEventUntilTurnStart
        ? { deferUserEventUntilTurnStart: true }
        : {}),
      ...(options?.turnCorrelationId
        ? { turnCorrelationId: options.turnCorrelationId }
        : {}),
      ...(options?.userEventAlreadyPersisted ? { suppressUserEvent: true } : {}),
    };
    return {
      message,
      idempotencyKey: key,
      fingerprint,
      bypassQueueLimit: options?.bypassQueueLimit,
    };
  }

  private enqueuePrepared(runtime: GrokRuntime, prepared: PreparedGrokMessage): void {
    const { message } = prepared;
    if (
      !prepared.bypassQueueLimit &&
      runtime.queue.length + (runtime.running ? 1 : 0) >= MAX_PENDING_MESSAGES
    ) {
      throw new Error(
        `待发送队列已堆积 ${MAX_PENDING_MESSAGES} 条，请等待当前轮次完成。`,
      );
    }
    runtime.queue.push(message);
    this.rememberAccepted(runtime, prepared);
    if (!message.deferUserEventUntilTurnStart && !message.suppressUserEvent) this.emitUserMessage(runtime, message);
    void this.drain(runtime);
  }

  private rememberAccepted(runtime: GrokRuntime, prepared: PreparedGrokMessage): void {
    if (prepared.idempotencyKey && prepared.fingerprint) {
      rememberAcceptedEnqueue(
        runtime.acceptedEnqueueFingerprints,
        prepared.idempotencyKey,
        prepared.fingerprint,
      );
    }
  }

  private startInterject(runtime: GrokRuntime, prepared: PreparedGrokMessage): boolean {
    if (runtime.interjectionSupported === false || !runtime.process || runtime.submittingMessage) {
      return false;
    }
    const submission: GrokSubmittingMessage = {
      message: prepared.message,
      status: 'submitting',
      promptRequestIssued: false,
      kind: 'interject',
      requestController: new AbortController(),
    };
    runtime.submittingMessage = submission;
    this.rememberAccepted(runtime, prepared);
    void this.runInterject(runtime, submission);
    return true;
  }

  private async runInterject(
    runtime: GrokRuntime,
    submission: GrokSubmittingMessage,
  ): Promise<void> {
    const { message } = submission;
    try {
      const content = await promptBlocks(message.providerText ?? message.text, message.attachments);
      if (runtime.submittingMessage !== submission || isCancelled(submission)) return;
      submission.promptRequestIssued = true;
      await runtime.process!.connection.agent.request<
        { status?: string },
        GrokInterjectRequest
      >(
        GROK_INTERJECT_WIRE_METHOD,
        {
          sessionId: requireNativeSession(runtime),
          text: message.text,
          interjectionId: message.id,
          content,
        },
        { cancellationSignal: submission.requestController!.signal },
      );
      if (runtime.submittingMessage !== submission || isCancelled(submission)) return;
      runtime.interjectionSupported = true;
      runtime.submittingMessage = null;
      this.emitUserMessage(runtime, message, true);
      void this.drain(runtime);
    } catch (error) {
      if (runtime.submittingMessage !== submission || runtime.closed) return;
      runtime.submittingMessage = null;
      if (isCancelled(submission)) return;
      if (isInterjectionUnsupported(error)) {
        runtime.interjectionSupported = false;
        try {
          this.enqueuePrepared(runtime, {
            message,
            fingerprint: null,
          });
        } catch (fallbackError) {
          this.emitEventError(runtime, fallbackError);
        }
        return;
      }
      this.emitEventError(runtime, error);
      void this.drain(runtime);
    }
  }

  async drain(runtime: GrokRuntime): Promise<void> {
    if (grokTurnBoundaryBlocked(runtime)) return;
    if (
      this.options.beforeNextTurn &&
      !await prepareGrokNextTurn(runtime, this.options)
    ) return;
    const message = runtime.queue.shift();
    if (!message) {
      if (runtime.sealed) await this.options.closeSession(runtime.applicationSessionId);
      return;
    }
    runtime.running = true;
    runtime.interruptRequested = false;
    const sessionCommand = resolveGrokSessionCommand(runtime, message.text);
    const currentTurnController = new AbortController();
    runtime.currentTurnController = currentTurnController;
    let recycleTransport = false;
    const submitting: GrokSubmittingMessage | null = message.deferUserEventUntilTurnStart
      ? {
          message,
          status: 'submitting',
          promptRequestIssued: false,
          kind: 'prompt',
        }
      : null;
    runtime.submittingMessage = submitting;
    try {
      const blocks = await promptBlocks(
        message.providerText ?? message.text,
        message.attachments,
      );
      if (isCancelled(submitting)) return;
      if (message.attachments?.length && !supportsImages(runtime)) {
        throw new Error(
          '当前 Grok Build ACP 会话未声明图片输入能力。请升级 Grok Build；当 initialize 返回 image=true 后，Agent Deck 会自动开放附件。',
        );
      }
      beginGrokTurn(
        runtime.translation,
        runtime.applicationSessionId,
        runtime.model,
        message.id,
      );
      if (submitting) submitting.promptRequestIssued = true;
      const outcome = await this.providerCompletionRecovery.run(
        runtime,
        () => this.livePromptCompletion.run(runtime, (turnId) =>
          this.firstModelEventWatchdog.run(
            runtime,
            () => runtime.process!.connection.agent.request(
              methods.agent.session.prompt,
              {
                sessionId: requireNativeSession(runtime),
                prompt: blocks,
                _meta: { turnId },
              },
              { cancellationSignal: currentTurnController.signal },
            ),
          )),
      );
      if (isCancelled(submitting)) return;
      if (outcome.kind === 'native-history') {
        if (submitting) this.confirmPromptAccepted(runtime);
        runtime.ready = false;
        runtime.suppressUpdates = true;
        this.firstModelEventWatchdog.clear(runtime);
        currentTurnController.abort();
        applyRecoveredGrokTurn(runtime, outcome.turn, this.options);
        recycleTransport = true;
        return;
      }
      const response = responseFromGrokLiveOutcome(
        runtime,
        outcome.value,
        { ...this.options, sessionCommand },
      );
      if (outcome.value.kind === 'prompt-complete') {
        runtime.ready = false;
        runtime.suppressUpdates = true;
        currentTurnController.abort();
        recycleTransport = true;
      }
      await finalizeGrokAcpResponse(
        runtime,
        response,
        { ...this.options, sessionCommand },
      );
      clearGrokTurnLiveRate(runtime.translation);
    } catch (error) {
      clearGrokTurnLiveRate(runtime.translation);
      await handleGrokTurnFailure({
        runtime,
        error,
        submitting,
        sessionCommand,
        options: this.options,
        flushText: () => this.flushText(runtime),
      });
    } finally {
      if (runtime.currentTurnController === currentTurnController) {
        runtime.currentTurnController = null;
      }
      runtime.interruptRequested = false;
      if (runtime.submittingMessage === submitting) runtime.submittingMessage = null;
      runtime.running = false;
      if (runtime.sealed) {
        await this.options.closeSession(runtime.applicationSessionId);
      } else if (recycleTransport) {
        await this.options.recycleRuntime(runtime);
      } else {
        void this.drain(runtime);
      }
    }
  }

  private emitUserMessage(
    runtime: GrokRuntime,
    message: GrokPendingMessage,
    steer = false,
  ): void {
    this.options.emitEvent(runtime.applicationSessionId, 'message', {
      text: message.text,
      role: 'user',
      ...(steer ? { steer: true } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(message.handOff ? { handOff: message.handOff } : {}),
      ...(message.continuation
        ? {
            messageOrigin: 'continuation',
            continuation: { ...message.continuation },
          }
        : {}),
      ...(message.turnCorrelationId
        ? { turnCorrelationId: message.turnCorrelationId }
        : {}),
    });
  }

  private flushText(runtime: GrokRuntime): void {
    for (const event of flushGrokTextUpdates(
      runtime.applicationSessionId,
      runtime.translation,
    )) {
      this.options.emit(event);
    }
  }

  private emitEventError(runtime: GrokRuntime, error: unknown): void {
    this.options.emitEvent(runtime.applicationSessionId, 'message', {
      text: `⚠ Grok Build 插入失败：${errorText(error)}`,
      error: true,
    });
  }
}
