import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_CHECKPOINT_PATCH_JSON_SCHEMA,
  continuationCheckpointPatchSchema,
} from '../checkpoint-patch-schema';

describe('checkpoint patch schema', () => {
  it('keeps the provider contract to version plus additions and updates', () => {
    expect(CONTINUATION_CHECKPOINT_PATCH_JSON_SCHEMA).toMatchObject({
      additionalProperties: false,
      required: ['formatVersion', 'additions', 'updates'],
      properties: {
        additions: { type: 'array' },
        updates: { type: 'array' },
      },
    });
    const additions = (CONTINUATION_CHECKPOINT_PATCH_JSON_SCHEMA as {
      properties: {
        additions: { items: { properties: { fact: { required: string[] } } } };
      };
    }).properties.additions;
    expect(additions.items.properties.fact.required).toEqual([
      'id', 'status', 'text', 'rationale', 'validation', 'priority', 'evidence',
    ]);
    const updates = (CONTINUATION_CHECKPOINT_PATCH_JSON_SCHEMA as {
      properties: { updates: { items: { properties: { status: { anyOf: unknown[] } } } } };
    }).properties.updates;
    expect(updates.items.properties.status.anyOf).toContainEqual({ type: 'null' });
  });

  it('rejects duplicate targets across additions and updates', () => {
    const addition = {
      status: 'active',
      text: 'State',
      rationale: '',
      validation: '',
      priority: 1,
      evidence: [{ eventId: 1, revision: 1 }],
    };
    const update = {
      status: null,
      text: 'Changed state',
      rationale: null,
      validation: null,
      priority: null,
      evidence: [{ eventId: 1, revision: 1 }],
    };
    const result = continuationCheckpointPatchSchema.safeParse({
      formatVersion: 1,
      additions: [{ section: 'goals', fact: { id: 'fact.same', ...addition } }],
      updates: [{ section: 'goals', id: 'fact.same', ...update }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ message: 'Duplicate checkpoint patch target: fact.same' }),
      );
    }
  });

  it('rejects an update that declares no changed field', () => {
    const result = continuationCheckpointPatchSchema.safeParse({
      formatVersion: 1,
      additions: [],
      updates: [{
        section: 'goals',
        id: 'goal.keep',
        status: null,
        text: null,
        rationale: null,
        validation: null,
        priority: null,
        evidence: [{ eventId: 1, revision: 1 }],
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ message: 'Checkpoint update goal.keep declares no semantic field' }),
      );
    }
  });
});
