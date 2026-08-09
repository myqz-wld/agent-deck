import { isJsonObject, type JsonObject } from './json';
import {
  SESSION_CONSOLE_MAX_ALIAS_BYTES,
  SESSION_CONSOLE_MAX_WORKING_DIRECTORY_BYTES,
  SessionConsoleContractError,
  parseWorkspaceDirectoryRef,
} from './session-console-common';

export const SESSION_CONSOLE_CAPABILITY_SCHEMA_VERSION = 1;
export const SESSION_CONSOLE_MAX_ADAPTERS = 16;
export const SESSION_CONSOLE_MAX_OPTION_VALUES = 64;
export const SESSION_CONSOLE_MAX_ATTACHMENT_COUNT = 20;
export const SESSION_CONSOLE_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const SESSION_CONSOLE_MAX_TOTAL_ATTACHMENT_BYTES = 30 * 1024 * 1024;

export const SESSION_CONSOLE_CREATE_OPTION_KEYS = Object.freeze([
  'approvalPolicy',
  'claudeCodeSandbox',
  'codexSandbox',
  'grokSandbox',
  'model',
  'permissionMode',
  'provider',
  'sessionMode',
  'thinking',
] as const);

export type SessionConsoleCreateOptionKey =
  (typeof SESSION_CONSOLE_CREATE_OPTION_KEYS)[number];

export interface SessionConsoleCapabilitiesParams {
  adapterId: string | null;
  provider: string;
  workingDirectory: string;
}

export interface SessionConsoleCreateOptions extends JsonObject {
  approvalPolicy: string | null;
  claudeCodeSandbox: string | null;
  codexSandbox: string | null;
  grokSandbox: string | null;
  model: string | null;
  permissionMode: string | null;
  provider: string | null;
  sessionMode: string | null;
  thinking: string | null;
}

export interface SessionConsoleCreateOptionDescriptor {
  allowedValues: string[] | null;
  allowEmpty: boolean;
  allowCustom: boolean;
  defaultValue: string | null;
  disabledReason: string | null;
  enabled: boolean;
}

export type SessionConsoleCreateOptionSchema = {
  [K in SessionConsoleCreateOptionKey]: SessionConsoleCreateOptionDescriptor;
};

export interface SessionConsoleAdapterSummaryDescriptor {
  adapterId: string;
  displayName: string;
  disabledReason: string | null;
  enabled: boolean;
}

export type SessionConsoleSandboxAccess =
  | 'provider-strict'
  | 'selected-directory-read-write'
  | 'workspace-read-only'
  | 'workspace-read-write';

export interface SessionConsoleSandboxChoiceDescriptor {
  disabledReason: string | null;
  effectiveAccess: SessionConsoleSandboxAccess;
  enabled: boolean;
  value: string;
}

export interface SessionConsoleSandboxDescriptor {
  choices: SessionConsoleSandboxChoiceDescriptor[];
  optionKey: 'claudeCodeSandbox' | 'codexSandbox' | 'grokSandbox';
  scope: 'selected-directory';
  workspaceCeiling: 'required';
}

export interface SessionConsoleAttachmentPolicyDescriptor {
  disabledReason: string | null;
  enabled: boolean;
  maxBytesEach: number;
  maxBytesTotal: number;
  maxCount: number;
  mimeTypes: string[];
}

export interface SessionConsoleAdapterCreateDescriptor
  extends SessionConsoleAdapterSummaryDescriptor {
  attachments: SessionConsoleAttachmentPolicyDescriptor;
  options: SessionConsoleCreateOptionSchema;
  sandbox: SessionConsoleSandboxDescriptor;
}

export interface SessionConsoleDirectoryPolicyDescriptor {
  kind: 'workspace-relative';
  maxBytes: number;
  rootRef: '.';
  selectedDirectory: string;
  symlinkPolicy: 'resolve-beneath-workspace';
}

export interface SessionConsoleCapabilitiesResult {
  adapters: SessionConsoleAdapterSummaryDescriptor[];
  capabilityRevision: string;
  create: SessionConsoleAdapterCreateDescriptor;
  directoryPolicy: SessionConsoleDirectoryPolicyDescriptor;
  revision: number;
  schemaVersion: typeof SESSION_CONSOLE_CAPABILITY_SCHEMA_VERSION;
  selectedAdapterId: string;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CAPABILITY_REVISION = /^sha256:[a-f0-9]{64}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const MAX_TEXT_BYTES = 512;

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

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' || (!allowEmpty && value.length === 0) ||
    bytes(value) > MAX_TEXT_BYTES || CONTROL.test(value)
  ) fail(field);
  return value;
}

function token(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (bytes(parsed) > SESSION_CONSOLE_MAX_ALIAS_BYTES || !SAFE_TOKEN.test(parsed)) fail(field);
  return parsed;
}

function nonNegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(field);
  return value as number;
}

function positive(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    fail(field);
  }
  return value as number;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field, true);
}

function nullableReason(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}

export function parseSessionConsoleCapabilityRevision(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!CAPABILITY_REVISION.test(parsed)) fail(field);
  return parsed;
}

export function parseSessionConsoleCapabilitiesParams(
  value: unknown,
): SessionConsoleCapabilitiesParams {
  if (!isJsonObject(value)) fail('session.console.capabilities.params');
  exactKeys(
    value,
    ['adapterId', 'provider', 'workingDirectory'],
    'session.console.capabilities.params',
  );
  return {
    adapterId: value.adapterId === null
      ? null
      : token(value.adapterId, 'session.console.capabilities.adapterId'),
    provider: text(value.provider, 'session.console.capabilities.provider', true),
    workingDirectory: parseWorkspaceDirectoryRef(
      value.workingDirectory,
      'session.console.capabilities.workingDirectory',
    ),
  };
}

export function parseSessionConsoleCreateOptions(
  value: unknown,
): SessionConsoleCreateOptions {
  if (!isJsonObject(value)) fail('session.console.create.options');
  exactKeys(value, SESSION_CONSOLE_CREATE_OPTION_KEYS, 'session.console.create.options');
  return {
    approvalPolicy: nullableText(value.approvalPolicy, 'options.approvalPolicy'),
    claudeCodeSandbox: nullableText(value.claudeCodeSandbox, 'options.claudeCodeSandbox'),
    codexSandbox: nullableText(value.codexSandbox, 'options.codexSandbox'),
    grokSandbox: nullableText(value.grokSandbox, 'options.grokSandbox'),
    model: nullableText(value.model, 'options.model'),
    permissionMode: nullableText(value.permissionMode, 'options.permissionMode'),
    provider: nullableText(value.provider, 'options.provider'),
    sessionMode: nullableText(value.sessionMode, 'options.sessionMode'),
    thinking: nullableText(value.thinking, 'options.thinking'),
  };
}

function parseOptionDescriptor(
  value: unknown,
  field: string,
): SessionConsoleCreateOptionDescriptor {
  if (!isJsonObject(value)) fail(field);
  exactKeys(value, [
    'allowedValues', 'allowCustom', 'allowEmpty', 'defaultValue',
    'disabledReason', 'enabled',
  ], field);
  if (
    typeof value.enabled !== 'boolean' || typeof value.allowCustom !== 'boolean' ||
    typeof value.allowEmpty !== 'boolean'
  ) fail(field);
  const disabledReason = nullableReason(value.disabledReason, `${field}.disabledReason`);
  const defaultValue = nullableText(value.defaultValue, `${field}.defaultValue`);
  if (value.enabled !== (disabledReason === null) || value.enabled !== (defaultValue !== null)) {
    fail(field);
  }
  let allowedValues: string[] | null = null;
  if (value.allowedValues !== null) {
    if (
      !Array.isArray(value.allowedValues) ||
      value.allowedValues.length > SESSION_CONSOLE_MAX_OPTION_VALUES
    ) fail(`${field}.allowedValues`);
    allowedValues = value.allowedValues.map((entry, index) =>
      text(entry, `${field}.allowedValues[${index}]`, true));
    if (new Set(allowedValues).size !== allowedValues.length) fail(`${field}.allowedValues`);
  }
  if (!value.enabled && (value.allowCustom || value.allowEmpty || allowedValues?.length)) fail(field);
  if (value.enabled && value.allowCustom !== (allowedValues === null)) fail(field);
  if (value.enabled && defaultValue !== null) {
    if (!value.allowEmpty && defaultValue.length === 0) fail(`${field}.defaultValue`);
    if (
      !value.allowCustom && defaultValue.length > 0 &&
      !allowedValues?.includes(defaultValue)
    ) fail(`${field}.defaultValue`);
  }
  return {
    allowedValues,
    allowEmpty: value.allowEmpty,
    allowCustom: value.allowCustom,
    defaultValue,
    disabledReason,
    enabled: value.enabled,
  };
}

function parseOptionSchema(value: unknown): SessionConsoleCreateOptionSchema {
  if (!isJsonObject(value)) fail('session.console.capabilities.create.options');
  exactKeys(value, SESSION_CONSOLE_CREATE_OPTION_KEYS, 'session.console.capabilities.create.options');
  return Object.fromEntries(SESSION_CONSOLE_CREATE_OPTION_KEYS.map((key) => [
    key,
    parseOptionDescriptor(value[key], `session.console.capabilities.create.options.${key}`),
  ])) as unknown as SessionConsoleCreateOptionSchema;
}

