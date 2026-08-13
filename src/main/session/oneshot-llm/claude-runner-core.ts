import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClaudeThinkingLevel } from '@shared/session-metadata';
import { raceWithTimeout } from './race-with-timeout';

export interface ClaudeOneshotOptions {
  cwd: string;
  prompt: string;
  model?: string;
  effort?: ClaudeThinkingLevel;
  systemPrompt: string;
  settingsPath?: string;
  timeoutMs: number;
  timeoutErrorMessage: string;
  signal?: AbortSignal;
}

interface ClaudeOneshotQuery extends AsyncIterable<unknown> {
  interrupt?: () => Promise<unknown>;
}

export interface ClaudeOneshotHost {
  readonly loadSdk: () => Promise<{
    query(input: Record<string, unknown>): ClaudeOneshotQuery;
  }>;
  readonly runtimeOptions: () => {
    executable: 'node';
    env: Record<string, string | undefined>;
  };
  readonly resolveBinary: () => string | undefined | null;
  readonly createIsolatedCwd?: () => string;
}

/** Host-neutral no-tool Claude oneshot shared by Desktop and Server Core. */
export async function runClaudeOneshotWithHost(
  opts: ClaudeOneshotOptions,
  host: ClaudeOneshotHost,
): Promise<string> {
  const sdk = await host.loadSdk();
  const runtime = host.runtimeOptions();
  const claudeBinary = host.resolveBinary();
  const isolatedCwd = host.createIsolatedCwd?.() ??
    mkdtempSync(join(tmpdir(), 'agent-deck-periodic-summary-'));
  try {
    const q = sdk.query({
      prompt: opts.prompt,
      options: {
        cwd: isolatedCwd,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        permissionMode: 'dontAsk',
        systemPrompt: opts.systemPrompt,
        settingSources: [],
        ...(opts.settingsPath ? { settings: opts.settingsPath } : {}),
        tools: [],
        mcpServers: {},
        maxTurns: 1,
        executable: runtime.executable,
        env: { ...runtime.env },
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      },
    });
    return await raceWithTimeout({
      work: consumeClaudeQuery(q),
      timeoutMs: opts.timeoutMs,
      errorMessage: opts.timeoutErrorMessage,
      onTimeout: () => { void q.interrupt?.().catch(() => undefined); },
      signal: opts.signal,
      onAbort: () => { void q.interrupt?.().catch(() => undefined); },
    });
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

async function consumeClaudeQuery(q: AsyncIterable<unknown>): Promise<string> {
  let result = '';
  for await (const message of q) {
    const value = message as {
      type: string;
      message?: { content?: { type: string; text?: string }[] };
    };
    if (value.type === 'assistant' && value.message?.content) {
      for (const block of value.message.content) {
        if (block.type === 'text' && block.text) result += block.text;
      }
    }
    if (value.type === 'result') break;
  }
  return result;
}
