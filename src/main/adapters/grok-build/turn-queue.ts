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
import { flushGrokTextUpdates, translateGrokUsage } from './translate';

const MAX_PENDING_MESSAGES = 20;

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

  enqueue(
    runtime: GrokRuntime,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: GrokEnqueueOptions,
  ): void {
    if (text.length > MAX_USER_MESSAGE_LENGTH) {
      throw new Error(
        `单条消息 ${text.length.toLocaleString()} 字符超过 ${MAX_USER_MESSAGE_LENGTH.toLocaleString()} 字符上限。`,
      );
    }
    if (runtime.closed || runtime.sealed) {
      throw new Error(`Grok session ${runtime.applicationSessionId} is closing.`);
    }
    if (
      !options?.bypassQueueLimit &&
      runtime.queue.length + (runtime.running ? 1 : 0) >= MAX_PENDING_MESSAGES
    ) {
      throw new Error(`待发送队列已堆积 ${MAX_PENDING_MESSAGES} 条，请等当前 turn 完成。`);
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
      return;
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
    runtime.queue.push(message);
    if (key && fingerprint) {
      rememberAcceptedEnqueue(runtime.acceptedEnqueueFingerprints, key, fingerprint);
    }
    if (!message.deferUserEventUntilTurnStart) this.emitUserMessage(runtime, message);
    void this.drain(runtime);
  }

  async drain(runtime: GrokRuntime): Promise<void> {
    if (runtime.running || runtime.closed) return;
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
      if (usageEvent) this.options.emit(usageEvent);
      this.options.emitEvent(runtime.applicationSessionId, 'finished', {
        ok: response.stopReason === 'end_turn',
        subtype: response.stopReason,
      });
    } catch (error) {
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

  private emitUserMessage(runtime: GrokRuntime, message: GrokPendingMessage): void {
    this.options.emitEvent(runtime.applicationSessionId, 'message', {
      text: message.text,
      role: 'user',
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
  return (
    runtime.process?.initializeResponse.agentCapabilities?.promptCapabilities?.image === true
  );
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
