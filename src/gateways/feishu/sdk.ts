import {
  Client,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  type Logger,
} from '@larksuiteoapi/node-sdk';
import type {
  FeishuOpenApiPort,
  FeishuSdkConnectionFactory,
  FeishuSdkConnectionPort,
  FeishuSdkEventHandlers,
} from './types';

export class OfficialFeishuOpenApi implements FeishuOpenApiPort {
  constructor(private readonly client: Client) {}

  reply(input: {
    messageId: string;
    content: string;
    messageType: 'interactive' | 'text';
    uuid: string;
  }) {
    return this.client.im.v1.message.reply({
      path: { message_id: input.messageId },
      data: {
        content: input.content,
        msg_type: input.messageType,
        uuid: input.uuid,
      },
    });
  }

  create(input: {
    chatId: string;
    content: string;
    messageType: 'interactive' | 'text';
    uuid: string;
  }) {
    return this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: input.chatId,
        content: input.content,
        msg_type: input.messageType,
        uuid: input.uuid,
      },
    });
  }

  patchCard(input: { messageId: string; content: string }) {
    return this.client.im.v1.message.patch({
      path: { message_id: input.messageId },
      data: { content: input.content },
    });
  }
}

class OfficialFeishuSdkConnection implements FeishuSdkConnectionPort {
  private readonly client: WSClient;

  constructor(
    appId: string,
    appSecret: string,
    logger: Logger,
    handshakeTimeoutMs: number,
    pingTimeoutSeconds: number,
    callbacks: Parameters<FeishuSdkConnectionFactory>[0],
  ) {
    this.client = new WSClient({
      appId,
      appSecret,
      logger,
      loggerLevel: LoggerLevel.error,
      autoReconnect: true,
      source: 'agent-deck-feishu',
      handshakeTimeoutMs,
      wsConfig: { pingTimeout: pingTimeoutSeconds },
      onReady: callbacks.onReady,
      onError: () => callbacks.onError(),
      onReconnecting: callbacks.onReconnecting,
      onReconnected: callbacks.onReconnected,
    });
  }

  async start(handlers: FeishuSdkEventHandlers): Promise<void> {
    const dispatcher = new EventDispatcher({
      logger: {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
      },
      loggerLevel: LoggerLevel.error,
    }).register({
      'im.message.receive_v1': async (data) => handlers.onMessage(data),
      'card.action.trigger': async (data: unknown) => handlers.onCardAction(data),
    });
    await this.client.start({ eventDispatcher: dispatcher });
  }

  close(force: boolean): void {
    this.client.close({ force });
  }
}

export function createOfficialFeishuOpenApi(
  appId: string,
  appSecret: string,
  logger: Logger,
): FeishuOpenApiPort {
  return new OfficialFeishuOpenApi(new Client({
    appId,
    appSecret,
    logger,
    loggerLevel: LoggerLevel.error,
    source: 'agent-deck-feishu',
  }));
}

export function createOfficialFeishuConnectionFactory(
  appId: string,
  appSecret: string,
  logger: Logger,
  handshakeTimeoutMs: number,
  pingTimeoutSeconds: number,
): FeishuSdkConnectionFactory {
  return (callbacks) => new OfficialFeishuSdkConnection(
    appId,
    appSecret,
    logger,
    handshakeTimeoutMs,
    pingTimeoutSeconds,
    callbacks,
  );
}
