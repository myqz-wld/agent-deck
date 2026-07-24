import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const logPath = process.env.FAKE_GROK_LOG;

if (args[0] === 'sessions' && args[1] === 'delete') {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ kind: 'delete', sessionId: args[2] })}\n`);
  }
  process.exit(0);
}

const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const promptFile = valueAfter('--prompt-file');
const sessionId = valueAfter('--session-id');
const prompt = promptFile ? readFileSync(promptFile, 'utf8') : '';

if (logPath) {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      kind: 'run',
      args,
      prompt,
      sessionId,
      hookEnv: {
        origin: process.env.AGENT_DECK_ORIGIN,
        claude: process.env.GROK_CLAUDE_HOOKS_ENABLED,
        cursor: process.env.GROK_CURSOR_HOOKS_ENABLED,
      },
    })}\n`,
  );
}

const delayMs = Number(process.env.FAKE_GROK_DELAY_MS ?? 0);
if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

if (process.env.FAKE_GROK_ERROR) {
  process.stdout.write(JSON.stringify({ type: 'error', message: process.env.FAKE_GROK_ERROR }));
  process.exit(1);
}

const text = process.env.FAKE_GROK_RESPONSE ?? `echo:${prompt}`;
process.stdout.write(JSON.stringify({
  ...(process.env.FAKE_GROK_STRUCTURED_OUTPUT
    ? { structuredOutput: JSON.parse(process.env.FAKE_GROK_STRUCTURED_OUTPUT) }
    : { content: text }),
  stopReason: 'EndTurn',
  sessionId,
  usage: {
    inputTokens: 13,
    outputTokens: 5,
    contextWindowTokens: 1_048_576,
  },
}));
