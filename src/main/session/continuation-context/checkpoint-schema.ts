import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CONTINUATION_CHECKPOINT_FORMAT_VERSION = 1 as const;
export const MAX_CHECKPOINT_FACTS_PER_SECTION = 64;
export const MAX_CHECKPOINT_EVIDENCE_PER_FACT = 16;

export const continuationFactStatusSchema = z.enum([
  'active',
  'completed',
  'blocked',
  'resolved',
  'superseded',
]);

export type ContinuationFactStatus = z.infer<typeof continuationFactStatusSchema>;

export const continuationEvidenceSchema = z
  .object({
    eventId: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export type ContinuationEvidence = z.infer<typeof continuationEvidenceSchema>;

export const continuationFactSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    status: continuationFactStatusSchema,
    text: z.string().trim().min(1).max(1_000),
    rationale: z.string().trim().min(1).max(1_000).optional(),
    validation: z.string().trim().min(1).max(1_000).optional(),
    priority: z.number().int().min(0).max(100),
    evidence: z
      .array(continuationEvidenceSchema)
      .min(1)
      .max(MAX_CHECKPOINT_EVIDENCE_PER_FACT),
  })
  .strict();

export type ContinuationFact = z.infer<typeof continuationFactSchema>;

const factSectionSchema = z.array(continuationFactSchema).max(MAX_CHECKPOINT_FACTS_PER_SECTION);

export const CONTINUATION_CHECKPOINT_SECTIONS = [
  'goals',
  'userIntent',
  'constraints',
  'decisions',
  'completedWork',
  'currentState',
  'nextSteps',
  'openQuestions',
  'risks',
  'keyFiles',
  'commands',
  'unresolvedErrors',
] as const;

/** Canonical, provider-neutral checkpoint persisted independently from display summaries. */
export const continuationCheckpointSchema = z
  .object({
    formatVersion: z.literal(CONTINUATION_CHECKPOINT_FORMAT_VERSION),
    goals: factSectionSchema,
    userIntent: factSectionSchema,
    constraints: factSectionSchema,
    decisions: factSectionSchema,
    completedWork: factSectionSchema,
    currentState: factSectionSchema,
    nextSteps: factSectionSchema,
    openQuestions: factSectionSchema,
    risks: factSectionSchema,
    keyFiles: factSectionSchema,
    commands: factSectionSchema,
    unresolvedErrors: factSectionSchema,
  })
  .strict()
  .superRefine((checkpoint, ctx) => {
    const seen = new Set<string>();
    for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
      checkpoint[section].forEach((fact, index) => {
        if (seen.has(fact.id)) {
          ctx.addIssue({
            code: 'custom',
            path: [section, index, 'id'],
            message: `Duplicate checkpoint fact id: ${fact.id}`,
          });
        }
        seen.add(fact.id);
      });
    }
  });

export type ContinuationCheckpoint = z.infer<typeof continuationCheckpointSchema>;
export type ContinuationCheckpointSection = Exclude<keyof ContinuationCheckpoint, 'formatVersion'>;

const evidenceJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'revision'],
  properties: {
    eventId: { type: 'integer', minimum: 1 },
    revision: { type: 'integer', minimum: 0 },
  },
} as const;

function factJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status', 'text', 'priority', 'evidence'],
    properties: {
      id: {
        type: 'string',
        minLength: 1,
        maxLength: 96,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
      },
      status: {
        type: 'string',
        enum: ['active', 'completed', 'blocked', 'resolved', 'superseded'],
      },
      text: { type: 'string', minLength: 1, maxLength: 1_000 },
      rationale: { type: 'string', minLength: 1, maxLength: 1_000 },
      validation: { type: 'string', minLength: 1, maxLength: 1_000 },
      priority: { type: 'integer', minimum: 0, maximum: 100 },
      evidence: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_CHECKPOINT_EVIDENCE_PER_FACT,
        items: evidenceJsonSchema,
      },
    },
  };
}

function factSectionJsonSchema(): Record<string, unknown> {
  return {
    type: 'array',
    maxItems: MAX_CHECKPOINT_FACTS_PER_SECTION,
    items: factJsonSchema(),
  };
}

/** Lowest-common-denominator schema passed to provider structured-output APIs. */
export const CONTINUATION_CHECKPOINT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'formatVersion',
    'goals',
    'userIntent',
    'constraints',
    'decisions',
    'completedWork',
    'currentState',
    'nextSteps',
    'openQuestions',
    'risks',
    'keyFiles',
    'commands',
    'unresolvedErrors',
  ],
  properties: {
    formatVersion: { type: 'integer', const: CONTINUATION_CHECKPOINT_FORMAT_VERSION },
    goals: factSectionJsonSchema(),
    userIntent: factSectionJsonSchema(),
    constraints: factSectionJsonSchema(),
    decisions: factSectionJsonSchema(),
    completedWork: factSectionJsonSchema(),
    currentState: factSectionJsonSchema(),
    nextSteps: factSectionJsonSchema(),
    openQuestions: factSectionJsonSchema(),
    risks: factSectionJsonSchema(),
    keyFiles: factSectionJsonSchema(),
    commands: factSectionJsonSchema(),
    unresolvedErrors: factSectionJsonSchema(),
  },
};

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableJsonValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface CanonicalContinuationCheckpoint {
  checkpoint: ContinuationCheckpoint;
  payloadJson: string;
  contentHash: string;
}

/** Validate once, serialize deterministically, and hash the exact canonical semantic value. */
export function canonicalizeContinuationCheckpoint(
  input: unknown,
): CanonicalContinuationCheckpoint {
  const checkpoint = continuationCheckpointSchema.parse(input);
  const payloadJson = JSON.stringify(stableJsonValue(checkpoint));
  return {
    checkpoint,
    payloadJson,
    contentHash: createHash('sha256').update(payloadJson, 'utf8').digest('hex'),
  };
}

export function parseContinuationCheckpointJson(payloadJson: string): CanonicalContinuationCheckpoint {
  return canonicalizeContinuationCheckpoint(JSON.parse(payloadJson) as unknown);
}
