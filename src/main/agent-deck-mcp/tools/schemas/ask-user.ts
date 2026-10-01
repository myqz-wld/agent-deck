import { z } from 'zod';
import {
  ASK_USER_MAX_ANSWER_BYTES,
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MAX_QUESTIONS,
} from '@shared/ask-user';

const encoder = new TextEncoder();
const boundedText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.trim().length > 0 && encoder.encode(value).byteLength <= maximum,
    `Expected non-blank text of at most ${maximum} UTF-8 bytes`)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u.test(value),
    'Unsupported control character');

const option = z.object({
  label: boundedText(256).describe('Unique option label within this question; 1–256 UTF-8 bytes.'),
  description: boundedText(512).optional().describe('Optional explanation, 1–512 UTF-8 bytes; omit when unnecessary. Null is rejected.'),
}).strict();

const question = z.object({
  question: boundedText(1_024).describe('Self-contained question, 1–1024 UTF-8 bytes.'),
  header: boundedText(256).optional().describe('Optional short category label, 1–256 UTF-8 bytes. Null is rejected.'),
  options: z.array(option).max(ASK_USER_MAX_OPTIONS).optional()
    .describe('0–8 choices with unique labels. Omit or use [] for a free-text question. Free text and a note are always available; do not add an Other option.'),
  multiSelect: z.boolean().optional().describe('Whether multiple options may be selected; omitted means false. Null is rejected.'),
}).strict().refine((item) => new Set(item.options?.map((entry) => entry.label)).size === (item.options?.length ?? 0),
  'Option labels must be unique within each question');

export const ASK_USER_SCHEMA = {
  questions: z.array(question).min(1).max(ASK_USER_MAX_QUESTIONS)
    .describe('1–4 related questions presented together in Pending. Batch only questions needed for the next decision.'),
};
export const ASK_USER_ARGS_SCHEMA = z.object(ASK_USER_SCHEMA).strict();
export type AskUserArgs = z.infer<typeof ASK_USER_ARGS_SCHEMA>;

const answerText = z.string().refine(
  (value) => encoder.encode(value).byteLength <= ASK_USER_MAX_ANSWER_BYTES,
  'Answer text must be at most 4096 UTF-8 bytes',
);
export const ASK_USER_OUTPUT_SCHEMA = z.object({
  status: z.enum(['answered', 'cancelled']).describe('answered means the user submitted; cancelled means the request ended without an answer.'),
  answers: z.array(z.object({
    question: z.string().describe('Original question text; entries preserve input order.'),
    selected: z.array(z.string()).max(ASK_USER_MAX_OPTIONS).describe('Selected original option labels; empty for free text or an unanswered question.'),
    other: answerText.optional().describe('Optional user-entered free-text answer; may be empty.'),
    note: answerText.optional().describe('Optional user note; may be empty and is not itself a choice.'),
  }).strict()).max(ASK_USER_MAX_QUESTIONS).describe('Input-aligned answers on submission; [] on cancellation. Blank entries are unanswered, never consent.'),
}).strict().refine((result) => result.status === 'cancelled' ? result.answers.length === 0 : result.answers.length > 0,
  'Cancelled requests have no answers; submitted requests contain input-aligned answers');
export type AskUserResult = z.infer<typeof ASK_USER_OUTPUT_SCHEMA>;

export const ASK_USER_DESCRIPTION = [
  'Ask the user for missing information, clarification, or a choice and show 1–4 related questions together in Agent Deck Pending. Use this for questions requiring a user response instead of leaving them only in chat.',
  'Claude, Codex, and Grok use the same tool. It belongs to the authenticated live caller session; external/global-token callers are rejected. It does not change provider permissions or replace present_plan/present_diff approval gates.',
  'Each question supports optional single/multiple-choice options, free text, and a note. Input schemas define limits and defaults; optional fields reject null. No selection is submitted automatically.',
  'This non-idempotent call creates one pending request and blocks without an application timeout until submission or cancellation. Limits are 4 pending groups per session and 64 per host (Server Core shares its presentation capacity). Do not duplicate a pending call or poll for answers. Provider/transport cancellation, session closure, or handoff ends the wait.',
  'Returns status="answered" and answers in input order, or status="cancelled" and answers=[]. Blank answer entries and cancellation are not approval; pause dependent work and follow the user\'s latest instruction. Only re-ask if the answer is still needed.',
  'Validation errors create no request: correct the named fields and retry. A closed/unknown session requires a live in-app session. Other failures return an error and recovery hint; never assume the user answered.',
].join('\n');
