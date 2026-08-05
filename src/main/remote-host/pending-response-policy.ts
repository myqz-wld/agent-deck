import { isJsonObject } from '@contracts/index';
import {
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

export function authorizeRemoteHostPendingResponse(
  pending: RemoteHostPendingListDto,
  response: RemoteHostPendingResponseDto,
): number {
  const request = pending.requests.find((item) => item.id === response.requestId);
  if (!request) {
    throw new RemoteHostPublicError('not_found', '待处理请求不存在。');
  }
  if (request.status !== 'pending') {
    throw new RemoteHostPublicError('already_decided', '该待处理请求已经完成。');
  }
  if (pending.revision !== response.expectedRevision) {
    throw new RemoteHostPublicError('conflict', '远程数据已变化，请刷新后重试。');
  }

  if (request.kind === 'ask-user-question') {
    if (response.action !== 'submit') invalidPendingAction();
    validateExactQuestionKeys(request, response.value);
    return pending.revision;
  }

  if (response.value !== undefined) invalidPendingAction();
  if (request.kind === 'permission') {
    if (response.action !== 'approve' && response.action !== 'deny') {
      invalidPendingAction();
    }
    return pending.revision;
  }
  if (response.action !== 'accept' && response.action !== 'reject') {
    invalidPendingAction();
  }
  return pending.revision;
}
