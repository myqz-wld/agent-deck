import { isJsonObject } from './json';

export const SESSION_PERMISSIONS_MAX_RULES = 200;
export const SESSION_PERMISSIONS_MAX_RESULT_BYTES = 128 * 1024;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const SUSPICIOUS = /(?:^|[-_.])(?:api|auth|bearer|credential|key|password|secret|token)(?:[-_.]|$)|^(?:sk|xai)-|^eyJ|private.?key/iu;

export type SessionPermissionSource = 'provider-default' | 'session';
export type SessionWorkspaceAccess = 'allowed' | 'denied' | 'provider-default' | 'unavailable';
export type SessionPermissionProvenance = 'core-default' | 'session' | 'workspace';

export interface ClaudeSessionPermissionProjection {
  adapterId: 'claude-code';
  permissionMode: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
  permissionModeSource: SessionPermissionSource;
  sandbox: 'off' | 'provider-default' | 'strict' | 'workspace-write';
  sandboxSource: SessionPermissionSource;
}

export interface CodexSessionPermissionProjection {
  adapterId: 'codex-cli';
  approvalPolicy: 'never' | 'on-request' | 'provider-default' | 'untrusted';
  approvalPolicySource: SessionPermissionSource;
  sandbox: 'danger-full-access' | 'provider-default' | 'read-only' | 'workspace-write';
  sandboxSource: SessionPermissionSource;
}

export interface GrokSessionPermissionProjection {
  adapterId: 'grok-build';
  sessionMode: 'ask' | 'default' | 'plan';
  sessionModeSource: SessionPermissionSource;
  sandbox: string;
  sandboxSource: SessionPermissionSource;
}

export type SessionPermissionProjection =
  | ClaudeSessionPermissionProjection
  | CodexSessionPermissionProjection
  | GrokSessionPermissionProjection;

export interface SessionWorkspacePermissionProjection {
  read: SessionWorkspaceAccess;
  write: SessionWorkspaceAccess;
  network: SessionWorkspaceAccess;
}

export interface SessionPermissionRuleDto {
  effect: 'allow' | 'ask' | 'deny';
  subject:
    | { kind: 'tool'; tool: string }
    | { kind: 'workspace-subtree'; segments: string[] };
  provenance: SessionPermissionProvenance;
}

export interface SessionPermissionRuleSetDto {
  state: 'available' | 'unavailable';
  items: SessionPermissionRuleDto[];
  omittedCount: number;
  truncated: boolean;
}

export interface SessionPermissionsGetParams { sessionId: string }
export interface SessionPermissionsGetResult {
  sessionId: string;
  adapterId: SessionPermissionProjection['adapterId'];
  effective: SessionPermissionProjection;
  workspace: SessionWorkspacePermissionProjection;
  rules: SessionPermissionRuleSetDto;
  revision: number;
}

function fail(field: string): never { throw new Error(`${field} is invalid`); }
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(field);
  }
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) fail(field);
  return value;
}
function token(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== 'string' || !TOKEN.test(value) || CONTROL.test(value) ||
      bytes(value) > maximum) fail(field);
  return value;
}
function safeToken(value: unknown, field: string, maximum = 64): string {
  const parsed = token(value, field, maximum);
  if (SUSPICIOUS.test(parsed) || parsed.includes('/') || parsed.includes('\\')) fail(field);
  return parsed;
}
function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(field);
  return Number(value);
}
function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(field);
  return value as T;
}

export function parseSessionPermissionsGetParams(value: unknown): SessionPermissionsGetParams {
  const raw = object(value, 'session.permissions.get.params');
  exact(raw, ['sessionId'], 'session.permissions.get.params');
  return { sessionId: token(raw.sessionId, 'session.permissions.get.sessionId') };
}

function source(value: unknown, field: string): SessionPermissionSource {
  return oneOf(value, ['provider-default', 'session'], field);
}

