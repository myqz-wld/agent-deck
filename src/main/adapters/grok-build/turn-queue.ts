import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  methods,
  type ContentBlock,
} from '@agentclientprotocol/sdk';
import type { AgentEnqueueOptions } from '@main/adapters/types';
import {
  enqueuePayloadFingerprint,
  isAcceptedEnqueueRetry,
  rememberAcceptedEnqueue,
} from '@main/adapters/enqueue-idempotency';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import type {
  AgentEvent,
  HandOffMetadata,
  UploadedAttachmentRef,
} from '@shared/types';

import { errorText } from './protocol-utils';
import type { GrokPendingMessage, GrokRuntime } from './runtime-types';
import {
  beginGrokTurn,
  clearGrokTurnLiveRate,
  completeGrokTurnLiveRate,
  flushGrokTextUpdates,
  translateGrokUsage,
  waitForGrokStandardUsage,
} from './translate';

const MAX_PENDING_MESSAGES = 20;
const GROK_INTERJECT_METHOD = 'x.ai/interject';
const GROK_INTERJECT_WIRE_METHOD = `_${GROK_INTERJECT_METHOD}`;

interface PreparedGrokMessage {
  message: GrokPendingMessage;
  idempotencyKey?: string;
  fingerprint: string | null;
  bypassQueueLimit?: boolean;
}

interface GrokInterjectRequest {
  sessionId: string;
  text: string;
  interjectionId: string;
  content: ContentBlock[];
}

export type GrokEnqueueOptions = AgentEnqueueOptions & {
  handOff?: HandOffMetadata;
  providerText?: string;
  continuation?: TrustedContinuationInitialTurn['metadata'];
};

interface GrokTurnQueueOptions {
  emit: (event: AgentEvent) => void;
  emitEvent: (sessionId: string, kind: AgentEvent['kind'], payload: unknown) => void;
  emitError: (sessionId: string, text: string) => void;
  closeSession: (sessionId: string) => Promise<void>;
}

export class GrokTurnQueue {
  constructor(private readonly options: GrokTurnQueueOptions) {}

