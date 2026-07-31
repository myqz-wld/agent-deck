import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makeSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('@main/adapters/claude-code/sdk-loader', () =>
  makeSdkLoaderMock(),
);

import { registerAgentDeckToolDefinitions } from '../server';
import { buildAgentDeckTools, type AgentDeckToolDefinition } from '../tools';
import { structuredOk } from '../tools/helpers';
import {
  EXIT_WORKTREE_SCHEMA,
  ENTER_WORKTREE_SCHEMA,
  ENTER_WORKTREE_OUTPUT_SCHEMA,
  EXIT_WORKTREE_OUTPUT_SCHEMA,
} from '../tools/schemas';

const ENTER_ACCEPTANCE_SENTENCE =
  'A success with `state: "waiting-tool-result"` is durable asynchronous acceptance, not proof that the current turn already runs in the worktree.';
const EXIT_ACCEPTANCE_SENTENCE =
  'An active structured lease is required. Success with `state: "waiting-tool-result"` accepts the reverse transition; it does not mean the worktree was already removed.';

describe('worktree MCP contract drift', () => {
  it('publishes automatic next-turn semantics and strict success schemas', async () => {
    const tools = await buildAgentDeckTools({
      callerSessionIdOverride: () => 'session-a',
      transport: 'in-process',
      adapterId: 'codex-cli',
    });
    const enter = tools.find((tool) => tool.name === 'enter_worktree');
    const exit = tools.find((tool) => tool.name === 'exit_worktree');
    expect(enter?.outputSchema).toBe(ENTER_WORKTREE_OUTPUT_SCHEMA);
    expect(exit?.outputSchema).toBe(EXIT_WORKTREE_OUTPUT_SCHEMA);
    expect(enter?.description).toContain(
      'Success state `waiting-tool-result` is asynchronous acceptance',
    );
    expect(enter?.description).toContain(
      'applies the worktree cwd to runtime and database',
    );
    expect(enter?.description).toContain(
      'creates the directory with `git worktree add --detach`',
    );
    expect(enter?.description).toContain(
      'never creates, switches, renames, or deletes a branch or other ref',
    );
    expect(enter?.description).toContain('30-second');
    expect(enter?.description).toContain('10-minute timeout');
    expect(enter?.description).toContain(
      'may remain as an empty directory after a later failure',
    );
    expect(ENTER_WORKTREE_SCHEMA.startPoint.description).toContain(
      'resolves it once in the caller repository',
    );
    const enterInputSchema = z.object(ENTER_WORKTREE_SCHEMA).strict();
    expect(enterInputSchema.safeParse({ startPoint: 'HEAD' }).success).toBe(
      true,
    );
    expect(enterInputSchema.safeParse({ startPoint: 'HEAD', unexpected: true }).success).toBe(false);
    expect(enter?.description).not.toContain(
      'does not change the SDK session cwd',
    );
    expect(exit?.description).toContain(
      'restores and confirms runtime/database cwd',
    );
    expect(exit?.description).toContain(
      'second dirty check immediately before removal',
    );
    expect(exit?.description).toContain(
      'never creates, renames, switches, or deletes Git branches or other refs',
    );
    expect(exit?.description).toContain(
      'branch changes do not block exit',
    );
    expect(exit?.description).toContain(
      'rejects an unreferenced HEAD commit',
    );
    expect(exit?.description).toContain(
      'caller without an active lease is rejected',
    );
    expect(exit?.description).toContain('`completed-cleanup`');
    expect(EXIT_WORKTREE_SCHEMA.discardChanges.description).toContain(
      'does not bypass lease/path/repository/reference checks or the durable-HEAD check',
    );

    const enterPayload = {
      transitionId: 'session-a:2',
      direction: 'enter',
      state: 'waiting-tool-result',
      effectiveFrom: 'automatic-next-turn',
      worktreePath: '/repo/worktree',
      startCommit: 'a'.repeat(40),
      headMode: 'detached',
    } as const;
    const exitPayload = {
      transitionId: 'session-a:2',
      direction: 'exit',
      state: 'completed-cleanup',
      effectiveFrom: 'already-effective',
      worktreePath: '/repo/worktree',
      worktreeRemoved: true,
    } as const;
    expect(ENTER_WORKTREE_OUTPUT_SCHEMA.safeParse(enterPayload).success).toBe(
      true,
    );
    expect(EXIT_WORKTREE_OUTPUT_SCHEMA.safeParse(exitPayload).success).toBe(
      true,
    );
    expect(
      EXIT_WORKTREE_OUTPUT_SCHEMA.safeParse({
        transitionId: 'session-a:3',
        direction: 'exit',
        state: 'waiting-tool-result',
        effectiveFrom: 'automatic-next-turn',
        worktreePath: '/repo/detached-worktree',
      }).success,
    ).toBe(true);
    for (const invalidPayload of [
      {
        transitionId: 'session-a:3',
        direction: 'exit',
        state: 'waiting-tool-result',
        effectiveFrom: 'already-effective',
        worktreePath: '/repo/detached-worktree',
      },
      {
        transitionId: 'session-a:3',
        direction: 'exit',
        state: 'waiting-tool-result',
        effectiveFrom: 'automatic-next-turn',
        worktreePath: '/repo/detached-worktree',
        worktreeRemoved: false,
      },
      {
        transitionId: 'session-a:3',
        direction: 'exit',
        state: 'completed-cleanup',
        effectiveFrom: 'automatic-next-turn',
        worktreePath: '/repo/detached-worktree',
        worktreeRemoved: true,
      },
      {
        transitionId: 'session-a:3',
        direction: 'exit',
        state: 'completed-cleanup',
        effectiveFrom: 'already-effective',
        worktreePath: '/repo/detached-worktree',
      },
    ]) {
      expect(EXIT_WORKTREE_OUTPUT_SCHEMA.safeParse(invalidPayload).success).toBe(
        false,
      );
    }
    const response = structuredOk(enterPayload);
    expect(response.structuredContent).toEqual(enterPayload);
    expect(response.content).toEqual([]);
  });

  it('publishes and validates exit results through the real MCP SDK', async () => {
    const waitingPayload = {
      transitionId: 'session-a:4',
      direction: 'exit',
      state: 'waiting-tool-result',
      effectiveFrom: 'automatic-next-turn',
      worktreePath: '/repo/detached-worktree',
    } as const;
    const server = new McpServer({
      name: 'worktree-output-contract-test',
      version: '1.0.0',
    });
    const tool = {
      name: 'exit_worktree_contract_test',
      description: 'Exercise the exit_worktree success output contract.',
      inputSchema: {},
      outputSchema: EXIT_WORKTREE_OUTPUT_SCHEMA,
      handler: async () => structuredOk(waitingPayload),
    } satisfies AgentDeckToolDefinition;
    registerAgentDeckToolDefinitions(server, [tool]);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: 'worktree-output-contract-test',
      version: '1.0.0',
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const registered = listed.tools.find(
        (candidate) => candidate.name === tool.name,
      );
      expect(registered?.outputSchema).toMatchObject({ type: 'object' });
      expect(registered?.outputSchema?.properties).toMatchObject({
        state: {
          enum: ['waiting-tool-result', 'completed-cleanup'],
        },
      });

      const result = await client.callTool({
        name: tool.name,
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(waitingPayload);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it('keeps Claude and Codex bundled instructions aligned without manual-cwd advice', () => {
    const root = process.cwd();
    const codex = readFileSync(
      resolve(root, 'resources/codex-config/CODEX_AGENTS.md'),
      'utf8',
    );
    const claude = readFileSync(
      resolve(root, 'resources/claude-config/CLAUDE.md'),
      'utf8',
    );
    const grok = readFileSync(
      resolve(root, 'resources/grok-config/GROK_AGENTS.md'),
      'utf8',
    );
    for (const instructions of [codex, claude]) {
      expect(instructions).toContain(ENTER_ACCEPTANCE_SENTENCE);
      expect(instructions).toContain(EXIT_ACCEPTANCE_SENTENCE);
      expect(instructions).toContain(
        'one internal continuation before any user input buffered during the transition',
      );
      expect(instructions).toContain(
        'full worktree lease including its original cwd',
      );
      expect(instructions).not.toContain(
        'MCP does not change the Codex SDK cwd',
      );
      expect(instructions).not.toContain(
        'After entering the worktree, point read/write commands',
      );
      expect(instructions).toContain(
        'Agent Deck resolves it once to `startCommit` and creates the worktree with detached HEAD',
      );
      expect(instructions).toContain(
        'neither worktree MCP tool mutates refs',
      );
    }
    expect(grok).toContain(
      '`exit_worktree` requires the caller\'s active structured lease',
    );
    expect(grok).toContain('creates only a detached worktree');
    expect(grok).not.toContain(
      'entering a worktree does not change the current process directory',
    );
  });
});
