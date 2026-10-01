import type { AskUserQuestionAnswer, AskUserQuestionItem } from './types/permission';

export const ASK_USER_MAX_QUESTIONS = 4;
export const ASK_USER_MAX_OPTIONS = 8;
export const ASK_USER_MAX_ANSWER_BYTES = 4_096;
const encoder = new TextEncoder();

function invalid(): never {
  throw new Error('回答无效：请按原问题顺序提交，每题只能选择提供的选项；单选题至多选择一项，并至少回答一道题。');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || encoder.encode(value).byteLength > ASK_USER_MAX_ANSWER_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    return invalid();
  }
  return value;
}

/** Validate against the pending request, never caller-supplied question/option identities. */
export function parseAskUserAnswer(
  questions: readonly AskUserQuestionItem[],
  value: unknown,
): AskUserQuestionAnswer {
  const raw = record(value);
  if (Object.keys(raw).some((key) => key !== 'answers') || !Array.isArray(raw.answers) ||
      raw.answers.length !== questions.length) return invalid();
  const answers = raw.answers.map((item, index) => {
    const answer = record(item);
    const question = questions[index]!;
    if (Object.keys(answer).some((key) => !['question', 'selected', 'other', 'note'].includes(key)) ||
        answer.question !== question.question || !Array.isArray(answer.selected) ||
        answer.selected.length > question.options.length ||
        (!question.multiSelect && answer.selected.length > 1)) return invalid();
    const selected = answer.selected.map((item) => {
      const label = text(item);
      if (!question.options.some((option) => option.label === label)) return invalid();
      return label;
    });
    if (new Set(selected).size !== selected.length) return invalid();
    return {
      question: question.question,
      selected,
      ...(answer.other === undefined ? {} : { other: text(answer.other) }),
      ...(answer.note === undefined ? {} : { note: text(answer.note) }),
    };
  });
  if (!answers.some((answer) => answer.selected.length > 0 || answer.other?.trim())) return invalid();
  return { answers };
}
