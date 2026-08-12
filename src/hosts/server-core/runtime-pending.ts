import {
  AgentDeckClientErrorCode,
  createPermissionPreviewDisplay,
  isJsonObject,
  parseMcpPresentationFeedback,
  type JsonObject,
  type JsonValue,
  type PendingRequestDto,
} from '@contracts/index';
import { DaemonRequestError } from '@hosts/daemon';
import type { AgentAdapter } from '@main/adapters/types';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
} from '@shared/types';
import type { ServerCorePendingResponseParams } from './runtime-validation';
import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';
import { redactRemoteSensitiveText } from './remote-sensitive-data';

const MAX_DISPLAY_TEXT_BYTES = 4_096;
const MAX_QUESTIONS = 32;
const MAX_OPTIONS = 32;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;

type PendingSnapshot = ReturnType<NonNullable<AgentAdapter['listPending']>>;

function invalid(message: string): never {
  throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, message);
}

function clip(value: string, maximum = MAX_DISPLAY_TEXT_BYTES): string {
  if (CONTROL.test(value)) return '[content omitted]';
  const projected = redactRemoteSensitiveText(value, () => 'Workspace');
  const encoded = Buffer.from(projected);
  if (encoded.byteLength <= maximum) return projected;
  const marker = '…';
  let cut = Math.max(0, maximum - Buffer.byteLength(marker));
  while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut -= 1;
  return `${encoded.subarray(0, cut).toString('utf8')}${marker}`;
}

function snapshot(adapter: AgentAdapter, sessionId: string): PendingSnapshot {
  return adapter.listPending?.(sessionId) ?? {
    permissions: [],
    askQuestions: [],
    exitPlanModes: [],
  };
}

function permissionDisplay(request: PermissionRequest): JsonObject {
  return createPermissionPreviewDisplay(request.toolName, request.toolInput);
}

function askDisplay(request: AskUserQuestionRequest): JsonObject {
  const questions = request.questions.slice(0, MAX_QUESTIONS).map((question, index) => ({
    id: `q${index + 1}`,
    question: clip(question.question, 1_024),
    ...(question.header ? { header: clip(question.header, 256) } : {}),
    multiSelect: question.multiSelect === true,
    options: question.options.slice(0, MAX_OPTIONS).map((option) => ({
      label: clip(option.label, 256),
      ...(option.description ? { description: clip(option.description, 512) } : {}),
    })),
  }));
  return {
    prompt: questions.length === 1 ? questions[0]!.question : `${questions.length} questions`,
    questionIds: questions.map((question) => question.id),
    questions,
  };
}

function exitPlanDisplay(request: ExitPlanModeRequest): JsonObject {
  return {
    ...(request.title ? { title: clip(request.title, 512) } : {}),
    summary: clip(request.plan),
  };
}

export function listServerCorePendingRequests(
  adapter: AgentAdapter,
  sessionId: string,
  createdAt: number,
  presentations: Pick<ServerCoreMcpPresentationPort, 'list'>,
): PendingRequestDto[] {
  const pending = snapshot(adapter, sessionId);
  const requests: PendingRequestDto[] = [
    ...presentations.list(sessionId),
    ...pending.permissions.map((request) => ({
      id: request.requestId,
      sessionId,
      kind: 'permission' as const,
      status: 'pending' as const,
      createdAt,
      expiresAt: null,
      display: permissionDisplay(request),
    })),
    ...pending.askQuestions.map((request) => ({
      id: request.requestId,
      sessionId,
      kind: 'ask-user-question' as const,
      status: 'pending' as const,
      createdAt,
      expiresAt: null,
      display: askDisplay(request),
    })),
    ...pending.exitPlanModes.map((request) => ({
      id: request.requestId,
      sessionId,
      kind: 'exit-plan' as const,
      status: 'pending' as const,
      createdAt,
      expiresAt: null,
      display: exitPlanDisplay(request),
    })),
  ];
  if (new Set(requests.map((request) => request.id)).size !== requests.length) {
    throw new Error('Provider returned duplicate pending request identities');
  }
  return requests;
}

function requireNoValue(params: ServerCorePendingResponseParams): void {
  if (params.value !== undefined) invalid('Pending response value is invalid');
}

function answerText(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== 'string' || (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > MAX_DISPLAY_TEXT_BYTES || CONTROL.test(value)
  ) invalid('Question answers are invalid');
  return value;
}

function selectedAnswers(
  question: AskUserQuestionRequest['questions'][number],
  value: unknown,
): string[] {
  if (
    !Array.isArray(value) || value.length > MAX_OPTIONS ||
    (!question.multiSelect && value.length > 1)
  ) invalid('Question answers are invalid');
  const allowed = new Map(
    question.options.slice(0, MAX_OPTIONS).map((option) => [
      clip(option.label, 256),
      option.label,
    ]),
  );
  if (allowed.size !== question.options.slice(0, MAX_OPTIONS).length) {
    invalid('Question answers are invalid');
  }
  const selected = value.map((item) => {
    const label = answerText(item);
    const original = allowed.get(label);
    if (original === undefined) invalid('Question answers are invalid');
    return original;
  });
  if (new Set(selected).size !== selected.length) invalid('Question answers are invalid');
  return selected;
}

