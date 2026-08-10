import type {
  RemoteHostJsonObject,
  RemoteHostJsonValue,
  RemoteHostPendingAction,
  RemoteHostPendingRequestDto,
} from './types';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const UTF8 = new TextEncoder();

export const REMOTE_HOST_FALLBACK_QUESTION_ID = 'answer';

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

export function remoteHostQuestionIds(display: RemoteHostJsonObject): string[] {
  return boundedRemoteHostQuestionIds(display) ?? [REMOTE_HOST_FALLBACK_QUESTION_ID];
}

export function hasMalformedRemoteHostQuestionIds(display: RemoteHostJsonObject): boolean {
  return display.questionIds !== undefined && boundedRemoteHostQuestionIds(display) === null;
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
  return canonical({
    actions: [...remoteHostPendingActionSurface(request.kind)],
    display: request.display,
    kind: request.kind,
    questionIds: remoteHostQuestionIds(request.display),
    status: request.status,
  });
}

export interface RemoteHostNativeExitPlanDisplay {
  readonly summary: string;
  readonly title?: string;
}

/** Exact native Provider shape; MCP and forward-compatible fallback displays stay distinct. */
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
