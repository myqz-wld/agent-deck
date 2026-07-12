import { describe, expect, it } from 'vitest';
import { invalidateCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';
import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  canonicalizeContinuationCheckpoint,
} from '../checkpoint-schema';
import { createCheckpointGeneratorRuntime } from '../runtime';

const runLive = process.env.AGENT_DECK_CODEX_LIVE_SMOKE === '1';

describe('Codex checkpoint live smoke', () => {
  it.runIf(runLive)(
    'returns schema-valid compact output through the hardened app-server runtime',
    async () => {
      const runtime = createCheckpointGeneratorRuntime({
        adapter: 'codex-cli',
        model: null,
        thinking: 'low',
        contextWindowTokens: null,
        configFingerprint: 'codex-live-smoke',
      });
      try {
        const result = await runtime.generate({
          prompt:
            'Create a Continuation Checkpoint for an empty evidence delta. ' +
            'Return formatVersion 1 and an empty array for every fact section. ' +
            'There are no allowed evidence references.',
          timeoutMs: 60_000,
          maxOutputBytes: 64 * 1024,
          remainingCalls: 1,
        });

        const canonical = canonicalizeContinuationCheckpoint(JSON.parse(result.rawText));
        expect(runtime.isolation).toBe('hardened-unattested');
        expect(canonical.checkpoint.formatVersion).toBe(1);
        expect(
          CONTINUATION_CHECKPOINT_SECTIONS.reduce(
            (count, section) => count + canonical.checkpoint[section].length,
            0,
          ),
        ).toBe(0);
        expect(result).toMatchObject({ providerCalls: 1, structured: true });
      } finally {
        invalidateCodexInstance();
      }
    },
    70_000,
  );
});
