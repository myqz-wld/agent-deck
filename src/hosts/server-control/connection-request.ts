import {
  assertExactKeys,
  requireAbsolutePath,
  requireObject,
  requireStableToken,
} from '@hosts/linux-runtime/validation';

export type ServerConnectionSurface = 'desktop' | 'feishu';
export type ServerConnectionCommand = 'issue' | 'revoke' | 'rotate';

interface ConnectionSelector {
  readonly credentialId: string;
  readonly surface: ServerConnectionSurface;
}

export interface IssueConnectionRequest extends ConnectionSelector {
  readonly schemaVersion: 1;
  readonly label: string;
  readonly outputFile: string;
}

export interface RevokeConnectionRequest extends ConnectionSelector {
  readonly schemaVersion: 1;
}

export interface RotateConnectionRequest {
  readonly schemaVersion: 1;
  readonly credentialId: string;
  readonly nextCredentialId: string;
  readonly surface: ServerConnectionSurface;
  readonly label: string;
  readonly outputFile: string;
}

export type ServerConnectionRequest =
  | IssueConnectionRequest
  | RevokeConnectionRequest
  | RotateConnectionRequest;

function surface(value: unknown): ServerConnectionSurface {
  if (value !== 'desktop' && value !== 'feishu') {
    throw new Error('connection surface is invalid');
  }
  return value;
}

function label(value: unknown): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 256 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    throw new Error('connection label is invalid');
  }
  return value;
}

export function parseServerConnectionRequest(
  command: 'issue',
  value: unknown,
): IssueConnectionRequest;
export function parseServerConnectionRequest(
  command: 'revoke',
  value: unknown,
): RevokeConnectionRequest;
export function parseServerConnectionRequest(
  command: 'rotate',
  value: unknown,
): RotateConnectionRequest;
export function parseServerConnectionRequest(
  command: ServerConnectionCommand,
  value: unknown,
): ServerConnectionRequest {
  const object = requireObject(value, 'connection request');
  const common = {
    schemaVersion: 1 as const,
    credentialId: requireStableToken(object.credentialId, 'credentialId'),
    surface: surface(object.surface),
  };
  if (object.schemaVersion !== 1) {
    throw new Error('connection request schemaVersion is unsupported');
  }
  if (command === 'revoke') {
    assertExactKeys(
      object,
      ['credentialId', 'schemaVersion', 'surface'],
      'connection revoke request',
    );
    return Object.freeze(common);
  }
  if (command === 'issue') {
    assertExactKeys(object, [
      'credentialId', 'label', 'outputFile', 'schemaVersion', 'surface',
    ], 'connection issue request');
    return Object.freeze({
      ...common,
      label: label(object.label),
      outputFile: requireAbsolutePath(object.outputFile, 'outputFile'),
    });
  }
  assertExactKeys(object, [
    'credentialId',
    'label',
    'nextCredentialId',
    'outputFile',
    'schemaVersion',
    'surface',
  ], 'connection rotate request');
  const nextCredentialId = requireStableToken(object.nextCredentialId, 'nextCredentialId');
  if (nextCredentialId === common.credentialId) {
    throw new Error('rotation requires a new credentialId');
  }
  return Object.freeze({
    ...common,
    nextCredentialId,
    label: label(object.label),
    outputFile: requireAbsolutePath(object.outputFile, 'outputFile'),
  });
}
