import {
  AgentDeckClientErrorCode,
  isJsonObject,
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
  PermissionRequest,
} from '@shared/types';
import type { ServerCorePendingResponseParams } from './runtime-validation';
import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';

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
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= maximum) return value;
  return `${encoded.subarray(0, maximum).toString('utf8')}…`;
}

function snapshot(adapter: AgentAdapter, sessionId: string): PendingSnapshot {
  return adapter.listPending?.(sessionId) ?? {
    permissions: [],
    askQuestions: [],
    exitPlanModes: [],
  };
}

function permissionDisplay(request: PermissionRequest): JsonObject {
  const display: JsonObject = { tool: clip(request.toolName, 256) };
  const command = request.toolInput.command;
  if (typeof command === 'string') display.command = clip(command);
  const description = request.toolInput.description;
  if (typeof description === 'string') display.description = clip(description);
  return display;
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
  return {
    answers: request.questions.slice(0, MAX_QUESTIONS).map((question, index) => {
      const answer = value[`q${index + 1}`];
      if (typeof answer === 'string' && answer.length > 0 && !CONTROL.test(answer)) {
        return { question: question.question, selected: [], other: clip(answer) };
      }
      if (
        Array.isArray(answer) && answer.length > 0 && answer.length <= MAX_OPTIONS &&
        answer.every((item) => typeof item === 'string' && item.length > 0 && !CONTROL.test(item))
      ) {
        return {
          question: question.question,
          selected: answer.map((item) => clip(String(item), 512)),
        };
      }
      return invalid('Question answers are invalid');
    }),
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
    requireNoValue(params);
    if (!adapter.respondExitPlanMode || !['accept', 'reject'].includes(params.action)) {
      invalid('Pending action is invalid');
    }
    await adapter.respondExitPlanMode(
      params.sessionId,
      params.requestId,
      params.action === 'accept'
        ? { decision: 'approve', targetMode: 'default' }
        : { decision: 'keep-planning' },
    );
    return params.action === 'accept' ? 'resolved' : 'denied';
  }

  throw new DaemonRequestError(
    AgentDeckClientErrorCode.NotFound,
    'Pending request was not found',
  );
}
