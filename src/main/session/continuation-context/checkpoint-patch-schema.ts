import { z } from 'zod';
import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  MAX_CHECKPOINT_EVIDENCE_PER_FACT,
  MAX_CHECKPOINT_FACTS_PER_SECTION,
  continuationEvidenceSchema,
  continuationFactStatusSchema,
} from './checkpoint-schema';

export const CONTINUATION_CHECKPOINT_PATCH_FORMAT_VERSION = 1 as const;
export const MAX_CHECKPOINT_PATCH_OPERATIONS = MAX_CHECKPOINT_FACTS_PER_SECTION * 2;

const checkpointSectionSchema = z.enum(CONTINUATION_CHECKPOINT_SECTIONS);
const factIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const patchEvidenceSchema = z
  .array(continuationEvidenceSchema)
  .min(1)
  .max(MAX_CHECKPOINT_EVIDENCE_PER_FACT);

const patchFactSchema = z
  .object({
    id: factIdSchema,
    status: continuationFactStatusSchema,
    text: z.string().trim().min(1).max(1_000),
    // Provider structured output requires every declared property. Empty strings mean absent.
    rationale: z.string().trim().max(1_000),
    validation: z.string().trim().max(1_000),
    priority: z.number().int().min(0).max(100),
    evidence: patchEvidenceSchema,
  })
  .strict();

export const checkpointPatchAdditionSchema = z
  .object({
    section: checkpointSectionSchema,
    fact: patchFactSchema,
  })
  .strict();

export const checkpointPatchUpdateSchema = z
  .object({
    section: checkpointSectionSchema,
    id: factIdSchema,
    status: continuationFactStatusSchema.nullable(),
    text: z.string().trim().min(1).max(1_000).nullable(),
    rationale: z.string().trim().max(1_000).nullable(),
    validation: z.string().trim().max(1_000).nullable(),
    priority: z.number().int().min(0).max(100).nullable(),
    evidence: patchEvidenceSchema,
  })
  .strict();

/** Transient model output. It is validated and reduced, never persisted as checkpoint state. */
export const continuationCheckpointPatchSchema = z
  .object({
    formatVersion: z.literal(CONTINUATION_CHECKPOINT_PATCH_FORMAT_VERSION),
    additions: z.array(checkpointPatchAdditionSchema).max(MAX_CHECKPOINT_PATCH_OPERATIONS),
    updates: z.array(checkpointPatchUpdateSchema).max(MAX_CHECKPOINT_PATCH_OPERATIONS),
  })
  .strict()
  .superRefine((patch, ctx) => {
    if (patch.additions.length + patch.updates.length > MAX_CHECKPOINT_PATCH_OPERATIONS) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `Checkpoint patch exceeds ${MAX_CHECKPOINT_PATCH_OPERATIONS} operations`,
      });
    }
    const seen = new Set<string>();
    patch.updates.forEach((update, index) => {
      if (
        update.status === null &&
        update.text === null &&
        update.rationale === null &&
        update.validation === null &&
        update.priority === null
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['updates', index],
          message: `Checkpoint update ${update.id} declares no semantic field`,
        });
      }
    });
    for (const [kind, operations] of [
      ['additions', patch.additions] as const,
      ['updates', patch.updates] as const,
    ]) {
      operations.forEach((operation, index) => {
        const id = kind === 'additions' ? operation.fact.id : operation.id;
        if (seen.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: [kind, index, kind === 'additions' ? 'fact' : 'id'],
            message: `Duplicate checkpoint patch target: ${id}`,
          });
        }
        seen.add(id);
      });
    }
  });

export type ContinuationCheckpointPatch = z.infer<typeof continuationCheckpointPatchSchema>;

const evidenceJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'revision'],
  properties: {
    eventId: { type: 'integer', minimum: 1 },
    revision: { type: 'integer', minimum: 0 },
  },
} as const;

const evidenceListJsonSchema = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_CHECKPOINT_EVIDENCE_PER_FACT,
  items: evidenceJsonSchema,
} as const;

const sectionJsonSchema = {
  type: 'string',
  enum: [...CONTINUATION_CHECKPOINT_SECTIONS],
} as const;

const idJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 96,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
} as const;

const statusJsonSchema = {
  type: 'string',
  enum: ['active', 'completed', 'blocked', 'resolved', 'superseded'],
} as const;

function patchSemanticProperties(): Record<string, unknown> {
  return {
    status: statusJsonSchema,
    text: { type: 'string', minLength: 1, maxLength: 1_000 },
    rationale: { type: 'string', maxLength: 1_000 },
    validation: { type: 'string', maxLength: 1_000 },
    priority: { type: 'integer', minimum: 0, maximum: 100 },
    evidence: evidenceListJsonSchema,
  };
}

function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  return { anyOf: [schema, { type: 'null' }] };
}

function patchUpdateSemanticProperties(): Record<string, unknown> {
  return {
    status: nullable(statusJsonSchema),
    text: nullable({ type: 'string', minLength: 1, maxLength: 1_000 }),
    rationale: nullable({ type: 'string', maxLength: 1_000 }),
    validation: nullable({ type: 'string', maxLength: 1_000 }),
    priority: nullable({ type: 'integer', minimum: 0, maximum: 100 }),
    evidence: evidenceListJsonSchema,
  };
}

const additionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['section', 'fact'],
  properties: {
    section: sectionJsonSchema,
    fact: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'status', 'text', 'rationale', 'validation', 'priority', 'evidence'],
      properties: {
        id: idJsonSchema,
        ...patchSemanticProperties(),
      },
    },
  },
} as const;

const updateJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['section', 'id', 'status', 'text', 'rationale', 'validation', 'priority', 'evidence'],
  properties: {
    section: sectionJsonSchema,
    id: idJsonSchema,
    ...patchUpdateSemanticProperties(),
  },
} as const;

/** Lowest-common-denominator structured-output schema used by every generator adapter. */
export const CONTINUATION_CHECKPOINT_PATCH_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['formatVersion', 'additions', 'updates'],
  properties: {
    formatVersion: {
      type: 'integer',
      const: CONTINUATION_CHECKPOINT_PATCH_FORMAT_VERSION,
    },
    additions: {
      type: 'array',
      maxItems: MAX_CHECKPOINT_PATCH_OPERATIONS,
      items: additionJsonSchema,
    },
    updates: {
      type: 'array',
      maxItems: MAX_CHECKPOINT_PATCH_OPERATIONS,
      items: updateJsonSchema,
    },
  },
};
