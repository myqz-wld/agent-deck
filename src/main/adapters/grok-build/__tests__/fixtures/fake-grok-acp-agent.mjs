import { Readable, Writable } from 'node:stream';
import {
  PROTOCOL_VERSION,
  agent,
  methods,
  ndJsonStream,
} from '@agentclientprotocol/sdk';

const sessions = new Set();
const sessionModes = new Map();
const authArg = process.argv.find((arg) => arg.startsWith('--auth='));
const authIds = authArg
  ? authArg.slice('--auth='.length).split(',').filter(Boolean)
  : [];
const failAuthArg = process.argv.find((arg) => arg.startsWith('--fail-auth='));
const failAuthIds = new Set(
  failAuthArg
    ? failAuthArg.slice('--fail-auth='.length).split(',').filter(Boolean)
    : [],
);
let authenticated = authIds.length === 0;

function authMethod(id) {
  return {
    id,
    name: id,
    ...(id === 'xai.api_key' ? { type: 'env_var', vars: [] } : {}),
  };
}

agent({ name: 'fake-grok-acp-agent' })
  .onRequest(methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: true,
      },
    },
    ...(authIds.length > 0
      ? { authMethods: authIds.map(authMethod) }
      : {}),
    agentInfo: { name: 'fake-grok-acp-agent', version: '1.0.0' },
    _meta: { modelState: { currentModelId: 'fake-model' } },
  }))
  .onRequest(methods.agent.authenticate, ({ params }) => {
    if (!authIds.includes(params.methodId)) {
      throw new Error(`unsupported auth method ${params.methodId}`);
    }
    if (failAuthIds.has(params.methodId)) {
      throw new Error(`rejected auth method ${params.methodId}`);
    }
    authenticated = true;
    return {};
  })
  .onRequest(methods.agent.session.new, ({ params }) => {
    if (!authenticated) throw new Error('authenticate must run before session/new');
    const sessionId =
      typeof params._meta?.fakeSessionId === 'string'
        ? params._meta.fakeSessionId
        : 'fake-native-session';
    sessions.add(sessionId);
    sessionModes.set(sessionId, 'default');
    return {
      sessionId,
      models: { currentModelId: 'fake-model', availableModels: [] },
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
          { id: 'ask', name: 'Ask' },
        ],
      },
    };
  })
  .onRequest(methods.agent.session.load, ({ params }) => {
    if (!authenticated) throw new Error('authenticate must run before session/load');
    sessions.add(params.sessionId);
    return {};
  })
  .onRequest(methods.agent.session.prompt, async (context) => {
    if (!sessions.has(context.params.sessionId)) {
      throw new Error(`unknown session ${context.params.sessionId}`);
    }
    const text = context.params.prompt
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    await context.client.notify(methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'fake thought' },
      },
    });
    if (text.includes('permission')) {
      const response = await context.client.request(
        methods.client.session.requestPermission,
        {
          sessionId: context.params.sessionId,
          toolCall: {
            toolCallId: 'fake-permission-tool',
            title: 'Fake permission tool',
            rawInput: { path: '/tmp/fake' },
          },
          options: [
            { kind: 'allow_once', name: 'Allow once', optionId: 'allow' },
            { kind: 'reject_once', name: 'Reject once', optionId: 'reject' },
          ],
        },
      );
      await context.client.notify(methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text:
              response.outcome.outcome === 'selected'
                ? `permission:${response.outcome.optionId}`
                : 'permission:cancelled',
          },
        },
      });
    } else {
      await context.client.notify(methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `echo:${text}` },
        },
      });
    }
    return {
      stopReason: 'end_turn',
      usage: {
        totalTokens: 12,
        inputTokens: 7,
        outputTokens: 5,
        thoughtTokens: 2,
      },
    };
  })
  .onRequest(
    'session/set_model',
    (params) => params,
    ({ params }) => ({
      modelId: params.modelId,
      reasoningEffort: params._meta?.reasoningEffort ?? null,
    }),
  )
  .onRequest(methods.agent.session.setMode, ({ params }) => {
    if (!sessions.has(params.sessionId)) {
      throw new Error(`unknown session ${params.sessionId}`);
    }
    sessionModes.set(params.sessionId, params.modeId);
    return {};
  })
  .onNotification(methods.agent.session.cancel, () => undefined)
  .connect(
    ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin),
    ),
  );