function parseAdapterSummary(
  value: unknown,
  field: string,
): SessionConsoleAdapterSummaryDescriptor {
  if (!isJsonObject(value)) fail(field);
  exactKeys(value, ['adapterId', 'disabledReason', 'displayName', 'enabled'], field);
  if (typeof value.enabled !== 'boolean') fail(`${field}.enabled`);
  const disabledReason = nullableReason(value.disabledReason, `${field}.disabledReason`);
  if (value.enabled !== (disabledReason === null)) fail(field);
  return {
    adapterId: token(value.adapterId, `${field}.adapterId`),
    displayName: text(value.displayName, `${field}.displayName`),
    disabledReason,
    enabled: value.enabled,
  };
}

function parseAttachments(value: unknown): SessionConsoleAttachmentPolicyDescriptor {
  const field = 'session.console.capabilities.create.attachments';
  if (!isJsonObject(value)) fail(field);
  exactKeys(value, [
    'disabledReason', 'enabled', 'maxBytesEach', 'maxBytesTotal',
    'maxCount', 'mimeTypes',
  ], field);
  if (typeof value.enabled !== 'boolean') fail(`${field}.enabled`);
  const disabledReason = nullableReason(value.disabledReason, `${field}.disabledReason`);
  if (value.enabled !== (disabledReason === null)) fail(field);
  const maxCount = positive(value.maxCount, `${field}.maxCount`, SESSION_CONSOLE_MAX_ATTACHMENT_COUNT);
  const maxBytesEach = positive(
    value.maxBytesEach,
    `${field}.maxBytesEach`,
    SESSION_CONSOLE_MAX_ATTACHMENT_BYTES,
  );
  const maxBytesTotal = positive(
    value.maxBytesTotal,
    `${field}.maxBytesTotal`,
    SESSION_CONSOLE_MAX_TOTAL_ATTACHMENT_BYTES,
  );
  if (!Array.isArray(value.mimeTypes) || value.mimeTypes.length > 32) fail(`${field}.mimeTypes`);
  const mimeTypes = value.mimeTypes.map((entry, index) => {
    const parsed = text(entry, `${field}.mimeTypes[${index}]`);
    if (!MIME.test(parsed)) fail(`${field}.mimeTypes[${index}]`);
    return parsed;
  });
  if (mimeTypes.length === 0 || new Set(mimeTypes).size !== mimeTypes.length) {
    fail(`${field}.mimeTypes`);
  }
  return { disabledReason, enabled: value.enabled, maxBytesEach, maxBytesTotal, maxCount, mimeTypes };
}

function parseSandbox(value: unknown): SessionConsoleSandboxDescriptor {
  const field = 'session.console.capabilities.create.sandbox';
  if (!isJsonObject(value)) fail(field);
  exactKeys(value, ['choices', 'optionKey', 'scope', 'workspaceCeiling'], field);
  if (
    !['claudeCodeSandbox', 'codexSandbox', 'grokSandbox'].includes(String(value.optionKey)) ||
    value.scope !== 'selected-directory' || value.workspaceCeiling !== 'required' ||
    !Array.isArray(value.choices) || value.choices.length === 0 ||
    value.choices.length > SESSION_CONSOLE_MAX_OPTION_VALUES
  ) fail(field);
  const choices = value.choices.map((entry, index) => {
    const choiceField = `${field}.choices[${index}]`;
    if (!isJsonObject(entry)) fail(choiceField);
    exactKeys(entry, ['disabledReason', 'effectiveAccess', 'enabled', 'value'], choiceField);
    if (
      typeof entry.enabled !== 'boolean' ||
      ![
        'provider-strict', 'selected-directory-read-write',
        'workspace-read-only', 'workspace-read-write',
      ].includes(String(entry.effectiveAccess))
    ) fail(choiceField);
    const disabledReason = nullableReason(entry.disabledReason, `${choiceField}.disabledReason`);
    if (entry.enabled !== (disabledReason === null)) fail(choiceField);
    return {
      disabledReason,
      effectiveAccess: entry.effectiveAccess as SessionConsoleSandboxAccess,
      enabled: entry.enabled,
      value: text(entry.value, `${choiceField}.value`),
    };
  });
  if (new Set(choices.map((choice) => choice.value)).size !== choices.length) fail(`${field}.choices`);
  return {
    choices,
    optionKey: value.optionKey as SessionConsoleSandboxDescriptor['optionKey'],
    scope: 'selected-directory',
    workspaceCeiling: 'required',
  };
}

