import { describe, expect, it } from 'vitest';
import {
  CodexAppServerClient,
  type CodexAppServerNotification,
  type CodexAppServerUserInput,
} from '../../app-server/client';
import type { JsonObject, JsonValue } from '../../app-server/protocol';
import type { CodexThreadOptions } from '../thread-options-builder';
import {
  buildForkedFirstTurnInput,
  buildForkInstructionReset,
} from './instruction-reset';

describe('Codex fork reset first-model-request capture', () => {
  it.each([
    {
      transition: 'generic to agent',
      inherited: 'Inherited generic source instructions',
      target: 'Target Agent Deck baseline\n\nTarget custom agent',
      expected: 'Target custom agent',
    },
    {
      transition: 'agent to generic',
      inherited: 'Inherited source Agent A instructions',
      target: undefined,
      expected: 'no effective target developer instructions',
    },
    {
      transition: 'agent A to agent B',
      inherited: 'Inherited source Agent A instructions',
      target: 'Target Agent Deck baseline\n\nTarget Agent B instructions',
      expected: 'Target Agent B instructions',
    },
  ])(
    '$transition places the reset after inherited instructions in the first /responses input',
    async ({ inherited, target, expected }) => {
      const client = new CapturingAppServerClient(inherited);
      const options = threadOptions(target);
      const fork = await client.forkThread('source-thread', 'terminal-turn', options);
      await client.injectThreadItems(fork.thread.id, [buildForkInstructionReset(target)]);
      const child = client.adoptThread(fork.thread.id, options);
      await child.run(buildForkedFirstTurnInput(
        [{ type: 'text', text: 'current source request', text_elements: [] }],
        'delegated child task',
      ));

      expect(client.rpcMethods).toEqual([
        'thread/fork',
        'thread/inject_items',
        'turn/start',
      ]);
      expect(client.responsesRequests).toHaveLength(1);
      const firstRequest = client.responsesRequests[0];
      const developerTexts = readMessageTexts(firstRequest.input, 'developer');
      expect(developerTexts[0]).toBe(inherited);
      expect(developerTexts.at(-1)).toContain('historical context only');
      expect(developerTexts.at(-1)).toContain('superseded for this child');
      expect(developerTexts.at(-1)).toContain(expected);
      const userTexts = readMessageTexts(firstRequest.input, 'user');
      expect(userTexts).toContain('current source request');
      expect(userTexts.some((text) => text.includes('child delegation boundary'))).toBe(true);
      expect(userTexts).toContain('delegated child task');
    },
  );
});

interface CapturedResponsesRequest {
  input: JsonValue[];
}

class CapturingAppServerClient extends CodexAppServerClient {
  readonly rpcMethods: string[] = [];
  readonly responsesRequests: CapturedResponsesRequest[] = [];
  private readonly historyByThread = new Map<string, JsonValue[]>();

  constructor(inheritedDeveloperInstructions: string) {
    super({ env: {}, config: null });
    this.historyByThread.set('source-thread', [developerMessage(inheritedDeveloperInstructions)]);
  }

  override get isProcessAlive(): boolean {
    return true;
  }

  override request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.rpcMethods.push(method);
    const object = params as JsonObject;
    if (method === 'thread/fork') {
      const source = String(object.threadId);
      this.historyByThread.set('child-thread', [
        ...(this.historyByThread.get(source) ?? []),
      ]);
      return resolved<T>({
        thread: { id: 'child-thread', forkedFromId: source, turns: [] },
      });
    }
    if (method === 'thread/inject_items') {
      const threadId = String(object.threadId);
      this.historyByThread.get(threadId)?.push(...((object.items as JsonValue[]) ?? []));
      return resolved<T>({});
    }
    if (method === 'turn/start') {
      const threadId = String(object.threadId);
      const turnId = 'child-turn';
      const input = object.input as CodexAppServerUserInput[];
      this.responsesRequests.push({
        input: [
          ...(this.historyByThread.get(threadId) ?? []),
          userMessage(input),
        ],
      });
      queueMicrotask(() => {
        this.dispatchForTest({
          method: 'turn/started',
          params: { threadId, turn: { id: turnId } },
        });
        this.dispatchForTest({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId } },
        });
      });
      return resolved<T>({ turn: { id: turnId } });
    }
    throw new Error(`Unexpected fake app-server method: ${method}`);
  }

  private dispatchForTest(notification: CodexAppServerNotification): void {
    const dispatch = (this as unknown as {
      dispatchNotification(value: CodexAppServerNotification): void;
    }).dispatchNotification;
    dispatch.call(this, notification);
  }
}

function threadOptions(developerInstructions: string | undefined): CodexThreadOptions {
  return {
    workingDirectory: '/repo',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    ...(developerInstructions ? { developerInstructions } : {}),
  };
}

function developerMessage(text: string): JsonValue {
  return {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text }],
  };
}

function userMessage(input: CodexAppServerUserInput[]): JsonValue {
  return {
    type: 'message',
    role: 'user',
    content: input.map((item) => item.type === 'text'
      ? { type: 'input_text', text: item.text }
      : { type: 'input_item', item: item as unknown as JsonValue }),
  };
}

function readMessageTexts(input: JsonValue[], role: string): string[] {
  return input.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    if (item.role !== role || !Array.isArray(item.content)) return [];
    return item.content.flatMap((content) => {
      if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
      return typeof content.text === 'string' ? [content.text] : [];
    });
  });
}

function resolved<T>(value: unknown): Promise<T> {
  return Promise.resolve(value as T);
}
