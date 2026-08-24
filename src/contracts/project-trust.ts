import {
  PROJECT_TRUST_REASON_CODES,
  PROJECT_TRUST_STATUSES,
  type ProjectTrustDescriptor,
  type ProjectTrustReasonCode,
  type ProjectTrustRequest,
  type ProjectTrustStatus,
} from '@shared/types';
import { isJsonObject } from './json';
import { SessionConsoleContractError } from './session-console-common';

const REVISION = /^sha256:[0-9a-f]{64}$/;

function fail(field: string): never {
  throw new SessionConsoleContractError(field);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(field);
  }
}

export function parseProjectTrustRevision(
  value: unknown,
  field: string,
): `sha256:${string}` {
  if (typeof value !== 'string' || !REVISION.test(value)) fail(field);
  return value as `sha256:${string}`;
}

export function parseProjectTrustDescriptor(
  value: unknown,
  field = 'projectTrust',
): ProjectTrustDescriptor {
  if (!isJsonObject(value)) fail(field);
  exactKeys(value, ['canGrant', 'reasonCode', 'revision', 'status'], field);
  if (
    !PROJECT_TRUST_STATUSES.includes(value.status as ProjectTrustStatus) ||
    typeof value.canGrant !== 'boolean'
  ) fail(field);
  const reasonCode = value.reasonCode;
  if (
    reasonCode !== null &&
    !PROJECT_TRUST_REASON_CODES.includes(reasonCode as ProjectTrustReasonCode)
  ) fail(`${field}.reasonCode`);
  if (value.canGrant && value.status !== 'untrusted') fail(`${field}.canGrant`);
  if (
    (value.status === 'trusted' || value.status === 'untrusted') !==
    (reasonCode === null)
  ) fail(`${field}.reasonCode`);
  return {
    status: value.status as ProjectTrustStatus,
    canGrant: value.canGrant,
    reasonCode: reasonCode as ProjectTrustReasonCode | null,
    revision: parseProjectTrustRevision(value.revision, `${field}.revision`),
  };
}

export function parseProjectTrustRequest(
  value: unknown,
  field = 'projectTrust',
): ProjectTrustRequest {
  if (!isJsonObject(value)) fail(field);
  exactKeys(value, ['grant', 'revision'], field);
  if (typeof value.grant !== 'boolean') fail(`${field}.grant`);
  return {
    grant: value.grant,
    revision: parseProjectTrustRevision(value.revision, `${field}.revision`),
  };
}