function askAnswer(
  request: AskUserQuestionRequest,
  value: JsonValue | undefined,
): AskUserQuestionAnswer {
  if (!isJsonObject(value)) invalid('Question answers are invalid');
  const questionIds = request.questions.slice(0, MAX_QUESTIONS).map((_, index) => `q${index + 1}`);
  const actual = Object.keys(value).sort();
  const expected = [...questionIds].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) invalid('Question answers are invalid');
  let hasMeaningfulAnswer = false;
  const answers = request.questions.slice(0, MAX_QUESTIONS).map((question, index) => {
    const answer = value[`q${index + 1}`];
    if (typeof answer === 'string') {
      const other = answerText(answer);
      hasMeaningfulAnswer = true;
      return { question: question.question, selected: [], other };
    }
    if (Array.isArray(answer)) {
      const selected = selectedAnswers(question, answer);
      if (selected.length === 0) invalid('Question answers are invalid');
      hasMeaningfulAnswer = true;
      return { question: question.question, selected };
    }
    if (!isJsonObject(answer)) invalid('Question answers are invalid');
    const keys = Object.keys(answer).sort();
    const expectedKeys = [
      'selected',
      ...(Object.hasOwn(answer, 'other') ? ['other'] : []),
      ...(Object.hasOwn(answer, 'note') ? ['note'] : []),
    ].sort();
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
    ) invalid('Question answers are invalid');
    const selected = selectedAnswers(question, answer.selected);
    const other = Object.hasOwn(answer, 'other')
      ? answerText(answer.other, true)
      : undefined;
    const note = Object.hasOwn(answer, 'note')
      ? answerText(answer.note, true)
      : undefined;
    if (selected.length > 0 || Boolean(other?.trim())) hasMeaningfulAnswer = true;
    return {
      question: question.question,
      selected,
      ...(other === undefined ? {} : { other }),
      ...(note === undefined ? {} : { note }),
    };
  });
  if (!hasMeaningfulAnswer) invalid('Question answers are invalid');
  return { answers };
}

const EXIT_PLAN_TARGET_MODES = new Set([
  'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions',
]);

function exitPlanAnswer(params: ServerCorePendingResponseParams): ExitPlanModeResponse {
  if (params.action === 'reject') {
    let feedback: string | undefined;
    try { feedback = parseMcpPresentationFeedback(params.value); }
    catch { return invalid('Pending response value is invalid'); }
    return {
      decision: 'keep-planning',
      ...(feedback === undefined ? {} : { feedback }),
    };
  }
  if (params.action !== 'accept') invalid('Pending action is invalid');
  if (params.value === undefined) return { decision: 'approve', targetMode: 'default' };
  if (!isJsonObject(params.value)) invalid('Pending response value is invalid');
  const keys = Object.keys(params.value);
  const targetMode = params.value.targetMode;
  if (
    keys.length !== 1 || keys[0] !== 'targetMode' ||
    typeof targetMode !== 'string' || !EXIT_PLAN_TARGET_MODES.has(targetMode)
  ) invalid('Pending response value is invalid');
  if (targetMode === 'bypassPermissions') return { decision: 'approve-bypass' };
  return {
    decision: 'approve',
    targetMode: targetMode as 'default' | 'acceptEdits' | 'plan' | 'auto',
  };
}

export async function respondToServerCorePending(
  adapter: AgentAdapter,
  params: ServerCorePendingResponseParams,
  presentations: Pick<ServerCoreMcpPresentationPort, 'respond'>,
): Promise<'denied' | 'resolved'> {
  try {
    const presented = presentations.respond(
      params.sessionId,
      params.requestId,
      params.action,
      params.value,
    );
    if (presented) return presented;
  } catch {
    invalid('Pending action is invalid');
  }
  const pending = snapshot(adapter, params.sessionId);
  const permission = pending.permissions.find((item) => item.requestId === params.requestId);
  if (permission) {
    requireNoValue(params);
    if (!adapter.respondPermission || !['approve', 'deny'].includes(params.action)) {
      invalid('Pending action is invalid');
    }
    if (
      params.action === 'approve' &&
      !createPermissionPreviewDisplay(permission.toolName, permission.toolInput).complete
    ) {
      invalid('Permission preview is incomplete');
    }
    await adapter.respondPermission(params.sessionId, params.requestId, {
      decision: params.action === 'approve' ? 'allow' : 'deny',
    });
    return params.action === 'approve' ? 'resolved' : 'denied';
  }

  const ask = pending.askQuestions.find((item) => item.requestId === params.requestId);
  if (ask) {
    if (!adapter.respondAskUserQuestion || params.action !== 'submit') {
      invalid('Pending action is invalid');
    }
    await adapter.respondAskUserQuestion(
      params.sessionId,
      params.requestId,
      askAnswer(ask, params.value),
    );
    return 'resolved';
  }

  const exitPlan = pending.exitPlanModes.find((item) => item.requestId === params.requestId);
  if (exitPlan) {
    if (!adapter.respondExitPlanMode || !['accept', 'reject'].includes(params.action)) {
      invalid('Pending action is invalid');
    }
    await adapter.respondExitPlanMode(
      params.sessionId,
      params.requestId,
      exitPlanAnswer(params),
    );
    return params.action === 'accept' ? 'resolved' : 'denied';
  }

  throw new DaemonRequestError(
    AgentDeckClientErrorCode.NotFound,
    'Pending request was not found',
  );
}
