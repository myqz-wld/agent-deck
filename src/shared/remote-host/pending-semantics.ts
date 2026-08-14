import type {
  RemoteHostJsonObject,
  RemoteHostJsonValue,
  RemoteHostPendingAction,
  RemoteHostPendingRequestDto,
} from './types';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const UTF8 = new TextEncoder();

export interface RemoteHostAskQuestionOption {
  readonly label: string;
  readonly description: string | null;
}

export interface RemoteHostAskQuestion {
  readonly id: string;
  readonly header: string | null;
  readonly question: string;
  readonly multiSelect: boolean;
  readonly options: readonly RemoteHostAskQuestionOption[];
}

export interface RemoteHostAskQuestionDisplay {
  readonly prompt: string;
  readonly questionIds: readonly string[];
  readonly questions: readonly RemoteHostAskQuestion[];
}

function boundedText(value: unknown, maximumBytes: number): string | null {
  return typeof value === 'string' && value.length > 0 &&
    UTF8.encode(value).byteLength <= maximumBytes && !CONTROL.test(value)
    ? value
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

export function boundedRemoteHostQuestionIds(
  display: RemoteHostJsonObject,
): string[] | null {
  const value = display.questionIds;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    !value.every((item) =>
      typeof item === 'string' &&
      item.length > 0 &&
      UTF8.encode(item).byteLength <= 128 &&
      !CONTROL.test(item)) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value] as string[];
}

export function parseRemoteHostAskQuestionDisplay(
  display: RemoteHostJsonObject,
): RemoteHostAskQuestionDisplay | null {
  const questionIds = boundedRemoteHostQuestionIds(display);
  const prompt = boundedText(display.prompt, 1_024);
  if (
    !questionIds || !prompt || !Array.isArray(display.questions) ||
    display.questions.length !== questionIds.length ||
    !exactKeys(display, ['prompt', 'questionIds', 'questions'])
  ) return null;
  const questions: RemoteHostAskQuestion[] = [];
  for (const [index, value] of display.questions.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as RemoteHostJsonObject;
    const keys = ['id', 'multiSelect', 'options', 'question'];
    if (item.header !== undefined) keys.push('header');
    if (!exactKeys(item, keys)) return null;
    const id = boundedText(item.id, 128);
    const question = boundedText(item.question, 1_024);
    const header = item.header === undefined ? null : boundedText(item.header, 256);
    if (
      id !== questionIds[index] || !question ||
      (item.header !== undefined && !header) || typeof item.multiSelect !== 'boolean' ||
      !Array.isArray(item.options) || item.options.length > 32
    ) return null;
    const options: RemoteHostAskQuestionOption[] = [];
    for (const rawOption of item.options) {
      if (rawOption === null || typeof rawOption !== 'object' || Array.isArray(rawOption)) return null;
      const option = rawOption as RemoteHostJsonObject;
      const optionKeys = ['label'];
      if (option.description !== undefined) optionKeys.push('description');
      const label = boundedText(option.label, 256);
      const description = option.description === undefined
        ? null
        : boundedText(option.description, 512);
      if (!exactKeys(option, optionKeys) || !label ||
          (option.description !== undefined && !description)) return null;
      options.push({ label, description });
    }
    if (new Set(options.map((option) => option.label)).size !== options.length) return null;
    questions.push({ id, header, question, multiSelect: item.multiSelect, options });
  }
  return { prompt, questionIds, questions };
}

export function remoteHostPendingActionSurface(
  kind: RemoteHostPendingRequestDto['kind'],
): readonly RemoteHostPendingAction[] {
  if (kind === 'permission') return ['approve', 'deny'];
  if (kind === 'ask-user-question') return ['submit'];
  return ['accept', 'reject'];
}

function canonical(value: RemoteHostJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

/** Canonical authorization surface shared by Renderer and Electron main. */
export function remoteHostPendingPresentationCanonical(
  request: RemoteHostPendingRequestDto,
): string {
  const questionIds = request.kind === 'ask-user-question'
    ? parseRemoteHostAskQuestionDisplay(request.display)?.questionIds ?? null
    : [];
  return canonical({
    actions: [...remoteHostPendingActionSurface(request.kind)],
    display: request.display,
    kind: request.kind,
    questionIds: questionIds === null ? null : [...questionIds],
    status: request.status,
  });
}

export interface RemoteHostNativeExitPlanDisplay {
  readonly summary: string;
  readonly title?: string;
}

/** Exact current native Provider exit-plan shape. */
export function parseRemoteHostNativeExitPlanDisplay(
  display: RemoteHostJsonObject,
): RemoteHostNativeExitPlanDisplay | null {
  const expected = typeof display.title === 'string' ? ['summary', 'title'] : ['summary'];
  const keys = Object.keys(display).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    typeof display.summary !== 'string'
  ) return null;
  return {
    summary: display.summary,
    ...(typeof display.title === 'string' ? { title: display.title } : {}),
  };
}
