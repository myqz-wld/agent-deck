import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildGrokHeadlessArgs,
  runGrokOneshot,
} from '../grok-runner';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-grok-headless.mjs', import.meta.url),
);
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Grok isolated oneshot runner', () => {
  it('builds a one-turn strict no-tool/no-memory command with model and effort passthrough', () => {
    const args = buildGrokHeadlessArgs({
      promptFile: '/tmp/prompt',
      sessionId: 'session-id',
      systemPrompt: 'system',
      model: 'fable',
      effort: 'xhigh',
      outputSchema: { type: 'object' },
    });

    expect(args).toEqual(expect.arrayContaining([
      '--tools',
      '',
      '--no-subagents',
      '--no-memory',
      '--disable-web-search',
      '--no-leader',
      '--max-turns',
      '1',
      '--permission-mode',
      'dontAsk',
      '--deny',
      'MCPTool',
      '--sandbox',
      'strict',
      '--model',
      'fable',
      '--reasoning-effort',
      'xhigh',
      '--json-schema',
      '{"type":"object"}',
    ]));
  });

  it('returns bounded JSON output and deletes only its generated ephemeral session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-grok-runner-test-'));
    tempRoots.push(root);
    const logPath = join(root, 'calls.jsonl');
    const result = await runGrokOneshot({
      prompt: 'summarize this evidence',
      systemPrompt: 'return text only',
      model: 'fable',
      effort: 'high',
      timeoutMs: 5_000,
      timeoutErrorMessage: 'timeout',
      testCommand: {
        binary: process.execPath,
        argsPrefix: [fixture],
      },
      envOverride: {
        FAKE_GROK_LOG: logPath,
        FAKE_GROK_RESPONSE: 'compact summary',
      },
    });

    expect(result).toEqual({
      text: 'compact summary',
      inputTokens: 13,
      outputTokens: 5,
      contextWindowTokens: 1_048_576,
      stopReason: 'EndTurn',
    });
    const calls = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        kind: string;
        sessionId: string;
        args?: string[];
        prompt?: string;
        hookEnv?: Record<string, string>;
      });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      kind: 'run',
      prompt: 'summarize this evidence',
      hookEnv: { origin: 'sdk', claude: '0', cursor: '0' },
    });
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      '--tools',
      '',
      '--sandbox',
      'strict',
      '--model',
      'fable',
      '--reasoning-effort',
      'high',
    ]));
    expect(calls[1]).toEqual({
      kind: 'delete',
      sessionId: calls[0]?.sessionId,
    });
  });

  it('terminates a timed-out child and still runs exact-session cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-grok-runner-timeout-'));
    tempRoots.push(root);
    const logPath = join(root, 'calls.jsonl');

    await expect(
      runGrokOneshot({
        prompt: 'slow',
        systemPrompt: 'system',
        timeoutMs: 20,
        timeoutErrorMessage: 'grok timeout',
        testCommand: {
          binary: process.execPath,
          argsPrefix: [fixture],
        },
        envOverride: {
          FAKE_GROK_LOG: logPath,
          FAKE_GROK_DELAY_MS: '10000',
        },
      }),
    ).rejects.toThrow('grok timeout');

    const calls = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string });
    expect(calls.map((call) => call.kind)).toContain('delete');
  });

  it('returns Grok structuredOutput as checkpoint JSON text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-grok-runner-structured-'));
    tempRoots.push(root);
    const result = await runGrokOneshot({
      prompt: 'checkpoint',
      systemPrompt: 'return structured output',
      outputSchema: {
        type: 'object',
        properties: { version: { type: 'number' } },
      },
      timeoutMs: 5_000,
      timeoutErrorMessage: 'timeout',
      testCommand: {
        binary: process.execPath,
        argsPrefix: [fixture],
      },
      envOverride: {
        FAKE_GROK_LOG: join(root, 'calls.jsonl'),
        FAKE_GROK_STRUCTURED_OUTPUT: '{"version":1}',
      },
    });

    expect(result.text).toBe('{"version":1}');
  });
});