function effective(value: unknown): SessionPermissionProjection {
  const raw = object(value, 'session.permissions.effective');
  const adapterId = oneOf(raw.adapterId, ['claude-code', 'codex-cli', 'grok-build'],
    'session.permissions.effective.adapterId');
  if (adapterId === 'claude-code') {
    exact(raw, ['adapterId', 'permissionMode', 'permissionModeSource', 'sandbox', 'sandboxSource'],
      'session.permissions.effective');
    return {
      adapterId,
      permissionMode: oneOf(raw.permissionMode,
        ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
        'session.permissions.effective.permissionMode'),
      permissionModeSource: source(raw.permissionModeSource,
        'session.permissions.effective.permissionModeSource'),
      sandbox: oneOf(raw.sandbox, ['off', 'provider-default', 'strict', 'workspace-write'],
        'session.permissions.effective.sandbox'),
      sandboxSource: source(raw.sandboxSource, 'session.permissions.effective.sandboxSource'),
    };
  }
  if (adapterId === 'codex-cli') {
    exact(raw, ['adapterId', 'approvalPolicy', 'approvalPolicySource', 'sandbox', 'sandboxSource'],
      'session.permissions.effective');
    return {
      adapterId,
      approvalPolicy: oneOf(raw.approvalPolicy,
        ['never', 'on-request', 'provider-default', 'untrusted'],
        'session.permissions.effective.approvalPolicy'),
      approvalPolicySource: source(raw.approvalPolicySource,
        'session.permissions.effective.approvalPolicySource'),
      sandbox: oneOf(raw.sandbox,
        ['danger-full-access', 'provider-default', 'read-only', 'workspace-write'],
        'session.permissions.effective.sandbox'),
      sandboxSource: source(raw.sandboxSource, 'session.permissions.effective.sandboxSource'),
    };
  }
  exact(raw, ['adapterId', 'sandbox', 'sandboxSource', 'sessionMode', 'sessionModeSource'],
    'session.permissions.effective');
  return {
    adapterId,
    sessionMode: oneOf(raw.sessionMode, ['ask', 'default', 'plan'],
      'session.permissions.effective.sessionMode'),
    sessionModeSource: source(raw.sessionModeSource,
      'session.permissions.effective.sessionModeSource'),
    sandbox: safeToken(raw.sandbox, 'session.permissions.effective.sandbox'),
    sandboxSource: source(raw.sandboxSource, 'session.permissions.effective.sandboxSource'),
  };
}

function access(value: unknown, field: string): SessionWorkspaceAccess {
  return oneOf(value, ['allowed', 'denied', 'provider-default', 'unavailable'], field);
}

function rule(value: unknown, index: number): SessionPermissionRuleDto {
  const field = `session.permissions.rules.items.${index}`;
  const raw = object(value, field);
  exact(raw, ['effect', 'provenance', 'subject'], field);
  const subjectRaw = object(raw.subject, `${field}.subject`);
  const kind = oneOf(subjectRaw.kind, ['tool', 'workspace-subtree'], `${field}.subject.kind`);
  let subject: SessionPermissionRuleDto['subject'];
  if (kind === 'tool') {
    exact(subjectRaw, ['kind', 'tool'], `${field}.subject`);
    subject = { kind, tool: safeToken(subjectRaw.tool, `${field}.subject.tool`) };
  } else {
    exact(subjectRaw, ['kind', 'segments'], `${field}.subject`);
    if (!Array.isArray(subjectRaw.segments) || subjectRaw.segments.length > 32) {
      fail(`${field}.subject.segments`);
    }
    subject = {
      kind,
      segments: subjectRaw.segments.map((segment, segmentIndex) =>
        safeToken(segment, `${field}.subject.segments.${segmentIndex}`, 128)),
    };
  }
  return {
    effect: oneOf(raw.effect, ['allow', 'ask', 'deny'], `${field}.effect`),
    subject,
    provenance: oneOf(raw.provenance, ['core-default', 'session', 'workspace'],
      `${field}.provenance`),
  };
}

export function parseSessionPermissionsGetResult(value: unknown): SessionPermissionsGetResult {
  if (bytes(JSON.stringify(value)) > SESSION_PERMISSIONS_MAX_RESULT_BYTES) {
    fail('session.permissions.result.bytes');
  }
  const raw = object(value, 'session.permissions.result');
  exact(raw, ['adapterId', 'effective', 'revision', 'rules', 'sessionId', 'workspace'],
    'session.permissions.result');
  const parsedEffective = effective(raw.effective);
  const adapterId = oneOf(raw.adapterId, ['claude-code', 'codex-cli', 'grok-build'],
    'session.permissions.adapterId');
  if (parsedEffective.adapterId !== adapterId) fail('session.permissions.adapterId');
  const workspaceRaw = object(raw.workspace, 'session.permissions.workspace');
  exact(workspaceRaw, ['network', 'read', 'write'], 'session.permissions.workspace');
  const rulesRaw = object(raw.rules, 'session.permissions.rules');
  exact(rulesRaw, ['items', 'omittedCount', 'state', 'truncated'], 'session.permissions.rules');
  if (!Array.isArray(rulesRaw.items) || rulesRaw.items.length > SESSION_PERMISSIONS_MAX_RULES ||
      typeof rulesRaw.truncated !== 'boolean') fail('session.permissions.rules');
  const items = rulesRaw.items.map(rule);
  const state = oneOf(rulesRaw.state, ['available', 'unavailable'], 'session.permissions.rules.state');
  if (state === 'unavailable' && items.length > 0) fail('session.permissions.rules.items');
  return {
    sessionId: token(raw.sessionId, 'session.permissions.sessionId'),
    adapterId,
    effective: parsedEffective,
    workspace: {
      read: access(workspaceRaw.read, 'session.permissions.workspace.read'),
      write: access(workspaceRaw.write, 'session.permissions.workspace.write'),
      network: access(workspaceRaw.network, 'session.permissions.workspace.network'),
    },
    rules: {
      state,
      items,
      omittedCount: integer(rulesRaw.omittedCount, 'session.permissions.rules.omittedCount'),
      truncated: rulesRaw.truncated,
    },
    revision: integer(raw.revision, 'session.permissions.revision'),
  };
}