  async send(
    runtime: GrokRuntime,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: GrokEnqueueOptions,
  ): Promise<void> {
    const prepared = this.prepareMessage(runtime, text, attachments, options);
    if (!prepared) return;

    if (runtime.running && runtime.ready && runtime.interjectionSupported !== false) {
      if (await this.tryInterject(runtime, prepared.message)) {
        this.rememberAccepted(runtime, prepared);
        this.emitUserMessage(runtime, prepared.message, true);
        return;
      }
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

  async steer(runtime: GrokRuntime, text: string): Promise<void> {
    if (!runtime.running || !runtime.ready || runtime.closed) {
      throw new Error('Grok 当前没有可插入的 active turn。');
    }
    const prepared = this.prepareMessage(runtime, text, undefined);
    if (!prepared) return;
    if (!(await this.tryInterject(runtime, prepared.message))) {
      throw new Error('当前 Grok Build 版本不支持 active-turn interjection。');
    }
    this.rememberAccepted(runtime, prepared);
    this.emitUserMessage(runtime, prepared.message, true);
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
      throw new Error(`Grok session ${runtime.applicationSessionId} is closing.`);
    }
    if (attachments?.length && !supportsImages(runtime)) {
      throw new Error(
        '当前 Grok ACP 会话未声明图片输入能力。请升级 Grok Build；当 initialize 返回 image=true 后，Agent Deck 会自动开放附件。',
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
      throw new Error(`待发送队列已堆积 ${MAX_PENDING_MESSAGES} 条，请等当前 turn 完成。`);
    }
    runtime.queue.push(message);
    this.rememberAccepted(runtime, prepared);
    if (!message.deferUserEventUntilTurnStart) this.emitUserMessage(runtime, message);
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

  private async tryInterject(
    runtime: GrokRuntime,
    message: GrokPendingMessage,
  ): Promise<boolean> {
    if (runtime.interjectionSupported === false || !runtime.process) return false;
    const content = await promptBlocks(message.providerText ?? message.text, message.attachments);
    try {
      await runtime.process.connection.agent.request<
        { status?: string },
        GrokInterjectRequest
      >(GROK_INTERJECT_WIRE_METHOD, {
        sessionId: requireNativeSession(runtime),
        text: message.text,
        interjectionId: message.id,
        content,
      });
      runtime.interjectionSupported = true;
      return true;
    } catch (error) {
      if (isInterjectionUnsupported(error)) {
        runtime.interjectionSupported = false;
        return false;
      }
      throw error;
    }
  }

  async drain(runtime: GrokRuntime): Promise<void> {
    if (runtime.running || runtime.closed || !runtime.ready) return;
    const message = runtime.queue.shift();
    if (!message) {
      if (runtime.sealed) await this.options.closeSession(runtime.applicationSessionId);
      return;
    }
    runtime.running = true;
    if (message.deferUserEventUntilTurnStart) this.emitUserMessage(runtime, message);
    try {
      const blocks = await promptBlocks(
        message.providerText ?? message.text,
        message.attachments,
      );
      if (message.attachments?.length && !supportsImages(runtime)) {
        throw new Error(
          '当前 Grok ACP 会话未声明图片输入能力。请升级 Grok Build；当 initialize 返回 image=true 后，Agent Deck 会自动开放附件。',
        );
      }
      beginGrokTurn(runtime.translation, runtime.applicationSessionId, runtime.model);
      const response = await runtime.process!.connection.agent.request(
        methods.agent.session.prompt,
        {
          sessionId: requireNativeSession(runtime),
          prompt: blocks,
        },
      );
      this.flushText(runtime);
      const usageEvent = translateGrokUsage(
        runtime.applicationSessionId,
        runtime.model,
        response.usage,
        runtime.translation,
      );
      if (usageEvent) {
        if (await waitForGrokStandardUsage(runtime.translation) && !runtime.closed) {
          this.options.emit(usageEvent);
          const payload = usageEvent.payload as { outputTokens?: unknown };
          completeGrokTurnLiveRate(
            runtime.translation,
            typeof payload.outputTokens === 'number' ? payload.outputTokens : 0,
          );
        }
      }
      clearGrokTurnLiveRate(runtime.translation);
      if (!runtime.closed) {
        this.options.emitEvent(runtime.applicationSessionId, 'finished', {
          ok: response.stopReason === 'end_turn',
          subtype: response.stopReason,
        });
      }
    } catch (error) {
      clearGrokTurnLiveRate(runtime.translation);
      if (!runtime.closed) {
        this.flushText(runtime);
        this.options.emitError(
          runtime.applicationSessionId,
          `Grok turn failed: ${errorText(error)}`,
        );
      }
    } finally {
      runtime.running = false;
      if (runtime.sealed) {
        await this.options.closeSession(runtime.applicationSessionId);
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
}

function supportsImages(runtime: GrokRuntime): boolean {
  if (!runtime.ready) return true;
  return (
    runtime.process?.initializeResponse.agentCapabilities?.promptCapabilities?.image === true
  );
}

function isInterjectionUnsupported(error: unknown): boolean {
  const candidate = error as { code?: unknown } | null;
  return candidate?.code === -32601 || /method not found/i.test(errorText(error));
}

function requireNativeSession(runtime: GrokRuntime): string {
  if (!runtime.nativeSessionId) {
    throw new Error(`Grok session ${runtime.applicationSessionId} has no native session id.`);
  }
  return runtime.nativeSessionId;
}

async function promptBlocks(
  text: string,
  attachments?: UploadedAttachmentRef[],
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const attachment of attachments ?? []) {
    blocks.push({
      type: 'image',
      data: (await readFile(attachment.path)).toString('base64'),
      mimeType: attachment.mime,
      uri: pathToFileURL(attachment.path).href,
    });
  }
  return blocks;
}
