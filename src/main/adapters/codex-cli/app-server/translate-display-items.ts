type AnyRecord = Record<string, unknown>;
type Emit = (
  kind: 'tool-use-start' | 'tool-use-end',
  payload: Record<string, unknown>,
) => void;

/** Translate current app-server display/tool items that are not ordinary function calls. */
export function translateCodexDisplayItemStarted(item: AnyRecord, emit: Emit): boolean {
  if (item.type !== 'sleep') return false;
  emit('tool-use-start', {
    toolUseId: item.id,
    toolName: 'clock.sleep',
    toolInput: { durationMs: item.durationMs },
  });
  return true;
}

export function translateCodexDisplayItemCompleted(item: AnyRecord, emit: Emit): boolean {
  switch (item.type) {
    case 'webSearch':
      emit('tool-use-start', {
        toolName: 'WebSearch',
        toolInput: { query: item.query },
        toolUseId: item.id,
      });
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: 'WebSearch',
        toolResult: {
          query: item.query,
          action: item.action ?? null,
          results: item.results ?? null,
        },
        status: 'completed',
      });
      return true;

    case 'sleep':
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: 'clock.sleep',
        toolInput: { durationMs: item.durationMs },
        durationMs: item.durationMs,
        status: 'completed',
      });
      return true;

    case 'imageView':
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: 'ImageView',
        toolInput: { path: item.path },
        toolResult: { path: item.path },
        status: 'completed',
      });
      return true;

    case 'imageGeneration': {
      const failed = item.status === 'failed';
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: 'ImageGeneration',
        toolInput: { prompt: item.revisedPrompt ?? null },
        toolResult: {
          savedPath: item.savedPath ?? null,
          hasInlineResult: typeof item.result === 'string' && item.result.length > 0,
        },
        status: item.status ?? 'completed',
        error: failed ? 'Codex image generation failed' : undefined,
      });
      return true;
    }

    default:
      return false;
  }
}