function parseCreateDescriptor(value: unknown): SessionConsoleAdapterCreateDescriptor {
  const field = 'session.console.capabilities.create';
  if (!isJsonObject(value)) fail(field);
  exactKeys(value, [
    'adapterId', 'attachments', 'disabledReason', 'displayName',
    'enabled', 'options', 'sandbox',
  ], field);
  const summary = parseAdapterSummary({
      adapterId: value.adapterId,
      disabledReason: value.disabledReason,
      displayName: value.displayName,
      enabled: value.enabled,
    }, field);
  const options = parseOptionSchema(value.options);
  const sandbox = parseSandbox(value.sandbox);
  const sandboxOption = options[sandbox.optionKey];
  const enabledChoices = sandbox.choices.filter((choice) => choice.enabled).map((choice) => choice.value);
  const enabledSandboxIsConsistent = sandboxOption.enabled &&
    !sandboxOption.allowCustom &&
    canonicalStrings(sandboxOption.allowedValues ?? []) === canonicalStrings(enabledChoices) &&
    enabledChoices.includes(sandboxOption.defaultValue ?? '');
  const disabledSandboxIsConsistent = !summary.enabled && !sandboxOption.enabled &&
    enabledChoices.length === 0 && (sandboxOption.allowedValues?.length ?? 0) === 0 &&
    sandboxOption.defaultValue === null;
  if (!enabledSandboxIsConsistent && !disabledSandboxIsConsistent) {
    fail(`${field}.sandbox`);
  }
  return {
    ...summary,
    attachments: parseAttachments(value.attachments),
    options,
    sandbox,
  };
}

function canonicalStrings(values: readonly string[]): string {
  return [...values].sort().join('\u0000');
}

export function parseSessionConsoleCapabilitiesResult(
  value: unknown,
  expected?: SessionConsoleCapabilitiesParams,
): SessionConsoleCapabilitiesResult {
  const field = 'session.console.capabilities.result';
  if (!isJsonObject(value)) fail(field);
  exactKeys(value, [
    'adapters', 'capabilityRevision', 'create', 'directoryPolicy',
    'revision', 'schemaVersion', 'selectedAdapterId',
  ], field);
  if (value.schemaVersion !== SESSION_CONSOLE_CAPABILITY_SCHEMA_VERSION) fail(`${field}.schemaVersion`);
  if (!Array.isArray(value.adapters) || value.adapters.length === 0 ||
      value.adapters.length > SESSION_CONSOLE_MAX_ADAPTERS) fail(`${field}.adapters`);
  const adapters = value.adapters.map((entry, index) =>
    parseAdapterSummary(entry, `${field}.adapters[${index}]`));
  if (new Set(adapters.map((adapter) => adapter.adapterId)).size !== adapters.length) {
    fail(`${field}.adapters`);
  }
  const selectedAdapterId = token(value.selectedAdapterId, `${field}.selectedAdapterId`);
  const create = parseCreateDescriptor(value.create);
  const selectedSummary = adapters.find((adapter) => adapter.adapterId === selectedAdapterId);
  if (
    create.adapterId !== selectedAdapterId ||
    !selectedSummary ||
    create.enabled !== selectedSummary.enabled ||
    create.displayName !== selectedSummary.displayName ||
    create.disabledReason !== selectedSummary.disabledReason
  ) fail(`${field}.selectedAdapterId`);
  if (!isJsonObject(value.directoryPolicy)) fail(`${field}.directoryPolicy`);
  exactKeys(value.directoryPolicy, [
    'kind', 'maxBytes', 'rootRef', 'selectedDirectory', 'symlinkPolicy',
  ], `${field}.directoryPolicy`);
  if (
    value.directoryPolicy.kind !== 'workspace-relative' ||
    value.directoryPolicy.rootRef !== '.' ||
    value.directoryPolicy.symlinkPolicy !== 'resolve-beneath-workspace' ||
    value.directoryPolicy.maxBytes !== SESSION_CONSOLE_MAX_WORKING_DIRECTORY_BYTES
  ) fail(`${field}.directoryPolicy`);
  const selectedDirectory = parseWorkspaceDirectoryRef(
    value.directoryPolicy.selectedDirectory,
    `${field}.directoryPolicy.selectedDirectory`,
  );
  if (
    expected &&
    (selectedDirectory !== expected.workingDirectory ||
      (expected.adapterId !== null && selectedAdapterId !== expected.adapterId) ||
      (expected.provider.length > 0 &&
        create.options.provider.defaultValue !== expected.provider))
  ) fail(`${field}.requestBinding`);
  const capabilityRevision = parseSessionConsoleCapabilityRevision(
    value.capabilityRevision,
    `${field}.capabilityRevision`,
  );
  return {
    adapters,
    capabilityRevision,
    create,
    directoryPolicy: {
      kind: 'workspace-relative',
      maxBytes: SESSION_CONSOLE_MAX_WORKING_DIRECTORY_BYTES,
      rootRef: '.',
      selectedDirectory,
      symlinkPolicy: 'resolve-beneath-workspace',
    },
    revision: nonNegative(value.revision, `${field}.revision`),
    schemaVersion: SESSION_CONSOLE_CAPABILITY_SCHEMA_VERSION,
    selectedAdapterId,
  };
}
