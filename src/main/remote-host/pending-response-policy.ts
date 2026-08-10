import { createHash } from 'node:crypto';

import {
  isJsonObject,
  parsePermissionPreviewDisplay,
  parseMcpPresentationDisplay,
  parseMcpPresentationFeedback,
} from '@contracts/index';
import {
  parseRemoteHostNativeExitPlanDisplay,
  remoteHostPendingPresentationCanonical,
  remoteHostQuestionIds,
  type RemoteHostPendingListDto,
  type RemoteHostPendingResponseDto,
} from '@shared/remote-host';

import { RemoteHostPublicError } from './errors';

function invalidPendingAction(): never {
  throw new RemoteHostPublicError(
    'invalid_request',
    '待处理请求的操作或回答无效。',
  );
}

function validateExactQuestionKeys(
  pending: RemoteHostPendingListDto['requests'][number],
  value: RemoteHostPendingResponseDto['value'],
): void {
  if (!isJsonObject(value)) invalidPendingAction();
  const actual = Object.keys(value).sort();
  const expected = remoteHostQuestionIds(pending.display).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalidPendingAction();
  }
}

const EXIT_PLAN_TARGET_MODES = new Set([
  'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions',
]);
const LEGACY_PERMISSION_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;

function hasCompleteLegacyPermissionDisplay(
  display: RemoteHostPendingListDto['requests'][number]['display'],
): boolean {
  return typeof display.tool === 'string' && display.tool.length > 0 &&
    Buffer.byteLength(display.tool, 'utf8') <= 256 && !LEGACY_PERMISSION_CONTROL.test(display.tool) &&
    typeof display.command === 'string' && display.command.trim().length > 0 &&
    Buffer.byteLength(display.command, 'utf8') <= 4_096 &&
    !LEGACY_PERMISSION_CONTROL.test(display.command);
}

export function remoteHostPendingPresentationDigest(
  request: RemoteHostPendingListDto['requests'][number],
): string {
  return `sha256:${createHash('sha256')
    .update(remoteHostPendingPresentationCanonical(request))
    .digest('hex')}`;
}

function validateNativeExitPlanValue(response: RemoteHostPendingResponseDto): void {
  if (response.action === 'reject') {
    try { parseMcpPresentationFeedback(response.value); }
    catch { invalidPendingAction(); }
    return;
  }
  if (response.value === undefined) return; // Legacy desktop: default permission mode.
  if (!isJsonObject(response.value)) invalidPendingAction();
  const keys = Object.keys(response.value);
  if (
    keys.length !== 1 || keys[0] !== 'targetMode' ||
    typeof response.value.targetMode !== 'string' ||
    !EXIT_PLAN_TARGET_MODES.has(response.value.targetMode)
  ) invalidPendingAction();
}

export function authorizeRemoteHostPendingResponse(
  pending: RemoteHostPendingListDto,
  response: RemoteHostPendingResponseDto,
): number {
  const request = pending.requests.find((item) => item.id === response.requestId);
  if (!request || request.status !== 'pending') {
    // The Core mutation ledger is the authority for uncertain replay. A completed intent is
    // returned before expectedRevision is checked; a new/changed intent still fails closed there.
    return response.expectedRevision;
  }
  if (remoteHostPendingPresentationDigest(request) !== response.expectedPresentationDigest) {
    throw new RemoteHostPublicError('conflict', '远程数据已变化，请刷新后重试。');
  }

  if (request.kind === 'ask-user-question') {
    if (response.action !== 'submit') invalidPendingAction();
    validateExactQuestionKeys(request, response.value);
    return pending.revision;
  }

  if (request.kind === 'permission') {
    if (response.value !== undefined) invalidPendingAction();
    if (response.action !== 'approve' && response.action !== 'deny') {
      invalidPendingAction();
    }
    if (response.action === 'approve') {
      let preview: ReturnType<typeof parsePermissionPreviewDisplay>;
      try { preview = parsePermissionPreviewDisplay(request.display); }
      catch { return invalidPendingAction(); }
      if (
        (preview && !preview.complete) ||
        (!preview && !hasCompleteLegacyPermissionDisplay(request.display))
      ) invalidPendingAction();
    }
    return pending.revision;
  }
  if (response.action !== 'accept' && response.action !== 'reject') {
    invalidPendingAction();
  }
  let presentation: ReturnType<typeof parseMcpPresentationDisplay>;
  try { presentation = parseMcpPresentationDisplay(request.display); }
  catch { return invalidPendingAction(); }
  if (!presentation) {
    if (request.kind === 'exit-plan' && parseRemoteHostNativeExitPlanDisplay(request.display)) {
      validateNativeExitPlanValue(response);
      return pending.revision;
    }
    if (response.value !== undefined) invalidPendingAction();
    return pending.revision;
  }
  if (response.action === 'accept' && response.value !== undefined) invalidPendingAction();
  if (response.action === 'reject') {
    try { parseMcpPresentationFeedback(response.value); } catch { invalidPendingAction(); }
  }
  return pending.revision;
}
