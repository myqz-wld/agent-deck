import { isJsonObject } from '@contracts/index';
import type { RemoteHostProfileDraftDto, RemoteHostSourceMode } from '@shared/remote-host';

import { RemoteHostInputError } from './input-validation-error';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

export function parseRemoteHostSourceMode(value: unknown): RemoteHostSourceMode {
  if (value !== 'local' && value !== 'remote') {
    throw new RemoteHostInputError('sourceMode', 'must be local or remote');
  }
  return value;
}

export function parseRemoteHostProfileDraft(value: unknown): RemoteHostProfileDraftDto {
  if (!isJsonObject(value)) throw new RemoteHostInputError('profile', 'must be an object');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'connectionSelectionId' || keys[1] !== 'label') {
    throw new RemoteHostInputError('profile', 'contains unexpected fields');
  }
  return {
    label: boundedText(value.label, 'profile.label', 256),
    connectionSelectionId: value.connectionSelectionId === null
      ? null
      : boundedToken(value.connectionSelectionId, 'profile.connectionSelectionId', 256),
  };
}

function boundedText(value: unknown, field: string, maxBytes: number): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes || CONTROL.test(value)
  ) {
    throw new RemoteHostInputError(field, 'invalid or too long');
  }
  return value;
}

function boundedToken(value: unknown, field: string, maxBytes: number): string {
  const parsed = boundedText(value, field, maxBytes);
  if (!SAFE_TOKEN.test(parsed)) throw new RemoteHostInputError(field, 'invalid token');
  return parsed;
}
